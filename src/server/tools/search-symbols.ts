import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { searchSymbols, ftsSearchSymbols, hasFtsIndex } from '../../core/db/symbol-store.js';
import { getFileSizesBatch } from '../../core/db/file-store.js';
import { countEmbeddings } from '../../core/db/embedding-store.js';
import { buildMeta } from './_meta.js';
import { getConfig } from '../../config/config-loader.js';
import { createEmbeddingProvider } from '../../semantic/embedding-provider.js';
import { VectorStore } from '../../semantic/vector-store.js';
import { HybridSearcher } from '../../semantic/hybrid-search.js';
import { logger } from '../../core/logger.js';
import { preprocessQuery } from '../../core/search/query-preprocessor.js';
import { rankSymbols } from '../../core/search/relevance-ranker.js';
import type { ScoredSymbol } from '../../core/search/relevance-ranker.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SymbolRecord } from '../../core/types.js';

export const name = 'search_symbols';

export const description =
  'Search for symbols (functions, classes, types, etc.) by name across an indexed repo. ' +
  'Returns signatures and summaries — not raw source code — for token efficiency. ' +
  'Supports keyword, semantic, and hybrid search modes. ' +
  'Use get_symbol_source to retrieve the full source of a specific symbol.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  query: z.string().describe('Name fragment or natural-language description to search for'),
  kind: z
    .enum(['function', 'class', 'method', 'const', 'type', 'interface', 'enum',
           'component', 'composable', 'hook', 'route', 'decorator', 'middleware'])
    .optional()
    .describe('Filter by symbol kind'),
  filePath: z.string().optional().describe('Filter to a specific file path'),
  limit: z.number().int().positive().optional().describe('Max results (default 50)'),
  mode: z
    .enum(['keyword', 'semantic', 'hybrid'])
    .optional()
    .describe(
      "Search mode: 'keyword' (FTS name match), 'semantic' (vector similarity), " +
      "'hybrid' (RRF-merged; default when semantic index exists)",
    ),
  semantic_weight: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Weight for semantic score in hybrid mode (default 0.5)'),
  keyword_weight: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Weight for keyword score in hybrid mode (default 0.5)'),
};

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  query: string;
  kind?: string;
  filePath?: string;
  limit?: number;
  mode?: 'keyword' | 'semantic' | 'hybrid';
  semantic_weight?: number;
  keyword_weight?: number;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const db = openDatabase(args.repoId);

  try {
    const limit = args.limit ?? 50;
    const semanticWeight = args.semantic_weight ?? 0.5;
    const keywordWeight = args.keyword_weight ?? 0.5;

    // Determine effective mode
    const embeddingCount = countEmbeddings(db, args.repoId);
    const hasSemanticIndex = embeddingCount > 0;

    let effectiveMode = args.mode;
    if (!effectiveMode) {
      effectiveMode = hasSemanticIndex ? 'hybrid' : 'keyword';
    }

    // For semantic/hybrid modes, fall back to keyword if no index or no provider
    if ((effectiveMode === 'hybrid' || effectiveMode === 'semantic') && !hasSemanticIndex) {
      logger.debug('search_symbols: no semantic index found, falling back to keyword', {
        repoId: args.repoId,
      });
      effectiveMode = 'keyword';
    }

    // ── Hybrid / Semantic mode ──────────────────────────────────────────────────
    if (effectiveMode === 'hybrid' || effectiveMode === 'semantic') {
      try {
        const config = getConfig();
        const provider = createEmbeddingProvider(config);
        const vectorStore = new VectorStore(args.repoId, provider, db);
        await vectorStore.rebuild();

        const searcher = new HybridSearcher(args.repoId, vectorStore, db);

        const kwWeight = effectiveMode === 'semantic' ? 0 : keywordWeight;
        const semWeight = effectiveMode === 'semantic' ? 1 : semanticWeight;

        const results = await searcher.search(args.query, {
          maxResults: limit,
          keywordWeight: kwWeight,
          semanticWeight: semWeight,
          kind: args.kind,
          filePattern: args.filePath,
        });

        const uniqueFiles = [...new Set(results.map((r) => r.symbol.filePath))];
        const fileSizes = getFileSizesBatch(db, args.repoId, uniqueFiles);
        const rawBytes = uniqueFiles.reduce((sum, fp) => sum + (fileSizes.get(fp) ?? 0), 0);
        const responseBytes = results.reduce(
          (sum, r) => sum + (r.symbol.endByte - r.symbol.startByte),
          0,
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: results.length,
                  symbols: results.map((r) => ({
                    id: r.symbol.id,
                    name: r.symbol.name,
                    kind: r.symbol.kind,
                    filePath: r.symbol.filePath,
                    signature: r.symbol.signature,
                    summary: r.symbol.summary,
                    scores: {
                      keyword: round4(r.keywordScore),
                      semantic: round4(r.semanticScore),
                      combined: round4(r.combinedScore),
                    },
                  })),
                  _meta: {
                    ...buildMeta({ timingMs: Date.now() - t0, rawBytes, responseBytes }),
                    mode: effectiveMode,
                    semantic_index_size: embeddingCount,
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        // If provider setup fails (not configured), fall back to keyword
        logger.warn(`search_symbols: semantic search unavailable, falling back to keyword: ${err}`);
        effectiveMode = 'keyword';
      }
    }

    // ── Keyword mode (default / fallback) ────────────────────────────────────
    let symbols: SymbolRecord[];
    let searchMode: 'fts' | 'like_fallback';

    const ftsAvailable = hasFtsIndex(db, args.repoId);
    if (ftsAvailable) {
      const ftsQuery = preprocessQuery(args.query);
      try {
        symbols = ftsSearchSymbols(db, args.repoId, ftsQuery, {
          kind: args.kind as never,
          filePath: args.filePath,
          limit,
        });
        searchMode = 'fts';
      } catch (err) {
        logger.warn(`search_symbols: FTS query failed, falling back to LIKE: ${err}`);
        symbols = searchSymbols(db, args.repoId, args.query, {
          kind: args.kind as never,
          filePath: args.filePath,
          limit,
        });
        searchMode = 'like_fallback';
      }
    } else {
      symbols = searchSymbols(db, args.repoId, args.query, {
        kind: args.kind as never,
        filePath: args.filePath,
        limit,
      });
      searchMode = 'like_fallback';
    }

    // Re-rank results by explicit relevance scoring
    const ranked: ScoredSymbol[] = rankSymbols(symbols, args.query);

    const uniqueFiles = [...new Set(ranked.map((r) => r.symbol.filePath))];
    const fileSizes = getFileSizesBatch(db, args.repoId, uniqueFiles);
    const rawBytes = uniqueFiles.reduce((sum, fp) => sum + (fileSizes.get(fp) ?? 0), 0);
    const responseBytes = ranked.reduce((sum, r) => sum + (r.symbol.endByte - r.symbol.startByte), 0);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              count: ranked.length,
              symbols: ranked.map((r) => ({
                id: r.symbol.id,
                name: r.symbol.name,
                kind: r.symbol.kind,
                filePath: r.symbol.filePath,
                signature: r.symbol.signature,
                summary: r.symbol.summary,
                score: r.score,
                matchReason: r.matchReason,
              })),
              _meta: {
                ...buildMeta({ timingMs: Date.now() - t0, rawBytes, responseBytes }),
                mode: effectiveMode,
                search_mode: searchMode,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  } finally {
    db.close();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
