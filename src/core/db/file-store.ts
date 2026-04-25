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
): void {
  try {
    db.prepare(`
      INSERT INTO files (repo_id, path, content_hash, raw_content, indexed_at, tenant_id)
      VALUES (@repoId, @path, @contentHash, @rawContent, @indexedAt, @tenantId)
      ON CONFLICT(repo_id, path) DO UPDATE SET
        content_hash = excluded.content_hash,
        raw_content  = excluded.raw_content,
        indexed_at   = excluded.indexed_at,
        tenant_id    = excluded.tenant_id
    `).run({
      repoId,
      path: filePath,
      contentHash,
      rawContent: rawContent ?? null,
      indexedAt: Date.now(),
      tenantId,
    });
  } catch (err) {
    throw new StorageError(`Failed to upsert file "${filePath}"`, 'upsertFile', err);
  }
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
