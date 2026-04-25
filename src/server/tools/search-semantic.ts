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
 * embeddings exist for the repo — use search_symbols for keyword-only search.
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
import { buildMeta } from './_meta.js';
import { logger } from '../../core/logger.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'search_semantic';

export const description =
  'Search for symbols using natural language with semantic (vector) and hybrid (semantic + keyword) ' +
  'modes. Requires a semantic index — use index_folder with an embedding provider configured. ' +
  'Returns results ranked by combined relevance score with per-result keyword, semantic, and ' +
  'combined scores. Falls back to an error when no semantic index exists for the repo.';

export const inputSchema = {
  repo: z.string().describe('Repo ID (16-char hex) or absolute path to the project root'),
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
};

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repo: string;
  query: string;
  mode?: 'semantic' | 'hybrid';
  semantic_weight?: number;
  keyword_weight?: number;
  max_results?: number;
  kind?: string;
  file_pattern?: string;
}): Promise<CallToolResult> {
  const t0 = Date.now();

  // ── Resolve repo ID ──────────────────────────────────────────────────────────
  const repoId =
    args.repo.length === 16 && /^[0-9a-f]+$/.test(args.repo)
      ? args.repo
      : computeRepoId(args.repo);

  const db = openDatabase(repoId);

  try {
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Repo not found: ${args.repo}` }) }],
        isError: true,
      };
    }

    // ── Require semantic index ───────────────────────────────────────────────
    const embeddingCount = countEmbeddings(db, repoId);
    if (embeddingCount === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                `No semantic index found for repo '${args.repo}'. ` +
                'Configure an embedding provider and re-run index_folder with semantic.enabled=true. ' +
                'Use search_symbols for keyword-only search.',
            }),
          },
        ],
        isError: true,
      };
    }

    // ── Resolve search weights ───────────────────────────────────────────────
    const mode = args.mode ?? 'hybrid';
    const maxResults = args.max_results ?? 10;

    const keywordWeight = mode === 'semantic' ? 0 : (args.keyword_weight ?? 0.5);
    const semanticWeight = mode === 'semantic' ? 1 : (args.semantic_weight ?? 0.5);

    // ── Build VectorStore + HybridSearcher ───────────────────────────────────
    let provider;
    try {
      const config = getConfig();
      provider = createEmbeddingProvider(config);
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Embedding provider not configured: ${err}. ` +
                'Set semantic.provider in config to enable semantic search.',
            }),
          },
        ],
        isError: true,
      };
    }

    const vectorStore = new VectorStore(repoId, provider, db);
    await vectorStore.rebuild();

    const searcher = new HybridSearcher(repoId, vectorStore, db);

    // ── Search ───────────────────────────────────────────────────────────────
    const tSearch = Date.now();
    const results = await searcher.search(args.query, {
      maxResults,
      keywordWeight,
      semanticWeight,
      kind: args.kind,
      filePattern: args.file_pattern,
    });
    const searchMs = Date.now() - tSearch;

    logger.debug('search_semantic completed', {
      repoId,
      mode,
      results: results.length,
      searchMs,
    });

    // ── Build response ───────────────────────────────────────────────────────
    const uniqueFiles = [...new Set(results.map((r) => r.symbol.filePath))];
    const fileSizes = getFileSizesBatch(db, repoId, uniqueFiles);
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
              results: results.map((r) => ({
                id: r.symbol.id,
                name: r.symbol.name,
                kind: r.symbol.kind,
                file: r.symbol.filePath,
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
                mode,
                semantic_index_size: embeddingCount,
                search_ms: searchMs,
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
