/**
 * analyze-diff.ts
 *
 * MCP tool: analyze_diff
 *
 * Accepts a unified git diff and produces a consolidated impact report:
 * which symbols were added, modified, signature-changed, or deleted, together
 * with an optional downstream blast-radius and a review-priority rating.
 *
 * Most useful in CI pipelines and AI-assisted code review workflows.
 */

import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { getSymbolsByFile } from '../../core/db/symbol-store.js';
import { getFileContent } from '../../core/db/file-store.js';
import { getBlastRadius } from '../../graph/graph-traversal.js';
import {
  parseDiff,
  getChangedNewRanges,
  getAddedNewLines,
  parseDeletedSymbolNames,
} from '../../core/diff-parser.js';
import { buildMeta } from './_meta.js';
import { byteOffsetToLine } from './symbol-lines.js';
import { synthesizeChange, type ChangeSynthesis } from './change-synthesis.js';
import type { SymbolRecord, SymbolKind } from '../../core/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'analyze_diff';

export const description =
  'Parse a unified git diff and produce an impact-aware change report: which ' +
  'symbols are added, modified, signature-changed, or deleted, the downstream ' +
  'blast radius, composite symbol risk, historically co-changing files MISSING ' +
  'from the diff (the senior-reviewer "you forgot to touch X" signal), ' +
  'recommended tests, coverage gaps, and architectural flags (cycles / layer ' +
  'crossings the change sits on). Returns a reviewPriority rating ' +
  '(low / medium / high / critical). Impact-aware sections default ON and are ' +
  'individually switchable for cheap runs. Most useful in CI and AI-assisted PR review.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  diff: z
    .string()
    .describe('Unified diff string (output of `git diff` or `git diff HEAD~1`)'),
  includeBlastRadius: z
    .boolean()
    .optional()
    .describe('Compute downstream blast radius for changed symbols (default true)'),
  blastRadiusDepth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe('Max dependency hops for blast-radius walk (default 2)'),
  includeRisk: z
    .boolean()
    .optional()
    .describe('Score composite symbol risk for changed symbols (default true)'),
  includeCoChangeGaps: z
    .boolean()
    .optional()
    .describe('Flag historically co-changing files missing from the diff (default true)'),
  includeTests: z
    .boolean()
    .optional()
    .describe('Recommend tests + report coverage gaps for changed symbols (default true)'),
  includeArchitectureFlags: z
    .boolean()
    .optional()
    .describe('Flag cycles / layer crossings the changed files sit on (default true)'),
};

// ─── Types ────────────────────────────────────────────────────────────────────

type ChangeType = 'added' | 'modified' | 'deleted' | 'signature_changed';

interface ChangedSymbol {
  symbolId: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  changeType: ChangeType;
  signatureBefore?: string;
  signatureAfter?: string;
}

interface AnalyzeDiffOutput {
  summary: {
    filesChanged: number;
    symbolsAdded: number;
    symbolsModified: number;
    symbolsDeleted: number;
    signatureBreaks: number;
  };
  changedSymbols: ChangedSymbol[];
  blastRadius?: {
    filesImpacted: number;
    symbolsImpacted: number;
    impactedFiles: string[];
  };
  risk?: ChangeSynthesis['aggregateRisk'];
  missingCoChange?: ChangeSynthesis['missingCoChange'];
  recommendedTests?: ChangeSynthesis['recommendedTests'];
  coverageGaps?: ChangeSynthesis['coverageGaps'];
  architecturalFlags?: ChangeSynthesis['architecturalFlags'];
  signalQuality?: ChangeSynthesis['signalQuality'];
  reviewPriority: 'low' | 'medium' | 'high' | 'critical';
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// byteOffsetToLine consolidated onto symbol-lines.ts (Phase 90).

/**
 * True when the line range [symStart, symEnd] overlaps with at least one of
 * the given changed ranges.
 */
function overlapsAny(
  symStart: number,
  symEnd: number,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  for (const r of ranges) {
    if (symStart <= r.end && symEnd >= r.start) return true;
  }
  return false;
}

/**
 * Strip the `a/` / `b/` git prefix from a diff file path.
 * Also normalises backslashes to forward slashes.
 */
function normalisePath(p: string | null): string | null {
  if (!p) return null;
  return p.replace(/\\/g, '/');
}

/**
 * Try to extract the first meaningful (non-blank, non-decorator, non-comment)
 * line from a block of content lines — this is typically where the signature lives.
 */
function extractSignatureLine(lines: string[]): string | null {
  for (const line of lines) {
    const t = line.trim();
    if (t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('#') && !t.startsWith('@')) {
      return t;
    }
  }
  return null;
}

/**
 * Determine whether the old content lines (removed in the diff) contain a
 * different version of the symbol's signature.
 *
 * Returns the old signature string if a change is detected, null otherwise.
 */
function detectOldSignature(
  removedContentLines: string[],
  currentSignature: string,
): string | null {
  const oldSig = extractSignatureLine(removedContentLines);
  if (!oldSig) return null;
  // Normalise whitespace for comparison.
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (norm(oldSig) !== norm(currentSignature)) return oldSig;
  return null;
}

/**
 * Derive the review priority from the analysis results.
 *
 * Folds the Phase 77 impact signals (composite risk band + coverage gaps) into
 * the original signature-break/blast heuristic. The enum is unchanged
 * (low/medium/high/critical) so existing CI consumers keep working; when risk
 * is not computed (riskBand undefined) the derivation reduces to the original.
 *
 * priority  condition
 * ────────  ─────────────────────────────────────────────────────────
 * critical  ≥1 signature break AND (blast > 10 files OR risk band high)
 * high      ≥1 signature break OR blast > 5 files OR risk band high
 * medium    blast 1–5 files OR risk band review OR ≥1 coverage gap
 * low       none of the above
 */
function computeReviewPriority(
  signatureBreaks: number,
  blastFilesImpacted: number | undefined,
  riskBand: 'low' | 'review' | 'high' | undefined,
  coverageGapCount: number,
): 'low' | 'medium' | 'high' | 'critical' {
  const blast = blastFilesImpacted ?? 0;
  const highRisk = riskBand === 'high';

  if (signatureBreaks > 0 && (blast > 10 || highRisk)) return 'critical';
  if (signatureBreaks > 0 || blast > 5 || highRisk) return 'high';
  if ((blast >= 1 && blast <= 5) || riskBand === 'review' || coverageGapCount > 0) return 'medium';
  return 'low';
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  diff: string;
  includeBlastRadius?: boolean;
  blastRadiusDepth?: number;
  includeRisk?: boolean;
  includeCoChangeGaps?: boolean;
  includeTests?: boolean;
  includeArchitectureFlags?: boolean;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    diff,
    includeBlastRadius = true,
    blastRadiusDepth = 2,
    includeRisk = true,
    includeCoChangeGaps = true,
    includeTests = true,
    includeArchitectureFlags = true,
  } = args;

  // ── 1. Parse the diff ──────────────────────────────────────────────────────
  const fileDiffs = parseDiff(diff);

  if (fileDiffs.length === 0) {
    const empty: AnalyzeDiffOutput = {
      summary: { filesChanged: 0, symbolsAdded: 0, symbolsModified: 0, symbolsDeleted: 0, signatureBreaks: 0 },
      changedSymbols: [],
      reviewPriority: 'low',
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };
    return { content: [{ type: 'text', text: JSON.stringify(empty, null, 2) }] };
  }

  const db = openDatabase(repoId);

  const changedSymbols: ChangedSymbol[] = [];

  // ── 2. Analyse each file in the diff ──────────────────────────────────────
  for (const fileDiff of fileDiffs) {
    const newPath = normalisePath(fileDiff.newPath);
    const oldPath = normalisePath(fileDiff.oldPath);

    // ── 2a. Fully deleted file ───────────────────────────────────────────────
    if (fileDiff.isDeleted && oldPath) {
      // We can't retrieve current symbols — parse `-` lines for heuristic names.
      const deletedNames = parseDeletedSymbolNames(fileDiff.hunks);
      for (const dname of deletedNames) {
        changedSymbols.push({
          symbolId: '',
          name: dname,
          kind: 'function' as SymbolKind,
          filePath: oldPath,
          changeType: 'deleted',
        });
      }
      continue;
    }

    if (!newPath) continue;

    // ── 2b. Get current symbols and file content from DB ─────────────────────
    const currentSymbols = getSymbolsByFile(db, repoId, newPath);
    const rawContent = getFileContent(db, repoId, newPath);

    // ── 2c. Fully new file — all symbols are added ───────────────────────────
    if (fileDiff.isNew) {
      for (const sym of currentSymbols) {
        changedSymbols.push({
          symbolId: sym.id,
          name: sym.name,
          kind: sym.kind,
          filePath: sym.filePath,
          changeType: 'added',
        });
      }
      continue;
    }

    // ── 2d. Modified file ────────────────────────────────────────────────────
    if (fileDiff.hunks.length === 0) continue;

    const changedRanges = getChangedNewRanges(fileDiff.hunks);
    const addedLines = getAddedNewLines(fileDiff.hunks);

    // Map symbol → line range using file content (falls back to byte/4 estimate)
    const symbolLines = new Map<
      string,
      { startLine: number; endLine: number; sym: SymbolRecord }
    >();

    if (rawContent) {
      for (const sym of currentSymbols) {
        const startLine = byteOffsetToLine(rawContent, sym.startByte);
        const endLine = byteOffsetToLine(rawContent, sym.endByte);
        symbolLines.set(sym.id, { startLine, endLine, sym });
      }
    } else {
      // No cached content — use rough estimate (4 bytes per char, ~80 chars/line)
      for (const sym of currentSymbols) {
        const startLine = Math.floor(sym.startByte / 80) + 1;
        const endLine = Math.floor(sym.endByte / 80) + 1;
        symbolLines.set(sym.id, { startLine, endLine, sym });
      }
    }

    // Find changed symbols (overlapping with hunk ranges)
    const processedIds = new Set<string>();

    for (const { startLine, endLine, sym } of symbolLines.values()) {
      if (!overlapsAny(startLine, endLine, changedRanges)) continue;
      if (processedIds.has(sym.id)) continue;
      processedIds.add(sym.id);

      // Determine change type ─────────────────────────────────────────────────
      // Collect the removed content from hunks overlapping this symbol's range
      const relevantRemovedContent: string[] = [];
      for (const hunk of fileDiff.hunks) {
        const hunkEnd = hunk.newStart + Math.max(hunk.newCount - 1, 0);
        if (startLine <= hunkEnd && endLine >= hunk.newStart) {
          relevantRemovedContent.push(...hunk.removedContent);
        }
      }

      // Added: symbol's start line is in addedNewLines (never existed in old ver)
      const isSymbolEntirelyAdded =
        addedLines.has(startLine) && relevantRemovedContent.length === 0;

      if (isSymbolEntirelyAdded) {
        changedSymbols.push({
          symbolId: sym.id,
          name: sym.name,
          kind: sym.kind,
          filePath: sym.filePath,
          changeType: 'added',
        });
        continue;
      }

      // Signature_changed: old content differs from current signature
      const oldSig = relevantRemovedContent.length > 0
        ? detectOldSignature(relevantRemovedContent, sym.signature)
        : null;

      if (oldSig !== null) {
        changedSymbols.push({
          symbolId: sym.id,
          name: sym.name,
          kind: sym.kind,
          filePath: sym.filePath,
          changeType: 'signature_changed',
          signatureBefore: oldSig,
          signatureAfter: sym.signature,
        });
      } else {
        changedSymbols.push({
          symbolId: sym.id,
          name: sym.name,
          kind: sym.kind,
          filePath: sym.filePath,
          changeType: 'modified',
        });
      }
    }

    // Deleted symbols: names found in `-` lines but absent from current DB ────
    const currentNames = new Set(currentSymbols.map((s) => s.name));
    const deletedNames = parseDeletedSymbolNames(fileDiff.hunks).filter(
      (n) => !currentNames.has(n),
    );

    for (const dname of deletedNames) {
      changedSymbols.push({
        symbolId: '',
        name: dname,
        kind: 'function' as SymbolKind,
        filePath: newPath,
        changeType: 'deleted',
      });
    }
  }

  // ── 3. Blast radius ────────────────────────────────────────────────────────
  let blastRadiusResult:
    | { filesImpacted: number; symbolsImpacted: number; impactedFiles: string[] }
    | undefined;

  if (includeBlastRadius) {
    const impactedFileSet = new Set<string>();
    const impactedSymbolSet = new Set<string>();

    for (const cs of changedSymbols) {
      if (!cs.symbolId || cs.changeType === 'deleted') continue;
      const br = getBlastRadius(cs.symbolId, repoId, db, blastRadiusDepth);
      for (const f of br.files) impactedFileSet.add(f);
      for (const s of br.symbols) impactedSymbolSet.add(s.id);
    }

    blastRadiusResult = {
      filesImpacted: impactedFileSet.size,
      symbolsImpacted: impactedSymbolSet.size,
      impactedFiles: [...impactedFileSet].sort(),
    };
  }

  // ── 4. Change-impact synthesis (Phase 77) ──────────────────────────────────
  // Built on top of the already-correct symbol-change list. Each section is
  // individually switchable; when all are off we skip synthesis entirely so the
  // output reduces to the original shape.
  const anySynthesis =
    includeRisk || includeCoChangeGaps || includeTests || includeArchitectureFlags;

  let synthesis: ChangeSynthesis | undefined;
  if (anySynthesis) {
    const changedSymbolIds = changedSymbols
      .filter((s) => s.symbolId && s.changeType !== 'deleted')
      .map((s) => s.symbolId);
    const changedFilePaths = [
      ...new Set(changedSymbols.map((s) => s.filePath).filter((p): p is string => !!p)),
    ];
    synthesis = synthesizeChange(db, repoId, {
      changedSymbolIds,
      changedFilePaths,
      includeRisk,
      includeCoChangeGaps,
      includeTests,
      includeArchitectureFlags,
    });
  }

  db.close();

  // ── 5. Build summary ───────────────────────────────────────────────────────
  const summary = {
    filesChanged: new Set(fileDiffs.map((f) => f.newPath ?? f.oldPath)).size,
    symbolsAdded: changedSymbols.filter((s) => s.changeType === 'added').length,
    symbolsModified: changedSymbols.filter((s) => s.changeType === 'modified').length,
    symbolsDeleted: changedSymbols.filter((s) => s.changeType === 'deleted').length,
    signatureBreaks: changedSymbols.filter((s) => s.changeType === 'signature_changed').length,
  };

  const riskBand = includeRisk ? synthesis?.aggregateRisk.band : undefined;
  const coverageGapCount = includeTests ? (synthesis?.coverageGaps.length ?? 0) : 0;

  const reviewPriority = computeReviewPriority(
    summary.signatureBreaks,
    blastRadiusResult?.filesImpacted,
    riskBand,
    coverageGapCount,
  );

  const output: AnalyzeDiffOutput = {
    summary,
    changedSymbols,
    reviewPriority,
    _meta: buildMeta({ timingMs: Date.now() - t0 }),
  };

  if (blastRadiusResult !== undefined) {
    output.blastRadius = blastRadiusResult;
  }

  // Attach only the synthesis sections whose toggle is on (additive output).
  if (synthesis) {
    if (includeRisk) output.risk = synthesis.aggregateRisk;
    if (includeCoChangeGaps) output.missingCoChange = synthesis.missingCoChange;
    if (includeTests) {
      output.recommendedTests = synthesis.recommendedTests;
      output.coverageGaps = synthesis.coverageGaps;
    }
    if (includeArchitectureFlags) output.architecturalFlags = synthesis.architecturalFlags;
    output.signalQuality = synthesis.signalQuality;
  }

  return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
}
