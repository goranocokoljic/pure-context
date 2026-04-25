import type Database from 'better-sqlite3';
import type { SymbolRecord, SymbolKind } from '../types.js';
import { StorageError } from '../errors.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DbSymbolRow {
  id: string;
  repo_id: string;
  name: string;
  kind: string;
  file_path: string;
  start_byte: number;
  end_byte: number;
  signature: string;
  summary: string;
  framework_meta: string | null;
  indexed_at: number;
}

export interface SearchOptions {
  kind?: SymbolKind;
  filePath?: string;
  limit?: number;
  /** When provided, results are filtered to this tenant only. */
  tenantId?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the file stem (basename without extension) from a relative file path. */
function getFileStem(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function rowToSymbol(row: DbSymbolRow): SymbolRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as SymbolKind,
    filePath: row.file_path,
    startByte: row.start_byte,
    endByte: row.end_byte,
    signature: row.signature,
    summary: row.summary,
    frameworkMeta: row.framework_meta
      ? (JSON.parse(row.framework_meta) as Record<string, unknown>)
      : undefined,
  };
}

// ─── Operations ───────────────────────────────────────────────────────────────

export function insertSymbols(
  db: Database.Database,
  repoId: string,
  symbols: SymbolRecord[],
  tenantId = 'local',
): void {
  if (symbols.length === 0) return;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO symbols
      (id, repo_id, name, kind, file_path, start_byte, end_byte, signature, summary, framework_meta, indexed_at, tenant_id)
    VALUES
      (@id, @repoId, @name, @kind, @filePath, @startByte, @endByte, @signature, @summary, @frameworkMeta, @indexedAt, @tenantId)
  `);

  const now = Date.now();
  const delFts = db.prepare('DELETE FROM fts_symbols WHERE symbol_id = ? AND repo_id = ?');
  const insFts = db.prepare(
    'INSERT INTO fts_symbols (symbol_id, repo_id, content) VALUES (?, ?, ?)',
  );

  const insert = db.transaction((rows: SymbolRecord[]) => {
    for (const s of rows) {
      try {
        stmt.run({
          id: s.id,
          repoId,
          name: s.name,
          kind: s.kind,
          filePath: s.filePath,
          startByte: s.startByte,
          endByte: s.endByte,
          signature: s.signature,
          summary: s.summary,
          frameworkMeta: s.frameworkMeta ? JSON.stringify(s.frameworkMeta) : null,
          indexedAt: now,
          tenantId,
        });
        // Keep FTS5 index in sync
        delFts.run(s.id, repoId);
        insFts.run(s.id, repoId, `${s.name} ${getFileStem(s.filePath)} ${s.signature} ${s.summary}`);
      } catch (err) {
        throw new StorageError(`Failed to insert symbol "${s.name}"`, 'insertSymbols', err);
      }
    }
  });

  insert(symbols);
}

export function searchSymbols(
  db: Database.Database,
  repoId: string,
  query: string,
  options: SearchOptions = {},
): SymbolRecord[] {
  const { kind, filePath, limit = 50, tenantId } = options;
  const parts: string[] = ['repo_id = ?'];
  const params: unknown[] = [repoId];

  parts.push('name LIKE ?');
  params.push(`%${query}%`);

  if (kind) {
    parts.push('kind = ?');
    params.push(kind);
  }
  if (filePath) {
    parts.push('file_path = ?');
    params.push(filePath);
  }
  if (tenantId !== undefined) {
    parts.push('tenant_id = ?');
    params.push(tenantId);
  }

  const sql = `SELECT * FROM symbols WHERE ${parts.join(' AND ')} ORDER BY name LIMIT ?`;
  params.push(limit);

  return db.prepare<unknown[], DbSymbolRow>(sql).all(...params).map(rowToSymbol);
}

export function getSymbolById(
  db: Database.Database,
  repoId: string,
  id: string,
  tenantId?: string,
): SymbolRecord | null {
  if (tenantId !== undefined) {
    const row = db.prepare<[string, string, string], DbSymbolRow>(
      'SELECT * FROM symbols WHERE repo_id = ? AND id = ? AND tenant_id = ?',
    ).get(repoId, id, tenantId);
    return row ? rowToSymbol(row) : null;
  }
  const row = db.prepare<[string, string], DbSymbolRow>(
    'SELECT * FROM symbols WHERE repo_id = ? AND id = ?',
  ).get(repoId, id);
  return row ? rowToSymbol(row) : null;
}

export function getSymbolsByFile(
  db: Database.Database,
  repoId: string,
  filePath: string,
  tenantId?: string,
): SymbolRecord[] {
  if (tenantId !== undefined) {
    return db
      .prepare<[string, string, string], DbSymbolRow>(
        'SELECT * FROM symbols WHERE repo_id = ? AND file_path = ? AND tenant_id = ? ORDER BY start_byte',
      )
      .all(repoId, filePath, tenantId)
      .map(rowToSymbol);
  }
  return db
    .prepare<[string, string], DbSymbolRow>(
      'SELECT * FROM symbols WHERE repo_id = ? AND file_path = ? ORDER BY start_byte',
    )
    .all(repoId, filePath)
    .map(rowToSymbol);
}

export function getSymbolsByRepo(
  db: Database.Database,
  repoId: string,
  limit = 1000,
  tenantId?: string,
): SymbolRecord[] {
  if (tenantId !== undefined) {
    return db
      .prepare<[string, string, number], DbSymbolRow>(
        'SELECT * FROM symbols WHERE repo_id = ? AND tenant_id = ? ORDER BY file_path, start_byte LIMIT ?',
      )
      .all(repoId, tenantId, limit)
      .map(rowToSymbol);
  }
  return db
    .prepare<[string, number], DbSymbolRow>(
      'SELECT * FROM symbols WHERE repo_id = ? ORDER BY file_path, start_byte LIMIT ?',
    )
    .all(repoId, limit)
    .map(rowToSymbol);
}

export function deleteByFile(
  db: Database.Database,
  repoId: string,
  filePath: string,
): void {
  // Remove from FTS first (needs symbol IDs which exist before main delete)
  deleteFtsByFile(db, repoId, filePath);
  db.prepare('DELETE FROM symbols WHERE repo_id = ? AND file_path = ?').run(repoId, filePath);
}

// ─── Embedding operations ─────────────────────────────────────────────────────

interface DbEmbeddingRow {
  id: string;
  repo_id: string;
  embedding: Buffer | null;
}

/**
 * Store packed embedding bytes for a symbol.
 * Embeddings are stored as raw Float32Array bytes (4 bytes per dimension).
 */
export function upsertEmbedding(
  db: Database.Database,
  repoId: string,
  symbolId: string,
  embedding: Buffer,
): void {
  db.prepare(
    'UPDATE symbols SET embedding = ? WHERE repo_id = ? AND id = ?',
  ).run(embedding, repoId, symbolId);
}

/**
 * Load all symbols that have stored embeddings for a repo.
 * Returns { symbol, embedding } pairs.
 */
export function getSymbolsWithEmbeddings(
  db: Database.Database,
  repoId: string,
): Array<{ symbol: SymbolRecord; embedding: Buffer }> {
  const rows = db
    .prepare<[string], DbSymbolRow & { embedding: Buffer | null }>(
      'SELECT * FROM symbols WHERE repo_id = ? AND embedding IS NOT NULL',
    )
    .all(repoId);

  return rows
    .filter((r): r is typeof r & { embedding: Buffer } => r.embedding !== null)
    .map((r) => ({ symbol: rowToSymbol(r), embedding: r.embedding }));
}

// ─── FTS5 operations ──────────────────────────────────────────────────────────

/**
 * Insert/replace a symbol into the FTS5 full-text search index.
 * Content = name + signature + summary (space-joined for broad matching).
 */
export function upsertFtsSymbol(
  db: Database.Database,
  repoId: string,
  symbol: SymbolRecord,
): void {
  // Delete any existing entry first (FTS5 doesn't support UPSERT).
  db.prepare('DELETE FROM fts_symbols WHERE symbol_id = ? AND repo_id = ?').run(symbol.id, repoId);
  db.prepare(
    'INSERT INTO fts_symbols (symbol_id, repo_id, content) VALUES (?, ?, ?)',
  ).run(symbol.id, repoId, `${symbol.name} ${getFileStem(symbol.filePath)} ${symbol.signature} ${symbol.summary}`);
}

/**
 * Bulk-insert symbols into the FTS5 index. Replaces any existing entries.
 */
export function bulkUpsertFtsSymbols(
  db: Database.Database,
  repoId: string,
  symbols: SymbolRecord[],
): void {
  if (symbols.length === 0) return;

  const del = db.prepare('DELETE FROM fts_symbols WHERE symbol_id = ? AND repo_id = ?');
  const ins = db.prepare(
    'INSERT INTO fts_symbols (symbol_id, repo_id, content) VALUES (?, ?, ?)',
  );

  const upsert = db.transaction((rows: SymbolRecord[]) => {
    for (const s of rows) {
      del.run(s.id, repoId);
      ins.run(s.id, repoId, `${s.name} ${getFileStem(s.filePath)} ${s.signature} ${s.summary}`);
    }
  });

  upsert(symbols);
}

export interface FtsSearchOptions {
  kind?: SymbolKind;
  filePath?: string;
  limit?: number;
  tenantId?: string;
}

/**
 * Search symbols using FTS5 full-text search.
 * Returns matching SymbolRecords sorted by BM25 relevance (most relevant first).
 */
export function ftsSearchSymbols(
  db: Database.Database,
  repoId: string,
  query: string,
  options: FtsSearchOptions = {},
): SymbolRecord[] {
  const { kind, filePath, limit = 20, tenantId } = options;

  const parts: string[] = ['f.repo_id = ?', 'fts_symbols MATCH ?'];
  const params: unknown[] = [repoId, query];

  if (tenantId !== undefined) {
    parts.push('s.tenant_id = ?');
    params.push(tenantId);
  }
  if (kind) {
    parts.push('s.kind = ?');
    params.push(kind);
  }
  if (filePath) {
    parts.push('s.file_path LIKE ?');
    params.push(filePath);
  }

  params.push(limit);

  const sql = `
    SELECT s.*
    FROM symbols s
    JOIN fts_symbols f ON f.symbol_id = s.id AND f.repo_id = s.repo_id
    WHERE ${parts.join(' AND ')}
    ORDER BY bm25(fts_symbols)
    LIMIT ?
  `;

  return db.prepare<unknown[], DbSymbolRow>(sql).all(...params).map(rowToSymbol);
}

/**
 * Returns true if the FTS5 index has been populated for this repo.
 * Used to decide whether to use FTS or fall back to LIKE search.
 */
export function hasFtsIndex(db: Database.Database, repoId: string): boolean {
  const row = db
    .prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM fts_symbols WHERE repo_id = ?')
    .get(repoId);
  return (row?.c ?? 0) > 0;
}

/**
 * Delete FTS5 entries for all symbols in a file (called when a file is reindexed).
 */
export function deleteFtsByFile(
  db: Database.Database,
  repoId: string,
  filePath: string,
): void {
  // Look up symbol IDs for this file, then delete from FTS.
  const ids = db
    .prepare<[string, string], { id: string }>(
      'SELECT id FROM symbols WHERE repo_id = ? AND file_path = ?',
    )
    .all(repoId, filePath)
    .map((r) => r.id);

  const del = db.prepare('DELETE FROM fts_symbols WHERE symbol_id = ? AND repo_id = ?');
  const cleanup = db.transaction((idList: string[]) => {
    for (const id of idList) {
      del.run(id, repoId);
    }
  });
  cleanup(ids);
}

/**
 * Bulk-update the summary field for a set of symbols identified by id.
 * Used by the AI summarizer (Stage 3) to apply generated summaries after
 * indexing completes. Skips ids not present in the database.
 */
export function updateSymbolSummaries(
  db: Database.Database,
  repoId: string,
  summaries: Map<string, string>,
): void {
  if (summaries.size === 0) return;

  const stmt = db.prepare(
    'UPDATE symbols SET summary = ? WHERE repo_id = ? AND id = ?',
  );

  const update = db.transaction((entries: [string, string][]) => {
    for (const [id, summary] of entries) {
      stmt.run(summary, repoId, id);
    }
  });

  update([...summaries.entries()]);
}
