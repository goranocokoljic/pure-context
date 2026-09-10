/**
 * Index garbage collection (Phase 100, Task 622).
 *
 * What accumulates in `<dataDir>`:
 * - `indexes/<id>.db` files with NO `repos` row — crashed or half-deleted
 *   runs (three such husks held 942 MB on the reporter machine);
 * - indexes whose `root_path` no longer exists — removed worktrees, deleted
 *   checkouts (only `.claude/worktrees/*` were ever cleaned automatically);
 * - blobs in `blobs.db` that no index references any more (mark-and-sweep;
 *   there are no refcounts on the write path by design — P2).
 *
 * Rules (P4):
 * - dry-run by default; `apply` deletes exactly what the plan listed;
 * - an index with an active job marker is never a candidate;
 * - an index that cannot be opened is REPORTED, never deleted (it may be
 *   mid-write by another process);
 * - the blob sweep re-marks under a write lock on `blobs.db`, and skips
 *   blobs younger than `storage.gcGraceMs` — an indexer writes the blob
 *   BEFORE the `files` row that references it (R3).
 */
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { logger } from './logger.js';
import { getConfig } from '../config/config-loader.js';
import { getIndexDir, getJobsDir, getRepo, openDatabase } from './db/schema.js';
import { openBlobStore, getBlobDbPath, blobFileBytes, type BlobStore } from './db/blob-store.js';
import { isJobInProgress } from './git-head.js';

export type OrphanReason = 'no_repo_row' | 'root_missing';
export type SkipReason = 'in_progress' | 'unreadable' | 'live' | 'out_of_scope';

export interface GcIndexCandidate {
  repoId: string;
  file: string;
  bytes: number;
  reason: OrphanReason;
  rootPath: string | null;
}

export interface GcIndexSkipped {
  repoId: string;
  file: string;
  bytes: number;
  reason: SkipReason;
  rootPath: string | null;
}

export interface GcBlobPlan {
  path: string;
  /** Rows in the store. */
  total: number;
  totalBytes: number;
  /** Hashes referenced by at least one index that survives this plan. */
  referenced: number;
  /** Unreferenced and older than the grace window — the sweep set. */
  unreferenced: number;
  unreferencedBytes: number;
  /** Unreferenced but too young to sweep (an indexer may be mid-write). */
  tooYoung: number;
  /** The sweep set (re-computed under lock at apply time). */
  hashes: string[];
}

export interface GcPlan {
  indexDir: string;
  candidates: GcIndexCandidate[];
  skipped: GcIndexSkipped[];
  /** Indexes that stay (live root, no marker). */
  liveIndexes: number;
  liveIndexBytes: number;
  blobs: GcBlobPlan | null;
  /** Bytes the plan would free (index files + blob rows; the VACUUM decides the on-disk figure). */
  reclaimableBytes: number;
}

export interface GcOptions {
  indexDir?: string;
  jobsDir?: string;
  /** Also plan / sweep unreferenced blobs. Default false. */
  blobs?: boolean;
  /** Only consider the index whose stored root is this path (WorktreeRemove hook). */
  scopeRoot?: string;
  /** Blobs younger than this are never swept. Default: config `storage.gcGraceMs`. */
  graceMs?: number;
  now?: number;
}

export interface GcResult {
  plan: GcPlan;
  deletedIndexes: GcIndexCandidate[];
  failedIndexes: Array<GcIndexCandidate & { error: string }>;
  blobsDeleted: number;
  blobBytesFreed: number;
  /** `blobs.db` size before / after the sweep + VACUUM. */
  blobFileBytesBefore: number;
  blobFileBytesAfter: number;
}

const DEFAULT_GRACE_MS = 15 * 60 * 1000;

function fileBytes(dbPath: string): number {
  let n = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      n += statSync(dbPath + suffix).size;
    } catch {
      /* absent */
    }
  }
  return n;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

interface IndexScan {
  candidates: GcIndexCandidate[];
  skipped: GcIndexSkipped[];
  /** repoIds whose rows must stay — their hashes are the blob mark set. */
  survivors: Array<{ repoId: string; file: string; bytes: number }>;
}

/** Classify every `.db` in the index dir. */
function scanIndexes(indexDir: string, jobsDir: string, scopeRoot?: string): IndexScan {
  const out: IndexScan = { candidates: [], skipped: [], survivors: [] };
  if (!existsSync(indexDir)) return out;
  for (const entry of readdirSync(indexDir).sort()) {
    if (!entry.endsWith('.db')) continue;
    const repoId = entry.slice(0, -3);
    const file = join(indexDir, entry);
    const bytes = fileBytes(file);
    let rootPath: string | null = null;
    let hasRow = false;
    try {
      const db = openDatabase(repoId, indexDir);
      try {
        const meta = getRepo(db, repoId);
        hasRow = meta !== null;
        rootPath = meta?.rootPath ?? null;
      } finally {
        db.close();
      }
    } catch (err) {
      logger.debug(`index gc: cannot open ${file}: ${String(err)}`);
      out.skipped.push({ repoId, file, bytes, reason: 'unreadable', rootPath: null });
      continue;
    }
    if (scopeRoot && (!rootPath || !samePath(rootPath, scopeRoot))) {
      out.skipped.push({ repoId, file, bytes, reason: 'out_of_scope', rootPath });
      out.survivors.push({ repoId, file, bytes });
      continue;
    }
    if (isJobInProgress(jobsDir, repoId)) {
      out.skipped.push({ repoId, file, bytes, reason: 'in_progress', rootPath });
      out.survivors.push({ repoId, file, bytes });
      continue;
    }
    if (!hasRow) {
      out.candidates.push({ repoId, file, bytes, reason: 'no_repo_row', rootPath: null });
      continue;
    }
    if (rootPath && !existsSync(rootPath)) {
      out.candidates.push({ repoId, file, bytes, reason: 'root_missing', rootPath });
      continue;
    }
    out.skipped.push({ repoId, file, bytes, reason: 'live', rootPath });
    out.survivors.push({ repoId, file, bytes });
  }
  return out;
}

/** Union of `files.content_hash` over the surviving indexes — the mark set. */
function markReferencedHashes(indexDir: string, survivors: IndexScan['survivors']): Set<string> {
  const marked = new Set<string>();
  for (const s of survivors) {
    try {
      const db = openDatabase(s.repoId, indexDir);
      try {
        const rows = db
          .prepare<[string], { content_hash: string }>('SELECT DISTINCT content_hash FROM files WHERE repo_id = ?')
          .all(s.repoId);
        for (const r of rows) marked.add(r.content_hash);
      } finally {
        db.close();
      }
    } catch (err) {
      // A survivor we cannot read must still protect its blobs: abort the
      // sweep rather than guess (never delete on incomplete evidence).
      throw new Error(`index gc: cannot read ${s.file} to mark its blobs: ${String(err)}`);
    }
  }
  return marked;
}

function planBlobs(
  store: BlobStore,
  marked: Set<string>,
  graceMs: number,
  now: number,
): GcBlobPlan {
  const all = store.list();
  const plan: GcBlobPlan = {
    path: store.path,
    total: all.length,
    totalBytes: 0,
    referenced: 0,
    unreferenced: 0,
    unreferencedBytes: 0,
    tooYoung: 0,
    hashes: [],
  };
  for (const b of all) {
    plan.totalBytes += b.size;
    if (marked.has(b.hash)) {
      plan.referenced++;
    } else if (now - b.createdAt < graceMs) {
      plan.tooYoung++;
    } else {
      plan.unreferenced++;
      plan.unreferencedBytes += b.size;
      plan.hashes.push(b.hash);
    }
  }
  return plan;
}

function resolveGrace(options: GcOptions): number {
  if (options.graceMs !== undefined) return options.graceMs;
  try {
    return getConfig().storage?.gcGraceMs ?? DEFAULT_GRACE_MS;
  } catch {
    return DEFAULT_GRACE_MS;
  }
}

/** Dry run: what `applyGc` would delete. Never writes. */
export function planGc(options: GcOptions = {}): GcPlan {
  const indexDir = options.indexDir ?? getIndexDir();
  const jobsDir = options.jobsDir ?? getJobsDir();
  const now = options.now ?? Date.now();
  const scan = scanIndexes(indexDir, jobsDir, options.scopeRoot);
  const plan: GcPlan = {
    indexDir,
    candidates: scan.candidates,
    skipped: scan.skipped,
    liveIndexes: scan.survivors.length,
    liveIndexBytes: scan.survivors.reduce((n, s) => n + s.bytes, 0),
    blobs: null,
    reclaimableBytes: scan.candidates.reduce((n, c) => n + c.bytes, 0),
  };
  if (options.blobs) {
    const store = openBlobStore({ createIfMissing: false });
    if (store) {
      const marked = markReferencedHashes(indexDir, scan.survivors);
      plan.blobs = planBlobs(store, marked, resolveGrace(options), now);
      plan.reclaimableBytes += plan.blobs.unreferencedBytes;
    }
  }
  return plan;
}

/**
 * Delete what `planGc` listed. Index candidates are unlinked (db + wal +
 * shm); blobs are re-marked under a write lock and swept in one
 * transaction, then the store is VACUUMed.
 */
export function applyGc(options: GcOptions = {}): GcResult {
  const plan = planGc(options);
  const result: GcResult = {
    plan,
    deletedIndexes: [],
    failedIndexes: [],
    blobsDeleted: 0,
    blobBytesFreed: 0,
    blobFileBytesBefore: blobFileBytes(getBlobDbPath()),
    blobFileBytesAfter: 0,
  };

  for (const c of plan.candidates) {
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          unlinkSync(c.file + suffix);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      result.deletedIndexes.push(c);
      logger.info(`index gc: deleted ${c.file} (${c.reason}, ${(c.bytes / 1_048_576).toFixed(1)} MB)`);
    } catch (err) {
      result.failedIndexes.push({ ...c, error: String(err) });
      logger.warn(`index gc: could not delete ${c.file}: ${String(err)}`);
    }
  }

  if (options.blobs && plan.blobs) {
    const store = openBlobStore({ createIfMissing: false });
    if (store) {
      const swept = sweepBlobs(store, options, result.deletedIndexes);
      result.blobsDeleted = swept.count;
      result.blobBytesFreed = swept.bytes;
      if (swept.count > 0) store.vacuum();
    }
  }
  result.blobFileBytesAfter = blobFileBytes(getBlobDbPath());
  return result;
}

/**
 * Sweep under `BEGIN IMMEDIATE`: the write lock keeps any concurrent
 * indexer's `putMany` waiting (busy timeout) while we re-mark against the
 * indexes as they are NOW, so a blob written since the plan is either
 * marked or inside the grace window.
 */
function sweepBlobs(
  store: BlobStore,
  options: GcOptions,
  deleted: GcIndexCandidate[],
): { count: number; bytes: number } {
  const indexDir = options.indexDir ?? getIndexDir();
  const jobsDir = options.jobsDir ?? getJobsDir();
  const db: Database.Database = store.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    const scan = scanIndexes(indexDir, jobsDir);
    const deletedIds = new Set(deleted.map((d) => d.repoId));
    // Everything still on disk that is not one of the candidates we deleted
    // protects its hashes — including candidates that failed to delete.
    const survivors = [
      ...scan.survivors,
      ...scan.candidates.filter((c) => !deletedIds.has(c.repoId)),
    ];
    const marked = markReferencedHashes(indexDir, survivors);
    const plan = planBlobs(store, marked, resolveGrace(options), options.now ?? Date.now());
    let count = 0;
    for (let i = 0; i < plan.hashes.length; i += 400) {
      const chunk = plan.hashes.slice(i, i + 400);
      count += db
        .prepare(`DELETE FROM blobs WHERE hash IN (${chunk.map(() => '?').join(',')})`)
        .run(...chunk).changes;
    }
    db.exec('COMMIT');
    if (count > 0) logger.info(`index gc: swept ${count} unreferenced blobs (${(plan.unreferencedBytes / 1_048_576).toFixed(1)} MB)`);
    return { count, bytes: plan.unreferencedBytes };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* not in a transaction */
    }
    throw err;
  }
}

// ─── Formatting (CLI + MCP share one text shape) ──────────────────────────────

export function formatBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function formatGcPlan(plan: GcPlan, opts: { blobsRequested: boolean }): string[] {
  const lines: string[] = [];
  lines.push(`Index dir: ${plan.indexDir}`);
  lines.push(`Live indexes: ${plan.liveIndexes} (${formatBytes(plan.liveIndexBytes)})`);
  if (plan.candidates.length === 0) {
    lines.push('Orphan indexes: none');
  } else {
    lines.push(`Orphan indexes: ${plan.candidates.length}`);
    for (const c of plan.candidates) {
      const why = c.reason === 'no_repo_row' ? 'no repo row (crashed / half-deleted run)' : `root missing: ${c.rootPath}`;
      lines.push(`  - ${c.file}  ${formatBytes(c.bytes)}  ${why}`);
    }
  }
  const inProgress = plan.skipped.filter((s) => s.reason === 'in_progress');
  const unreadable = plan.skipped.filter((s) => s.reason === 'unreadable');
  for (const s of inProgress) lines.push(`  ~ ${s.file}  re-index in progress — skipped`);
  for (const s of unreadable) lines.push(`  ? ${s.file}  ${formatBytes(s.bytes)}  cannot be opened — left alone (delete by hand if it is junk)`);
  if (opts.blobsRequested) {
    if (!plan.blobs) {
      lines.push('Blob store: none (no index has written to it yet)');
    } else {
      const b = plan.blobs;
      lines.push(
        `Blob store: ${b.path}  ${b.total} blobs / ${formatBytes(b.totalBytes)}  ` +
          `referenced ${b.referenced}, unreferenced ${b.unreferenced} (${formatBytes(b.unreferencedBytes)})` +
          (b.tooYoung > 0 ? `, ${b.tooYoung} too young to sweep` : ''),
      );
    }
  }
  lines.push(`Reclaimable: ${formatBytes(plan.reclaimableBytes)}`);
  return lines;
}
