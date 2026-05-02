/**
 * Competitive benchmark — Task 69.
 *
 * Compares PureContext token efficiency against jCodeMunch using the same
 * corpus defined in `reference/jcodemunch-mcp/benchmarks/tasks.json`.
 *
 * **Methodology** (identical to jCodeMunch's published approach):
 * - Baseline: concatenate all indexed source files, count tokens using
 *   cl100k_base encoding (approximated as bytes / 4)
 * - PureContext workflow: `search-symbols` (max 5 results) + `get-symbol-source`
 *   for top 3 hits
 * - Token counting: sum all tool response JSON bytes / 4
 * - Reduction formula: `(1 - purecontext_tokens / baseline_tokens) * 100`
 *
 * **Run command:**
 *   npm run benchmark:competitive
 *
 * Or directly:
 *   npx vitest bench --run test/benchmarks/competitive.bench.ts
 *
 * **Note:** This benchmark uses local fixture projects instead of cloning
 * remote repos (which would require network access). The methodology
 * remains identical — the goal is to demonstrate token efficiency on
 * representative codebases.
 */

import { describe, bench, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'fs';

import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';
import { getFileContent } from '../../src/core/db/file-store.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { swiftHandler } from '../../src/handlers/swift.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { _resetForTesting as resetAdapters } from '../../src/adapters/adapter-registry.js';

// ─── Paths ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const FIXTURES_DIR = resolve(__dirname, '../fixtures');

// ─── Token approximation ──────────────────────────────────────────────────────

/**
 * Approximate token count using bytes / 4 (cl100k_base approximation).
 * This is the same methodology used in jCodeMunch benchmarks.
 */
function estimateTokens(content: string | Buffer): number {
  const bytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length;
  return Math.ceil(bytes / 4);
}

// ─── File system helpers ──────────────────────────────────────────────────────

/**
 * Recursively collect all source files in a directory.
 */
function collectSourceFiles(dir: string, extensions: Set<string>): string[] {
  const files: string[] = [];

  function walk(d: string) {
    const entries = readdirSync(d);
    for (const entry of entries) {
      const fullPath = resolve(d, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        // Skip common non-source directories
        if (['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(entry)) continue;
        walk(fullPath);
      } else if (stat.isFile()) {
        const ext = '.' + entry.split('.').pop();
        if (extensions.has(ext)) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return files;
}

/**
 * Calculate baseline tokens: sum of all source file contents.
 */
function calculateBaseline(dir: string, extensions: Set<string>): { files: number; tokens: number } {
  const sourceFiles = collectSourceFiles(dir, extensions);
  let totalTokens = 0;

  for (const file of sourceFiles) {
    try {
      const content = readFileSync(file, 'utf8');
      totalTokens += estimateTokens(content);
    } catch {
      // Skip unreadable files
    }
  }

  return { files: sourceFiles.length, tokens: totalTokens };
}

// ─── Benchmark queries (from jCodeMunch tasks.json) ───────────────────────────

const QUERIES = [
  { id: 'router-route-handler', query: 'router route handler' },
  { id: 'middleware',           query: 'middleware' },
  { id: 'error-exception',      query: 'error exception' },
  { id: 'request-response',     query: 'request response' },
  { id: 'context-bind',         query: 'context bind' },
];

// ─── Fixtures to benchmark ────────────────────────────────────────────────────

interface BenchmarkFixture {
  name: string;
  path: string;
  extensions: Set<string>;
}

const BENCHMARK_FIXTURES: BenchmarkFixture[] = [
  {
    name: 'basic-ts-project',
    path: resolve(FIXTURES_DIR, 'basic-ts-project'),
    extensions: new Set(['.ts', '.tsx', '.js', '.jsx']),
  },
  {
    name: 'swift-project',
    path: resolve(FIXTURES_DIR, 'swift-project'),
    extensions: new Set(['.swift']),
  },
  {
    name: 'vapor-project',
    path: resolve(FIXTURES_DIR, 'vapor-project'),
    extensions: new Set(['.swift']),
  },
];

// ─── Benchmark state ──────────────────────────────────────────────────────────

interface RepoState {
  repoId: string;
  baseline: { files: number; tokens: number };
  symbolCount: number;
}

const repoStates = new Map<string, RepoState>();

// ─── Results storage ──────────────────────────────────────────────────────────

interface QueryResult {
  query: string;
  searchTokens: number;
  fetchTokens: number;
  totalTokens: number;
  hitsFetched: number;
  searchMs: number;
}

interface RepoResult {
  name: string;
  filesIndexed: number;
  symbolsExtracted: number;
  baselineTokens: number;
  queryResults: QueryResult[];
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  resetAdapters();

  // Register handlers
  registerHandler(typescriptHandler);
  registerHandler(javascriptHandler);
  registerHandler(swiftHandler);

  await initParser();

  // Index all fixtures
  for (const fixture of BENCHMARK_FIXTURES) {
    if (!existsSync(fixture.path)) {
      console.warn(`Fixture not found: ${fixture.path}`);
      continue;
    }

    const baseline = calculateBaseline(fixture.path, fixture.extensions);
    const indexResult = await indexFolder(fixture.path);

    // Get symbol count
    const db = openDatabase(indexResult.repoId);
    const allSymbols = searchSymbols(db, indexResult.repoId, '', { limit: 10000 });
    db.close();

    repoStates.set(fixture.name, {
      repoId: indexResult.repoId,
      baseline,
      symbolCount: allSymbols.length,
    });
  }
}, 120_000);

afterAll(() => {
  // Cleanup indexes
  for (const state of repoStates.values()) {
    if (state.repoId) deleteIndex(state.repoId);
  }

  // Collect and write results
  const results: RepoResult[] = [];

  for (const fixture of BENCHMARK_FIXTURES) {
    const state = repoStates.get(fixture.name);
    if (!state) continue;

    const queryResults: QueryResult[] = [];
    const db = openDatabase(state.repoId);

    for (const q of QUERIES) {
      const searchStart = performance.now();
      const searchResults = searchSymbols(db, state.repoId, q.query, { limit: 5 });
      const searchMs = performance.now() - searchStart;

      const searchResponse = JSON.stringify(searchResults);
      const searchTokens = estimateTokens(searchResponse);

      let fetchTokens = 0;
      let hitsFetched = 0;
      const topHits = searchResults.slice(0, 3);

      for (const symbol of topHits) {
        const fileContent = getFileContent(db, state.repoId, symbol.filePath);
        if (fileContent) {
          const sourceSlice = fileContent.slice(symbol.startByte, symbol.endByte);
          fetchTokens += estimateTokens(sourceSlice);
          hitsFetched++;
        }
      }

      queryResults.push({
        query: q.query,
        searchTokens,
        fetchTokens,
        totalTokens: searchTokens + fetchTokens,
        hitsFetched,
        searchMs,
      });
    }

    db.close();

    results.push({
      name: fixture.name,
      filesIndexed: state.baseline.files,
      symbolsExtracted: state.symbolCount,
      baselineTokens: state.baseline.tokens,
      queryResults,
    });
  }

  // Write results to markdown
  writeResults(results);
});

// ─── Results writer ───────────────────────────────────────────────────────────

function writeResults(results: RepoResult[]): void {
  if (results.length === 0) return;

  const lines: string[] = [
    '# PureContext — Token Efficiency Benchmark',
    '',
    '**Tokenizer:** `cl100k_base` approximation (bytes / 4)',
    '**Workflow:** `search-symbols` (top 5) + `get-symbol-source` x 3',
    '**Baseline:** all source files concatenated (minimum for "open every file" agent)',
    '',
  ];

  let grandBaselineTotal = 0;
  let grandPureContextTotal = 0;
  let totalQueryRuns = 0;

  for (const repo of results) {
    lines.push(`## ${repo.name}`);
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Files indexed | **${repo.filesIndexed}** |`);
    lines.push(`| Symbols extracted | **${repo.symbolsExtracted}** |`);
    lines.push(`| Baseline tokens (all files) | **${repo.baselineTokens.toLocaleString()}** |`);
    lines.push('');
    lines.push('| Query | Baseline&nbsp;tokens | PureContext&nbsp;tokens | Reduction | Ratio |');
    lines.push('|-------|---------------------:|---------------------:|----------:|------:|');

    let repoTotalPureContext = 0;
    let repoTotalReduction = 0;
    let queryCount = 0;

    for (const qr of repo.queryResults) {
      const reduction = repo.baselineTokens > 0
        ? ((1 - qr.totalTokens / repo.baselineTokens) * 100).toFixed(1)
        : '0.0';
      const ratio = qr.totalTokens > 0
        ? (repo.baselineTokens / qr.totalTokens).toFixed(1)
        : '∞';

      lines.push(
        `| \`${qr.query}\` | ${repo.baselineTokens.toLocaleString()} | ${qr.totalTokens.toLocaleString()} | **${reduction}%** | ${ratio}x |`
      );

      repoTotalPureContext += qr.totalTokens;
      repoTotalReduction += parseFloat(reduction);
      queryCount++;
      totalQueryRuns++;
    }

    const avgReduction = queryCount > 0 ? (repoTotalReduction / queryCount).toFixed(1) : '0.0';
    const avgRatio = repoTotalPureContext > 0 && queryCount > 0
      ? ((repo.baselineTokens * queryCount) / repoTotalPureContext).toFixed(1)
      : '∞';

    lines.push(`| **Average** | — | — | **${avgReduction}%** | **${avgRatio}x** |`);
    lines.push('');

    // Details
    lines.push('<details><summary>Query detail (search + fetch tokens, latency)</summary>');
    lines.push('');
    lines.push('| Query | Search&nbsp;tokens | Fetch&nbsp;tokens | Hits&nbsp;fetched | Search&nbsp;ms |');
    lines.push('|-------|-----------------:|------------------:|------------------:|---------------:|');

    for (const qr of repo.queryResults) {
      lines.push(
        `| \`${qr.query}\` | ${qr.searchTokens} | ${qr.fetchTokens} | ${qr.hitsFetched} | ${qr.searchMs.toFixed(1)} |`
      );
    }

    lines.push('');
    lines.push('</details>');
    lines.push('');

    grandBaselineTotal += repo.baselineTokens * repo.queryResults.length;
    grandPureContextTotal += repoTotalPureContext;
  }

  // Grand summary
  lines.push('---');
  lines.push('');
  lines.push('## Grand Summary');
  lines.push('');
  lines.push('| | Tokens |');
  lines.push('|--|-------:|');
  lines.push(`| Baseline total (${totalQueryRuns} task-runs) | ${grandBaselineTotal.toLocaleString()} |`);
  lines.push(`| PureContext total | ${grandPureContextTotal.toLocaleString()} |`);

  const grandReduction = grandBaselineTotal > 0
    ? ((1 - grandPureContextTotal / grandBaselineTotal) * 100).toFixed(1)
    : '0.0';
  const grandRatio = grandPureContextTotal > 0
    ? (grandBaselineTotal / grandPureContextTotal).toFixed(1)
    : '∞';

  lines.push(`| **Reduction** | **${grandReduction}%** |`);
  lines.push(`| **Ratio** | **${grandRatio}x** |`);
  lines.push('');
  lines.push('> Measured with cl100k_base approximation (bytes / 4). Baseline = all indexed source files. PureContext = search_symbols (top 5) + get_symbol_source x 3 per query.');
  lines.push('');

  // Ensure benchmarks directory exists
  const benchDir = resolve(__dirname, '../../benchmarks');
  if (!existsSync(benchDir)) {
    mkdirSync(benchDir, { recursive: true });
  }

  writeFileSync(resolve(benchDir, 'results.md'), lines.join('\n'));
  console.log(`\nResults written to benchmarks/results.md`);
}

// ─── Benchmark suites ─────────────────────────────────────────────────────────

/**
 * Run a single query benchmark for a fixture.
 */
function runQueryBenchmark(fixtureName: string, query: string): QueryResult {
  const state = repoStates.get(fixtureName);
  if (!state) {
    return {
      query,
      searchTokens: 0,
      fetchTokens: 0,
      totalTokens: 0,
      hitsFetched: 0,
      searchMs: 0,
    };
  }

  const db = openDatabase(state.repoId);

  // Measure search
  const searchStart = performance.now();
  const searchResults = searchSymbols(db, state.repoId, query, { limit: 5 });
  const searchMs = performance.now() - searchStart;

  // Calculate search response size (simulate JSON response)
  const searchResponse = JSON.stringify(searchResults);
  const searchTokens = estimateTokens(searchResponse);

  // Fetch top 3 symbol sources
  let fetchTokens = 0;
  let hitsFetched = 0;
  const topHits = searchResults.slice(0, 3);

  for (const symbol of topHits) {
    // Get the actual source code for this symbol
    const fileContent = getFileContent(db, state.repoId, symbol.filePath);
    if (fileContent) {
      const sourceSlice = fileContent.slice(symbol.startByte, symbol.endByte);
      fetchTokens += estimateTokens(sourceSlice);
      hitsFetched++;
    }
  }

  db.close();

  return {
    query,
    searchTokens,
    fetchTokens,
    totalTokens: searchTokens + fetchTokens,
    hitsFetched,
    searchMs,
  };
}

// ─── Define benchmark suites for each fixture ─────────────────────────────────

for (const fixture of BENCHMARK_FIXTURES) {
  describe(`${fixture.name} token efficiency`, () => {
    for (const q of QUERIES) {
      bench(
        `query: ${q.query}`,
        () => {
          return runQueryBenchmark(fixture.name, q.query);
        },
        { iterations: 1, warmupIterations: 0 },
      );
    }
  });
}
