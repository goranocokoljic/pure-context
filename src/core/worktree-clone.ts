/**
 * Worktree index cloning (Phase 97, Task 602).
 *
 * A new git worktree of an already-indexed repository is 95%+ identical to a
 * sibling worktree's tree, yet every worktree used to pay a FULL parse (4–12
 * minutes and gigabytes on the reporter's 26k-file tree). Here a new
 * worktree's index is seeded by copying a sibling's `.db` and rewriting the
 * repo id; the caller then applies the delta (`reindexChanged` since the
 * sibling's stored sha, or an incremental `indexFolder` whose hash cache now
 * skips everything unchanged).
 *
 * Symbol ids are `hash(filePath:name:kind)` over REPO-RELATIVE paths, so they
 * survive the copy unchanged — only `repo_id` (and `repos.root_path`) differ.
 *
 * Safety rules (risk register R3/R4):
 * - the sibling is checkpointed (`wal_checkpoint(TRUNCATE)`) through an opened
 *   handle before the copy — a live WAL is never copied;
 * - a sibling with a running detached re-index (job marker) is skipped;
 * - the `repo_id` rewrite enumerates columns via `sqlite_master` +
 *   `PRAGMA table_info` — no hand-kept table list, ever.
 */
import { constants as fsConstants, copyFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { logger } from './logger.js';
import {
  computeRepoId,
  getIndexDir,
  getJobsDir,
  getRepo,
  openDatabase,
  SCHEMA_VERSION,
} from './db/schema.js';
import { getSqliteFactory } from './db/sqlite-loader.js';
import { contentStoreMode } from './db/blob-store.js';
import { inlineContentBytes, moveInlineContentToBlobs } from './db/file-store.js';
import { gitDirtyFiles, gitWorktreeList, isJobInProgress, isLinkedWorktree } from './git-head.js';

/**
 * Oldest sibling schema a clone may be seeded from. v12 → v13 changed no
 * table (content location only), so a v12 sibling is still a correct seed;
 * its inline content is moved to the blob store right after the copy.
 */
export const MIN_CLONE_SCHEMA_VERSION = 12;

export interface CloneSource {
  repoId: string;
  rootPath: string;
  /** The sibling index's stored HEAD — the delta base for the new worktree. */
  sha: string | null;
  dbPath: string;
  isMain: boolean;
}

export interface CloneResult {
  source: CloneSource;
  newRepoId: string;
  /** Tables whose `repo_id` column was rewritten. */
  tables: string[];
  rowsRewritten: number;
  /** Final size of the new index file. */
  bytes: number;
  /** Size right after the copy, before inline content was moved out (Phase 100). */
  bytesCopied: number;
  /** Files whose inline bytes moved to the blob store during the clone. */
  contentMoved: number;
  cloneMs: number;
  /**
   * Paths dirty in the SIBLING's working tree right now. The sibling's index
   * may hold their uncommitted content, which this worktree does not have —
   * `reindexChanged` re-checks them on top of the committed delta.
   */
  sourceDirtyFiles: string[];
}

/**
 * Pick the sibling worktree whose index can seed `absRoot`'s. Main worktree
 * first, then the others in `git worktree list` order. A candidate must have
 * an index at the CURRENT schema version with a stored sha, and no detached
 * re-index running. Null when `absRoot` is not a linked worktree or nothing
 * qualifies (the caller falls back to a full index — P2).
 */
export function findCloneSource(absRoot: string): CloneSource | null {
  const root = resolve(absRoot);
  const worktrees = gitWorktreeList(root);
  if (worktrees.length < 2) return null;

  const indexDir = getIndexDir();
  const jobsDir = getJobsDir();
  const ordered = [...worktrees].sort((a, b) => Number(b.isMain) - Number(a.isMain));

  for (const wt of ordered) {
    if (samePath(wt.path, root)) continue;
    const repoId = computeRepoId(wt.path);
    const dbPath = join(indexDir, `${repoId}.db`);
    if (!existsSync(dbPath)) continue;
    if (isJobInProgress(jobsDir, repoId)) {
      logger.info(`worktree clone: sibling ${wt.path} has a re-index in progress — skipped`);
      continue;
    }
    try {
      const db = openDatabase(repoId);
      const meta = getRepo(db, repoId);
      db.close();
      if (!meta) continue;
      if (meta.schemaVersion < MIN_CLONE_SCHEMA_VERSION || meta.schemaVersion > SCHEMA_VERSION) {
        logger.info(
          `worktree clone: sibling ${wt.path} is schema v${meta.schemaVersion} (need v${MIN_CLONE_SCHEMA_VERSION}–v${SCHEMA_VERSION}) — skipped`,
        );
        continue;
      }
      if (!meta.gitTreeSha) {
        logger.info(`worktree clone: sibling ${wt.path} has no stored HEAD sha — skipped`);
        continue;
      }
      // The stored root must be the worktree path itself (not a moved/renamed index).
      if (!samePath(meta.rootPath, wt.path)) continue;
      return { repoId, rootPath: wt.path, sha: meta.gitTreeSha, dbPath, isMain: wt.isMain };
    } catch (err) {
      logger.debug(`worktree clone: cannot read sibling index ${dbPath}: ${String(err)}`);
    }
  }
  return null;
}

/**
 * Copy `source`'s database to `<newRepoId>.db` and rewrite every `repo_id`
 * (plus `repos.id` / `repos.root_path`). The new file must not exist yet.
 */
export function cloneIndex(source: CloneSource, newRepoId: string, newRoot: string): CloneResult {
  const t0 = Date.now();
  const indexDir = getIndexDir();
  const dest = join(indexDir, `${newRepoId}.db`);
  if (existsSync(dest)) {
    throw new Error(`cloneIndex: destination already exists: ${dest}`);
  }

  // 1. Checkpoint the sibling through an OPEN handle so the copy sees every
  //    committed page in the main file (never copy a live WAL).
  {
    const src = getSqliteFactory().open(source.dbPath);
    try {
      src.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* WASM tier / no WAL — the main file is already complete */
    } finally {
      src.close();
    }
  }

  // 2. Copy the main file only (after TRUNCATE the WAL is empty). A reflink
  //    (COPYFILE_FICLONE) shares blocks on btrfs/xfs/APFS/ReFS; file systems
  //    without it (NTFS) fall back to a plain copy silently — Node semantics.
  copyFileSync(source.dbPath, dest, fsConstants.COPYFILE_FICLONE);
  const bytesCopied = statSync(dest).size;

  // 3. Rewrite repo ids. FK enforcement is ON in this schema (children
  //    reference repos.id, ON UPDATE = NO ACTION), so disable it for the
  //    rewrite — outside any transaction, as SQLite requires.
  const db = getSqliteFactory().open(dest);
  const tables: string[] = [];
  let rowsRewritten = 0;
  let contentMoved = 0;
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    const rewrite = db.transaction(() => {
      for (const table of tablesWithRepoIdColumn(db)) {
        const res = db
          .prepare(`UPDATE "${table}" SET repo_id = ? WHERE repo_id = ?`)
          .run(newRepoId, source.repoId);
        tables.push(table);
        rowsRewritten += res.changes;
      }
      db.prepare(
        'UPDATE repos SET id = ?, root_path = ?, indexed_at = ? WHERE id = ?',
      ).run(newRepoId, newRoot, Date.now(), source.repoId);
      // Phase 99: the sibling's workspace links point at indexes INSIDE the
      // sibling worktree (a different git toplevel — never linkable from
      // here). Drop them and the cross edges that depend on them; the caller
      // re-resolves the graph against this worktree's own links.
      try {
        db.prepare('DELETE FROM repo_links WHERE repo_id = ?').run(newRepoId);
        db.prepare('DELETE FROM dep_edges WHERE repo_id = ? AND target_repo_id IS NOT NULL').run(newRepoId);
      } catch {
        /* pre-v12 sibling: no such column / table — nothing to drop */
      }
    });
    rewrite();
    db.exec('PRAGMA foreign_keys = ON');
    // Sanity (R4): nothing anywhere may still carry the old id.
    const leftovers = countRowsWithRepoId(db, source.repoId);
    if (leftovers > 0) {
      throw new Error(`cloneIndex: ${leftovers} row(s) still carry the source repo id`);
    }
    // Phase 100 (Task 623): a sibling indexed before v13 (or in inline mode)
    // carries every file's bytes inline — the copy just duplicated them.
    // Move them to the shared blob store; the clone keeps only what is
    // unique to it. `VACUUM INTO` below drops the freed pages.
    if (contentStoreMode() === 'blob' && inlineContentBytes(db, newRepoId) > 0) {
      contentMoved = moveInlineContentToBlobs(db, newRepoId).files;
    }
  } catch (err) {
    db.close();
    try { unlinkSync(dest); } catch { /* best effort */ }
    throw err;
  }
  if (contentMoved > 0) {
    // Rewrite the file without the freed pages (a plain VACUUM would also
    // work but rewrites in place; INTO lets a failure leave `dest` intact).
    const slim = `${dest}.slim`;
    try {
      try { unlinkSync(slim); } catch { /* absent */ }
      db.exec(`VACUUM INTO '${slim.replace(/'/g, "''")}'`);
      db.close();
      unlinkSync(dest);
      renameSync(slim, dest);
    } catch (err) {
      logger.debug(`cloneIndex: VACUUM INTO unavailable — keeping the un-vacuumed copy: ${String(err)}`);
      try { db.close(); } catch { /* already closed */ }
      try { unlinkSync(slim); } catch { /* absent */ }
    }
  } else {
    db.close();
  }
  const bytes = statSync(dest).size;

  const sourceDirtyFiles = gitDirtyFiles(source.rootPath) ?? [];
  const cloneMs = Date.now() - t0;
  logger.info(
    `Cloned index from worktree ${source.rootPath} (${(bytes / 1_048_576).toFixed(1)} MB` +
      (contentMoved > 0
        ? `, ${(bytesCopied / 1_048_576).toFixed(1)} MB before moving ${contentMoved} files' content to the blob store`
        : '') +
      `, ${tables.length} tables, ${rowsRewritten} rows re-keyed) in ${cloneMs}ms`,
  );
  return {
    source,
    newRepoId,
    tables,
    rowsRewritten,
    bytes,
    bytesCopied,
    contentMoved,
    cloneMs,
    sourceDirtyFiles,
  };
}

/**
 * The one-call entry used by `indexFolder` / `reindexChanged`: when `absRoot`
 * is a linked worktree WITHOUT an index, seed one from a sibling. Returns the
 * clone result, or null when nothing was cloned (not linked, index already
 * present, no qualifying sibling). Never throws — a failed clone leaves no
 * file behind and the caller proceeds with a full index.
 */
export function maybeCloneWorktreeIndex(absRoot: string, repoId: string): CloneResult | null {
  const dest = join(getIndexDir(), `${repoId}.db`);
  if (existsSync(dest) && !isEmptyIndexFile(dest, repoId)) return null;
  let linked = false;
  try {
    linked = isLinkedWorktree(absRoot);
  } catch {
    return null;
  }
  if (!linked) return null;
  const source = findCloneSource(absRoot);
  if (!source) {
    logger.info('Linked worktree without a qualifying sibling index — full index');
    return null;
  }
  try {
    return cloneIndex(source, repoId, absRoot);
  } catch (err) {
    logger.warn(`Worktree index clone failed (falling back to a full index): ${String(err)}`);
    return null;
  }
}

/**
 * Every table (incl. FTS5 virtual tables) that has a `repo_id` column —
 * discovered from the live schema, so a future table can never be missed.
 */
export function tablesWithRepoIdColumn(db: Database.Database): string[] {
  const names = (
    db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
  ).map((r) => r.name);
  const out: string[] = [];
  for (const name of names) {
    let cols: Array<{ name: string }>;
    try {
      cols = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>;
    } catch {
      continue; // shadow tables of virtual tables may refuse PRAGMA — they have no repo_id
    }
    if (cols.some((c) => c.name === 'repo_id')) out.push(name);
  }
  return out.sort();
}

/** Rows across all repo_id-bearing tables (and repos.id) that carry `repoId`. */
export function countRowsWithRepoId(db: Database.Database, repoId: string): number {
  let n = 0;
  for (const table of tablesWithRepoIdColumn(db)) {
    n +=
      db
        .prepare<[string], { c: number }>(`SELECT COUNT(*) AS c FROM "${table}" WHERE repo_id = ?`)
        .get(repoId)?.c ?? 0;
  }
  n += db.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM repos WHERE id = ?').get(repoId)?.c ?? 0;
  return n;
}

/**
 * `delete-index` / `invalidate_cache` empty the rows but keep the `.db` file.
 * Such a husk must not block a clone: if it holds no repo row, remove it.
 */
function isEmptyIndexFile(dest: string, repoId: string): boolean {
  try {
    const db = openDatabase(repoId);
    const empty = getRepo(db, repoId) === null;
    db.close();
    if (!empty) return false;
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(dest + suffix); } catch { /* absent */ }
    }
    return !existsSync(dest);
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}
