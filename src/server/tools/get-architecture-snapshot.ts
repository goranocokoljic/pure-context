/**
 * get-architecture-snapshot.ts
 *
 * MCP tool: get_architecture_snapshot
 *
 * Freeze the current architecture state (dep graph topology + quality metrics)
 * into a named snapshot, and diff two snapshots to show what changed structurally
 * between commits or dates.
 *
 * Actions:
 *   'create' — compute current metrics, store as a snapshot row
 *   'list'   — return all snapshots for the repo, newest first
 *   'diff'   — compare two snapshot records and return deltas
 *   'delete' — remove a snapshot by ID
 *
 * Storage: `snapshots` table in SQLite — stores aggregated metrics as a JSON
 * blob plus the file list (for filesAdded/filesRemoved diffing).
 * No full graph copies are stored.
 */

import { z } from 'zod';
import { randomBytes } from 'crypto';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getCouplingMap } from '../../core/db/dep-store.js';
import { findImportCycles } from '../../graph/graph-traversal.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_architecture_snapshot';

export const description =
  'Freeze the current architecture state into a named snapshot, then diff two snapshots ' +
  'to measure structural change over time. ' +
  'action "create": compute fileCount, symbolCount, edgeCount, cycleCount, avgCoupling, ' +
  'avgComplexity and store them with an optional label. ' +
  'action "list": return all snapshots for the repo, newest first. ' +
  'action "diff": compare two snapshots and return deltas (cycleCountDelta < 0 means fewer cycles — good). ' +
  'action "delete": remove a snapshot by ID.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  action: z
    .enum(['create', 'list', 'diff', 'delete'])
    .describe('"create" | "list" | "diff" | "delete"'),
  snapshotId: z
    .string()
    .optional()
    .describe('Snapshot ID — required for diff (snapshotId = base) and delete'),
  compareId: z
    .string()
    .optional()
    .describe('The second snapshot ID to compare against — required for diff'),
  label: z
    .string()
    .optional()
    .describe('Human-readable label for the snapshot (e.g. "before-auth-refactor")'),
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface StoredMetrics {
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  cycleCount: number;
  avgCoupling: number;
  avgComplexity: number;
  files: string[];
}

interface SnapshotRecord {
  snapshotId: string;
  label: string;
  createdAt: string;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  cycleCount: number;
  avgCoupling: number;
  avgComplexity: number;
}

interface SnapshotDiff {
  filesAdded: string[];
  filesRemoved: string[];
  symbolsAdded: number;
  symbolsRemoved: number;
  edgesAdded: number;
  edgesRemoved: number;
  cycleCountDelta: number;
  avgCouplingDelta: number;
  avgComplexityDelta: number;
}

interface GetArchitectureSnapshotOutput {
  action: string;
  snapshot?: SnapshotRecord;
  snapshots?: SnapshotRecord[];
  diff?: SnapshotDiff;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

type Db = ReturnType<typeof openDatabase>;

function ensureSnapshotsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      snapshot_id  TEXT    NOT NULL,
      repo_id      TEXT    NOT NULL,
      label        TEXT    NOT NULL DEFAULT '',
      created_at   INTEGER NOT NULL,
      metrics      TEXT    NOT NULL,
      PRIMARY KEY (snapshot_id, repo_id),
      FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
    )
  `);
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_snapshots_repo ON snapshots(repo_id, created_at)');
  } catch {
    // already exists
  }
}

interface DbSnapshotRow {
  snapshot_id: string;
  repo_id: string;
  label: string;
  created_at: number;
  metrics: string;
}

function rowToRecord(row: DbSnapshotRow): SnapshotRecord {
  const m = JSON.parse(row.metrics) as StoredMetrics;
  return {
    snapshotId: row.snapshot_id,
    label: row.label,
    createdAt: new Date(row.created_at).toISOString(),
    fileCount: m.fileCount,
    symbolCount: m.symbolCount,
    edgeCount: m.edgeCount,
    cycleCount: m.cycleCount,
    avgCoupling: m.avgCoupling,
    avgComplexity: m.avgComplexity,
  };
}

// ─── Metrics computation ──────────────────────────────────────────────────────

function computeMetrics(db: Db, repoId: string): StoredMetrics {
  // File count
  const fileRow = db
    .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM files WHERE repo_id = ?')
    .get(repoId);
  const fileCount = fileRow?.n ?? 0;

  // Symbol count
  const symRow = db
    .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM symbols WHERE repo_id = ?')
    .get(repoId);
  const symbolCount = symRow?.n ?? 0;

  // Edge count
  const edgeRow = db
    .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM dep_edges WHERE repo_id = ?')
    .get(repoId);
  const edgeCount = edgeRow?.n ?? 0;

  // File paths list
  const filePaths = db
    .prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ? ORDER BY path')
    .all(repoId)
    .map((r) => r.path);

  // Cycle count — use DFS-based findImportCycles, cap at 500
  const cyclesResult = findImportCycles(repoId, db, undefined, 500);
  const cycleCount = cyclesResult.cycles.length;

  // Average coupling (efferent + afferent per file / 2 averaged across files)
  const couplingRows = getCouplingMap(db, repoId);
  let avgCoupling = 0;
  if (couplingRows.length > 0) {
    const totalCoupling = couplingRows.reduce(
      (sum, r) => sum + r.efferentCoupling + r.afferentCoupling,
      0,
    );
    avgCoupling = Math.round((totalCoupling / couplingRows.length) * 100) / 100;
  }

  // Average cyclomatic complexity from indexed symbols (skip NULLs)
  const complexityRow = db
    .prepare<[string], { avg: number | null }>(
      'SELECT AVG(cyclomatic_complexity) AS avg FROM symbols WHERE repo_id = ? AND cyclomatic_complexity IS NOT NULL',
    )
    .get(repoId);
  const avgComplexity =
    complexityRow?.avg != null
      ? Math.round(complexityRow.avg * 100) / 100
      : 0;

  return { fileCount, symbolCount, edgeCount, cycleCount, avgCoupling, avgComplexity, files: filePaths };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  action: 'create' | 'list' | 'diff' | 'delete';
  snapshotId?: string;
  compareId?: string;
  label?: string;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, action, snapshotId, compareId, label = '' } = args;

  const db = openDatabase(repoId);

  try {
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: `Repo "${repoId}" not found. Run index_folder first.` }),
          },
        ],
        isError: true,
      };
    }

    // Ensure the snapshots table exists (safe with IF NOT EXISTS)
    ensureSnapshotsTable(db);

    if (action === 'create') {
      const metrics = computeMetrics(db, repoId);
      const snapId = randomBytes(6).toString('hex'); // 12-char hex
      const now = Date.now();

      db.prepare<[string, string, string, number, string]>(`
        INSERT INTO snapshots (snapshot_id, repo_id, label, created_at, metrics)
        VALUES (?, ?, ?, ?, ?)
      `).run(snapId, repoId, label, now, JSON.stringify(metrics));

      const record: SnapshotRecord = {
        snapshotId: snapId,
        label,
        createdAt: new Date(now).toISOString(),
        fileCount: metrics.fileCount,
        symbolCount: metrics.symbolCount,
        edgeCount: metrics.edgeCount,
        cycleCount: metrics.cycleCount,
        avgCoupling: metrics.avgCoupling,
        avgComplexity: metrics.avgComplexity,
      };

      const output: GetArchitectureSnapshotOutput = {
        action: 'create',
        snapshot: record,
        _meta: buildMeta({ timingMs: Date.now() - t0 }),
      };

      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    }

    if (action === 'list') {
      const rows = db
        .prepare<[string], DbSnapshotRow>(
          'SELECT * FROM snapshots WHERE repo_id = ? ORDER BY created_at DESC',
        )
        .all(repoId);

      const output: GetArchitectureSnapshotOutput = {
        action: 'list',
        snapshots: rows.map(rowToRecord),
        _meta: buildMeta({ timingMs: Date.now() - t0 }),
      };

      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    }

    if (action === 'diff') {
      if (!snapshotId || !compareId) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'action "diff" requires both snapshotId (base) and compareId (compare).',
              }),
            },
          ],
          isError: true,
        };
      }

      const baseRow = db
        .prepare<[string, string], DbSnapshotRow>(
          'SELECT * FROM snapshots WHERE snapshot_id = ? AND repo_id = ?',
        )
        .get(snapshotId, repoId);

      const compareRow = db
        .prepare<[string, string], DbSnapshotRow>(
          'SELECT * FROM snapshots WHERE snapshot_id = ? AND repo_id = ?',
        )
        .get(compareId, repoId);

      if (!baseRow) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `Snapshot "${snapshotId}" not found.` }),
            },
          ],
          isError: true,
        };
      }
      if (!compareRow) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `Snapshot "${compareId}" not found.` }),
            },
          ],
          isError: true,
        };
      }

      const baseMetrics = JSON.parse(baseRow.metrics) as StoredMetrics;
      const compareMetrics = JSON.parse(compareRow.metrics) as StoredMetrics;

      const baseFiles = new Set(baseMetrics.files);
      const compareFiles = new Set(compareMetrics.files);

      const filesAdded = compareMetrics.files.filter((f) => !baseFiles.has(f));
      const filesRemoved = baseMetrics.files.filter((f) => !compareFiles.has(f));

      const diff: SnapshotDiff = {
        filesAdded,
        filesRemoved,
        symbolsAdded: Math.max(0, compareMetrics.symbolCount - baseMetrics.symbolCount),
        symbolsRemoved: Math.max(0, baseMetrics.symbolCount - compareMetrics.symbolCount),
        edgesAdded: Math.max(0, compareMetrics.edgeCount - baseMetrics.edgeCount),
        edgesRemoved: Math.max(0, baseMetrics.edgeCount - compareMetrics.edgeCount),
        cycleCountDelta: compareMetrics.cycleCount - baseMetrics.cycleCount,
        avgCouplingDelta:
          Math.round((compareMetrics.avgCoupling - baseMetrics.avgCoupling) * 100) / 100,
        avgComplexityDelta:
          Math.round((compareMetrics.avgComplexity - baseMetrics.avgComplexity) * 100) / 100,
      };

      const output: GetArchitectureSnapshotOutput = {
        action: 'diff',
        snapshot: rowToRecord(baseRow),
        diff,
        _meta: buildMeta({ timingMs: Date.now() - t0 }),
      };

      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    }

    if (action === 'delete') {
      if (!snapshotId) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'action "delete" requires snapshotId.' }),
            },
          ],
          isError: true,
        };
      }

      const result = db
        .prepare<[string, string]>(
          'DELETE FROM snapshots WHERE snapshot_id = ? AND repo_id = ?',
        )
        .run(snapshotId, repoId);

      if (result.changes === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `Snapshot "${snapshotId}" not found.` }),
            },
          ],
          isError: true,
        };
      }

      const output: GetArchitectureSnapshotOutput = {
        action: 'delete',
        _meta: buildMeta({ timingMs: Date.now() - t0 }),
      };

      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    }

    // Should never reach here (Zod enum validation prevents it)
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Unknown action: ${action as string}` }) }],
      isError: true,
    };
  } finally {
    db.close();
  }
}
