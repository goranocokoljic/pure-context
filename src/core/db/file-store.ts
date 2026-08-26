import type Database from 'better-sqlite3';
import { StorageError } from '../errors.js';

// ─── Operations ───────────────────────────────────────────────────────────────

export function upsertFile(
  db: Database.Database,
  repoId: string,
  filePath: string,
  contentHash: string,
  rawContent?: Buffer,
  tenantId = 'local',
  declaredPackage?: string | null,
): void {
  try {
    // declaredPackage semantics: undefined = keep the stored value (hash-only
    // upserts must not wipe it); null = the file declares no package.
    db.prepare(`
      INSERT INTO files (repo_id, path, content_hash, raw_content, indexed_at, tenant_id, declared_package)
      VALUES (@repoId, @path, @contentHash, @rawContent, @indexedAt, @tenantId, @declaredPackage)
      ON CONFLICT(repo_id, path) DO UPDATE SET
        content_hash = excluded.content_hash,
        raw_content  = excluded.raw_content,
        indexed_at   = excluded.indexed_at,
        tenant_id    = excluded.tenant_id,
        declared_package = CASE WHEN @setDeclaredPackage = 1
          THEN excluded.declared_package ELSE files.declared_package END
    `).run({
      repoId,
      path: filePath,
      contentHash,
      rawContent: rawContent ?? null,
      indexedAt: Date.now(),
      tenantId,
      declaredPackage: declaredPackage ?? null,
      setDeclaredPackage: declaredPackage === undefined ? 0 : 1,
    });
  } catch (err) {
    throw new StorageError(`Failed to upsert file "${filePath}"`, 'upsertFile', err);
  }
}

/**
 * All files with a declared package (JVM languages) for a repo.
 * Returns a map of relative file path → package (e.g. "com.example.foo").
 * Used by the JVM import resolver to map package-qualified imports to files.
 */
export function getDeclaredPackages(
  db: Database.Database,
  repoId: string,
): Map<string, string> {
  const rows = db
    .prepare<[string], { path: string; declared_package: string }>(
      'SELECT path, declared_package FROM files WHERE repo_id = ? AND declared_package IS NOT NULL',
    )
    .all(repoId);
  return new Map(rows.map((r) => [r.path, r.declared_package]));
}

export function getFileContent(
  db: Database.Database,
  repoId: string,
  filePath: string,
  tenantId?: string,
): Buffer | null {
  if (tenantId !== undefined) {
    const row = db
      .prepare<[string, string, string], { raw_content: Buffer | null }>(
        'SELECT raw_content FROM files WHERE repo_id = ? AND path = ? AND tenant_id = ?',
      )
      .get(repoId, filePath, tenantId);
    return row?.raw_content ?? null;
  }
  const row = db
    .prepare<[string, string], { raw_content: Buffer | null }>(
      'SELECT raw_content FROM files WHERE repo_id = ? AND path = ?',
    )
    .get(repoId, filePath);

  return row?.raw_content ?? null;
}

export function getFileHash(
  db: Database.Database,
  repoId: string,
  filePath: string,
  tenantId?: string,
): string | null {
  if (tenantId !== undefined) {
    const row = db
      .prepare<[string, string, string], { content_hash: string }>(
        'SELECT content_hash FROM files WHERE repo_id = ? AND path = ? AND tenant_id = ?',
      )
      .get(repoId, filePath, tenantId);
    return row?.content_hash ?? null;
  }
  const row = db
    .prepare<[string, string], { content_hash: string }>(
      'SELECT content_hash FROM files WHERE repo_id = ? AND path = ?',
    )
    .get(repoId, filePath);

  return row?.content_hash ?? null;
}

export function deleteFile(
  db: Database.Database,
  repoId: string,
  filePath: string,
): void {
  db.prepare('DELETE FROM files WHERE repo_id = ? AND path = ?').run(repoId, filePath);
}

export function getAllFileHashes(
  db: Database.Database,
  repoId: string,
): Map<string, string> {
  const rows = db
    .prepare<[string], { path: string; content_hash: string }>(
      'SELECT path, content_hash FROM files WHERE repo_id = ?',
    )
    .all(repoId);

  return new Map(rows.map((r) => [r.path, r.content_hash]));
}

// ─── Git metadata ─────────────────────────────────────────────────────────────

/**
 * Update the denormalised last-commit summary columns on a files row.
 * The full per-commit history lives in the git_metadata table.
 */
export function updateFileGitMeta(
  db: Database.Database,
  repoId: string,
  filePath: string,
  meta: {
    lastCommitSha: string;
    lastCommitAuthor: string;
    lastCommitDate: number;
    lastCommitMessage: string;
    commitCount: number;
  },
): void {
  db.prepare(`
    UPDATE files
    SET last_commit_sha     = @lastCommitSha,
        last_commit_author  = @lastCommitAuthor,
        last_commit_date    = @lastCommitDate,
        last_commit_message = @lastCommitMessage,
        commit_count        = @commitCount
    WHERE repo_id = @repoId AND path = @filePath
  `).run({ repoId, filePath, ...meta });
}

// ─── Remote SHA tracking (GitHub API indexing) ───────────────────────────────

/**
 * Get all stored Git blob SHAs for a repo.
 * Returns a map of relative file path → blob SHA.
 * Files without a remote_sha are omitted.
 */
export function getAllRemoteShas(
  db: Database.Database,
  repoId: string,
): Map<string, string> {
  const rows = db
    .prepare<[string], { path: string; remote_sha: string | null }>(
      'SELECT path, remote_sha FROM files WHERE repo_id = ? AND remote_sha IS NOT NULL',
    )
    .all(repoId);

  return new Map(rows.map((r) => [r.path, r.remote_sha as string]));
}

/**
 * Update the remote_sha for a specific file.
 * No-op if the file does not exist in the DB.
 */
export function updateRemoteSha(
  db: Database.Database,
  repoId: string,
  filePath: string,
  remoteSha: string,
): void {
  db.prepare('UPDATE files SET remote_sha = ? WHERE repo_id = ? AND path = ?').run(
    remoteSha,
    repoId,
    filePath,
  );
}

// ─── Size queries ─────────────────────────────────────────────────────────────

/**
 * Returns the byte length of a file's stored content, or 0 if not found.
 * Uses SQLite's length() on the blob to avoid loading content into memory.
 */
export function getFileSizeBytes(
  db: Database.Database,
  repoId: string,
  filePath: string,
): number {
  const row = db
    .prepare<[string, string], { size: number | null }>(
      'SELECT length(raw_content) as size FROM files WHERE repo_id = ? AND path = ?',
    )
    .get(repoId, filePath);
  return row?.size ?? 0;
}

/**
 * Returns byte lengths for multiple files in a single pass.
 * Files not found in the DB get a size of 0.
 */
export function getFileSizesBatch(
  db: Database.Database,
  repoId: string,
  filePaths: string[],
): Map<string, number> {
  const result = new Map<string, number>();
  if (filePaths.length === 0) return result;

  const stmt = db.prepare<[string, string], { path: string; size: number | null }>(
    'SELECT path, length(raw_content) as size FROM files WHERE repo_id = ? AND path = ?',
  );

  for (const fp of filePaths) {
    const row = stmt.get(repoId, fp);
    result.set(fp, row?.size ?? 0);
  }

  return result;
}

export interface FileEntry {
  path: string;
  rawContent: Buffer | null;
}

export function getAllFilesWithContent(
  db: Database.Database,
  repoId: string,
): FileEntry[] {
  const rows = db
    .prepare<[string], { path: string; raw_content: Buffer | null }>(
      'SELECT path, raw_content FROM files WHERE repo_id = ?',
    )
    .all(repoId);

  return rows.map((r) => ({ path: r.path, rawContent: r.raw_content }));
}

/**
 * Return the total bytes of stored raw_content for a tenant across all repos.
 * Used for storage quota tracking.
 */
export function getTenantStorageBytes(
  db: Database.Database,
  tenantId: string,
): number {
  const row = db
    .prepare<[string], { total: number | null }>(
      'SELECT SUM(length(raw_content)) AS total FROM files WHERE tenant_id = ?',
    )
    .get(tenantId);
  return row?.total ?? 0;
}
