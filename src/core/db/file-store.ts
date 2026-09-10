import type Database from 'better-sqlite3';
import { StorageError } from '../errors.js';
import { contentStoreMode, openBlobStore, type BlobStore } from './blob-store.js';

/**
 * The ONE accessor for indexed file content (Phase 100, P1).
 *
 * `files.raw_content` is inline-or-blob since schema v13: a row with bytes
 * reads them directly; a row with NULL reads `<dataDir>/blobs.db` by its
 * `content_hash`. No other module issues SQL against `raw_content`
 * (`test/core/source-hygiene.test.ts` enforces it), so the two storage
 * layouts are invisible to every tool.
 */

// ─── Content persistence (write side) ─────────────────────────────────────────

/**
 * Decide where one file's bytes go. Returns the buffer to store INLINE, or
 * null when the bytes now live in the blob store. In 'inline' mode (config,
 * WASM tier, `PCTX_CONTENT_STORE=inline`) this is the identity.
 */
export function persistContent(contentHash: string, content: Buffer): Buffer | null {
  const m = persistContentBatch([{ hash: contentHash, content }]);
  return m.has(contentHash) ? (m.get(contentHash) as Buffer | null) : content;
}

/**
 * Batch form: one blob-store transaction for a whole commit batch. The map
 * holds every input hash; value null = "in the blob store", Buffer = store
 * inline (mode inline, or the blob write failed — R1: never a lost file).
 */
export function persistContentBatch(
  entries: Array<{ hash: string; content: Buffer }>,
): Map<string, Buffer | null> {
  const out = new Map<string, Buffer | null>();
  if (entries.length === 0) return out;
  if (contentStoreMode() !== 'blob') {
    for (const e of entries) out.set(e.hash, e.content);
    return out;
  }
  let present = new Set<string>();
  try {
    const store = openBlobStore({ createIfMissing: true });
    if (store) present = store.putMany(entries.map((e) => ({ hash: e.hash, bytes: e.content })));
  } catch {
    present = new Set();
  }
  for (const e of entries) out.set(e.hash, present.has(e.hash) ? null : e.content);
  return out;
}

// ─── Content resolution (read side) ───────────────────────────────────────────

function readStore(): BlobStore | null {
  try {
    return openBlobStore({ createIfMissing: false });
  } catch {
    return null;
  }
}

/**
 * Row values may arrive as Uint8Array (WASM tier) or as TEXT (rows written
 * by older code / tests that stored a string) — normalize to Buffer.
 */
function asBuffer(v: Buffer | Uint8Array | string | null | undefined): Buffer | null {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

function resolveOne(hash: string, raw: Buffer | Uint8Array | null | undefined): Buffer | null {
  const inline = asBuffer(raw);
  if (inline) return inline;
  return readStore()?.get(hash) ?? null;
}

interface ContentRow {
  path: string;
  content_hash: string;
  raw_content: Buffer | null;
}

/** Resolve a set of rows in one batched blob lookup. */
function resolveRows(rows: ContentRow[]): Map<string, Buffer | null> {
  const out = new Map<string, Buffer | null>();
  const missing: string[] = [];
  for (const r of rows) {
    const inline = asBuffer(r.raw_content);
    if (inline) out.set(r.path, inline);
    else missing.push(r.content_hash);
  }
  if (missing.length > 0) {
    const blobs = readStore()?.getMany(missing) ?? new Map<string, Buffer>();
    for (const r of rows) {
      if (!out.has(r.path)) out.set(r.path, blobs.get(r.content_hash) ?? null);
    }
  }
  return out;
}

// ─── Operations ───────────────────────────────────────────────────────────────

export function upsertFile(
  db: Database.Database,
  repoId: string,
  filePath: string,
  contentHash: string,
  rawContent?: Buffer | null,
  tenantId = 'local',
  declaredPackage?: string | null,
): void {
  try {
    // declaredPackage semantics: undefined = keep the stored value (hash-only
    // upserts must not wipe it); null = the file declares no package.
    // rawContent null = the bytes live in the blob store (see persistContent).
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
  type Row = { content_hash: string; raw_content: Buffer | null };
  const row =
    tenantId !== undefined
      ? db
          .prepare<[string, string, string], Row>(
            'SELECT content_hash, raw_content FROM files WHERE repo_id = ? AND path = ? AND tenant_id = ?',
          )
          .get(repoId, filePath, tenantId)
      : db
          .prepare<[string, string], Row>(
            'SELECT content_hash, raw_content FROM files WHERE repo_id = ? AND path = ?',
          )
          .get(repoId, filePath);
  if (!row) return null;
  return resolveOne(row.content_hash, row.raw_content);
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
 * Uses SQLite's length() on the blob to avoid loading content into memory;
 * a blob-store row is answered from the store's `size` column.
 */
export function getFileSizeBytes(
  db: Database.Database,
  repoId: string,
  filePath: string,
): number {
  const row = db
    .prepare<[string, string], { content_hash: string; size: number | null }>(
      'SELECT content_hash, length(raw_content) as size FROM files WHERE repo_id = ? AND path = ?',
    )
    .get(repoId, filePath);
  if (!row) return 0;
  if (row.size !== null) return row.size;
  return readStore()?.sizeOf(row.content_hash) ?? 0;
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

  const stmt = db.prepare<[string, string], { content_hash: string; size: number | null }>(
    'SELECT content_hash, length(raw_content) as size FROM files WHERE repo_id = ? AND path = ?',
  );

  const pending: Array<{ path: string; hash: string }> = [];
  for (const fp of filePaths) {
    const row = stmt.get(repoId, fp);
    if (!row) result.set(fp, 0);
    else if (row.size !== null) result.set(fp, row.size);
    else pending.push({ path: fp, hash: row.content_hash });
  }
  if (pending.length > 0) {
    const sizes = readStore()?.sizesOf(pending.map((p) => p.hash)) ?? new Map<string, number>();
    for (const p of pending) result.set(p.path, sizes.get(p.hash) ?? 0);
  }

  return result;
}

export interface FileEntry {
  path: string;
  rawContent: Buffer | null;
}

export interface FilesWithContentOptions {
  /** Only rows whose path equals this OR starts with it (a file or a directory). */
  pathPrefix?: string;
  /** Drop rows whose bytes cannot be resolved (hash-only rows, missing blobs). */
  onlyWithContent?: boolean;
}

/**
 * Every file of a repo with its bytes resolved (inline or blob store) —
 * one SQL query plus one batched blob lookup.
 */
export function getAllFilesWithContent(
  db: Database.Database,
  repoId: string,
  options: FilesWithContentOptions = {},
): FileEntry[] {
  const conditions = ['repo_id = @repoId'];
  const params: Record<string, unknown> = { repoId };
  if (options.pathPrefix) {
    conditions.push('(path = @prefix OR path LIKE @prefixLike)');
    params['prefix'] = options.pathPrefix;
    params['prefixLike'] = `${options.pathPrefix}%`;
  }
  const rows = db
    .prepare<Record<string, unknown>, ContentRow>(
      `SELECT path, content_hash, raw_content FROM files WHERE ${conditions.join(' AND ')} ORDER BY path`,
    )
    .all(params);
  const resolved = resolveRows(rows);
  const out: FileEntry[] = [];
  for (const r of rows) {
    const rawContent = resolved.get(r.path) ?? null;
    if (options.onlyWithContent && !rawContent) continue;
    out.push({ path: r.path, rawContent });
  }
  return out;
}

/**
 * Return the total bytes of stored content for a tenant across all repos.
 * Used for storage quota tracking. Blob-store rows count their stored size.
 */
export function getTenantStorageBytes(
  db: Database.Database,
  tenantId: string,
): number {
  const rows = db
    .prepare<[string], { content_hash: string; size: number | null }>(
      'SELECT content_hash, length(raw_content) AS size FROM files WHERE tenant_id = ?',
    )
    .all(tenantId);
  let total = 0;
  const pending: string[] = [];
  for (const r of rows) {
    if (r.size !== null) total += r.size;
    else pending.push(r.content_hash);
  }
  if (pending.length > 0) {
    const sizes = readStore()?.sizesOf(pending) ?? new Map<string, number>();
    for (const h of pending) total += sizes.get(h) ?? 0;
  }
  return total;
}

// ─── Full rows (export / import bundles) ──────────────────────────────────────

export interface FileRowFull {
  path: string;
  contentHash: string;
  /** Resolved bytes (inline or blob store); null when unavailable. */
  rawContent: Buffer | null;
  indexedAt: number;
  tenantId: string;
  remoteSha: string | null;
  lastCommitSha: string | null;
  lastCommitAuthor: string | null;
  lastCommitDate: number | null;
  lastCommitMessage: string | null;
  commitCount: number | null;
  declaredPackage: string | null;
}

/** Every files row of a repo with metadata and resolved content (`export_index`). */
export function getAllFileRows(
  db: Database.Database,
  repoId: string,
  options: { includeContent?: boolean } = {},
): FileRowFull[] {
  interface Row extends ContentRow {
    indexed_at: number;
    tenant_id: string;
    remote_sha: string | null;
    last_commit_sha: string | null;
    last_commit_author: string | null;
    last_commit_date: number | null;
    last_commit_message: string | null;
    commit_count: number | null;
    declared_package: string | null;
  }
  const includeContent = options.includeContent ?? true;
  const rows = db
    .prepare<[string], Row>(
      `SELECT path, content_hash, ${includeContent ? 'raw_content' : 'NULL AS raw_content'},
              indexed_at, tenant_id, remote_sha, last_commit_sha, last_commit_author,
              last_commit_date, last_commit_message, commit_count, declared_package
       FROM files WHERE repo_id = ? ORDER BY path`,
    )
    .all(repoId);
  const resolved = includeContent ? resolveRows(rows) : new Map<string, Buffer | null>();
  return rows.map((r) => ({
    path: r.path,
    contentHash: r.content_hash,
    rawContent: includeContent ? (resolved.get(r.path) ?? null) : null,
    indexedAt: r.indexed_at,
    tenantId: r.tenant_id,
    remoteSha: r.remote_sha ?? null,
    lastCommitSha: r.last_commit_sha ?? null,
    lastCommitAuthor: r.last_commit_author ?? null,
    lastCommitDate: r.last_commit_date ?? null,
    lastCommitMessage: r.last_commit_message ?? null,
    commitCount: r.commit_count ?? null,
    declaredPackage: r.declared_package ?? null,
  }));
}

/**
 * Write one complete files row (`import_index`). Content goes wherever
 * `persistContent` decides — a bundle always carries bytes inline (portable),
 * the importing machine stores them by ITS mode.
 */
export function importFileRow(
  db: Database.Database,
  repoId: string,
  row: Omit<FileRowFull, 'declaredPackage'> & { declaredPackage?: string | null },
): void {
  const inline = row.rawContent ? persistContent(row.contentHash, row.rawContent) : null;
  db.prepare(`
    INSERT INTO files
      (repo_id, path, content_hash, raw_content, indexed_at, tenant_id,
       remote_sha, last_commit_sha, last_commit_author, last_commit_date,
       last_commit_message, commit_count, declared_package)
    VALUES
      (@repoId, @path, @contentHash, @rawContent, @indexedAt, @tenantId,
       @remoteSha, @lastCommitSha, @lastCommitAuthor, @lastCommitDate,
       @lastCommitMessage, @commitCount, @declaredPackage)
    ON CONFLICT(repo_id, path) DO UPDATE SET
      content_hash        = excluded.content_hash,
      raw_content         = excluded.raw_content,
      indexed_at          = excluded.indexed_at,
      tenant_id           = excluded.tenant_id,
      remote_sha          = excluded.remote_sha,
      last_commit_sha     = excluded.last_commit_sha,
      last_commit_author  = excluded.last_commit_author,
      last_commit_date    = excluded.last_commit_date,
      last_commit_message = excluded.last_commit_message,
      commit_count        = excluded.commit_count,
      declared_package    = excluded.declared_package
  `).run({
    repoId,
    path: row.path,
    contentHash: row.contentHash,
    rawContent: inline,
    indexedAt: row.indexedAt,
    tenantId: row.tenantId ?? 'local',
    remoteSha: row.remoteSha ?? null,
    lastCommitSha: row.lastCommitSha ?? null,
    lastCommitAuthor: row.lastCommitAuthor ?? null,
    lastCommitDate: row.lastCommitDate ?? null,
    lastCommitMessage: row.lastCommitMessage ?? null,
    commitCount: row.commitCount ?? null,
    declaredPackage: row.declaredPackage ?? null,
  });
}

// ─── Inline → blob migration (Task 621/623) ───────────────────────────────────

export interface ContentMoveResult {
  /** Rows whose bytes now live in the blob store. */
  files: number;
  /** Bytes removed from the index (sum of moved inline lengths). */
  bytes: number;
}

/** Inline bytes still carried by this repo's rows (0 for a fully blob-backed index). */
export function inlineContentBytes(db: Database.Database, repoId: string): number {
  const row = db
    .prepare<[string], { total: number | null }>(
      'SELECT SUM(length(raw_content)) AS total FROM files WHERE repo_id = ? AND raw_content IS NOT NULL',
    )
    .get(repoId);
  return row?.total ?? 0;
}

/**
 * Move every inline row of a repo into the blob store and NULL it out —
 * chunked so a 200 MB index never sits in memory at once. A row whose blob
 * write fails stays inline (R1). Does nothing in 'inline' mode. The index
 * file does not shrink by itself; callers VACUUM (or `VACUUM INTO`) after.
 */
export function moveInlineContentToBlobs(
  db: Database.Database,
  repoId: string,
  options: { chunk?: number } = {},
): ContentMoveResult {
  const result: ContentMoveResult = { files: 0, bytes: 0 };
  if (contentStoreMode() !== 'blob') return result;
  const chunk = options.chunk ?? 200;
  const select = db.prepare<[string, string, number], ContentRow>(
    `SELECT path, content_hash, raw_content FROM files
     WHERE repo_id = ? AND raw_content IS NOT NULL AND path > ? ORDER BY path LIMIT ?`,
  );
  const clear = db.prepare('UPDATE files SET raw_content = NULL WHERE repo_id = ? AND path = ?');
  let after = '';
  for (;;) {
    const rows = select.all(repoId, after, chunk);
    if (rows.length === 0) break;
    after = rows[rows.length - 1].path;
    const entries = rows.map((r) => ({ hash: r.content_hash, content: asBuffer(r.raw_content) as Buffer }));
    const stored = persistContentBatch(entries);
    db.transaction(() => {
      for (const r of rows) {
        if (stored.get(r.content_hash) === null) {
          clear.run(repoId, r.path);
          result.files++;
          result.bytes += asBuffer(r.raw_content)?.length ?? 0;
        }
      }
    })();
  }
  return result;
}
