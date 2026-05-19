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
import { rankSymbols, isLibraryPath } from '../../core/search/relevance-ranker.js';
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
        // Fetch more candidates than the requested limit so the relevance ranker
        // has a large enough pool to surface the best match even when FTS5 BM25
        // ranking places it slightly outside the bare limit.  The ranker then
        // re-sorts and the caller receives exactly `limit` results.
        const ftsLimit = Math.min(limit * 4, 200);
        try {
          symbols = ftsSearchSymbols(db, repo.id, ftsQuery, {
            kind: args.kind as never,
            filePath: args.filePath,
            limit: ftsLimit,
          });

          // OR-fallback: when the AND query returns nothing, retry with terms joined
          // by OR so that natural-language queries match symbols containing only some
          // of the query words (e.g. "parse source file tree-sitter ast" → parseFile).
          // Also fire when AND results contain no application-layer service/repo methods
          // — this means the AND pool is filled with Prisma types or DTOs while the
          // correct service method couldn't satisfy all AND terms (e.g. "listing"
          // doesn't appear in ProductsService.create's FTS content).
          // Also fire when ALL AND results are library code (system/, vendor/, etc.)
          // — in that case application symbols can only enter via the OR pool.
          const needsOrFallback =
            symbols.length === 0 ||
            !hasServiceMethodCandidate(symbols) ||
            symbols.every((s) => isLibraryPath(s.filePath));
          if (needsOrFallback) {
            const orQuery = toOrFallbackQuery(ftsQuery);
            if (orQuery !== ftsQuery) {
              const orSymbols = ftsSearchSymbols(db, repo.id, orQuery, {
                kind: args.kind as never,
                filePath: args.filePath,
                limit: ftsLimit,
              });
              if (symbols.length === 0) {
                symbols = orSymbols;
              } else {
                // Merge: append OR results not already in AND results
                const seen = new Set(symbols.map((s) => s.id));
                for (const s of orSymbols) {
                  if (!seen.has(s.id)) symbols.push(s);
                }
              }
              if (orSymbols.length > 0) {
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

/**
 * Return true when the candidate pool contains at least one method on an
 * application-layer *Service / *Repository / *Manager / *Store class.
 *
 * Used as a quality gate for OR-fallback: if AND results contain no such
 * method, we augment with OR results so the ranker can surface the right
 * service method even when it failed some AND terms.
 */
/**
 * Return true when the candidate pool contains at least one application-layer
 * method — i.e. a method on a class that looks like business/data logic rather
 * than a DTO, config constant, or third-party library type.
 *
 * Patterns covered:
 *   TypeScript: *Service, *Repository, *Manager, *Store
 *   PHP: *_model, *Model (CodeIgniter / Laravel conventions)
 *   PHP: *_controller, *Controller
 *   Python: *Processor, *Indexer, *Parser
 *
 * Used as a quality gate: if no such candidate exists in the AND result pool,
 * we fire the OR-fallback to widen the search and surface the right symbol.
 */
/**
 * For methods stored with bare names (Java/Rust), extract the class name from
 * the signature prefix ("ClassName.method: ..." or "TypeName::method: ...").
 */
function classFromSignatureForMethod(name: string, signature: string): string {
  if (!signature) return '';
  const dotPat = '.' + name + ':';
  const di = signature.indexOf(dotPat);
  if (di > 0) {
    const c = signature.slice(0, di);
    if (!c.includes('.') && !c.includes(':')) return c.toLowerCase();
  }
  const colonPat = '::' + name;
  const ci = signature.indexOf(colonPat);
  if (ci > 0) {
    const c = signature.slice(0, ci);
    if (!c.includes('.') && !c.includes(':')) return c.toLowerCase();
  }
  return '';
}

function hasServiceMethodCandidate(symbols: SymbolRecord[]): boolean {
  return symbols.some((s) => {
    if (s.kind !== 'method') return false;
    const dotIdx = s.name.indexOf('.');
    const colonIdx = s.name.indexOf('::');
    const sepIdx = dotIdx >= 0 ? dotIdx : colonIdx;
    const cls = sepIdx > 0
      ? s.name.slice(0, sepIdx).toLowerCase()
      : classFromSignatureForMethod(s.name, s.signature ?? '');
    if (!cls) return false;
    return (
      // TypeScript application-layer naming
      cls.endsWith('service') ||
      cls.endsWith('repository') ||
      cls.endsWith('manager') ||
      cls.endsWith('store') ||
      // PHP model conventions (CodeIgniter: *_model; Laravel/generic: *Model)
      cls.endsWith('_model') ||
      (cls.endsWith('model') && cls.length > 5) ||
      // PHP controller conventions
      cls.endsWith('_controller') ||
      (cls.endsWith('controller') && cls.length > 10) ||
      // Go HTTP handlers, database layers, and API clients
      cls.endsWith('handler') ||
      cls.endsWith('db') ||
      cls.endsWith('client') ||
      // Android framework classes (lifecycle methods, adapters)
      cls.endsWith('activity') ||
      cls.endsWith('fragment') ||
      cls.endsWith('adapter') ||
      cls.endsWith('viewmodel') ||
      // Python application-layer class patterns
      cls.endsWith('processor') ||
      cls.endsWith('indexer') ||
      cls.endsWith('parser') ||
      // Symfony event-driven and form patterns
      cls.endsWith('eventsubscriber') ||
      cls.endsWith('listener') ||
      cls.endsWith('formtype')
    );
  });
}
