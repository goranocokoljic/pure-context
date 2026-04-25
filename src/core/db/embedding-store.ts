/**
 * SQLite persistence layer for symbol embedding vectors.
 *
 * Stores Float32Array embeddings as BLOB (binary) so they can be loaded back
 * after a restart and used to rebuild the HNSW in-memory index without re-calling
 * the embedding API.
 *
 * Table: embeddings
 *   symbol_id  TEXT PK  — matches symbols.id
 *   repo_id    TEXT     — for scoped queries / bulk delete
 *   embedding  BLOB     — raw Float32Array bytes (little-endian, 4 bytes per float)
 *   dimension  INTEGER  — number of floats (sanity check)
 *   provider   TEXT     — 'anthropic' | 'openai' | 'local'
 *   created_at TEXT     — ISO-8601 timestamp
 */

import type Database from 'better-sqlite3';
import { StorageError } from '../errors.js';

// ─── DDL (called from schema init) ───────────────────────────────────────────

export const EMBEDDINGS_DDL = `
CREATE TABLE IF NOT EXISTS embeddings (
  symbol_id  TEXT    NOT NULL,
  repo_id    TEXT    NOT NULL,
  embedding  BLOB    NOT NULL,
  dimension  INTEGER NOT NULL,
  provider   TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  tenant_id  TEXT    NOT NULL DEFAULT 'local',
  PRIMARY KEY (symbol_id, repo_id),
  FOREIGN KEY (symbol_id, repo_id) REFERENCES symbols(id, repo_id) ON DELETE CASCADE,
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_embeddings_repo ON embeddings(repo_id);
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function bufferToFloat32(buf: Buffer): Float32Array {
  // Buffer.from may share memory — copy to ensure alignment
  const ab = new ArrayBuffer(buf.length);
  buf.copy(Buffer.from(ab));
  return new Float32Array(ab);
}

// ─── Operations ───────────────────────────────────────────────────────────────

/**
 * Persist a batch of embeddings to SQLite.
 * Replaces any existing embedding for the same (symbol_id, repo_id) pair.
 */
export function saveEmbeddings(
  db: Database.Database,
  repoId: string,
  provider: string,
  embeddings: Map<string, Float32Array>,
  tenantId = 'local',
): void {
  if (embeddings.size === 0) return;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO embeddings (symbol_id, repo_id, embedding, dimension, provider, created_at, tenant_id)
    VALUES (@symbolId, @repoId, @embedding, @dimension, @provider, @createdAt, @tenantId)
  `);

  const createdAt = new Date().toISOString();

  const insert = db.transaction(() => {
    for (const [symbolId, vec] of embeddings) {
      try {
        stmt.run({
          symbolId,
          repoId,
          embedding: float32ToBuffer(vec),
          dimension: vec.length,
          provider,
          createdAt,
          tenantId,
        });
      } catch (err) {
        throw new StorageError(`Failed to save embedding for symbol ${symbolId}`, 'saveEmbeddings', err);
      }
    }
  });

  insert();
}

/**
 * Load all embeddings for a repo.
 * Returns a Map from symbol_id → Float32Array.
 */
export function loadEmbeddings(
  db: Database.Database,
  repoId: string,
): Map<string, Float32Array> {
  interface EmbeddingRow {
    symbol_id: string;
    embedding: Buffer;
    dimension: number;
  }

  const rows = db.prepare<[string], EmbeddingRow>(
    'SELECT symbol_id, embedding, dimension FROM embeddings WHERE repo_id = ?',
  ).all(repoId);

  const result = new Map<string, Float32Array>();
  for (const row of rows) {
    const vec = bufferToFloat32(row.embedding);
    if (vec.length !== row.dimension) {
      // Corrupted row — skip rather than crash
      continue;
    }
    result.set(row.symbol_id, vec);
  }
  return result;
}

/**
 * Delete embeddings for specific symbol IDs (e.g., when symbols are removed).
 */
export function deleteEmbeddings(
  db: Database.Database,
  symbolIds: string[],
): void {
  if (symbolIds.length === 0) return;

  const del = db.transaction(() => {
    const stmt = db.prepare('DELETE FROM embeddings WHERE symbol_id = ?');
    for (const id of symbolIds) {
      stmt.run(id);
    }
  });
  del();
}

/**
 * Delete all embeddings for a repo (e.g., on full re-index).
 */
export function deleteAllEmbeddings(db: Database.Database, repoId: string): void {
  db.prepare('DELETE FROM embeddings WHERE repo_id = ?').run(repoId);
}

/**
 * Return the number of stored embeddings for a repo.
 */
export function countEmbeddings(db: Database.Database, repoId: string): number {
  const row = db.prepare<[string], { n: number }>(
    'SELECT COUNT(*) AS n FROM embeddings WHERE repo_id = ?',
  ).get(repoId);
  return row?.n ?? 0;
}
