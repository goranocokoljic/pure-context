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
  line_count: number | null;
  cyclomatic_complexity: number | null;
  cognitive_complexity: number | null;
  param_count: number | null;
  return_count: number | null;
  nesting_depth: number | null;
}

interface DbSymbolRowFts extends DbSymbolRow {
  fts_bm25: number;
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

/**
 * Return lowercase split tokens for a symbol name, for inclusion in the
 * FTS5 content field alongside the original name.
 *
 * FTS5's unicode61 tokenizer treats "FrontController" as a single token,
 * making partial-word matches like "controller" impossible. By appending
 * the split parts ("front controller") to the FTS5 document, we enable
 * sub-identifier lookups without changing the tokenizer configuration.
 *
 * Handles three cases:
 *  - Pure camelCase/PascalCase ("FrontController" → "front controller")
 *  - Hybrid snake_case with camelCase segments ("CIR_FrontController" →
 *    "front controller"). FTS5 already splits on the underscore, but the
 *    individual segments ("frontcontroller") remain opaque tokens.
 *  - Simple snake_case ("get_user_by_id") — no expansion needed since FTS5
 *    splits all segments into individual lowercase words already.
 *
 * Returns an empty string when no expansion is needed.
 */
function splitNameForFts(name: string): string {
  // All-caps acronym (MCP, HTTP, URL) — no camelCase boundary to detect.
  if (/^[A-Z\d]+$/.test(name)) return '';

  if (name.includes('_')) {
    // For snake_case names: FTS5 already splits on underscores, so plain
    // lowercase segments ("get", "user") don't need re-indexing.
    // BUT segments that are themselves camelCase (e.g. "FrontController" in
    // "CIR_FrontController") are treated as a single FTS5 token and must be
    // split explicitly so that "front" and "controller" become searchable.
    const parts: string[] = [];
    for (const seg of name.split('_')) {
      if (seg.length < 2) continue;
      if (seg === seg.toLowerCase()) continue; // plain lowercase — FTS5 handles it
      if (/^[A-Z\d]+$/.test(seg)) continue;   // all-caps acronym segment (CIR, HTTP)
      const camelParts = splitCamelParts(seg);
      if (camelParts.length > 1) parts.push(...camelParts);
    }
    if (parts.length === 0) return '';
    return [...new Set(parts)].join(' ');
  }

  // Pure camelCase / PascalCase
  const parts = splitCamelParts(name);
  if (parts.length <= 1) return '';
  return parts.join(' ');
}

/**
 * Split a single camelCase or PascalCase token into lowercase word parts.
 * Returns the original (lowercased) token as a single-element array when no
 * split boundaries are detected (e.g. all-caps acronyms, single words).
 */
function splitCamelParts(token: string): string[] {
  const spaced = token
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return spaced.split(' ').filter((t) => t.length >= 2).map((t) => t.toLowerCase());
}

/**
 * Build the FTS5 content string for a symbol.
 *
 * Includes:
 *  - Original name (e.g. "FrontController")
 *  - CamelCase-split name parts (e.g. "front controller") — enables partial-word search
 *  - File stem (e.g. "UserController")
 *  - Full signature and summary
 *  - Body snippet (first ~200 bytes of function body, when available)
 */
function buildFtsContent(s: SymbolRecord): string {
  return [s.name, splitNameForFts(s.name), getFileStem(s.filePath), s.signature, s.summary, s.bodySnippet ?? '']
    .filter(Boolean)
    .join(' ');
}

function rowToSymbol(row: DbSymbolRow): SymbolRecord {
  const sym: SymbolRecord = {
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
  if (row.line_count !== null && row.line_count !== undefined) {
    sym.metrics = {
      lineCount: row.line_count,
      cyclomaticComplexity: row.cyclomatic_complexity ?? 1,
      cognitiveComplexity: row.cognitive_complexity ?? 0,
      paramCount: row.param_count ?? 0,
      returnCount: row.return_count ?? 0,
      nestingDepth: row.nesting_depth ?? 0,
    };
  }
  return sym;
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
      (id, repo_id, name, kind, file_path, start_byte, end_byte, signature, summary, framework_meta, indexed_at, tenant_id,
       line_count, cyclomatic_complexity, cognitive_complexity, param_count, return_count, nesting_depth)
    VALUES
      (@id, @repoId, @name, @kind, @filePath, @startByte, @endByte, @signature, @summary, @frameworkMeta, @indexedAt, @tenantId,
       @lineCount, @cyclomaticComplexity, @cognitiveComplexity, @paramCount, @returnCount, @nestingDepth)
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
          lineCount: s.metrics?.lineCount ?? null,
          cyclomaticComplexity: s.metrics?.cyclomaticComplexity ?? null,
          cognitiveComplexity: s.metrics?.cognitiveComplexity ?? null,
          paramCount: s.metrics?.paramCount ?? null,
          returnCount: s.metrics?.returnCount ?? null,
          nestingDepth: s.metrics?.nestingDepth ?? null,
        });
        // Keep FTS5 index in sync
        delFts.run(s.id, repoId);
        insFts.run(s.id, repoId, buildFtsContent(s));
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
  ).run(symbol.id, repoId, buildFtsContent(symbol));
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
      ins.run(s.id, repoId, buildFtsContent(s));
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
    SELECT s.*, bm25(fts_symbols) AS fts_bm25
    FROM symbols s
    JOIN fts_symbols f ON f.symbol_id = s.id AND f.repo_id = s.repo_id
    WHERE ${parts.join(' AND ')}
    ORDER BY bm25(fts_symbols)
    LIMIT ?
  `;

  return db.prepare<unknown[], DbSymbolRowFts>(sql).all(...params).map((row) => {
    const sym = rowToSymbol(row);
    sym.ftsBm25 = row.fts_bm25;
    return sym;
  });
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
 * Update the summary and framework_meta for a single symbol.
 * Used by context providers (e.g. dbt) to annotate indexed symbols with
 * ecosystem metadata. Keeps the FTS5 index in sync.
 */
export function updateSymbolMeta(
  db: Database.Database,
  repoId: string,
  id: string,
  summary: string,
  frameworkMeta: Record<string, unknown> | null,
): void {
  db.prepare(`
    UPDATE symbols
    SET summary = ?, framework_meta = ?
    WHERE repo_id = ? AND id = ?
  `).run(summary, frameworkMeta ? JSON.stringify(frameworkMeta) : null, repoId, id);
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

// ─── Quality metrics queries ──────────────────────────────────────────────────

export interface QualityMetricsOptions {
  scope?: string;
  kind?: SymbolKind;
  sortBy?: 'complexity' | 'size' | 'nesting' | 'params';
  threshold?: {
    cyclomaticComplexity?: number;
    lineCount?: number;
    nestingDepth?: number;
  };
  limit?: number;
  tenantId?: string;
}

export interface QualitySymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  line_count: number;
  cyclomatic_complexity: number;
  cognitive_complexity: number;
  param_count: number;
  return_count: number;
  nesting_depth: number;
}

/**
 * Query symbols that have quality metrics, applying optional filters and sorting.
 * Only returns symbols that were indexed with metrics (non-null line_count).
 */
export function queryQualityMetrics(
  db: Database.Database,
  repoId: string,
  options: QualityMetricsOptions = {},
): QualitySymbolRow[] {
  const { scope, kind, sortBy = 'complexity', threshold = {}, limit = 20, tenantId } = options;

  const parts: string[] = ['repo_id = ?', 'line_count IS NOT NULL'];
  const params: unknown[] = [repoId];

  if (tenantId !== undefined) {
    parts.push('tenant_id = ?');
    params.push(tenantId);
  }
  if (scope) {
    parts.push('file_path LIKE ?');
    params.push(`${scope}%`);
  }
  if (kind) {
    parts.push('kind = ?');
    params.push(kind);
  }
  if (threshold.cyclomaticComplexity !== undefined) {
    parts.push('cyclomatic_complexity >= ?');
    params.push(threshold.cyclomaticComplexity);
  }
  if (threshold.lineCount !== undefined) {
    parts.push('line_count >= ?');
    params.push(threshold.lineCount);
  }
  if (threshold.nestingDepth !== undefined) {
    parts.push('nesting_depth >= ?');
    params.push(threshold.nestingDepth);
  }

  const orderCol =
    sortBy === 'size'    ? 'line_count' :
    sortBy === 'nesting' ? 'nesting_depth' :
    sortBy === 'params'  ? 'param_count' :
    'cyclomatic_complexity'; // default: 'complexity'

  params.push(limit);

  const sql = `
    SELECT id, name, kind, file_path,
           COALESCE(line_count, 0)            AS line_count,
           COALESCE(cyclomatic_complexity, 1)  AS cyclomatic_complexity,
           COALESCE(cognitive_complexity, 0)   AS cognitive_complexity,
           COALESCE(param_count, 0)            AS param_count,
           COALESCE(return_count, 0)           AS return_count,
           COALESCE(nesting_depth, 0)          AS nesting_depth
    FROM symbols
    WHERE ${parts.join(' AND ')}
    ORDER BY ${orderCol} DESC
    LIMIT ?
  `;

  return db.prepare<unknown[], QualitySymbolRow>(sql).all(...params);
}

/**
 * Count all symbols with quality metrics for a repo (for symbolsAnalyzed field).
 */
export function countSymbolsWithMetrics(
  db: Database.Database,
  repoId: string,
  tenantId?: string,
): number {
  if (tenantId !== undefined) {
    return db
      .prepare<[string, string], { c: number }>(
        'SELECT COUNT(*) AS c FROM symbols WHERE repo_id = ? AND tenant_id = ? AND line_count IS NOT NULL',
      )
      .get(repoId, tenantId)?.c ?? 0;
  }
  return db
    .prepare<[string], { c: number }>(
      'SELECT COUNT(*) AS c FROM symbols WHERE repo_id = ? AND line_count IS NOT NULL',
    )
    .get(repoId)?.c ?? 0;
}

// ─── Cache invalidation ───────────────────────────────────────────────────────

export interface InvalidateResult {
  repoId: string;
  repoPath: string;
  symbolsDeleted: number;
  filesDeleted: number;
}

/**
 * Delete all indexed data for a repo in a single atomic transaction.
 * Clears symbols, files, dep_edges, FTS5 entries, and embeddings.
 * The SQLite file itself is NOT deleted — only the rows.
 *
 * Returns null if the repo is not found in the database.
 */
export function invalidateCache(
  db: Database.Database,
  repoId: string,
): InvalidateResult | null {
  const repoRow = db
    .prepare<[string], { root_path: string }>('SELECT root_path FROM repos WHERE id = ?')
    .get(repoId);

  if (!repoRow) return null;

  const symbolCount =
    db.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM symbols WHERE repo_id = ?').get(repoId)?.c ?? 0;
  const fileCount =
    db.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM files WHERE repo_id = ?').get(repoId)?.c ?? 0;

  db.transaction(() => {
    // 1. FTS5 virtual-table entries (must precede symbols delete for consistency)
    db.prepare('DELETE FROM fts_symbols WHERE repo_id = ?').run(repoId);
    // 2. Embeddings
    db.prepare('DELETE FROM embeddings WHERE repo_id = ?').run(repoId);
    // 3. Dependency edges
    db.prepare('DELETE FROM dep_edges WHERE repo_id = ?').run(repoId);
    // 4. Symbols
    db.prepare('DELETE FROM symbols WHERE repo_id = ?').run(repoId);
    // 5. Files
    db.prepare('DELETE FROM files WHERE repo_id = ?').run(repoId);
    // 6. Repo metadata row
    db.prepare('DELETE FROM repos WHERE id = ?').run(repoId);
  })();

  return {
    repoId,
    repoPath: repoRow.root_path,
    symbolsDeleted: symbolCount,
    filesDeleted: fileCount,
  };
}
