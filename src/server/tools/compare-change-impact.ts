/**
 * compare-change-impact.ts
 *
 * MCP tool: compare_change_impact (Phase 79, Group C)
 *
 * Architecture *regression* detection — the before/after delta, distinct from
 * analyze_diff's current-state `architecturalFlags`. Given a baseline snapshot
 * (created with get_architecture_snapshot BEFORE the change) and the current
 * live index (the "after"), it reports what the change INTRODUCED:
 *
 *   newCycles            — import cycles present now but not in the baseline
 *   newLayerViolations   — layer-boundary crossings introduced since the baseline
 *   resolvedCycles       — cycles the change removed (improvement)
 *   resolvedLayerViolations — violations the change removed (improvement)
 *   verdict: regressed | improved | unchanged | no_baseline
 *
 * It never claims a PRE-EXISTING cycle was "introduced" — that distinction
 * (flag vs regression) is the whole point. The "before" comes from a snapshot
 * (Task 473 decision: reuse get_architecture_snapshot, never checkout+reindex);
 * with no usable baseline it degrades to `no_baseline` + current-state flags.
 *
 * The compute helpers are exported so get_architecture_snapshot stores the exact
 * same cycle/violation representation it will later be diffed against.
 */

import { z } from 'zod';
import type Database from 'better-sqlite3';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getAllDepEdges } from '../../core/db/dep-store.js';
import { findImportCycles, findWorkspaceCycles } from '../../graph/graph-traversal.js';
import { openWorkspace, rootLabels, workspaceAdjacency, type Workspace } from '../../graph/workspace-graph.js';
import { assignLayer, detectLayerViolations, isAllowed } from './get-layer-violations.js';
import { getConfig } from '../../config/config-loader.js';
import { buildMeta } from './_meta.js';
import { gateCompareChangeImpact } from './gate-envelope.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'compare_change_impact';

export const description =
  'Architecture regression check: compare the current code against a baseline ' +
  'snapshot (created with get_architecture_snapshot BEFORE your change) and report ' +
  'what the change INTRODUCED — new import cycles (newCycles) and new layer-boundary ' +
  'violations (newLayerViolations) — plus cycles/violations it resolved. Distinct ' +
  'from analyze_diff architecturalFlags, which flag pre-existing issues; this reports ' +
  'only the delta and never blames the change for issues it did not create. Verdict: ' +
  'regressed / improved / unchanged / no_baseline. Workflow: snapshot before, edit, ' +
  'reindex, compare_change_impact. crossIndex:true (since 1.35.0) also diffs cycles and ' +
  'layer violations that cross into LINKED indexes — only against a baseline snapshot ' +
  'taken with crossIndex:true and the SAME link set (`crossBaseline`: compared | no_baseline; ' +
  'a link-set change never reads as a regression).';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  baselineSnapshotId: z
    .string()
    .optional()
    .describe(
      'Snapshot ID to use as the "before" state (from get_architecture_snapshot ' +
      'action:create). If omitted, the most recent snapshot is used.',
    ),
  crossIndex: z
    .boolean()
    .optional()
    .describe(
      'Also diff cross-index cycles / layer violations (default false). Needs a baseline ' +
      'created with crossIndex:true against the same links; otherwise crossBaseline = no_baseline.',
    ),
};

// ─── Shared representation (also used by get_architecture_snapshot storage) ────

export interface StoredCycle {
  /** Cycle member files, in graph order. */
  files: string[];
}

export interface StoredLayerViolation {
  from: string;
  to: string;
  fromFile: string;
  toFile: string;
  /** Phase 102: the linked index the target lives in (cross violations only). */
  toRepoId?: string;
}

const MAX_CYCLES = 200;
const MAX_VIOLATIONS = 500;

/** Canonical key for a cycle — its member set, order/rotation independent. */
function cycleKey(files: string[]): string {
  return [...new Set(files.map((f) => f.replace(/\\/g, '/')))].sort().join('|');
}

function violationKey(v: StoredLayerViolation): string {
  return `${v.from}\u0000${v.to}\u0000${v.fromFile}\u0000${v.toFile}`;
}

/** Sorted linked repo ids — the identity of the link set a cross snapshot was taken against. */
export function linkSetOf(ws: Workspace): string[] {
  return ws.links.map((m) => m.repoId).sort();
}

/**
 * Phase 102: cycles with at least one member in a LINKED index, over the
 * union graph (local-only cycles stay in `computeCurrentCycles`, so the two
 * sets never double count). Members are named `<repoId>:<path>` when linked.
 */
export function computeCurrentCrossCycles(ws: Workspace): StoredCycle[] {
  if (ws.links.length === 0) return [];
  return findWorkspaceCycles(ws, undefined, MAX_CYCLES)
    .cycles.filter((c) => c.crossIndex)
    .map((c) => ({ files: c.files }));
}

/**
 * Phase 102: this root's layer violations whose TARGET is in a linked index
 * (`toFile` = `<rootName>:<path>`), under this root's rules (P3).
 */
export function computeCurrentCrossLayerViolations(ws: Workspace): StoredLayerViolation[] {
  const layers = getConfig().layers;
  if (!layers || ws.links.length === 0) return [];
  const labels = rootLabels(ws);
  const { edges } = workspaceAdjacency(ws, { scope: 'local-source', excludeEdgeTypes: [], skipSelfLoops: false });
  const cross = edges
    .filter((e) => e.target.repoId !== ws.local.repoId)
    .map((e) => ({ sourceFile: e.source.path, targetFile: e.target.path, specifier: e.specifier, targetRepoId: e.target.repoId }));
  const out: StoredLayerViolation[] = [];
  const seen = new Set<string>();
  for (const v of detectLayerViolations(cross, layers.definitions, layers.rules, labels)) {
    const sv: StoredLayerViolation = {
      from: v.from_layer,
      to: v.to_layer,
      fromFile: v.from_file.replace(/\\/g, '/'),
      toFile: v.to_file.replace(/\\/g, '/'),
      toRepoId: v.to_repo_id,
    };
    const k = violationKey(sv);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(sv);
    if (out.length >= MAX_VIOLATIONS) break;
  }
  return out;
}

/**
 * Current import cycles as stored cycles (capped). Same representation the
 * snapshot persists, so before/after sets are directly comparable.
 */
export function computeCurrentCycles(db: Database.Database, repoId: string): StoredCycle[] {
  const result = findImportCycles(repoId, db, undefined, MAX_CYCLES);
  return result.cycles.map((c) => ({ files: c.files }));
}

/**
 * Current layer-boundary violations (capped). Empty when no layer config exists
 * (the dimension is simply not evaluated, not "no violations").
 */
export function computeCurrentLayerViolations(
  db: Database.Database,
  repoId: string,
): StoredLayerViolation[] {
  const layers = getConfig().layers;
  if (!layers) return [];
  const { definitions, rules } = layers;
  const out: StoredLayerViolation[] = [];
  const seen = new Set<string>();
  for (const edge of getAllDepEdges(db, repoId)) {
    const from = assignLayer(edge.sourceFile, definitions);
    const to = assignLayer(edge.targetFile, definitions);
    if (from === 'unclassified' || to === 'unclassified' || from === to) continue;
    if (isAllowed(from, to, rules)) continue;
    const v: StoredLayerViolation = {
      from,
      to,
      fromFile: edge.sourceFile.replace(/\\/g, '/'),
      toFile: edge.targetFile.replace(/\\/g, '/'),
    };
    const k = violationKey(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= MAX_VIOLATIONS) break;
  }
  return out;
}

/** Whether a snapshot's metrics blob carries the data this tool needs to diff. */
function hasBaselineGraph(m: Record<string, unknown>): boolean {
  return Array.isArray(m['cycles']) && Array.isArray(m['layerViolations']);
}

/** Phase 102: the cross part is comparable only against the SAME link set (R3). */
function hasCrossBaseline(m: Record<string, unknown>, linkSet: string[]): boolean {
  const stored = m['linkSet'];
  if (!Array.isArray(stored) || !Array.isArray(m['crossCycles']) || !Array.isArray(m['crossLayerViolations'])) return false;
  const a = (stored as unknown[]).filter((x): x is string => typeof x === 'string').sort();
  return a.length === linkSet.length && a.every((x, i) => x === linkSet[i]);
}

// ─── Output ────────────────────────────────────────────────────────────────────

interface CompareChangeImpactOutput {
  verdict: 'regressed' | 'improved' | 'unchanged' | 'no_baseline';
  baselineSnapshotId?: string;
  newCycles: string[][];
  resolvedCycles: string[][];
  newLayerViolations: StoredLayerViolation[];
  resolvedLayerViolations: StoredLayerViolation[];
  currentCycleCount: number;
  currentLayerViolationCount: number;
  reasons: string[];
  /** Phase 102 — present only when `crossIndex: true` was requested. */
  crossIndex?: boolean;
  links?: Array<{ repoId: string; rootPath: string }>;
  crossBaseline?: 'compared' | 'no_baseline';
  newCrossCycles?: string[][];
  resolvedCrossCycles?: string[][];
  newCrossLayerViolations?: StoredLayerViolation[];
  resolvedCrossLayerViolations?: StoredLayerViolation[];
  currentCrossCycleCount?: number;
  currentCrossLayerViolationCount?: number;
  _meta: ReturnType<typeof buildMeta>;
}

interface SnapshotRow {
  snapshot_id: string;
  metrics: string;
}

/** Attach the normalized gate envelope (Task 486) and serialize. */
function emit(out: CompareChangeImpactOutput): CallToolResult {
  const env = gateCompareChangeImpact({
    verdict: out.verdict,
    newCycles: [...out.newCycles, ...(out.newCrossCycles ?? [])],
    newLayerViolations: [...out.newLayerViolations, ...(out.newCrossLayerViolations ?? [])],
  });
  return { content: [{ type: 'text', text: JSON.stringify({ ...out, ...env }, null, 2) }] };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export function handler(args: { repoId: string; baselineSnapshotId?: string; crossIndex?: boolean }): CallToolResult {
  const t0 = Date.now();
  const { repoId, baselineSnapshotId, crossIndex = false } = args;

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

    const currentCycles = computeCurrentCycles(db, repoId);
    const currentViolations = computeCurrentLayerViolations(db, repoId);

    // Phase 102: the cross part, computed now so the workspace handles close early.
    let cross: {
      links: Array<{ repoId: string; rootPath: string }>;
      linkSet: string[];
      cycles: StoredCycle[];
      violations: StoredLayerViolation[];
    } | null = null;
    if (crossIndex) {
      const ws = openWorkspace(db, repoId, repo.rootPath);
      try {
        cross = {
          links: ws.links.map((m) => ({ repoId: m.repoId, rootPath: m.rootPath })),
          linkSet: linkSetOf(ws),
          cycles: computeCurrentCrossCycles(ws),
          violations: computeCurrentCrossLayerViolations(ws),
        };
      } finally {
        ws.close();
      }
    }
    const crossCurrent = (): Partial<CompareChangeImpactOutput> =>
      cross
        ? {
            crossIndex: true,
            links: cross.links,
            currentCrossCycleCount: cross.cycles.length,
            currentCrossLayerViolationCount: cross.violations.length,
          }
        : {};

    // ── Load baseline snapshot ────────────────────────────────────────────────
    let baselineRow: SnapshotRow | undefined;
    try {
      if (baselineSnapshotId) {
        baselineRow = db
          .prepare<[string, string], SnapshotRow>(
            'SELECT snapshot_id, metrics FROM snapshots WHERE snapshot_id = ? AND repo_id = ?',
          )
          .get(baselineSnapshotId, repoId);
      } else {
        baselineRow = db
          .prepare<[string], SnapshotRow>(
            'SELECT snapshot_id, metrics FROM snapshots WHERE repo_id = ? ORDER BY created_at DESC LIMIT 1',
          )
          .get(repoId);
      }
    } catch {
      // snapshots table may not exist yet → treated as no baseline below.
      baselineRow = undefined;
    }

    const degrade = (note: string): CallToolResult => {
      const out: CompareChangeImpactOutput = {
        verdict: 'no_baseline',
        newCycles: [],
        resolvedCycles: [],
        newLayerViolations: [],
        resolvedLayerViolations: [],
        currentCycleCount: currentCycles.length,
        currentLayerViolationCount: currentViolations.length,
        reasons: [
          note,
          `Current state (flags, NOT regressions): ${currentCycles.length} import cycle(s), ` +
          `${currentViolations.length} layer violation(s). Create a baseline with ` +
          'get_architecture_snapshot (action:create) before the change, then re-run.',
        ],
        ...crossCurrent(),
        ...(cross ? { crossBaseline: 'no_baseline' as const } : {}),
        _meta: buildMeta({ timingMs: Date.now() - t0 }),
      };
      return emit(out);
    };

    if (baselineSnapshotId && !baselineRow) {
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: `Snapshot "${baselineSnapshotId}" not found.` }) },
        ],
        isError: true,
      };
    }
    if (!baselineRow) return degrade('No baseline snapshot exists for this repo.');

    const metrics = JSON.parse(baselineRow.metrics) as Record<string, unknown>;
    if (!hasBaselineGraph(metrics)) {
      return degrade(
        `Snapshot "${baselineRow.snapshot_id}" predates Phase 79 and has no stored cycle/layer data.`,
      );
    }

    const baselineCycles = metrics['cycles'] as StoredCycle[];
    const baselineViolations = metrics['layerViolations'] as StoredLayerViolation[];

    // ── Cycle delta ───────────────────────────────────────────────────────────
    const baseCycleKeys = new Set(baselineCycles.map((c) => cycleKey(c.files)));
    const currCycleKeys = new Set(currentCycles.map((c) => cycleKey(c.files)));
    const newCycles = currentCycles.filter((c) => !baseCycleKeys.has(cycleKey(c.files))).map((c) => c.files);
    const resolvedCycles = baselineCycles.filter((c) => !currCycleKeys.has(cycleKey(c.files))).map((c) => c.files);

    // ── Layer-violation delta ─────────────────────────────────────────────────
    const baseVKeys = new Set(baselineViolations.map(violationKey));
    const currVKeys = new Set(currentViolations.map(violationKey));
    const newLayerViolations = currentViolations.filter((v) => !baseVKeys.has(violationKey(v)));
    const resolvedLayerViolations = baselineViolations.filter((v) => !currVKeys.has(violationKey(v)));

    // ── Cross-index delta (Phase 102) — same link set only, else no_baseline ──
    let crossFields: Partial<CompareChangeImpactOutput> = {};
    let crossRegressed = false;
    let crossImproved = false;
    const crossReasons: string[] = [];
    if (cross) {
      if (hasCrossBaseline(metrics, cross.linkSet)) {
        const baseC = metrics['crossCycles'] as StoredCycle[];
        const baseV = metrics['crossLayerViolations'] as StoredLayerViolation[];
        const baseCK = new Set(baseC.map((c) => cycleKey(c.files)));
        const currCK = new Set(cross.cycles.map((c) => cycleKey(c.files)));
        const newCrossCycles = cross.cycles.filter((c) => !baseCK.has(cycleKey(c.files))).map((c) => c.files);
        const resolvedCrossCycles = baseC.filter((c) => !currCK.has(cycleKey(c.files))).map((c) => c.files);
        const baseVK = new Set(baseV.map(violationKey));
        const currVK = new Set(cross.violations.map(violationKey));
        const newCrossLayerViolations = cross.violations.filter((v) => !baseVK.has(violationKey(v)));
        const resolvedCrossLayerViolations = baseV.filter((v) => !currVK.has(violationKey(v)));
        crossRegressed = newCrossCycles.length > 0 || newCrossLayerViolations.length > 0;
        crossImproved = resolvedCrossCycles.length > 0 || resolvedCrossLayerViolations.length > 0;
        if (newCrossCycles.length > 0) {
          crossReasons.push(`Introduced ${newCrossCycles.length} new cross-index cycle(s): ${newCrossCycles.slice(0, 2).map((c) => c.join(' → ')).join('; ')}.`);
        }
        if (newCrossLayerViolations.length > 0) {
          crossReasons.push(`Introduced ${newCrossLayerViolations.length} new cross-index layer violation(s): ${newCrossLayerViolations.slice(0, 2).map((v) => `${v.from}→${v.to}`).join(', ')}.`);
        }
        if (resolvedCrossCycles.length > 0) crossReasons.push(`Resolved ${resolvedCrossCycles.length} cross-index cycle(s).`);
        if (resolvedCrossLayerViolations.length > 0) crossReasons.push(`Resolved ${resolvedCrossLayerViolations.length} cross-index layer violation(s).`);
        crossFields = {
          ...crossCurrent(),
          crossBaseline: 'compared',
          newCrossCycles,
          resolvedCrossCycles,
          newCrossLayerViolations,
          resolvedCrossLayerViolations,
        };
      } else {
        crossReasons.push(
          `Cross-index part not compared: snapshot "${baselineRow.snapshot_id}" was not taken with ` +
            'crossIndex:true against the same link set (create a new baseline with crossIndex:true). ' +
            `Current cross state (flags, NOT regressions): ${cross.cycles.length} cycle(s), ${cross.violations.length} layer violation(s).`,
        );
        crossFields = { ...crossCurrent(), crossBaseline: 'no_baseline' };
      }
    }

    // ── Verdict + reasons ─────────────────────────────────────────────────────
    const regressed = newCycles.length > 0 || newLayerViolations.length > 0 || crossRegressed;
    const improved = resolvedCycles.length > 0 || resolvedLayerViolations.length > 0 || crossImproved;
    const verdict: CompareChangeImpactOutput['verdict'] = regressed
      ? 'regressed'
      : improved
        ? 'improved'
        : 'unchanged';

    const reasons: string[] = [];
    if (newCycles.length > 0) {
      reasons.push(
        `Introduced ${newCycles.length} new import cycle(s): ` +
        `${newCycles.slice(0, 2).map((c) => c.join(' → ')).join('; ')}.`,
      );
    }
    if (newLayerViolations.length > 0) {
      reasons.push(
        `Introduced ${newLayerViolations.length} new layer violation(s): ` +
        `${newLayerViolations.slice(0, 2).map((v) => `${v.from}→${v.to}`).join(', ')}.`,
      );
    }
    if (resolvedCycles.length > 0) reasons.push(`Resolved ${resolvedCycles.length} pre-existing cycle(s).`);
    if (resolvedLayerViolations.length > 0) {
      reasons.push(`Resolved ${resolvedLayerViolations.length} pre-existing layer violation(s).`);
    }
    reasons.push(...crossReasons);
    if (reasons.length === 0) {
      reasons.push('No architectural cycles or layer violations introduced or resolved by this change.');
    }

    const out: CompareChangeImpactOutput = {
      verdict,
      baselineSnapshotId: baselineRow.snapshot_id,
      newCycles,
      resolvedCycles,
      newLayerViolations,
      resolvedLayerViolations,
      currentCycleCount: currentCycles.length,
      currentLayerViolationCount: currentViolations.length,
      reasons,
      ...crossFields,
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };
    return emit(out);
  } finally {
    db.close();
  }
}
