/**
 * prepare-change.ts
 *
 * MCP tool: prepare_change (Phase 79, Group A)
 *
 * The PRE-EDIT half of PureContext's refactoring loop. Given a stated intent
 * (rename / delete / modify / extract) and a target (a symbolId or a free-text
 * query), it resolves the concrete change set and returns an impact-aware
 * pre-flight verdict BEFORE the agent edits anything:
 *
 *   - the predicted change (symbols + files that will need touching)
 *   - aggregate composite risk + the historically co-changing files that are
 *     NOT yet in the predicted change ("you'll also want to touch X")
 *   - recommended tests, coverage gaps, and architectural flags
 *   - plain-English `reasons[]` (the explainability contract — not a bare score)
 *
 * It is JUDGMENT, NOT ACTUATION: it never edits. The agent applies the change
 * with its own tools, then calls `verify_change` with the real diff to reconcile
 * what it actually did against this prediction.
 *
 * Both prepare_change and analyze_diff are thin consumers of the same
 * `synthesizeChange` engine — the synthesis logic lives there, never here.
 */

import { z } from 'zod';
import { createHash } from 'crypto';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getSymbolById } from '../../core/db/symbol-store.js';
import { getImportersOf } from '../../core/db/dep-store.js';
import { getConfig } from '../../config/config-loader.js';
import { buildMeta } from './_meta.js';
import { synthesizeChange, type ChangeSynthesis } from './change-synthesis.js';
import { handler as searchSymbolsHandler } from './search-symbols.js';
import { handler as findReferencesHandler } from './find-references.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'prepare_change';

export const description =
  'Pre-edit refactoring orchestrator: given an intent (rename / delete / modify / ' +
  'extract) and a target (symbolId or free-text query), resolve the change set and ' +
  'return an impact-aware pre-flight BEFORE editing — predicted files, composite ' +
  'risk, historically co-changing files MISSING from the predicted change (the ' +
  '"you forgot to touch X" signal), recommended tests, coverage gaps, architectural ' +
  'flags, and plain-English reasons. Read-only — it never edits. Apply the change ' +
  'yourself, then call verify_change with the real diff to confirm completeness. ' +
  'Returns verdict "ambiguous_target" with candidates when a query is not a clear ' +
  'match (it never guesses).';

const intentEnum = z.enum(['rename', 'delete', 'modify', 'extract']);

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  intent: intentEnum.describe(
    'What you intend to do: rename, delete, modify (edit body/signature), or extract (move).',
  ),
  targetSymbolId: z
    .string()
    .optional()
    .describe('Symbol ID of the target. Provide this OR query.'),
  query: z
    .string()
    .optional()
    .describe(
      'Free-text name/description of the target symbol. Resolved via search; ' +
      'returns "ambiguous_target" with candidates if there is no clear match.',
    ),
  includeRisk: z.boolean().optional().describe('Score composite risk (default true)'),
  includeCoChangeGaps: z
    .boolean()
    .optional()
    .describe('Flag historically co-changing files missing from the change (default true)'),
  includeTests: z.boolean().optional().describe('Recommend tests + coverage gaps (default true)'),
  includeArchitectureFlags: z
    .boolean()
    .optional()
    .describe('Flag cycles / layer crossings the target sits on (default true)'),
};

// ─── Output types ─────────────────────────────────────────────────────────────

type Intent = z.infer<typeof intentEnum>;

interface TargetCandidate {
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  score: number;
}

interface PrepareChangeOutput {
  verdict: 'ready' | 'ambiguous_target' | 'no_target';
  intent: Intent;
  target?: { symbolId: string; name: string; kind: string; filePath: string };
  candidates?: TargetCandidate[];
  predictedChange?: { changedSymbolIds: string[]; changedFilePaths: string[] };
  predictionId?: string;
  risk?: ChangeSynthesis['aggregateRisk'];
  missingCoChange?: ChangeSynthesis['missingCoChange'];
  recommendedTests?: ChangeSynthesis['recommendedTests'];
  coverageGaps?: ChangeSynthesis['coverageGaps'];
  architecturalFlags?: ChangeSynthesis['architecturalFlags'];
  signalQuality?: ChangeSynthesis['signalQuality'];
  reasons: string[];
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface SearchResultShape {
  count: number;
  symbols: Array<{ id: string; name: string; kind: string; filePath: string; score: number }>;
}

interface FindReferencesShape {
  references: Array<{ filePath: string }>;
}

function parseJsonResult<T>(result: CallToolResult): T | null {
  if (result.isError) return null;
  const text = (result.content[0] as { text?: string }).text;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * A query resolves cleanly when there is exactly one match, or the top match
 * clearly dominates the runner-up. Otherwise we return candidates and refuse to
 * guess — synthesizing against the wrong target produces misleading pre-flight.
 */
function isClearWinner(candidates: TargetCandidate[]): boolean {
  if (candidates.length === 0) return false;
  if (candidates.length === 1) return true;
  const top = candidates[0]!.score;
  const second = candidates[1]!.score;
  return top >= second * 1.5 || top - second >= 30;
}

function buildReasons(intent: Intent, syn: ChangeSynthesis): string[] {
  const reasons: string[] = [];

  reasons.push(`Aggregate change risk: ${syn.aggregateRisk.band}.`);
  const topRisk = syn.aggregateRisk.topRiskSymbols[0];
  if (topRisk && topRisk.band !== 'low') {
    reasons.push(`Highest-risk symbol: ${topRisk.name} (${topRisk.band}, ${topRisk.riskScore}/100).`);
  }

  if (syn.missingCoChange.length > 0) {
    const top = syn.missingCoChange.slice(0, 3).map((m) => m.filePath).join(', ');
    reasons.push(
      `${syn.missingCoChange.length} file(s) historically co-change with the target but are NOT in the ` +
      `predicted change — consider touching them too: ${top}.`,
    );
  }

  if (syn.coverageGaps.length > 0) {
    reasons.push(
      `${syn.coverageGaps.length} changed symbol(s) have no detected test coverage — add or update tests.`,
    );
  }

  if (syn.architecturalFlags.cyclesTouched.length > 0) {
    reasons.push(
      `Target sits on ${syn.architecturalFlags.cyclesTouched.length} import cycle(s); a ${intent} here ` +
      'may be harder to land cleanly.',
    );
  }
  if (syn.architecturalFlags.layerViolations.length > 0) {
    reasons.push(
      `Target sits on ${syn.architecturalFlags.layerViolations.length} layer-boundary crossing(s).`,
    );
  }

  if (syn.signalQuality === 'low') {
    reasons.push(
      'Co-change signal is low (shallow or squashed git history) — completeness suggestions suppressed.',
    );
  }

  if (reasons.length === 1 && syn.aggregateRisk.band === 'low') {
    reasons.push('No elevated change risk detected for this target.');
  }

  return reasons;
}

/** Deterministic id so verify_change can reference a prediction without a round-trip. */
function predictionIdFor(repoId: string, intent: Intent, symbolIds: string[]): string {
  const key = `${repoId}:${intent}:${[...symbolIds].sort().join(',')}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  intent: Intent;
  targetSymbolId?: string;
  query?: string;
  includeRisk?: boolean;
  includeCoChangeGaps?: boolean;
  includeTests?: boolean;
  includeArchitectureFlags?: boolean;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    intent,
    targetSymbolId,
    query,
    includeRisk = true,
    includeCoChangeGaps = true,
    includeTests = true,
    includeArchitectureFlags = true,
  } = args;

  if (!targetSymbolId && !query) {
    return {
      content: [
        { type: 'text', text: JSON.stringify({ error: 'prepare_change requires targetSymbolId or query.' }) },
      ],
      isError: true,
    };
  }

  const maxCandidates = getConfig().refactoring.maxCandidates;

  const db = openDatabase(repoId);
  try {
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: `Repo "${repoId}" not found. Run index_folder first.` }) },
        ],
        isError: true,
      };
    }

    // ── 1. Resolve target ────────────────────────────────────────────────────
    let target: { symbolId: string; name: string; kind: string; filePath: string };

    if (targetSymbolId) {
      const sym = getSymbolById(db, repoId, targetSymbolId);
      if (!sym) {
        const out: PrepareChangeOutput = {
          verdict: 'no_target',
          intent,
          candidates: [],
          reasons: [`Symbol "${targetSymbolId}" not found in repo "${repoId}".`],
          _meta: buildMeta({ timingMs: Date.now() - t0 }),
        };
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      }
      target = { symbolId: sym.id, name: sym.name, kind: sym.kind, filePath: sym.filePath };
    } else {
      const searchRes = await searchSymbolsHandler({ repoId, query: query!, limit: Math.max(maxCandidates, 5) });
      const parsed = parseJsonResult<SearchResultShape>(searchRes);
      const candidates: TargetCandidate[] = (parsed?.symbols ?? []).map((s) => ({
        symbolId: s.id,
        name: s.name,
        kind: s.kind,
        filePath: s.filePath,
        score: s.score,
      }));

      if (candidates.length === 0) {
        const out: PrepareChangeOutput = {
          verdict: 'no_target',
          intent,
          candidates: [],
          reasons: [
            `No symbol matched "${query}". The target may not exist — report the gap rather than ` +
            'editing a guessed location.',
          ],
          _meta: buildMeta({ timingMs: Date.now() - t0 }),
        };
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      }

      if (!isClearWinner(candidates)) {
        const out: PrepareChangeOutput = {
          verdict: 'ambiguous_target',
          intent,
          candidates: candidates.slice(0, maxCandidates),
          reasons: [
            `"${query}" matched ${candidates.length} symbols with no clear winner. ` +
            'Re-call prepare_change with targetSymbolId set to the intended candidate.',
          ],
          _meta: buildMeta({ timingMs: Date.now() - t0 }),
        };
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      }

      const top = candidates[0]!;
      target = { symbolId: top.symbolId, name: top.name, kind: top.kind, filePath: top.filePath };
    }

    // ── 2. Predict the change set ─────────────────────────────────────────────
    const changedFilePaths = new Set<string>([target.filePath.replace(/\\/g, '/')]);

    if (intent === 'rename' || intent === 'delete') {
      // Reference sites must be edited too.
      const refRes = findReferencesHandler({ repoId, identifier: target.name });
      const refs = parseJsonResult<FindReferencesShape>(refRes);
      for (const r of refs?.references ?? []) changedFilePaths.add(r.filePath.replace(/\\/g, '/'));
    } else if (intent === 'extract') {
      // Importers must update their import paths when the symbol moves.
      for (const f of getImportersOf(db, repoId, target.filePath)) {
        changedFilePaths.add(f.replace(/\\/g, '/'));
      }
    }
    // 'modify' touches only the target file by default.

    const changedSymbolIds = [target.symbolId];
    const predictedFilePaths = [...changedFilePaths];

    // ── 3. Synthesize impact (the shared engine) ──────────────────────────────
    const syn = synthesizeChange(db, repoId, {
      changedSymbolIds,
      changedFilePaths: predictedFilePaths,
      includeRisk,
      includeCoChangeGaps,
      includeTests,
      includeArchitectureFlags,
    });

    const out: PrepareChangeOutput = {
      verdict: 'ready',
      intent,
      target,
      predictedChange: { changedSymbolIds, changedFilePaths: predictedFilePaths },
      predictionId: predictionIdFor(repoId, intent, changedSymbolIds),
      reasons: buildReasons(intent, syn),
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };

    if (includeRisk) out.risk = syn.aggregateRisk;
    if (includeCoChangeGaps) out.missingCoChange = syn.missingCoChange;
    if (includeTests) {
      out.recommendedTests = syn.recommendedTests;
      out.coverageGaps = syn.coverageGaps;
    }
    if (includeArchitectureFlags) out.architecturalFlags = syn.architecturalFlags;
    out.signalQuality = syn.signalQuality;

    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  } finally {
    db.close();
  }
}
