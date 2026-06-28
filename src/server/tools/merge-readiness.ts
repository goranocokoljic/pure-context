/**
 * merge-readiness.ts (Phase 80, Task 487)
 *
 * One go/no-go a harness calls right before its own git-merge step. It is a THIN
 * consumer that folds the existing closed-loop signals into a single gate:
 *
 *   verify_change          → is the change COMPLETE relative to the prediction?
 *                            (unaddressed co-change + coverage gaps on the diff)
 *   compare_change_impact  → did it introduce an architecture REGRESSION?
 *
 * It runs no new analysis — coverage gaps come from verify_change (diff-scoped),
 * architecture regression from compare_change_impact (snapshot delta). The
 * overall gate is the most severe of the two (block > warn > pass), and a
 * consolidated `unresolved[]` lists exactly what stands between the diff and a
 * clean merge. Read-only / judgment, not actuation — the harness owns the merge.
 */

import { z } from 'zod';
import { handler as verifyChangeHandler } from './verify-change.js';
import { handler as compareChangeImpactHandler } from './compare-change-impact.js';
import { worstGate, type Gate } from './gate-envelope.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'merge_readiness';

export const description =
  'Pre-merge go/no-go for a completed change. Folds verify_change (is the change ' +
  'complete vs the prepare_change prediction — unaddressed co-change + diff coverage ' +
  'gaps) and compare_change_impact (did it introduce a new import cycle or layer ' +
  'violation vs a baseline snapshot) into one { gate: pass|warn|block, reasons[], ' +
  'unresolved[] }. The gate is the most severe of the two. Read-only — it never ' +
  'merges; call it before your own git-merge step. Thin consumer: no new analysis.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  diff: z.string().describe('Unified diff of the completed change (output of `git diff`)'),
  predictedFilePaths: z
    .array(z.string())
    .optional()
    .describe('predictedChange.changedFilePaths from prepare_change (default [] — verify runs unscoped).'),
  predictedCoChange: z
    .array(z.string())
    .optional()
    .describe('missingCoChange[].filePath from prepare_change (the partners you were advised to consider).'),
  baselineSnapshotId: z
    .string()
    .optional()
    .describe('Snapshot ID from get_architecture_snapshot taken BEFORE the change (for regression check).'),
};

interface VerifyShape {
  verdict: 'complete' | 'incomplete' | 'scope_expanded';
  gate: Gate;
  gateReasons: string[];
  unaddressedCoChange: string[];
  coverageGapsRemaining: { symbolId: string; name: string }[];
}

interface CompareShape {
  verdict: 'regressed' | 'improved' | 'unchanged' | 'no_baseline';
  gate: Gate;
  gateReasons: string[];
  newCycles: string[][];
  newLayerViolations: { from: string; to: string }[];
}

function parse<T>(result: CallToolResult): T | null {
  if (result.isError) return null;
  const text = (result.content[0] as { text?: string }).text;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function handler(args: {
  repoId: string;
  diff: string;
  predictedFilePaths?: string[];
  predictedCoChange?: string[];
  baselineSnapshotId?: string;
}): Promise<CallToolResult> {
  const t0 = Date.now();

  // ── verify_change (completeness) ─────────────────────────────────────────
  const verifyRes = await verifyChangeHandler({
    repoId: args.repoId,
    diff: args.diff,
    predictedFilePaths: args.predictedFilePaths ?? [],
    predictedCoChange: args.predictedCoChange,
  });
  const verify = parse<VerifyShape>(verifyRes);

  // ── compare_change_impact (architecture regression) ──────────────────────
  const compareRes = compareChangeImpactHandler({
    repoId: args.repoId,
    baselineSnapshotId: args.baselineSnapshotId,
  });
  const compare = parse<CompareShape>(compareRes);

  // ── Compose ──────────────────────────────────────────────────────────────
  const gates: Gate[] = [];
  const reasons: string[] = [];
  const unresolved: string[] = [];

  if (verify) {
    gates.push(verify.gate);
    reasons.push(...verify.gateReasons);
    for (const f of verify.unaddressedCoChange) unresolved.push(`unaddressed co-change: ${f}`);
    for (const c of verify.coverageGapsRemaining) unresolved.push(`untested changed symbol: ${c.name}`);
  } else {
    gates.push('warn');
    reasons.push('verify_change could not be evaluated (check the diff / prediction inputs).');
  }

  if (compare) {
    gates.push(compare.gate);
    reasons.push(...compare.gateReasons);
    for (const cyc of compare.newCycles) unresolved.push(`new import cycle: ${cyc.join(' → ')}`);
    for (const v of compare.newLayerViolations) unresolved.push(`new layer violation: ${v.from} → ${v.to}`);
  }

  const gate = worstGate(gates);
  const nextAction =
    gate === 'block' ? 'resolve_unresolved_then_remerge' : gate === 'warn' ? 'review_then_merge' : 'merge';

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            repoId: args.repoId,
            gate,
            reasons,
            unresolved,
            nextAction,
            verify: verify ? { verdict: verify.verdict, gate: verify.gate } : null,
            architecture: compare ? { verdict: compare.verdict, gate: compare.gate } : null,
            _meta: buildMeta({ timingMs: Date.now() - t0 }),
          },
          null,
          2,
        ),
      },
    ],
  };
}
