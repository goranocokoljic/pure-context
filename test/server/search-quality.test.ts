/**
 * Task 114 — Phase 14 integration: search quality gate.
 *
 * Indexes the augmented basic-ts-project fixture (which contains the 12 symbols
 * from the original ground-truth corpus) and drives the search_symbols handler
 * with each ground-truth query.  Asserts:
 *   - R@5: expected symbol appears in the top-5 results
 *   - P@1: expected symbol is the top result (gate ≥ 8/12)
 *   - search_mode is 'fts' (FTS5 path, not LIKE fallback)
 *   - every result carries score and matchReason fields
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as searchHandler } from '../../src/server/tools/search-symbols.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

// ─── Ground truth (12 original tasks) ────────────────────────────────────────

const GROUND_TRUTH_12 = [
  { id: 'gt-01', query: 'orchestrate indexing pipeline',            expected: 'indexFolder' },
  { id: 'gt-02', query: 'parse source file tree-sitter ast',        expected: 'parseFile' },
  { id: 'gt-03', query: 'symbol name keyword search database',      expected: 'searchSymbols' },
  { id: 'gt-04', query: 'full text search fts5 symbols',            expected: 'ftsSearchSymbols' },
  { id: 'gt-05', query: 'compute blast radius impact analysis',     expected: 'getBlastRadius' },
  { id: 'gt-06', query: 'hybrid vector semantic search',            expected: 'HybridSearcher' },
  { id: 'gt-07', query: 'discover files scan directory gitignore',  expected: 'discoverFiles' },
  { id: 'gt-08', query: 'watch file changes chokidar',              expected: 'startWatching' },
  { id: 'gt-09', query: 'build dependency graph import edges',      expected: 'buildGraph' },
  { id: 'gt-10', query: 'generate docstring summary symbol',        expected: 'generateSummary' },
  { id: 'gt-11', query: 'typescript language handler extract symbols', expected: 'typescriptHandler' },
  { id: 'gt-12', query: 'find unused dead code exports',            expected: 'findDeadCode' },
] as const;

// ─── Fixture setup ────────────────────────────────────────────────────────────

let repoId: string;

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  const result = await indexFolder(FIXTURE, { fileLimit: 100 });
  repoId = result.repoId;
  expect(result.symbolsFound).toBeGreaterThan(0);
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

type ParsedResponse = {
  symbols: Array<{ name: string; kind: string; filePath: string; score: number; matchReason: string }>;
  _meta: Record<string, unknown>;
};

function parseResult(result: { content: { text: string }[] }): ParsedResponse {
  return JSON.parse(result.content[0].text) as ParsedResponse;
}

async function runQuery(query: string): Promise<ParsedResponse> {
  const result = await searchHandler({ repoId, query, mode: 'keyword' });
  return parseResult(result);
}

// ─── Per-query R@5 gate ───────────────────────────────────────────────────────

describe('search quality — R@5 (expected symbol in top 5)', () => {
  for (const task of GROUND_TRUTH_12) {
    it(`[${task.id}] "${task.query}" → ${task.expected}`, async () => {
      const parsed = await runQuery(task.query);
      const top5 = parsed.symbols.slice(0, 5).map((s) => s.name);
      expect(top5, `Expected "${task.expected}" in top 5, got: ${top5.join(', ')}`).toContain(
        task.expected,
      );
    });
  }
});

// ─── search_mode and result fields ───────────────────────────────────────────

describe('search quality — response format', () => {
  it('search_mode is "fts" (FTS index was populated)', async () => {
    const parsed = await runQuery('orchestrate indexing pipeline');
    expect(parsed._meta.search_mode).toBe('fts');
  });

  it('every result has a numeric score field', async () => {
    const parsed = await runQuery('build dependency graph import edges');
    expect(parsed.symbols.length).toBeGreaterThan(0);
    for (const s of parsed.symbols) {
      expect(typeof s.score).toBe('number');
    }
  });

  it('every result has a matchReason field', async () => {
    const parsed = await runQuery('generate docstring summary symbol');
    expect(parsed.symbols.length).toBeGreaterThan(0);
    for (const s of parsed.symbols) {
      expect(s.matchReason).toMatch(/^(exact_name|prefix_name|name_contains|word_overlap|content_match)$/);
    }
  });
});

// ─── Aggregate gate: P@1 ≥ 8/12 and R@5 ≥ 10/12 ─────────────────────────────

describe('search quality — aggregate metrics', () => {
  it('achieves P@1 ≥ 8/12 (67%) and R@5 ≥ 10/12 (83%)', async () => {
    let p1Hits = 0;
    let r5Hits = 0;

    for (const task of GROUND_TRUTH_12) {
      const parsed = await runQuery(task.query);
      const names = parsed.symbols.map((s) => s.name);
      const top5 = names.slice(0, 5);

      if (top5.includes(task.expected)) r5Hits++;
      if (names[0] === task.expected) p1Hits++;
    }

    expect(
      p1Hits,
      `P@1 ${p1Hits}/12 below the 8/12 gate. Check ground truth queries against fixture symbols.`,
    ).toBeGreaterThanOrEqual(8);

    expect(
      r5Hits,
      `R@5 ${r5Hits}/12 below the 10/12 gate. Check FTS content and fixture docstrings.`,
    ).toBeGreaterThanOrEqual(10);
  });
});
