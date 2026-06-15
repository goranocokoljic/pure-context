/**
 * verify-change.ts
 *
 * MCP tool: verify_change (Phase 79, Group B)
 *
 * The POST-EDIT half of PureContext's refactoring loop, and the capability a
 * fast symbol index (or a tool that only applies edits) does not have:
 * plan-vs-actual reconciliation. Given the real diff of what the agent did and
 * the prediction from `prepare_change`, it answers "is this change complete?":
 *
 *   - unaddressedCoChange — files prepare_change flagged as historically coupled
 *     that the agent STILL did not touch ("you planned around X; it's untouched")
 *   - addressedCoChange   — predicted partners that WERE touched (good)
 *   - unplannedChanges    — files in the diff that were NOT predicted (scope creep)
 *   - coverageGapsRemaining — changed symbols still without test coverage
 *   - verdict: complete | incomplete | scope_expanded, with reasons[]
 *
 * Reuses analyze_diff verbatim for the "actual" synthesis — no duplicated diff
 * parsing or synthesis logic. Stateless: the agent passes the prediction back
 * inline (predictedFilePaths / predictedCoChange from prepare_change).
 */

import { z } from 'zod';
import { parseDiff } from '../../core/diff-parser.js';
import { buildMeta } from './_meta.js';
import { handler as analyzeDiffHandler } from './analyze-diff.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'verify_change';

export const description =
  'Post-edit refactoring reconciliation: given the real diff and the prediction ' +
  'from prepare_change, confirm the change is COMPLETE. Reports historically ' +
  'co-changing files you planned around but still did not touch ' +
  '(unaddressedCoChange), predicted partners you did touch (addressedCoChange), ' +
  'files changed that were not predicted (unplannedChanges / scope creep), and ' +
  'changed symbols still lacking tests (coverageGapsRemaining). Returns a verdict ' +
  '(complete / incomplete / scope_expanded) with plain-English reasons. Stateless: ' +
  'pass predictedFilePaths and predictedCoChange from the prepare_change output. ' +
  'Co-change reconciliation is suppressed when the git signal is low.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  diff: z.string().describe('Unified diff of what you actually changed (output of `git diff`)'),
  predictedFilePaths: z
    .array(z.string())
    .describe('predictedChange.changedFilePaths from the prepare_change output'),
  predictedCoChange: z
    .array(z.string())
    .optional()
    .describe(
      'File paths prepare_change flagged in missingCoChange (the partners you were ' +
      'advised to consider). Pass missingCoChange[].filePath. Defaults to empty.',
    ),
  predictionId: z
    .string()
    .optional()
    .describe('Optional echo of prepare_change.predictionId (label only; not stored).'),
};

// ─── Output types ─────────────────────────────────────────────────────────────

interface VerifyChangeOutput {
  verdict: 'complete' | 'incomplete' | 'scope_expanded';
  predictionId?: string;
  actualFilePaths: string[];
  addressedCoChange: string[];
  unaddressedCoChange: string[];
  unplannedChanges: string[];
  coverageGapsRemaining: { symbolId: string; name: string }[];
  signalQuality: 'ok' | 'low';
  reasons: string[];
  _meta: ReturnType<typeof buildMeta>;
}

interface AnalyzeDiffShape {
  changedSymbols: Array<{ symbolId: string; name: string; filePath: string; changeType: string }>;
  coverageGaps?: Array<{ symbolId: string; name: string }>;
  signalQuality?: 'ok' | 'low';
}

function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

function parseAnalyzeDiff(result: CallToolResult): AnalyzeDiffShape | null {
  if (result.isError) return null;
  const text = (result.content[0] as { text?: string }).text;
  if (!text) return null;
  try {
    return JSON.parse(text) as AnalyzeDiffShape;
  } catch {
    return null;
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  diff: string;
  predictedFilePaths: string[];
  predictedCoChange?: string[];
  predictionId?: string;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, diff, predictedFilePaths, predictedCoChange = [], predictionId } = args;

  // ── 1. Actual change set + synthesis via analyze_diff (no duplication) ──────
  const analysis = parseAnalyzeDiff(
    await analyzeDiffHandler({
      repoId,
      diff,
      includeBlastRadius: false,
      includeRisk: false,
      includeCoChangeGaps: false,
      includeTests: true,
      includeArchitectureFlags: false,
    }),
  );

  // Actual files = diff file headers ∪ resolved changed-symbol files (robust to
  // files with no indexed symbols).
  const actual = new Set<string>();
  for (const fd of parseDiff(diff)) {
    if (fd.newPath) actual.add(norm(fd.newPath));
    if (fd.oldPath) actual.add(norm(fd.oldPath));
  }
  for (const cs of analysis?.changedSymbols ?? []) {
    if (cs.filePath) actual.add(norm(cs.filePath));
  }

  const signalQuality: 'ok' | 'low' = analysis?.signalQuality ?? 'low';
  const coverageGapsRemaining = analysis?.coverageGaps ?? [];

  // ── 2. Reconcile against the prediction ────────────────────────────────────
  const predictedSet = new Set(predictedFilePaths.map(norm));
  const predictedCo = [...new Set(predictedCoChange.map(norm))];

  // Co-change reconciliation is only trustworthy when the git signal is ok.
  const coChangeTrusted = signalQuality === 'ok';
  const addressedCoChange = coChangeTrusted ? predictedCo.filter((f) => actual.has(f)) : [];
  const unaddressedCoChange = coChangeTrusted ? predictedCo.filter((f) => !actual.has(f)) : [];

  const unplannedChanges = [...actual].filter((f) => !predictedSet.has(f)).sort();

  // ── 3. Verdict + reasons ───────────────────────────────────────────────────
  const reasons: string[] = [];
  let verdict: VerifyChangeOutput['verdict'];

  if (unaddressedCoChange.length > 0 || coverageGapsRemaining.length > 0) {
    verdict = 'incomplete';
    if (unaddressedCoChange.length > 0) {
      reasons.push(
        `${unaddressedCoChange.length} historically co-changing file(s) you planned around are still ` +
        `untouched: ${unaddressedCoChange.slice(0, 3).join(', ')}. Consider editing them in this change.`,
      );
    }
    if (coverageGapsRemaining.length > 0) {
      reasons.push(
        `${coverageGapsRemaining.length} changed symbol(s) still have no test coverage: ` +
        `${coverageGapsRemaining.slice(0, 3).map((c) => c.name).join(', ')}.`,
      );
    }
  } else if (unplannedChanges.length > 0) {
    verdict = 'scope_expanded';
    reasons.push(
      `Change is complete relative to the plan, but ${unplannedChanges.length} file(s) were touched that ` +
      `were not predicted: ${unplannedChanges.slice(0, 3).join(', ')}. Confirm this scope was intended.`,
    );
  } else {
    verdict = 'complete';
    reasons.push('Change matches the prediction: all planned files touched, no co-change gaps, no coverage gaps.');
  }

  if (addressedCoChange.length > 0) {
    reasons.push(
      `Addressed ${addressedCoChange.length} predicted co-change partner(s): ${addressedCoChange.slice(0, 3).join(', ')}.`,
    );
  }
  if (!coChangeTrusted && predictedCo.length > 0) {
    reasons.push('Co-change reconciliation suppressed — git signal is low (shallow/squashed history).');
  }

  const out: VerifyChangeOutput = {
    verdict,
    actualFilePaths: [...actual].sort(),
    addressedCoChange,
    unaddressedCoChange,
    unplannedChanges,
    coverageGapsRemaining,
    signalQuality,
    reasons,
    _meta: buildMeta({ timingMs: Date.now() - t0 }),
  };
  if (predictionId) out.predictionId = predictionId;

  return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
}
