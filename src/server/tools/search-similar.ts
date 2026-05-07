/**
 * search_similar tool — find semantically similar code using HNSW embedding search.
 *
 * Given a code snippet or an existing symbol ID, returns the most similar symbols
 * across any indexed repos by cosine similarity. Unlike keyword search, this finds
 * code that implements the same pattern even when names differ.
 *
 * Source (exactly one required):
 *   symbolId    — reuse an existing symbol's stored embedding (no API call)
 *   codeSnippet — embed a raw code snippet on-the-fly (requires embedding provider)
 *
 * Requires a semantic index — run index_folder with semantic.enabled=true first.
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import {
  loadEmbeddings,
  countEmbeddings,
  getEmbedding,
} from '../../core/db/embedding-store.js';
import { getSymbolById } from '../../core/db/symbol-store.js';
import { getConfig } from '../../config/config-loader.js';
import { computeRepoId } from '../../core/index-manager.js';
import { createEmbeddingProvider } from '../../semantic/embedding-provider.js';
import { HNSWIndex } from '../../semantic/hnsw-index.js';
import { resolveRepoScope } from '../../core/db/repo-scope.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SymbolKind } from '../../core/types.js';

// ─── Exports ──────────────────────────────────────────────────────────────────

export const name = 'search_similar';

export const description =
  'Find semantically similar code using HNSW embedding search. ' +
  'Given a code snippet or an existing symbol ID, returns the most similar symbols ' +
  'across any indexed repos by cosine similarity. ' +
  'Unlike keyword search, this finds code that implements the same pattern even when ' +
  'names differ — the killer differentiator for cross-repo code discovery. ' +
  'Using symbolId reuses the stored embedding (no API call); ' +
  'codeSnippet embeds on-the-fly and requires a configured embedding provider. ' +
  'Requires a semantic index — run index_folder with semantic.enabled=true first.';

export const inputSchema = {
  repoId: z
    .string()
    .optional()
    .describe('Scope results to a single repo ID or absolute path (optional)'),
  repoIds: z
    .array(z.string())
    .optional()
    .describe('Scope results to multiple repo IDs (optional). Omit both repoId/repoIds for all repos.'),
  symbolId: z
    .string()
    .optional()
    .describe(
      'Use an existing symbol\'s stored embedding as the similarity query — no API call. ' +
      'Mutually exclusive with codeSnippet.',
    ),
  codeSnippet: z
    .string()
    .optional()
    .describe(
      'Embed a raw code snippet on-the-fly and use it as the similarity query. ' +
      'Requires a configured embedding provider. Mutually exclusive with symbolId.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Maximum results to return (default 10, max 50)'),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Cosine similarity floor — results below this are excluded (default 0.75)'),
  excludeSelf: z
    .boolean()
    .optional()
    .describe('When source is symbolId, exclude the source symbol from results (default true)'),
  kind: z
    .enum([
      'function', 'class', 'method', 'const', 'type', 'interface', 'enum',
      'component', 'composable', 'hook', 'route', 'decorator', 'middleware',
    ])
    .optional()
    .describe('Filter results by symbol kind'),
};

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId?: string;
  repoIds?: string[];
  symbolId?: string;
  codeSnippet?: string;
  limit?: number;
  threshold?: number;
  excludeSelf?: boolean;
  kind?: string;
}): Promise<CallToolResult> {
  const t0 = Date.now();

  // ── Validate source ─────────────────────────────────────────────────────────
  if (!args.symbolId && !args.codeSnippet) {
    return errorResult('Exactly one of symbolId or codeSnippet must be provided.');
  }
  if (args.symbolId && args.codeSnippet) {
    return errorResult('Provide either symbolId or codeSnippet, not both.');
  }

  const limit = Math.min(args.limit ?? 10, 50);
  const threshold = args.threshold ?? 0.75;
  const excludeSelf = args.excludeSelf !== false; // default true
  const source: 'symbol' | 'snippet' = args.symbolId ? 'symbol' : 'snippet';

  // ── Resolve repo scope ──────────────────────────────────────────────────────
  let resolvedRepoId: string | undefined;
  if (args.repoId) {
    resolvedRepoId =
      args.repoId.length === 16 && /^[0-9a-f]+$/.test(args.repoId)
        ? args.repoId
        : computeRepoId(args.repoId);
  }

  const repos = resolveRepoScope({ repoId: resolvedRepoId, repoIds: args.repoIds });
  if (repos.length === 0) {
    return errorResult(
      args.repoId
        ? `Repo not found: ${args.repoId}`
        : 'No indexed repos found. Run index_folder first.',
    );
  }

  // ── Obtain query vector ─────────────────────────────────────────────────────
  let queryVector: Float32Array;
  let sourceName: string | undefined;

  if (source === 'symbol') {
    // Reuse a stored embedding — no API call
    const found = loadSymbolEmbedding(repos, args.symbolId!);
    if (!found) {
      return errorResult(
        `No embedding found for symbol '${args.symbolId}'. ` +
        'Ensure the symbol exists and the repo has been semantically indexed ' +
        '(index_folder with semantic.enabled=true).',
      );
    }
    queryVector = found.vector;
    sourceName = found.symbolName;
  } else {
    // Embed snippet on-the-fly
    let provider;
    try {
      const config = getConfig();
      provider = createEmbeddingProvider(config);
    } catch (err) {
      return errorResult(
        `Embedding provider not configured: ${err}. ` +
        'Set semantic.provider in config, or use symbolId instead of codeSnippet.',
      );
    }
    const [vec] = await provider.embed([args.codeSnippet!]);
    if (!vec) return errorResult('Embedding provider returned no vector for the code snippet.');
    queryVector = vec;
  }

  // ── Search each repo ────────────────────────────────────────────────────────
  interface SimilarResult {
    symbolId: string;
    name: string;
    kind: SymbolKind;
    filePath: string;
    repoId: string;
    repoName: string;
    similarity: number;
    signature: string;
    summary: string;
  }

  const allResults: SimilarResult[] = [];
  const reposSearched: string[] = [];
  let anyEmbeddings = false;
  const fetchK = Math.min(limit * 4, 200); // oversample before filtering

  for (const repo of repos) {
    let db;
    try {
      db = openDatabase(repo.id);
      const repoMeta = getRepo(db, repo.id);
      if (!repoMeta) continue;

      const embCount = countEmbeddings(db, repo.id);
      if (embCount === 0) continue;
      anyEmbeddings = true;
      reposSearched.push(repo.id);

      // Reconstruct HNSW from stored embeddings
      const embeddingsMap = loadEmbeddings(db, repo.id);
      const dim = queryVector.length;
      const hnsw = new HNSWIndex(dim, 200_000, 16, 200, 100);
      hnsw.add([...embeddingsMap.keys()], [...embeddingsMap.values()]);

      // Search by raw vector
      const rawResults = hnsw.search(queryVector, Math.min(fetchK, embCount));

      for (const { id: symId, distance } of rawResults) {
        const similarity = Math.max(0, 1 - distance);
        if (similarity < threshold) continue;
        if (excludeSelf && source === 'symbol' && symId === args.symbolId) continue;

        const symbol = getSymbolById(db, repo.id, symId);
        if (!symbol) continue;
        if (args.kind && symbol.kind !== args.kind) continue;

        allResults.push({
          symbolId: symId,
          name: symbol.name,
          kind: symbol.kind,
          filePath: symbol.filePath,
          repoId: repo.id,
          repoName: repo.name,
          similarity,
          signature: symbol.signature,
          summary: symbol.summary,
        });
      }
    } finally {
      db?.close();
    }
  }

  if (!anyEmbeddings) {
    return errorResult(
      'No semantic index found for any of the targeted repos. ' +
      'Configure an embedding provider and re-run index_folder with semantic.enabled=true.',
    );
  }

  // ── Sort, deduplicate by symbolId+repoId, trim ──────────────────────────────
  const seen = new Set<string>();
  const deduped: SimilarResult[] = [];
  for (const r of allResults) {
    const key = `${r.repoId}:${r.symbolId}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(r);
    }
  }
  deduped.sort((a, b) => b.similarity - a.similarity);
  const top = deduped.slice(0, limit);

  // ── Build response ──────────────────────────────────────────────────────────
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(
        {
          source,
          ...(sourceName !== undefined ? { sourceName } : {}),
          results: top.map((r) => ({
            symbolId: r.symbolId,
            name: r.name,
            kind: r.kind,
            filePath: r.filePath,
            repoId: r.repoId,
            repoName: r.repoName,
            similarity: round4(r.similarity),
            signature: r.signature,
            summary: r.summary,
          })),
          _meta: {
            ...buildMeta({ timingMs: Date.now() - t0 }),
            reposSearched,
            threshold,
            resultCount: top.length,
          },
        },
        null,
        2,
      ),
    }],
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Find a stored embedding for a symbol across the given repos.
 * Returns the Float32Array and the symbol's name if found, null otherwise.
 */
function loadSymbolEmbedding(
  repos: Array<{ id: string; name: string }>,
  symbolId: string,
): { vector: Float32Array; symbolName: string } | null {
  for (const repo of repos) {
    let db;
    try {
      db = openDatabase(repo.id);
      const vec = getEmbedding(db, repo.id, symbolId);
      if (vec) {
        const symbol = getSymbolById(db, repo.id, symbolId);
        const symbolName = symbol?.name ?? symbolId;
        return { vector: vec, symbolName };
      }
    } catch {
      // Unreadable DB — skip
    } finally {
      db?.close();
    }
  }
  return null;
}
