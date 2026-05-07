/**
 * search_semantic tool — dedicated semantic / hybrid symbol search.
 *
 * Uses the Phase 11 HybridSearcher (RRF fusion of FTS5 + HNSW) for repos that
 * have been semantically indexed.  Returns structured results with per-result
 * keyword, semantic, and combined scores, plus timing metadata.
 *
 * Modes:
 *   'hybrid'   — RRF-fused FTS5 + HNSW (default)
 *   'semantic' — HNSW vector search only (keyword_weight implicitly 0)
 *
 * Requires a semantic index (embeddings stored in DB). Returns an error when no
 * embeddings exist for any targeted repo — use search_symbols for keyword-only search.
 *
 * Cross-repo: omit repo/repoIds to search all indexed repos in one call.
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { countEmbeddings } from '../../core/db/embedding-store.js';
import { getFileSizesBatch } from '../../core/db/file-store.js';
import { getConfig } from '../../config/config-loader.js';
import { computeRepoId } from '../../core/index-manager.js';
import { createEmbeddingProvider } from '../../semantic/embedding-provider.js';
import { VectorStore } from '../../semantic/vector-store.js';
import { HybridSearcher } from '../../semantic/hybrid-search.js';
import { resolveRepoScope } from '../../core/db/repo-scope.js';
import { buildMeta } from './_meta.js';
import { logger } from '../../core/logger.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'search_semantic';

export const description =
  'Search for symbols using natural language with semantic (vector) and hybrid (semantic + keyword) ' +
  'modes across one or more indexed repos. Requires a semantic index — use index_folder with an ' +
  'embedding provider configured. Omit repo/repoIds to search ALL indexed repos in one call. ' +
  'Returns results ranked by combined relevance score with per-result repoId and repoName for ' +
  'disambiguation. Falls back to an error when no semantic index exists for any targeted repo.';

export const inputSchema = {
  repo: z
    .string()
    .optional()
    .describe('Single repo ID (16-char hex) or absolute path — mutually exclusive with repoIds. Omit both for all repos.'),
  repoIds: z
    .array(z.string())
    .optional()
    .describe('Multiple repo IDs to search — mutually exclusive with repo. Omit both for all repos.'),
  query: z.string().describe('Natural language query describing what to find'),
  mode: z
    .enum(['semantic', 'hybrid'])
    .optional()
    .describe("Search mode: 'hybrid' (semantic + keyword RRF fusion, default) or 'semantic' (vector only)"),
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
  max_results: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum results to return (default 10)'),
  kind: z
    .enum([
      'function', 'class', 'method', 'const', 'type', 'interface', 'enum',
      'component', 'composable', 'hook', 'route', 'decorator', 'middleware',
    ])
    .optional()
    .describe('Filter by symbol kind'),
  file_pattern: z
    .string()
    .optional()
    .describe('Filter results to files whose path contains this substring'),
  debug: z
    .boolean()
    .optional()
    .describe('Return per-result score breakdown for tuning and diagnostics (default false)'),
};

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repo?: string;
  repoIds?: string[];
  query: string;
  mode?: 'semantic' | 'hybrid';
  semantic_weight?: number;
  keyword_weight?: number;
  max_results?: number;
  kind?: string;
  file_pattern?: string;
  debug?: boolean;
}): Promise<CallToolResult> {
  const t0 = Date.now();

  // ── Resolve repo ID(s) ─────────────────────────────────────────────────────
  let resolvedRepoId: string | undefined;
  if (args.repo) {
    resolvedRepoId =
      args.repo.length === 16 && /^[0-9a-f]+$/.test(args.repo)
        ? args.repo
        : computeRepoId(args.repo);
  }

  const repos = resolveRepoScope({ repoId: resolvedRepoId, repoIds: args.repoIds });
  if (repos.length === 0) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: args.repo
            ? `Repo not found: ${args.repo}`
            : 'No indexed repos found. Run index_folder first.',
        }),
      }],
      isError: true,
    };
  }

  const reposSearched = repos.map((r) => r.id);

  // ── Require at least one repo with a semantic index ────────────────────────
  const reposWithEmbeddings = await checkReposForEmbeddings(repos);
  if (reposWithEmbeddings.length === 0) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error:
            `No semantic index found for ${repos.length === 1 ? `repo '${args.repo ?? repos[0].id}'` : 'any of the targeted repos'}. ` +
            'Configure an embedding provider and re-run index_folder with semantic.enabled=true. ' +
            'Use search_symbols for keyword-only search.',
        }),
      }],
      isError: true,
    };
  }

  // ── Resolve search weights ─────────────────────────────────────────────────
  const mode = args.mode ?? 'hybrid';
  const maxResults = args.max_results ?? 10;
  const keywordWeight = mode === 'semantic' ? 0 : (args.keyword_weight ?? 0.5);
  const semanticWeight = mode === 'semantic' ? 1 : (args.semantic_weight ?? 0.5);

  // ── Build embedding provider ───────────────────────────────────────────────
  let provider;
  try {
    const config = getConfig();
    provider = createEmbeddingProvider(config);
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: `Embedding provider not configured: ${err}. ` +
            'Set semantic.provider in config to enable semantic search.',
        }),
      }],
      isError: true,
    };
  }

  // ── Search each repo and merge ─────────────────────────────────────────────
  interface TaggedResult {
    id: string;
    name: string;
    kind: string;
    file: string;
    repoId: string;
    repoName: string;
    signature: string;
    summary: string;
    keywordScore: number;
    semanticScore: number;
    combinedScore: number;
    rawCosineDistance?: number;
    startByte: number;
    endByte: number;
  }

  const allResults: TaggedResult[] = [];
  let totalRawBytes = 0;
  let totalResponseBytes = 0;
  let totalEmbeddingCount = 0;
  const tSearch = Date.now();

  for (const repo of reposWithEmbeddings) {
    const db = openDatabase(repo.id);
    try {
      // Confirm repo exists in this DB
      const repoMeta = getRepo(db, repo.id);
      if (!repoMeta) continue;

      const embeddingCount = countEmbeddings(db, repo.id);
      totalEmbeddingCount += embeddingCount;

      const vectorStore = new VectorStore(repo.id, provider, db);
      await vectorStore.rebuild();
      const searcher = new HybridSearcher(repo.id, vectorStore, db);

      const results = await searcher.search(args.query, {
        maxResults,
        keywordWeight,
        semanticWeight,
        kind: args.kind,
        filePattern: args.file_pattern,
        debug: args.debug,
      });

      logger.debug('search_semantic per-repo completed', {
        repoId: repo.id,
        mode,
        results: results.length,
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
          id: r.symbol.id,
          name: r.symbol.name,
          kind: r.symbol.kind,
          file: r.symbol.filePath,
          repoId: repo.id,
          repoName: repo.name,
          signature: r.symbol.signature,
          summary: r.symbol.summary,
          keywordScore: r.keywordScore,
          semanticScore: r.semanticScore,
          combinedScore: r.combinedScore,
          rawCosineDistance: r.rawCosineDistance,
          startByte: r.symbol.startByte,
          endByte: r.symbol.endByte,
        });
      }
    } finally {
      db.close();
    }
  }

  const searchMs = Date.now() - tSearch;

  // Sort by combined score descending across all repos, take top maxResults
  allResults.sort((a, b) => b.combinedScore - a.combinedScore);
  const top = allResults.slice(0, maxResults);

  // ── Build response ─────────────────────────────────────────────────────────
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(
        {
          results: top.map((r) => ({
            id: r.id,
            name: r.name,
            kind: r.kind,
            file: r.file,
            repoId: r.repoId,
            repoName: r.repoName,
            signature: r.signature,
            summary: r.summary,
            scores: {
              keyword: round4(r.keywordScore),
              semantic: round4(r.semanticScore),
              combined: round4(r.combinedScore),
            },
            ...(args.debug ? {
              _score: {
                total: round4(r.combinedScore),
                vectorSimilarity: r.rawCosineDistance !== undefined
                  ? round4(1 - r.rawCosineDistance)
                  : null,
                keywordBoost: round4(r.keywordScore),
                nameMatch: computeNameMatch(r.name, args.query),
                hybridWeight: semanticWeight,
              },
            } : {}),
          })),
          _meta: {
            ...buildMeta({ timingMs: Date.now() - t0, rawBytes: totalRawBytes, responseBytes: totalResponseBytes }),
            mode,
            semantic_index_size: totalEmbeddingCount,
            search_ms: searchMs,
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
 * Compute a name match bonus for debug output.
 * Returns 1.0 for exact match, 0.6 for prefix, 0.4 for contains, else 0.
 */
function computeNameMatch(name: string, query: string): number {
  const nameLower = name.toLowerCase();
  const queryLower = query.trim().toLowerCase();
  if (nameLower === queryLower) return 1.0;
  if (nameLower.startsWith(queryLower)) return 0.6;
  if (nameLower.includes(queryLower)) return 0.4;
  return 0;
}

/**
 * Filter repos to those that have a semantic (embeddings) index.
 * Opens each DB briefly to check, then closes.
 */
async function checkReposForEmbeddings(
  repos: Array<{ id: string; name: string }>,
): Promise<Array<{ id: string; name: string }>> {
  const result: Array<{ id: string; name: string }> = [];
  for (const repo of repos) {
    try {
      const db = openDatabase(repo.id);
      const count = countEmbeddings(db, repo.id);
      db.close();
      if (count > 0) result.push(repo);
    } catch {
      // skip unreadable DB
    }
  }
  return result;
}
