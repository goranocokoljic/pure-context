/**
 * git-metadata-store.ts
 *
 * CRUD operations for the `git_metadata` table, which stores per-file commit
 * history captured during indexing.  The files table's last_commit_* columns
 * hold a denormalised summary row for fast single-file lookups; this table
 * holds the full history (last N commits per file).
 */

import type Database from 'better-sqlite3';
import type { CommitRecord } from '../git-log-reader.js';

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Upsert a batch of commits for one file into `git_metadata`.
 * Uses INSERT OR REPLACE so re-indexing never creates duplicate rows.
 */
export function insertGitCommits(
  db: Database.Database,
  repoId: string,
  filePath: string,
  commits: CommitRecord[],
): void {
  if (commits.length === 0) return;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO git_metadata
      (repo_id, file_path, commit_sha, author_name, author_email, commit_date, message)
    VALUES (@repoId, @filePath, @commitSha, @authorName, @authorEmail, @commitDate, @message)
  `);

  db.transaction(() => {
    for (const c of commits) {
      stmt.run({
        repoId,
        filePath,
        commitSha: c.sha,
        authorName: c.authorName,
        authorEmail: c.authorEmail,
        commitDate: c.date,
        message: c.message,
      });
    }
  })();
}

/**
 * Delete all git_metadata rows for a specific file in a repo.
 * Called before re-capturing history on re-index.
 */
export function deleteGitMetadataForFile(
  db: Database.Database,
  repoId: string,
  filePath: string,
): void {
  db.prepare(
    'DELETE FROM git_metadata WHERE repo_id = ? AND file_path = ?',
  ).run(repoId, filePath);
}

/**
 * Delete all git_metadata rows for a repo.
 * Used when invalidating the cache.
 */
export function deleteGitMetadataForRepo(
  db: Database.Database,
  repoId: string,
): void {
  db.prepare('DELETE FROM git_metadata WHERE repo_id = ?').run(repoId);
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Return the stored commit history for a file, ordered newest-first.
 */
export function getFileCommits(
  db: Database.Database,
  repoId: string,
  filePath: string,
  limit = 10,
): CommitRecord[] {
  const rows = db
    .prepare<
      [string, string, number],
      {
        commit_sha: string;
        author_name: string;
        author_email: string;
        commit_date: number;
        message: string;
      }
    >(
      `SELECT commit_sha, author_name, author_email, commit_date, message
       FROM git_metadata
       WHERE repo_id = ? AND file_path = ?
       ORDER BY commit_date DESC
       LIMIT ?`,
    )
    .all(repoId, filePath, limit);

  return rows.map((r) => ({
    sha: r.commit_sha,
    authorName: r.author_name,
    authorEmail: r.author_email,
    date: r.commit_date,
    message: r.message,
  }));
}

/**
 * Return all files in a repo that have git metadata, together with their
 * latest commit date and commit count — used by the churn-metrics tool.
 */
export function getFilesWithGitMeta(
  db: Database.Database,
  repoId: string,
): Array<{
  filePath: string;
  lastCommitDate: number;
  commitCount: number;
}> {
  const rows = db
    .prepare<
      [string],
      { file_path: string; last_commit_date: number; commit_count: number }
    >(
      `SELECT file_path,
              MAX(commit_date)  AS last_commit_date,
              COUNT(*)          AS commit_count
       FROM git_metadata
       WHERE repo_id = ?
       GROUP BY file_path`,
    )
    .all(repoId);

  return rows.map((r) => ({
    filePath: r.file_path,
    lastCommitDate: r.last_commit_date,
    commitCount: r.commit_count,
  }));
}

/**
 * Return all commits in a date window for a specific file path prefix (scope).
 * Used by get_churn_metrics to aggregate by directory.
 */
export function getCommitsInWindow(
  db: Database.Database,
  repoId: string,
  sinceTimestamp: number,
  filePathPrefix?: string,
): Array<{
  filePath: string;
  commitSha: string;
  authorName: string;
  commitDate: number;
}> {
  if (filePathPrefix) {
    const rows = db
      .prepare<
        [string, number, string],
        {
          file_path: string;
          commit_sha: string;
          author_name: string;
          commit_date: number;
        }
      >(
        `SELECT file_path, commit_sha, author_name, commit_date
         FROM git_metadata
         WHERE repo_id = ?
           AND commit_date >= ?
           AND file_path LIKE ?
         ORDER BY commit_date DESC`,
      )
      .all(repoId, sinceTimestamp, `${filePathPrefix}%`);
    return rows.map((r) => ({
      filePath: r.file_path,
      commitSha: r.commit_sha,
      authorName: r.author_name,
      commitDate: r.commit_date,
    }));
  }

  const rows = db
    .prepare<
      [string, number],
      {
        file_path: string;
        commit_sha: string;
        author_name: string;
        commit_date: number;
      }
    >(
      `SELECT file_path, commit_sha, author_name, commit_date
       FROM git_metadata
       WHERE repo_id = ?
         AND commit_date >= ?
       ORDER BY commit_date DESC`,
    )
    .all(repoId, sinceTimestamp);

  return rows.map((r) => ({
    filePath: r.file_path,
    commitSha: r.commit_sha,
    authorName: r.author_name,
    commitDate: r.commit_date,
  }));
}
