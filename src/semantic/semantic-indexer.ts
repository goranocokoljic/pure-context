/**
 * SemanticIndexer — orchestrates the full semantic indexing pipeline.
 *
 * Decides whether a repo should be semantically indexed, batches symbols,
 * generates embeddings, and updates the HNSW vector store incrementally.
 *
 * The threshold gate (`shouldIndex`) keeps FTS-only search for small repos
 * where HNSW provides no benefit while adding API cost.
 */

import type Database from 'better-sqlite3';
import type { SymbolRecord } from '../core/types.js';
import type { PureContextConfig } from '../config/config-schema.js';
import { PureContextError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { createEmbeddingProvider, type EmbeddingProvider } from './embedding-provider.js';
import { VectorStore, type VectorStoreOptions } from './vector-store.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SemanticIndexResult {
  symbolsIndexed: number;
  embeddingTimeMs: number;
  indexBuildTimeMs: number;
  indexSizeBytes: number;
}

// ─── SemanticIndexer ──────────────────────────────────────────────────────────

export interface SemanticIndexerOptions {
  /** Optional overrides forwarded to VectorStore (useful for tests to set indexDir). */
  storeOptions?: VectorStoreOptions;
  /**
   * Override the embedding provider factory (used in tests to inject a mock provider
   * without having to mock the module).
   */
  providerFactory?: (config: PureContextConfig) => EmbeddingProvider;
}

export class SemanticIndexer {
  private readonly config: PureContextConfig;
  private readonly storeOptions: VectorStoreOptions;
  private readonly providerFactory: (config: PureContextConfig) => EmbeddingProvider;

  constructor(config: PureContextConfig, options: SemanticIndexerOptions = {}) {
    this.config = config;
    this.storeOptions = options.storeOptions ?? {};
    this.providerFactory = options.providerFactory ?? createEmbeddingProvider;
  }

  // ─── Gate ────────────────────────────────────────────────────────────────

  /**
   * Returns true when semantic indexing should run for this repo.
   * Requires `semantic.enabled`, a non-'none' provider, and enough symbols.
   */
  shouldIndex(_repoId: string, symbolCount: number): boolean {
    const { semantic } = this.config;
    if (!semantic.enabled) return false;
    if (semantic.provider === 'none') return false;
    return symbolCount >= semantic.threshold;
  }

  // ─── Full index ──────────────────────────────────────────────────────────

  /**
   * Embed all `symbols` and build a new HNSW index for `repoId`.
   *
   * Processing is batched according to `semantic.batchSize` and
   * parallelized up to `semantic.concurrency` concurrent batches.
   */
  async index(
    repoId: string,
    symbols: SymbolRecord[],
    db: Database.Database,
  ): Promise<SemanticIndexResult> {
    const t0 = Date.now();

    const provider = this.providerFactory(this.config);
    const store = new VectorStore(repoId, provider, db, this.storeOptions);

    logger.info('SemanticIndexer: starting full index', {
      repoId,
      symbolCount: symbols.length,
      batchSize: this.config.semantic.batchSize,
      concurrency: this.config.semantic.concurrency,
    });

    const embeddingStart = Date.now();
    await this.processBatches(store, symbols);
    const embeddingTimeMs = Date.now() - embeddingStart;

    const indexBuildStart = Date.now();
    store.saveIndex();
    const indexBuildTimeMs = Date.now() - indexBuildStart;

    const result: SemanticIndexResult = {
      symbolsIndexed: store.size,
      embeddingTimeMs,
      indexBuildTimeMs,
      // Size approximation: each vector is dimension * 4 bytes + overhead
      indexSizeBytes: store.size * provider.dimension * 4,
    };

    logger.info('SemanticIndexer: index complete', {
      repoId,
      ...result,
      totalMs: Date.now() - t0,
    });

    return result;
  }

  // ─── Incremental update ──────────────────────────────────────────────────

  /**
   * Update the HNSW index after incremental file changes.
   *
   * - `added`: new or modified symbols to embed and add
   * - `removed`: symbol IDs to remove from the index
   */
  async updateIncremental(
    repoId: string,
    added: SymbolRecord[],
    removed: string[],
    db: Database.Database,
  ): Promise<void> {
    if (added.length === 0 && removed.length === 0) return;

    const provider = this.providerFactory(this.config);
    const store = new VectorStore(repoId, provider, db, this.storeOptions);

    // Restore in-memory HNSW from disk or SQLite
    const loaded = store.loadIndex();
    if (!loaded) {
      await store.rebuild();
    }

    if (removed.length > 0) {
      store.removeSymbols(removed);
      logger.debug('SemanticIndexer: removed symbols', { repoId, count: removed.length });
    }

    if (added.length > 0) {
      await this.processBatches(store, added);
      logger.debug('SemanticIndexer: added symbols', { repoId, count: added.length });
    }

    store.saveIndex();
    logger.info('SemanticIndexer: incremental update complete', {
      repoId,
      added: added.length,
      removed: removed.length,
    });
  }

  // ─── Batch processing ────────────────────────────────────────────────────

  /**
   * Split `symbols` into batches and embed them with bounded concurrency.
   */
  private async processBatches(store: VectorStore, symbols: SymbolRecord[]): Promise<void> {
    const { batchSize, concurrency } = this.config.semantic;

    // Slice into batches
    const batches: SymbolRecord[][] = [];
    for (let i = 0; i < symbols.length; i += batchSize) {
      batches.push(symbols.slice(i, i + batchSize));
    }

    logger.info('SemanticIndexer: processing batches', {
      total: symbols.length,
      batches: batches.length,
      batchSize,
      concurrency,
    });

    // Process with bounded concurrency
    let batchIndex = 0;

    async function worker(): Promise<void> {
      while (batchIndex < batches.length) {
        const idx = batchIndex++;
        const batch = batches[idx];
        logger.debug('SemanticIndexer: embedding batch', {
          batch: idx + 1,
          of: batches.length,
          size: batch.length,
        });
        await store.indexSymbols(batch);
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, batches.length) }, worker);
    await Promise.all(workers);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a `SemanticIndexer` if semantic search is configured, else null.
 * Returns null when `semantic.provider === 'none'` or `!semantic.enabled`.
 */
export function createSemanticIndexer(config: PureContextConfig): SemanticIndexer | null {
  if (!config.semantic.enabled || config.semantic.provider === 'none') {
    return null;
  }
  try {
    // Validate the provider can be constructed (throws if misconfigured)
    createEmbeddingProvider(config);
    return new SemanticIndexer(config, {});
  } catch (err) {
    if (err instanceof PureContextError) {
      logger.warn(`SemanticIndexer: provider misconfigured — ${err.message}`);
      return null;
    }
    throw err;
  }
}
