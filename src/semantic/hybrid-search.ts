/**
 * HybridSearcher — combines FTS5 keyword search with HNSW semantic search
 * using Reciprocal Rank Fusion (RRF).
 *
 * Algorithm:
 *   1. Run FTS5 → get top-N keyword-ranked symbols
 *   2. Run semantic (HNSW) → get top-N vector-ranked symbols
 *   3. Merge via RRF: score = kw_weight * 1/(k+kwRank) + sem_weight * 1/(k+semRank)
 *   4. Sort descending by combined score; return top maxResults
 *
 * When no semantic index exists (VectorStore.size === 0), the searcher falls
 * back to keyword-only mode silently.
 */

import type Database from 'better-sqlite3';
import { ftsSearchSymbols } from '../core/db/symbol-store.js';
import type { SymbolRecord } from '../core/types.js';
import { logger } from '../core/logger.js';
import type { VectorStore } from './vector-store.js';
import { expandQuery } from './query-expansion.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SearchOptions {
  /** Maximum results to return (default: 10). */
  maxResults?: number;
  /** Weight given to keyword rank in RRF (default: 0.5). */
  keywordWeight?: number;
  /** Weight given to semantic rank in RRF (default: 0.5). */
  semanticWeight?: number;
  /** Minimum combined RRF score to include in results (default: 0). */
  threshold?: number;
  /** Filter by symbol kind. */
  kind?: string;
  /** Filter by file path prefix. */
  filePattern?: string;
  /** Use query expansion to improve recall (default: true). */
  expandQuery?: boolean;
  /** Return per-result score breakdown in debug fields (default: false). */
  debug?: boolean;
}

export interface HybridSearchResult {
  symbol: SymbolRecord;
  keywordScore: number;
  semanticScore: number;
  combinedScore: number;
  /** Raw cosine distance from HNSW (0 = identical, 2 = opposite). Only set when SearchOptions.debug=true and semantic was used. */
  rawCosineDistance?: number;
}

// ─── RRF constant ─────────────────────────────────────────────────────────────

/** Standard RRF k constant — smoothes rank differences. */
const RRF_K = 60;

// ─── HybridSearcher ───────────────────────────────────────────────────────────

export class HybridSearcher {
  private readonly repoId: string;
  private readonly vectorStore: VectorStore;
  private readonly db: Database.Database;

  constructor(repoId: string, vectorStore: VectorStore, db: Database.Database) {
    this.repoId = repoId;
    this.vectorStore = vectorStore;
    this.db = db;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async search(query: string, options: SearchOptions = {}): Promise<HybridSearchResult[]> {
    const {
      maxResults = 10,
      keywordWeight = 0.5,
      semanticWeight = 0.5,
      threshold = 0,
      kind,
      filePattern,
      expandQuery: doExpand = true,
      debug = false,
    } = options;

    const hasSemanticIndex = this.vectorStore.size > 0;

    // Determine effective mode
    const useKeyword = keywordWeight > 0;
    const useSemantic = semanticWeight > 0 && hasSemanticIndex;

    const candidateCount = Math.max(maxResults * 4, 40); // over-fetch for merging

    // ── Step 1: FTS keyword search ────────────────────────────────────────────
    const keywordResults: SymbolRecord[] = [];
    if (useKeyword) {
      const ftsQuery = buildFtsQuery(query);
      try {
        const rows = ftsSearchSymbols(this.db, this.repoId, ftsQuery, { limit: candidateCount });
        keywordResults.push(...rows);
      } catch {
        // FTS query can fail on special characters — fall back to empty
        logger.debug('HybridSearcher: FTS query failed, continuing without keyword results', { query });
      }
    }

    // ── Step 2: Semantic vector search ────────────────────────────────────────
    const semanticIdsByRank: string[] = [];
    // Track raw cosine distances for debug mode
    const semDistanceOf = new Map<string, number>(); // symbolId → cosine distance
    if (useSemantic) {
      const queries = doExpand ? expandQuery(query) : [query];
      // Collect semantic hits across all query variations; de-dup by ID, preserve first rank
      const seenSemantic = new Set<string>();
      for (const q of queries) {
        const hits = await this.vectorStore.searchSimilar(q, candidateCount);
        for (const hit of hits) {
          if (!seenSemantic.has(hit.id)) {
            seenSemantic.add(hit.id);
            semanticIdsByRank.push(hit.id);
            if (debug) semDistanceOf.set(hit.id, hit.distance);
          }
        }
        if (semanticIdsByRank.length >= candidateCount) break;
      }
    }

    // ── Step 3: Build ranked maps ─────────────────────────────────────────────
    const kwRankOf = new Map<string, number>(); // symbolId → 1-based rank
    for (let i = 0; i < keywordResults.length; i++) {
      kwRankOf.set(keywordResults[i].id, i + 1);
    }

    const semRankOf = new Map<string, number>(); // symbolId → 1-based rank
    for (let i = 0; i < semanticIdsByRank.length; i++) {
      semRankOf.set(semanticIdsByRank[i], i + 1);
    }

    // ── Step 4: Collect all candidate symbol IDs ──────────────────────────────
    const allIds = new Set<string>([
      ...keywordResults.map((s) => s.id),
      ...semanticIdsByRank,
    ]);

    // ── Step 5: Build symbol map (keyword results already fetched; semantic IDs
    //            need lookup from DB for symbols not in keyword results) ────────
    const symbolById = new Map<string, SymbolRecord>();
    for (const sym of keywordResults) {
      symbolById.set(sym.id, sym);
    }
    // Fetch semantic-only symbols from DB in one query
    const missingIds = [...allIds].filter((id) => !symbolById.has(id));
    if (missingIds.length > 0) {
      const fetched = fetchSymbolsByIds(this.db, this.repoId, missingIds);
      for (const sym of fetched) {
        symbolById.set(sym.id, sym);
      }
    }

    // ── Step 6: RRF scoring ───────────────────────────────────────────────────
    const scored: HybridSearchResult[] = [];

    for (const id of allIds) {
      const symbol = symbolById.get(id);
      if (!symbol) continue;

      // Apply filters
      if (kind && symbol.kind !== kind) continue;
      if (filePattern && !symbol.filePath.includes(filePattern)) continue;

      const kwRank = kwRankOf.get(id);
      const semRank = semRankOf.get(id);

      const keywordScore = kwRank !== undefined && useKeyword
        ? keywordWeight * (1 / (RRF_K + kwRank))
        : 0;

      const semanticScore = semRank !== undefined && useSemantic
        ? semanticWeight * (1 / (RRF_K + semRank))
        : 0;

      const combinedScore = keywordScore + semanticScore;

      if (combinedScore < threshold) continue;

      const result: HybridSearchResult = { symbol, keywordScore, semanticScore, combinedScore };
      if (debug) {
        const dist = semDistanceOf.get(id);
        if (dist !== undefined) result.rawCosineDistance = dist;
      }
      scored.push(result);
    }

    // ── Step 7: Sort and return ───────────────────────────────────────────────
    scored.sort((a, b) => b.combinedScore - a.combinedScore);
    return scored.slice(0, maxResults);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a plain search query to a safe FTS5 query string.
 * Wraps terms in quotes to handle special characters; falls back to
 * prefix matching for single words.
 */
function buildFtsQuery(query: string): string {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '""';
  // Use prefix matching on each token: `auth*`
  return words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(' ');
}

/**
 * Bulk-fetch SymbolRecords by ID for a given repo.
 * Uses a single SQL query with placeholders.
 */
function fetchSymbolsByIds(
  db: Database.Database,
  repoId: string,
  ids: string[],
): SymbolRecord[] {
  if (ids.length === 0) return [];

  interface DbRow {
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

  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare<unknown[], DbRow>(
      `SELECT * FROM symbols WHERE repo_id = ? AND id IN (${placeholders})`,
    )
    .all(repoId, ...ids);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind as SymbolRecord['kind'],
    filePath: r.file_path,
    startByte: r.start_byte,
    endByte: r.end_byte,
    signature: r.signature,
    summary: r.summary,
    frameworkMeta: r.framework_meta
      ? (JSON.parse(r.framework_meta) as Record<string, unknown>)
      : undefined,
  }));
}
