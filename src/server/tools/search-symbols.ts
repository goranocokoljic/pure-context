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
import { preprocessQuery, toOrFallbackQuery, isStopWord } from '../../core/search/query-preprocessor.js';
import { rankSymbols, isLibraryPath, isFrontendAppPath } from '../../core/search/relevance-ranker.js';
import { computeSymbolRisk } from './symbol-risk.js';
import { resolveRepoScope } from '../../core/db/repo-scope.js';
import type { ScoredSymbol, RankOptions } from '../../core/search/relevance-ranker.js';
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
  includeRisk: z
    .boolean()
    .optional()
    .describe(
      'When true, attach a compact change-risk verdict { band, riskScore } to ' +
      'each result (Phase 76). Default false (no extra cost). Use ' +
      'get_symbol_risk for the full factor breakdown before editing a high-risk symbol.',
    ),
  cfgFilter: z
    .union([
      z.string().describe('Simple predicate string, e.g. \'target_os = "linux"\''),
      z.object({
        kind: z.string(),
        key: z.string().optional(),
        value: z.string().optional(),
      }).describe('Structured predicate object'),
    ])
    .optional()
    .describe(
      'Filter results to only symbols gated by a specific Rust #[cfg(...)] predicate. ' +
      'Applied after ranking. Ignored with a _diagnostics warning when no cfg metadata exists.',
    ),
};

// ─── cfg filter helpers ───────────────────────────────────────────────────────

interface CfgPredMatcher {
  kind: string;
  key?: string;
  value?: string;
}

/** Parse a string predicate like 'target_os = "linux"' into a structured matcher. */
function parseCfgFilterString(filter: string): CfgPredMatcher | null {
  const m = filter.match(/^(\w+)\s*=\s*"([^"]+)"$/);
  if (m) return { kind: 'eq', key: m[1], value: m[2] };
  const bare = filter.match(/^(\w+)$/);
  if (bare) return { kind: 'flag', key: bare[1] };
  return null;
}

/** Deep-walk a predicate tree to find a matching leaf. */
function predicateMatches(pred: unknown, matcher: CfgPredMatcher): boolean {
  if (!pred || typeof pred !== 'object') return false;
  const p = pred as Record<string, unknown>;
  if (matcher.kind === 'eq') {
    if (p['kind'] === 'eq' && p['key'] === matcher.key && p['value'] === matcher.value) return true;
  } else if (matcher.kind === 'flag') {
    if (p['kind'] === 'flag' && p['key'] === matcher.key) return true;
    if (p['kind'] === 'eq' && p['key'] === matcher.key) return true; // key exists in any form
  }
  // Recurse into children (all/any/not)
  if (Array.isArray(p['children'])) {
    for (const child of p['children'] as unknown[]) {
      if (predicateMatches(child, matcher)) return true;
    }
  }
  return false;
}

/**
 * Returns true if the symbol's cfg metadata matches the given filter.
 * Handles single CfgMeta object and array of CfgMeta objects.
 */
function symbolMatchesCfgFilter(symbol: SymbolRecord, matcher: CfgPredMatcher): boolean {
  const cfg = symbol.frameworkMeta?.['cfg'];
  if (!cfg) return false;

  const entries = Array.isArray(cfg) ? cfg : [cfg];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const predicates = Array.isArray(e['predicates']) ? e['predicates'] : [];
    for (const p of predicates) {
      if (predicateMatches(p, matcher)) return true;
    }
  }
  return false;
}

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
  includeRisk?: boolean;
  cfgFilter?: string | { kind: string; key?: string; value?: string };
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const limit = args.limit ?? 50;
  const semanticWeight = args.semantic_weight ?? 0.5;
  const keywordWeight = args.keyword_weight ?? 0.5;

  // ── Resolve cfgFilter matcher ─────────────────────────────────────────────
  let cfgMatcher: CfgPredMatcher | null = null;
  if (args.cfgFilter) {
    if (typeof args.cfgFilter === 'string') {
      cfgMatcher = parseCfgFilterString(args.cfgFilter);
    } else {
      cfgMatcher = args.cfgFilter as CfgPredMatcher;
    }
  }

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

  // ── Detect domain (scopes domain-specific synonyms) ─────────────────────
  // rendering: Only enable rendering synonyms when the repo name suggests a rendering /
  // graphics / PBR codebase — prevents synonym noise in unrelated repos
  // (e.g. nuxt, airodump, origamicms-frontend regressed in Phase 47).
  // rust: Only enable Rust async/serde synonyms (future→poll, spawn→tokio, etc.)
  // for Rust repos — prevents 'future→poll' from making FutureBase::poll outscore
  // folly::Future in C++ repos like facebook-folly.
  const RENDERING_REPO_PATTERN = /render|draw|shader|scene|material|graphic|mitsuba|pbr|tracer|opengl|vulkan|cuda|opencl/i;
  const RUST_REPO_PATTERN = /\brust\b|tokio|serde|actix|axum|hyper|warp|rocket|cargo/i;
  const JAVA_GROOVY_REPO_PATTERN = /\bjenkins\b|\bgradle\b|\bspring\b|\bmaven\b|\bgroovy\b/i;
  const domain = repos.some((r) => RENDERING_REPO_PATTERN.test(r.name))
    ? 'rendering'
    : repos.some((r) => RUST_REPO_PATTERN.test(r.name))
    ? 'rust'
    : repos.some((r) => JAVA_GROOVY_REPO_PATTERN.test(r.name))
    ? 'java'
    : undefined;

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
          const cfgDiagnostic = cfgMatcher
            ? allResults.every((r) => !r.symbol.frameworkMeta?.['cfg'])
              ? 'cfgFilter ignored: no symbols in this repo have cfg metadata'
              : null
            : null;
          const top = cfgMatcher && !cfgDiagnostic
            ? allResults.filter((r) => symbolMatchesCfgFilter(r.symbol, cfgMatcher!)).slice(0, limit)
            : allResults.slice(0, limit);

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
                  ...(cfgDiagnostic ? { _diagnostics: [cfgDiagnostic] } : {}),
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
        const ftsQuery = preprocessQuery(args.query, domain);
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
          // Also fire when query asks for a React hook (use*/hook) but AND pool has
          // no use[A-Z] symbols — hook names rarely satisfy all AND terms.
          const isHookQuery = hasReactHookQuery(args.query);
          // < 5: a near-empty AND pool almost always means low recall, not a
          // precise hit — merge in the OR pool (AND hits still rank first).
          const needsOrFallback =
            symbols.length < 5 ||
            !hasServiceMethodCandidate(symbols) ||
            symbols.every((s) => isLibraryPath(s.filePath)) ||
            (isHookQuery && !symbols.some((s) => /^use[A-Z]/.test(s.name)));
          if (needsOrFallback) {
            const orQuery = toOrFallbackQuery(ftsQuery, domain);
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

        // ── Class-type injection ────────────────────────────────────────────
        // In large C++ codebases, method symbols with namespace-qualified names
        // (e.g. FutureBase::poll) dominate the FTS5 candidate pool, pushing out
        // class/struct/function symbols.  Run a secondary OR query restricted to
        // non-method kinds so class symbols are always represented in the pool.
        // Guard: only fires when the main pool contains C++ style qualified methods
        // (name contains "::"), preventing regression in Ruby/JS repos where
        // single-word class names (Git, Bottle) would incorrectly outscore compound
        // class names (GitDownloadStrategy, BottleSpecification) via identityExact.
        const hasCppStyleMethods = symbols.some((s) => s.kind === 'method' && s.name.includes('::'));
        if (!args.kind && ftsAvailable && hasCppStyleMethods) {
          try {
            const orQuery = toOrFallbackQuery(preprocessQuery(args.query, domain), domain);
            const classSymbols = ftsSearchSymbols(db, repo.id, orQuery, {
              kinds: ['class', 'struct', 'enum', 'function', 'namespace'],
              filePath: args.filePath,
              limit: 50,
            });
            if (classSymbols.length > 0) {
              const seen = new Set(symbols.map((s) => s.id));
              for (const s of classSymbols) {
                if (!seen.has(s.id)) symbols.push(s);
              }
            }
          } catch {
            // Secondary injection is best-effort — never fail the main search
          }
        }
      } else {
        symbols = searchSymbols(db, repo.id, args.query, {
          kind: args.kind as never,
          filePath: args.filePath,
          limit,
        });
        searchMode = 'like_fallback';
      }

      const rankOpts: RankOptions = {
        isMixedMonorepo: detectMixedMonorepo(symbols),
        hasReactHookQuery: hasReactHookQuery(args.query),
        isJavaGroovyMixed: detectJavaGroovyMixed(symbols),
        isAngularRepo: symbols.some(
          (s) => s.filePath.endsWith('.component.ts') || s.filePath.endsWith('.module.ts'),
        ),
      };
      const ranked: ScoredSymbol[] = rankSymbols(symbols, args.query, args.debug, domain, rankOpts);

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

  // Sort by score descending across all repos, apply cfg filter, take top `limit`
  allKeywordResults.sort((a, b) => b.score - a.score);
  const cfgDiagnostic = cfgMatcher
    ? allKeywordResults.every((r) => !r.symbol.frameworkMeta?.['cfg'])
      ? 'cfgFilter ignored: no symbols in this repo have cfg metadata'
      : null
    : null;
  const top = cfgMatcher && !cfgDiagnostic
    ? allKeywordResults.filter((r) => symbolMatchesCfgFilter(r.symbol, cfgMatcher!)).slice(0, limit)
    : allKeywordResults.slice(0, limit);

  // ── Optional compact risk verdict per result (opt-in, Phase 76) ────────────
  const riskByKey = new Map<string, { band: string; riskScore: number }>();
  if (args.includeRisk && top.length > 0) {
    const byRepo = new Map<string, string[]>();
    for (const r of top) {
      const list = byRepo.get(r.repoId) ?? [];
      list.push(r.symbol.id);
      byRepo.set(r.repoId, list);
    }
    for (const [rid, symbolIds] of byRepo) {
      const rdb = openDatabase(rid);
      try {
        for (const sid of symbolIds) {
          const risk = computeSymbolRisk(rdb, rid, sid);
          if (risk) riskByKey.set(`${rid}::${sid}`, { band: risk.band, riskScore: risk.riskScore });
        }
      } finally {
        rdb.close();
      }
    }
  }

  const negativeEvidence =
    top.length === 0
      ? {
          verdict: 'no_match',
          query: args.query,
          searched_kinds: args.kind ? [args.kind] : [],
          searched_repos: reposSearched,
          suggestion:
            'The symbol does not appear to exist. Consider search_text for string/comment lookups or get_repo_outline to survey the codebase.',
        }
      : undefined;

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(
        {
          count: top.length,
          ...(negativeEvidence ? { negative_evidence: negativeEvidence } : {}),
          ...(cfgDiagnostic ? { _diagnostics: [cfgDiagnostic] } : {}),
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
            ...(args.includeRisk && riskByKey.has(`${r.repoId}::${r.symbol.id}`)
              ? { risk: riskByKey.get(`${r.repoId}::${r.symbol.id}`) }
              : {}),
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
 * Return true when the query is asking for a React hook (or Vue composable —
 * Phase 92, V-11: composable-phrased queries get the same OR-fallback and
 * useHookBonus): the first meaningful token starts with 'use' and has ≥ 4
 * chars (filters out the English word "use"), OR the query contains the word
 * 'hook' / 'hooks' / 'composable' / 'composables'.
 */
export function hasReactHookQuery(query: string): boolean {
  const words = query.toLowerCase().split(/[\s-]+/).filter(Boolean);
  const firstMeaningful = words.find((w) => !isStopWord(w) && w.length >= 2);
  if (firstMeaningful && firstMeaningful.startsWith('use') && firstMeaningful.length >= 4) return true;
  return (
    words.includes('hook') || words.includes('hooks') ||
    words.includes('composable') || words.includes('composables')
  );
}

/**
 * Return true when the candidate symbol pool contains symbols from both a
 * frontend app path (apps/dashboard/, apps/web/, etc.) and a backend app path
 * (apps/api/, apps/server/, etc.), indicating a mixed frontend+backend monorepo.
 *
 * Uses the already-fetched FTS5 candidate pool — no extra DB queries.
 */
const BACKEND_APP_SEGMENTS = new Set(['api', 'server', 'backend', 'trpc']);

export function detectMixedMonorepo(symbols: SymbolRecord[]): boolean {
  let hasFrontend = false;
  let hasBackend = false;
  for (const s of symbols) {
    // Phase 92 (572c): first-or-second path segment, shared with the ranker's
    // isFrontendAppPath — covers apps/dashboard/ (novu), frontend/src/
    // (infisical), packages/trpc/ (cal.com) without matching deep incidental
    // src/api/ folders inside a pure frontend app.
    if (!hasFrontend && isFrontendAppPath(s.filePath)) hasFrontend = true;
    if (!hasBackend) {
      const segs = s.filePath.replace(/\\/g, '/').toLowerCase().split('/');
      if (segs.slice(0, 2).some((seg) => BACKEND_APP_SEGMENTS.has(seg))) hasBackend = true;
    }
    if (hasFrontend && hasBackend) return true;
  }
  return false;
}

/**
 * Return true when the candidate pool contains both .java and .groovy symbols,
 * indicating a mixed Java+Groovy repo (gradle, jenkins, groovy) where Groovy
 * `def` methods may be outranked by numerically-dominant Java methods.
 */
export function detectJavaGroovyMixed(symbols: SymbolRecord[]): boolean {
  let hasJava = false;
  let hasGroovy = false;
  for (const s of symbols) {
    if (s.filePath.endsWith('.java')) hasJava = true;
    else if (s.filePath.endsWith('.groovy')) hasGroovy = true;
    if (hasJava && hasGroovy) return true;
  }
  return false;
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
