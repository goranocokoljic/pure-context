/**
 * co-change-store.ts
 *
 * CRUD for the `commit_files` table — a dedicated, repo-level capture of which
 * files changed together in each commit. This is the foundation for temporal
 * coupling (co-change) analysis (Phase 76).
 *
 * Deliberately SEPARATE from `git_metadata`:
 *   - `git_metadata` stores only the last ~10 commits *per file* (recency-skewed,
 *     captured via N per-file `git log --follow` calls). Too shallow for
 *     co-change, which needs the full commit→files mapping at repo scope.
 *   - `commit_files` is populated from a single `git log --name-only -n N` at the
 *     repo root, giving an accurate commit_sha → {files} relation.
 *
 * Co-change of two files = a self-join on `commit_sha`.
 */

import type Database from 'better-sqlite3';
import type { RepoCommit } from '../git-log-reader.js';

// ─── DDL ────────────────────────────────────────────────────────────────────

export const CO_CHANGE_DDL = `
CREATE TABLE IF NOT EXISTS commit_files (
  repo_id     TEXT    NOT NULL,
  commit_sha  TEXT    NOT NULL,
  file_path   TEXT    NOT NULL,
  commit_date INTEGER NOT NULL,
  PRIMARY KEY (repo_id, commit_sha, file_path),
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_commit_files_sha  ON commit_files(repo_id, commit_sha);
CREATE INDEX IF NOT EXISTS idx_commit_files_path ON commit_files(repo_id, file_path);
`;

// ─── Writes ─────────────────────────────────────────────────────────────────

/**
 * Insert a batch of repo-level commits (each with its touched files).
 * Uses INSERT OR IGNORE so re-running is idempotent (PK = repo+sha+file).
 */
export function insertCommitFiles(
  db: Database.Database,
  repoId: string,
  commits: RepoCommit[],
): void {
  if (commits.length === 0) return;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO commit_files (repo_id, commit_sha, file_path, commit_date)
    VALUES (@repoId, @commitSha, @filePath, @commitDate)
  `);

  db.transaction(() => {
    for (const c of commits) {
      for (const filePath of c.files) {
        stmt.run({
          repoId,
          commitSha: c.sha,
          filePath,
          commitDate: c.date,
        });
      }
    }
  })();
}

/**
 * Delete all commit_files rows for a repo. Called before re-capturing on
 * re-index so stale entries (deleted/renamed files) do not linger.
 */
export function deleteCommitFilesForRepo(db: Database.Database, repoId: string): void {
  db.prepare('DELETE FROM commit_files WHERE repo_id = ?').run(repoId);
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** Number of distinct commits captured for a repo (the co-change window size). */
export function countCommits(db: Database.Database, repoId: string): number {
  const row = db
    .prepare<[string], { n: number }>(
      'SELECT COUNT(DISTINCT commit_sha) AS n FROM commit_files WHERE repo_id = ?',
    )
    .get(repoId);
  return row?.n ?? 0;
}

/** Number of distinct commits that touched a specific file. */
export function countCommitsForFile(
  db: Database.Database,
  repoId: string,
  filePath: string,
): number {
  const row = db
    .prepare<[string, string], { n: number }>(
      'SELECT COUNT(DISTINCT commit_sha) AS n FROM commit_files WHERE repo_id = ? AND file_path = ?',
    )
    .get(repoId, filePath);
  return row?.n ?? 0;
}
