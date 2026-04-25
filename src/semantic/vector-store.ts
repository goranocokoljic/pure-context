/**
 * VectorStore — coordinates embedding generation, HNSW indexing, and SQLite persistence.
 *
 * Lifecycle:
 *   1. `indexSymbols(symbols)` — embed + add to HNSW + persist embeddings to SQLite
 *   2. `searchSimilar(query, k)` — embed query → HNSW search → return SymbolRecords
 *   3. `removeSymbols(ids)` — mark deleted in HNSW + delete from SQLite
 *   4. `rebuild()` — load embeddings from SQLite and reconstruct the HNSW in-memory
 *
 * The HNSW index is held in memory. On startup, call `rebuild()` to restore from disk
 * (SQLite embeddings are faster to reload than re-calling the embedding API).
 *
 * Index file: `~/.purecontext/indexes/{repoId}/hnsw.idx`
 */

import { join } from 'path';
import { homedir } from 'os';
import type Database from 'better-sqlite3';
import type { SymbolRecord } from '../core/types.js';
import { PureContextError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import { HNSWIndex } from './hnsw-index.js';
import { prepareSymbolText } from './text-preparation.js';
import {
  saveEmbeddings,
  loadEmbeddings,
  deleteEmbeddings,
  deleteAllEmbeddings,
} from '../core/db/embedding-store.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VectorStoreOptions {
  /** Max elements the HNSW index can hold (default: 200_000). */
  maxElements?: number;
  /** HNSW M parameter — connections per node (default: 16). */
  M?: number;
  /** HNSW efConstruction — build quality (default: 200). */
  efConstruction?: number;
  /** HNSW efSearch — search quality (default: 100). */
  efSearch?: number;
  /** Root directory for index files (default: ~/.purecontext/indexes). */
  indexDir?: string;
}

// ─── VectorStore ─────────────────────────────────────────────────────────────

export class VectorStore {
  private readonly repoId: string;
  private readonly provider: EmbeddingProvider;
  private readonly db: Database.Database;
  private readonly indexPath: string;
  private readonly maxElements: number;
  private readonly M: number;
  private readonly efConstruction: number;
  private readonly efSearch: number;

  private hnsw: HNSWIndex;

  constructor(
    repoId: string,
    provider: EmbeddingProvider,
    db: Database.Database,
    options: VectorStoreOptions = {},
  ) {
    this.repoId = repoId;
    this.provider = provider;
    this.db = db;

    this.maxElements = options.maxElements ?? 200_000;
    this.M = options.M ?? 16;
    this.efConstruction = options.efConstruction ?? 200;
    this.efSearch = options.efSearch ?? 100;

    const indexDir = options.indexDir ?? join(homedir(), '.purecontext', 'indexes', repoId);
    this.indexPath = join(indexDir, 'hnsw.idx');

    this.hnsw = this.makeIndex();
  }

  private makeIndex(): HNSWIndex {
    return new HNSWIndex(
      this.provider.dimension,
      this.maxElements,
      this.M,
      this.efConstruction,
      this.efSearch,
    );
  }

  // ─── Indexing ────────────────────────────────────────────────────────────

  /**
   * Embed `symbols` and add them to the HNSW index and SQLite embeddings table.
   * Already-indexed symbols (by ID) are skipped.
   */
  async indexSymbols(symbols: SymbolRecord[]): Promise<void> {
    if (symbols.length === 0) return;

    logger.info('VectorStore: embedding symbols', { repoId: this.repoId, count: symbols.length });

    // Prepare texts
    const texts = symbols.map((s) => prepareSymbolText(s, this.provider.maxTokens));

    // Embed in one call (provider handles internal batching)
    const vectors = await this.provider.embed(texts);

    if (vectors.length !== symbols.length) {
      throw new PureContextError(
        `VectorStore: provider returned ${vectors.length} vectors for ${symbols.length} symbols`,
      );
    }

    // Add to HNSW
    const ids = symbols.map((s) => s.id);
    this.hnsw.add(ids, vectors);

    // Persist to SQLite
    const embeddingMap = new Map<string, Float32Array>();
    for (let i = 0; i < symbols.length; i++) {
      embeddingMap.set(symbols[i].id, vectors[i]);
    }
    saveEmbeddings(this.db, this.repoId, this.provider.name, embeddingMap);

    logger.info('VectorStore: indexed symbols', {
      repoId: this.repoId,
      indexed: symbols.length,
      total: this.hnsw.size(),
    });
  }

  // ─── Search ──────────────────────────────────────────────────────────────

  /**
   * Find the `k` most similar symbols to `query` text.
   * Returns IDs sorted by ascending cosine distance (nearest first).
   */
  async searchSimilar(query: string, k: number): Promise<Array<{ id: string; distance: number }>> {
    if (this.hnsw.size() === 0) return [];

    const [queryVec] = await this.provider.embed([query]);
    if (!queryVec) throw new PureContextError('VectorStore: embedding provider returned no vector for query');

    return this.hnsw.search(queryVec, k);
  }

  // ─── Removal ─────────────────────────────────────────────────────────────

  /**
   * Remove symbols from the HNSW index and SQLite embeddings.
   */
  removeSymbols(ids: string[]): void {
    if (ids.length === 0) return;
    this.hnsw.remove(ids);
    deleteEmbeddings(this.db, ids);
    logger.debug('VectorStore: removed symbols', { count: ids.length });
  }

  // ─── Rebuild ─────────────────────────────────────────────────────────────

  /**
   * Reconstruct the in-memory HNSW index from embeddings stored in SQLite.
   * Call this on startup instead of re-embedding all symbols.
   */
  async rebuild(): Promise<void> {
    logger.info('VectorStore: rebuilding HNSW from SQLite embeddings', { repoId: this.repoId });

    const embeddings = loadEmbeddings(this.db, this.repoId);
    if (embeddings.size === 0) {
      logger.info('VectorStore: no embeddings found, starting fresh', { repoId: this.repoId });
      return;
    }

    this.hnsw = this.makeIndex();

    const ids = [...embeddings.keys()];
    const vectors = [...embeddings.values()];
    this.hnsw.add(ids, vectors);

    logger.info('VectorStore: rebuilt HNSW', { repoId: this.repoId, size: this.hnsw.size() });
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  /**
   * Save the HNSW index to disk.
   * Call after bulk indexing to avoid rebuilding on next startup.
   */
  saveIndex(): void {
    this.hnsw.save(this.indexPath);
  }

  /**
   * Load the HNSW index from disk (if it exists).
   * Faster than `rebuild()` — no SQLite round-trip.
   */
  loadIndex(): boolean {
    try {
      this.hnsw = this.makeIndex();
      this.hnsw.load(this.indexPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Full re-index: clear all embeddings and rebuild from scratch.
   */
  async fullReindex(symbols: SymbolRecord[]): Promise<void> {
    deleteAllEmbeddings(this.db, this.repoId);
    this.hnsw = this.makeIndex();
    await this.indexSymbols(symbols);
  }

  // ─── Accessors ───────────────────────────────────────────────────────────

  /** Number of live vectors in the HNSW index. */
  get size(): number {
    return this.hnsw.size();
  }
}
