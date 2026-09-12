/**
 * Test-file token store (Phase 104, Task 649).
 *
 * One row per TEST file: the file's content hash and the sorted, deduped set
 * of word tokens (`[A-Za-z0-9_]+` runs) found in it, deflated. The test
 * mapper re-tokenizes a file only when its hash moved, and re-intersects
 * production symbol names against these sets WITHOUT re-reading test files
 * (a symbol-side change — new production symbol — costs a set lookup, not a
 * content scan).
 *
 * The table is created by the base DDL (`TEST_TOKEN_DDL`, schema v15,
 * additive — a new TABLE is safe on old DBs; the v9/v12 lesson). A pre-v15
 * index holds no rows until its next whole-tree run or the first
 * coverage-needing tool call (lazy build, Task 650).
 */
import type Database from 'better-sqlite3';
import { deflateSync, inflateSync } from 'zlib';

export const TEST_TOKEN_DDL = `
CREATE TABLE IF NOT EXISTS test_file_tokens (
  repo_id      TEXT    NOT NULL,
  file_path    TEXT    NOT NULL,
  content_hash TEXT    NOT NULL,
  tokens       BLOB    NOT NULL,
  token_count  INTEGER NOT NULL,
  PRIMARY KEY (repo_id, file_path),
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);
`;

/** path → content hash of every stored token row. */
export function getTestTokenHashes(db: Database.Database, repoId: string): Map<string, string> {
  const rows = db
    .prepare<[string], { file_path: string; content_hash: string }>(
      'SELECT file_path, content_hash FROM test_file_tokens WHERE repo_id = ?',
    )
    .all(repoId);
  return new Map(rows.map((r) => [r.file_path, r.content_hash]));
}

/** path → token set for every stored row (inflated). */
export function getAllTestTokens(db: Database.Database, repoId: string): Map<string, Set<string>> {
  const rows = db
    .prepare<[string], { file_path: string; tokens: Buffer }>(
      'SELECT file_path, tokens FROM test_file_tokens WHERE repo_id = ?',
    )
    .all(repoId);
  const out = new Map<string, Set<string>>();
  for (const r of rows) out.set(r.file_path, decodeTokens(r.tokens));
  return out;
}

export function upsertTestTokens(
  db: Database.Database,
  repoId: string,
  filePath: string,
  contentHash: string,
  tokens: Set<string>,
): void {
  db.prepare(
    `INSERT INTO test_file_tokens (repo_id, file_path, content_hash, tokens, token_count)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, file_path) DO UPDATE SET
       content_hash = excluded.content_hash,
       tokens       = excluded.tokens,
       token_count  = excluded.token_count`,
  ).run(repoId, filePath, contentHash, encodeTokens(tokens), tokens.size);
}

export function deleteTestTokens(db: Database.Database, repoId: string, filePath: string): void {
  db.prepare('DELETE FROM test_file_tokens WHERE repo_id = ? AND file_path = ?').run(repoId, filePath);
}

export function deleteAllTestTokens(db: Database.Database, repoId: string): void {
  db.prepare('DELETE FROM test_file_tokens WHERE repo_id = ?').run(repoId);
}

/** Stored size of the token rows (R2 — measured, not guessed). */
export function testTokenBytes(db: Database.Database, repoId: string): number {
  return (
    db
      .prepare<[string], { b: number | null }>(
        'SELECT SUM(LENGTH(tokens)) AS b FROM test_file_tokens WHERE repo_id = ?',
      )
      .get(repoId)?.b ?? 0
  );
}

/** Sorted, newline-joined, deflated. Identifier lists compress 3-5x. */
export function encodeTokens(tokens: Set<string>): Buffer {
  return deflateSync(Buffer.from([...tokens].sort().join('\n'), 'utf8'));
}

export function decodeTokens(blob: Buffer): Set<string> {
  const text = inflateSync(blob).toString('utf8');
  return text.length === 0 ? new Set() : new Set(text.split('\n'));
}
