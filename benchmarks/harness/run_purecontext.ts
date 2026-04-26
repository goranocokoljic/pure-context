#!/usr/bin/env tsx
/**
 * PureContext benchmark harness — Dimensions 1, 2, 3, and 4.
 *
 * Dimensions:
 *   1 — Token efficiency vs. "read all files" baseline
 *   2 — Search quality: keyword Precision@1 / Recall@5 against ground-truth tasks
 *   3 — Symbol coverage: count, by-kind breakdown, symbols/kLOC
 *   4 — Semantic search: keyword vs. hybrid P@1/R@5 on same ground-truth set
 *
 * Usage:
 *   npx tsx benchmarks/harness/run_purecontext.ts [--out results/purecontext.json]
 *
 * Requirements:
 *   npm run build   (or tsx handles it directly)
 *   The PureContext repo must be the CWD parent (script lives in benchmarks/harness/).
 */

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';
import { encode } from 'gpt-tokenizer';

// ─── Resolve paths ────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const BENCHMARKS_DIR = resolve(__dirname, '..');

// ─── Config ───────────────────────────────────────────────────────────────────

const SEARCH_MAX_RESULTS = 5;
const SYMBOLS_FETCHED = 3;

// ─── Imports from PureContext source ─────────────────────────────────────────────
// tsx resolves these at runtime without a separate compile step.

// Handler registration (must run before indexFolder)
import { registerHandler } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { pythonHandler } from '../../src/handlers/python.js';
import { goHandler } from '../../src/handlers/go.js';
import { rustHandler } from '../../src/handlers/rust.js';
import { javaHandler } from '../../src/handlers/java.js';
import { csharpHandler } from '../../src/handlers/csharp.js';
import { phpHandler } from '../../src/handlers/php.js';
import { rubyHandler } from '../../src/handlers/ruby.js';
import { kotlinHandler } from '../../src/handlers/kotlin.js';
import { cHandler } from '../../src/handlers/c.js';
import { cppHandler } from '../../src/handlers/cpp.js';
import { luaHandler } from '../../src/handlers/lua.js';
import { dartHandler } from '../../src/handlers/dart.js';
import { swiftHandler } from '../../src/handlers/swift.js';
import { elixirHandler } from '../../src/handlers/elixir.js';
import { haskellHandler } from '../../src/handlers/haskell.js';
import { scalaHandler } from '../../src/handlers/scala.js';
import { rHandler } from '../../src/handlers/r.js';

import { indexFolder, deleteIndex, computeRepoId } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import {
  searchSymbols,
  getSymbolById,
  getSymbolsByRepo,
} from '../../src/core/db/symbol-store.js';
import {
  getFileContent,
  getAllFilesWithContent,
} from '../../src/core/db/file-store.js';
import { HybridSearcher } from '../../src/semantic/hybrid-search.js';
import { VectorStore } from '../../src/semantic/vector-store.js';
import { createEmbeddingProvider } from '../../src/semantic/embedding-provider.js';
import { getConfig } from '../../src/config/config-loader.js';
import { countEmbeddings } from '../../src/core/db/embedding-store.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Task { id: string; query: string; description?: string; }
interface GroundTruthTask {
  id: string;
  query: string;
  expected_symbol: string;
  expected_file: string;
  description?: string;
}
interface Dim1Row {
  query: string;
  baseline_tokens: number;
  tool_tokens: number;
  reduction_pct: number;
  ratio: number;
  search_tokens: number;
  fetch_tokens: number;
  hits_fetched: number;
  search_ms: number;
}
interface Dim2Row {
  id: string;
  query: string;
  expected_symbol: string;
  expected_file: string;
  rank_found: number | null;
  p1: boolean;
  p3: boolean;
  p5: boolean;
  top5_names: string[];
  query_ms: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countTokens(text: string): number {
  return encode(text).length;
}

function serialize(obj: unknown): string {
  return JSON.stringify(obj, null, 0);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function parseArgs(): { out?: string } {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  return { out: outIdx >= 0 ? args[outIdx + 1] : undefined };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { out } = parseArgs();
  const totalStart = performance.now();

  // Load benchmark config
  const tasks: Task[] = JSON.parse(
    readFileSync(resolve(BENCHMARKS_DIR, 'tasks.json'), 'utf-8'),
  ).tasks;
  const groundTruth: GroundTruthTask[] = JSON.parse(
    readFileSync(resolve(BENCHMARKS_DIR, 'ground-truth.json'), 'utf-8'),
  ).tasks;

  // Register all language handlers (mirrors src/index.ts bootstrap())
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  registerHandler(pythonHandler);
  registerHandler(goHandler);
  registerHandler(rustHandler);
  registerHandler(javaHandler);
  registerHandler(csharpHandler);
  registerHandler(phpHandler);
  registerHandler(rubyHandler);
  registerHandler(kotlinHandler);
  registerHandler(cHandler);
  registerHandler(cppHandler);
  registerHandler(luaHandler);
  registerHandler(dartHandler);
  registerHandler(swiftHandler);
  registerHandler(elixirHandler);
  registerHandler(haskellHandler);
  registerHandler(scalaHandler);
  registerHandler(rHandler);

  // ── Dimension 0: Indexing Speed ──────────────────────────────────────────
  console.error('[purecontext] Running Dimension 0 (indexing speed) ...');

  // Pass 1 — sequential (concurrency: 1) to establish baseline
  console.error(`[purecontext] Dim 0 pass 1/2: sequential (concurrency:1) ...`);
  const seqStart = performance.now();
  const seqResult = await indexFolder(REPO_ROOT, { concurrency: 1 });
  const seqMs = round1(performance.now() - seqStart);
  console.error(`[purecontext] Dim 0 sequential: ${seqMs}ms — ${seqResult.filesIndexed} files, ${seqResult.symbolsFound} symbols`);
  deleteIndex(computeRepoId(REPO_ROOT));

  // Pass 2 — auto concurrency (default: min(cpuCount, 8))
  console.error(`[purecontext] Dim 0 pass 2/2: parallel (concurrency:auto) ...`);
  const indexStart = performance.now();
  const indexResult = await indexFolder(REPO_ROOT);
  const indexingMs = round1(performance.now() - indexStart);
  console.error(`[purecontext] Dim 0 parallel: ${indexingMs}ms — ${indexResult.totalSymbolsInDb} symbols, ${indexResult.totalFilesInDb} files`);

  const dim0 = {
    sequential: {
      duration_ms: seqMs,
      files_indexed: seqResult.filesIndexed,
      symbols_found: seqResult.symbolsFound,
      files_per_sec: round1((seqResult.filesIndexed / seqMs) * 1000),
      symbols_per_sec: round1((seqResult.symbolsFound / seqMs) * 1000),
    },
    parallel: {
      duration_ms: indexingMs,
      files_indexed: indexResult.filesIndexed,
      symbols_found: indexResult.symbolsFound,
      files_per_sec: round1((indexResult.filesIndexed / indexingMs) * 1000),
      symbols_per_sec: round1((indexResult.symbolsFound / indexingMs) * 1000),
    },
    speedup: round1(seqMs / (indexingMs || 1)),
  };
  console.error(`[purecontext] Dim 0 speedup: ${dim0.speedup}×`);

  const repoId = computeRepoId(REPO_ROOT);
  const db = openDatabase(repoId);

  const totalSymbolCount = indexResult.totalSymbolsInDb;
  const totalFileCount = indexResult.totalFilesInDb;

  // ── Baseline ──────────────────────────────────────────────────────────────
  console.error('[purecontext] Computing baseline token count ...');
  const allFiles = getAllFilesWithContent(db, repoId);
  let baselineTokens = 0;
  let totalLoc = 0;
  for (const f of allFiles) {
    if (f.rawContent) {
      const text = f.rawContent.toString('utf-8');
      baselineTokens += countTokens(text);
      totalLoc += text.split('\n').length;
    }
  }
  console.error(`[purecontext] Baseline: ${baselineTokens.toLocaleString()} tokens across ${allFiles.length} files`);

  // ── Dimension 1: Token Efficiency ─────────────────────────────────────────
  console.error('[purecontext] Running Dimension 1 (token efficiency) ...');
  const dim1Tasks: Dim1Row[] = [];

  for (const task of tasks) {
    const t0 = performance.now();
    const symbols = searchSymbols(db, repoId, task.query, { limit: SEARCH_MAX_RESULTS });
    const searchMs = round1(performance.now() - t0);

    const searchPayload = {
      count: symbols.length,
      symbols: symbols.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        filePath: s.filePath,
        signature: s.signature,
        summary: s.summary,
      })),
    };
    const searchTokens = countTokens(serialize(searchPayload));

    let fetchTokens = 0;
    const topSymbols = symbols.slice(0, SYMBOLS_FETCHED);
    for (const sym of topSymbols) {
      const raw = getFileContent(db, repoId, sym.filePath);
      if (raw) {
        const source = raw.slice(sym.startByte, sym.endByte).toString('utf-8');
        fetchTokens += countTokens(
          serialize({
            symbol: {
              id: sym.id,
              name: sym.name,
              kind: sym.kind,
              filePath: sym.filePath,
              signature: sym.signature,
              summary: sym.summary,
              source,
            },
          }),
        );
      }
    }

    const toolTokens = searchTokens + fetchTokens;
    dim1Tasks.push({
      query: task.query,
      baseline_tokens: baselineTokens,
      tool_tokens: toolTokens,
      reduction_pct: round1((1 - toolTokens / baselineTokens) * 100),
      ratio: round1(baselineTokens / (toolTokens || 1)),
      search_tokens: searchTokens,
      fetch_tokens: fetchTokens,
      hits_fetched: topSymbols.length,
      search_ms: searchMs,
    });

    console.error(`  ${task.query}: ${toolTokens.toLocaleString()} tokens (${round1((1 - toolTokens / baselineTokens) * 100)}% reduction)`);
  }

  // ── Dimension 2: Search Quality (keyword) ────────────────────────────────
  console.error('[purecontext] Running Dimension 2 (keyword search quality) ...');
  const dim2Tasks: Dim2Row[] = [];
  const dim2QueryMs: number[] = [];

  for (const gt of groundTruth) {
    const t0 = performance.now();
    const symbols = searchSymbols(db, repoId, gt.query, { limit: 5 });
    const queryMs = round1(performance.now() - t0);
    dim2QueryMs.push(queryMs);

    const names = symbols.map((s) => s.name);
    const rank = names.indexOf(gt.expected_symbol) + 1; // 0 = not found

    dim2Tasks.push({
      id: gt.id,
      query: gt.query,
      expected_symbol: gt.expected_symbol,
      expected_file: gt.expected_file,
      rank_found: rank > 0 ? rank : null,
      p1: rank === 1,
      p3: rank > 0 && rank <= 3,
      p5: rank > 0 && rank <= 5,
      top5_names: names,
      query_ms: queryMs,
    });
  }

  const p1Keyword = round4(dim2Tasks.filter((t) => t.p1).length / dim2Tasks.length);
  const r5Keyword = round4(dim2Tasks.filter((t) => t.p5).length / dim2Tasks.length);

  const dim2QueryMsSorted = [...dim2QueryMs].sort((a, b) => a - b);
  const dim2LatencyMedian = dim2QueryMsSorted[Math.floor(dim2QueryMsSorted.length / 2)] ?? 0;
  const dim2LatencyP95 = dim2QueryMsSorted[Math.floor(dim2QueryMsSorted.length * 0.95)] ?? 0;

  // ── Dimension 3: Symbol Coverage ─────────────────────────────────────────
  console.error('[purecontext] Running Dimension 3 (symbol coverage) ...');
  const allSymbols = getSymbolsByRepo(db, repoId, 100_000);
  const byKind: Record<string, number> = {};
  for (const sym of allSymbols) {
    byKind[sym.kind] = (byKind[sym.kind] ?? 0) + 1;
  }

  // ── Dimension 4: Semantic vs. Keyword ────────────────────────────────────
  console.error('[purecontext] Running Dimension 4 (semantic search quality) ...');
  const dim4Tasks: (Dim2Row & { hybrid_rank: number | null; hybrid_p1: boolean; hybrid_p3: boolean; hybrid_p5: boolean })[] = [];

  let hybridAvailable = false;
  try {
    const embCount = countEmbeddings(db, repoId);
    if (embCount > 0) {
      hybridAvailable = true;
      const config = getConfig();
      const provider = createEmbeddingProvider(config);
      const vectorStore = new VectorStore(repoId, provider, db);
      await vectorStore.rebuild();
      const searcher = new HybridSearcher(repoId, vectorStore, db);

      for (const gt of groundTruth) {
        // Keyword rank (already computed in dim2)
        const kwRow = dim2Tasks.find((r) => r.id === gt.id)!;

        // Hybrid rank
        const hybridResults = await searcher.search(gt.query, { maxResults: 5 });
        const hybridNames = hybridResults.map((r) => r.symbol.name);
        const hybridRank = hybridNames.indexOf(gt.expected_symbol) + 1;

        dim4Tasks.push({
          ...kwRow,
          hybrid_rank: hybridRank > 0 ? hybridRank : null,
          hybrid_p1: hybridRank === 1,
          hybrid_p3: hybridRank > 0 && hybridRank <= 3,
          hybrid_p5: hybridRank > 0 && hybridRank <= 5,
        });
      }
    } else {
      console.error('[purecontext] No semantic index found — skipping Dim 4 (run index with embeddings to enable)');
    }
  } catch (err) {
    console.error(`[purecontext] Dim 4 skipped: ${err}`);
  }

  db.close();

  // ── Assemble result ───────────────────────────────────────────────────────
  const dim1Avg = {
    reduction_pct: round1(dim1Tasks.reduce((s, t) => s + t.reduction_pct, 0) / dim1Tasks.length),
    ratio: round1(dim1Tasks.reduce((s, t) => s + t.ratio, 0) / dim1Tasks.length),
  };

  const result = {
    tool: 'purecontext',
    tool_version: '0.1.0',
    repo_path: REPO_ROOT,
    repo_id: repoId,
    dim0,
    indexing: {
      duration_ms: indexingMs,
      file_count: totalFileCount,
      symbol_count: totalSymbolCount,
    },
    baseline_tokens: baselineTokens,
    dim1: {
      workflow: `search_symbols (top ${SEARCH_MAX_RESULTS}) + get_symbol_source x${SYMBOLS_FETCHED}`,
      tasks: dim1Tasks,
      avg: dim1Avg,
    },
    dim2: {
      mode: 'keyword',
      tasks: dim2Tasks,
      precision_at_1: p1Keyword,
      recall_at_5: r5Keyword,
      latency_ms: {
        median: dim2LatencyMedian,
        p95: dim2LatencyP95,
      },
    },
    dim3: {
      symbol_count: totalSymbolCount,
      file_count: totalFileCount,
      total_loc: totalLoc,
      symbols_per_kloc: round1(allSymbols.length / (totalLoc / 1000)),
      by_kind: byKind,
    },
    dim4: hybridAvailable
      ? {
          tasks: dim4Tasks,
          keyword_precision_at_1: p1Keyword,
          keyword_recall_at_5: r5Keyword,
          hybrid_precision_at_1: round4(dim4Tasks.filter((t) => t.hybrid_p1).length / dim4Tasks.length),
          hybrid_recall_at_5: round4(dim4Tasks.filter((t) => t.hybrid_p5).length / dim4Tasks.length),
        }
      : { skipped: true, reason: 'No semantic index — re-index with embeddings enabled' },
    total_runtime_ms: round1(performance.now() - totalStart),
  };

  const json = JSON.stringify(result, null, 2);

  if (out) {
    writeFileSync(out, json, 'utf-8');
    console.error(`[purecontext] Results written to ${out}`);
  } else {
    console.log(json);
  }
}

main().catch((err) => {
  console.error('[purecontext] Fatal:', err);
  process.exit(1);
});
