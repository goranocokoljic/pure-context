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
import { preprocessQuery, toOrFallbackQuery } from '../../core/search/query-preprocessor.js';
import { rankSymbols } from '../../core/search/relevance-ranker.js';
import { resolveRepoScope } from '../../core/db/repo-scope.js';
import type { ScoredSymbol } from '../../core/search/relevance-ranker.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SymbolRecord } from '../../core/types.js';

export const name = 'search_symbols';

export const description =
  'Search for symbols (functions, classes, types, etc.) by name across one or more indexed repos. ' +
  'Returns signatures and summaries — not raw source code — for token efficiency. ' +
  'Supports keyword, semantic, and hybrid search modes. ' +
  'Omit repoId/repoIds to search ALL indexed repos in one call. ' +
  'Use get_symbol_source to retrieve the full source of a specific symbol.';

export const inputSchema = {
  repoId: z
    .string()
    .optional()
    .describe('Single repo ID — mutually exclusive with repoIds. Omit both to search all repos.'),
  repoIds: z
    .array(z.string())
    .optional()
    .describe('Multiple repo IDs to search — mutually exclusive with repoId. Omit both for all repos.'),
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
  debug: z
    .boolean()
    .optional()
    .describe('Return per-result score breakdown for tuning and diagnostics (default false)'),
};

// ─── Tagged result types ──────────────────────────────────────────────────────

interface TaggedKeywordResult {
  symbol: SymbolRecord;
  repoId: string;
  repoName: string;
  score: number;
  matchReason?: string;
  debugScore?: unknown;
}

interface TaggedHybridResult {
  symbol: SymbolRecord;
  repoId: string;
  repoName: string;
  keywordScore: number;
  semanticScore: number;
  combinedScore: number;
  rawCosineDistance?: number;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId?: string;
  repoIds?: string[];
  query: string;
  kind?: string;
  filePath?: string;
  limit?: number;
  mode?: 'keyword' | 'semantic' | 'hybrid';
  semantic_weight?: number;
  keyword_weight?: number;
  debug?: boolean;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const limit = args.limit ?? 50;
  const semanticWeight = args.semantic_weight ?? 0.5;
  const keywordWeight = args.keyword_weight ?? 0.5;

  // ── Resolve target repos ───────────────────────────────────────────────────
  const repos = resolveRepoScope({ repoId: args.repoId, repoIds: args.repoIds });
  if (repos.length === 0) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: args.repoId
            ? `Repo not found: ${args.repoId}`
            : 'No indexed repos found. Run index_folder first.',
        }),
      }],
      isError: true,
    };
  }

  const reposSearched = repos.map((r) => r.id);

  // ── Determine effective mode using first repo with a semantic index ─────────
  let effectiveMode = args.mode;
  if (!effectiveMode) {
    // Check first repo for semantic index to decide default mode
    const firstDb = openDatabase(repos[0].id);
    const firstEmbCount = countEmbeddings(firstDb, repos[0].id);
    firstDb.close();
    effectiveMode = firstEmbCount > 0 ? 'hybrid' : 'keyword';
  }

  // ── Hybrid / Semantic path ─────────────────────────────────────────────────
  if (effectiveMode === 'hybrid' || effectiveMode === 'semantic') {
    let provider;
    try {
      const config = getConfig();
      provider = createEmbeddingProvider(config);
    } catch {
      // Provider not configured — fall back to keyword
      logger.debug('search_symbols: embedding provider unavailable, falling back to keyword');
      effectiveMode = 'keyword';
    }

    if (provider && (effectiveMode === 'hybrid' || effectiveMode === 'semantic')) {
      try {
        const kwWeight = effectiveMode === 'semantic' ? 0 : keywordWeight;
        const semWeight = effectiveMode === 'semantic' ? 1 : semanticWeight;

        const allResults: TaggedHybridResult[] = [];
        let totalRawBytes = 0;
        let totalResponseBytes = 0;

        for (const repo of repos) {
          const db = openDatabase(repo.id);
          try {
            const embCount = countEmbeddings(db, repo.id);
            if (embCount === 0) {
              // No semantic index for this repo — skip it in semantic/hybrid mode
              logger.debug(`search_symbols: no semantic index for ${repo.id}, skipping in ${effectiveMode} mode`);
              continue;
            }

            const vectorStore = new VectorStore(repo.id, provider!, db);
            await vectorStore.rebuild();
            const searcher = new HybridSearcher(repo.id, vectorStore, db);

            const results = await searcher.search(args.query, {
              maxResults: limit,
              keywordWeight: kwWeight,
              semanticWeight: semWeight,
              kind: args.kind,
              filePattern: args.filePath,
              debug: args.debug,
            });

            const uniqueFiles = [...new Set(results.map((r) => r.symbol.filePath))];
            const fileSizes = getFileSizesBatch(db, repo.id, uniqueFiles);
            totalRawBytes += uniqueFiles.reduce((sum, fp) => sum + (fileSizes.get(fp) ?? 0), 0);
            totalResponseBytes += results.reduce(
              (sum, r) => sum + (r.symbol.endByte - r.symbol.startByte),
              0,
            );

            for (const r of results) {
              allResults.push({
                symbol: r.symbol,
                repoId: repo.id,
                repoName: repo.name,
                keywordScore: r.keywordScore,
                semanticScore: r.semanticScore,
                combinedScore: r.combinedScore,
                rawCosineDistance: r.rawCosineDistance,
              });
            }
          } finally {
            db.close();
          }
        }

        if (allResults.length > 0 || effectiveMode === 'semantic') {
          // Sort by combined score descending, take top `limit`
          allResults.sort((a, b) => b.combinedScore - a.combinedScore);
          const top = allResults.slice(0, limit);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify(
                {
                  count: top.length,
                  symbols: top.map((r) => ({
                    id: r.symbol.id,
                    name: r.symbol.name,
                    kind: r.symbol.kind,
                    filePath: r.symbol.filePath,
                    repoId: r.repoId,
                    repoName: r.repoName,
                    signature: r.symbol.signature,
                    summary: r.symbol.summary,
                    scores: {
                      keyword: round4(r.keywordScore),
                      semantic: round4(r.semanticScore),
                      combined: round4(r.combinedScore),
                    },
                    ...(args.debug ? {
                      _score: {
                        total: round4(r.combinedScore),
                        keywordRrf: round4(r.keywordScore),
                        semanticRrf: round4(r.semanticScore),
                        vectorSimilarity: r.rawCosineDistance !== undefined
                          ? round4(1 - r.rawCosineDistance)
                          : null,
                        keywordWeight: kwWeight,
                        semanticWeight: semWeight,
                      },
                    } : {}),
                  })),
                  _meta: {
                    ...buildMeta({ timingMs: Date.now() - t0, rawBytes: totalRawBytes, responseBytes: totalResponseBytes }),
                    mode: effectiveMode,
                    reposSearched,
                  },
                },
                null,
                2,
              ),
            }],
          };
        }

        // All repos had no semantic index — fall through to keyword
        effectiveMode = 'keyword';
      } catch (err) {
        logger.warn(`search_symbols: semantic search failed, falling back to keyword: ${err}`);
        effectiveMode = 'keyword';
      }
    }
  }

  // ── Keyword path (default / fallback) ─────────────────────────────────────
  const allKeywordResults: TaggedKeywordResult[] = [];
  let totalRawBytes = 0;
  let totalResponseBytes = 0;
  let searchMode: 'fts' | 'fts_or_fallback' | 'like_fallback' = 'fts';

  for (const repo of repos) {
    const db = openDatabase(repo.id);
    try {
      let symbols: SymbolRecord[];
      const ftsAvailable = hasFtsIndex(db, repo.id);

      if (ftsAvailable) {
        const ftsQuery = preprocessQuery(args.query);
        try {
          symbols = ftsSearchSymbols(db, repo.id, ftsQuery, {
            kind: args.kind as never,
            filePath: args.filePath,
            limit,
          });

          // OR-fallback: when the AND query returns nothing, retry with terms joined
          // by OR so that natural-language queries match symbols containing only some
          // of the query words (e.g. "parse source file tree-sitter ast" → parseFile).
          if (symbols.length === 0) {
            const orQuery = toOrFallbackQuery(ftsQuery);
            if (orQuery !== ftsQuery) {
              symbols = ftsSearchSymbols(db, repo.id, orQuery, {
                kind: args.kind as never,
                filePath: args.filePath,
                limit,
              });
              if (symbols.length > 0) {
                searchMode = 'fts_or_fallback';
              }
            }
          }
        } catch (err) {
          logger.warn(`search_symbols: FTS query failed for ${repo.id}, falling back to LIKE: ${err}`);
          symbols = searchSymbols(db, repo.id, args.query, {
            kind: args.kind as never,
            filePath: args.filePath,
            limit,
          });
          searchMode = 'like_fallback';
        }
      } else {
        symbols = searchSymbols(db, repo.id, args.query, {
          kind: args.kind as never,
          filePath: args.filePath,
          limit,
        });
        searchMode = 'like_fallback';
      }

      const ranked: ScoredSymbol[] = rankSymbols(symbols, args.query, args.debug);

      const uniqueFiles = [...new Set(ranked.map((r) => r.symbol.filePath))];
      const fileSizes = getFileSizesBatch(db, repo.id, uniqueFiles);
      totalRawBytes += uniqueFiles.reduce((sum, fp) => sum + (fileSizes.get(fp) ?? 0), 0);
      totalResponseBytes += ranked.reduce((sum, r) => sum + (r.symbol.endByte - r.symbol.startByte), 0);

      for (const r of ranked) {
        allKeywordResults.push({
          symbol: r.symbol,
          repoId: repo.id,
          repoName: repo.name,
          score: r.score,
          matchReason: r.matchReason,
          debugScore: r.debugScore,
        });
      }
    } finally {
      db.close();
    }
  }

  // Sort by score descending across all repos, take top `limit`
  allKeywordResults.sort((a, b) => b.score - a.score);
  const top = allKeywordResults.slice(0, limit);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(
        {
          count: top.length,
          symbols: top.map((r) => ({
            id: r.symbol.id,
            name: r.symbol.name,
            kind: r.symbol.kind,
            filePath: r.symbol.filePath,
            repoId: r.repoId,
            repoName: r.repoName,
            signature: r.symbol.signature,
            summary: r.symbol.summary,
            score: r.score,
            matchReason: r.matchReason,
            ...(args.debug && r.debugScore ? { _score: r.debugScore } : {}),
          })),
          _meta: {
            ...buildMeta({ timingMs: Date.now() - t0, rawBytes: totalRawBytes, responseBytes: totalResponseBytes }),
            mode: effectiveMode,
            search_mode: searchMode,
            reposSearched,
          },
        },
        null,
        2,
      ),
    }],
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
