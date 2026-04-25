/**
 * Task 114 — Phase 14 integration: end-to-end search pipeline.
 *
 * Exercises the three-stage pipeline as a unit:
 *   preprocessQuery → ftsSearchSymbols → rankSymbols
 *
 * Tests: camelCase query, natural-language query, single-word query,
 * snake_case expansion, and empty query safety.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { ftsSearchSymbols } from '../../src/core/db/symbol-store.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { preprocessQuery } from '../../src/core/search/query-preprocessor.js';
import { rankSymbols } from '../../src/core/search/relevance-ranker.js';
import { handler as searchHandler } from '../../src/server/tools/search-symbols.js';
import type { SymbolRecord } from '../../src/core/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

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

/** Run the full three-stage pipeline and return ranked symbol names. */
function runPipeline(rawQuery: string): string[] {
  const ftsQuery = preprocessQuery(rawQuery);
  if (!ftsQuery) return [];

  const db = openDatabase(repoId);
  let symbols: SymbolRecord[];
  try {
    symbols = ftsSearchSymbols(db, repoId, ftsQuery);
  } finally {
    db.close();
  }

  return rankSymbols(symbols, rawQuery).map((r) => r.symbol.name);
}

// ─── camelCase query ──────────────────────────────────────────────────────────

describe('search pipeline — camelCase query', () => {
  it('parseFile query returns parseFile at rank 1', () => {
    const results = runPipeline('parseFile');
    expect(results[0]).toBe('parseFile');
  });

  it('generateSummary query returns generateSummary at rank 1', () => {
    const results = runPipeline('generateSummary');
    expect(results[0]).toBe('generateSummary');
  });

  it('indexFolder query returns indexFolder at rank 1', () => {
    const results = runPipeline('indexFolder');
    expect(results[0]).toBe('indexFolder');
  });
});

// ─── Natural language query ───────────────────────────────────────────────────

describe('search pipeline — natural language query', () => {
  it('"orchestrate indexing pipeline" returns indexFolder in top 5', () => {
    const results = runPipeline('orchestrate indexing pipeline');
    expect(results.slice(0, 5)).toContain('indexFolder');
  });

  it('"build dependency graph import edges" returns buildGraph in top 5', () => {
    const results = runPipeline('build dependency graph import edges');
    expect(results.slice(0, 5)).toContain('buildGraph');
  });

  it('"compute blast radius impact analysis" returns getBlastRadius in top 5', () => {
    const results = runPipeline('compute blast radius impact analysis');
    expect(results.slice(0, 5)).toContain('getBlastRadius');
  });
});

// ─── Single-word query ────────────────────────────────────────────────────────

describe('search pipeline — single-word query', () => {
  it('"format" finds formatDiagnostic', () => {
    const results = runPipeline('format');
    expect(results).toContain('formatDiagnostic');
  });

  it('"clamp" finds clamp', () => {
    const results = runPipeline('clamp');
    expect(results[0]).toBe('clamp');
  });

  it('"truncate" finds truncate', () => {
    const results = runPipeline('truncate');
    expect(results[0]).toBe('truncate');
  });
});

// ─── Ranked output structure ──────────────────────────────────────────────────

describe('search pipeline — ranked output structure', () => {
  it('each ScoredSymbol has symbol, score, and matchReason', () => {
    const ftsQuery = preprocessQuery('format');
    const db = openDatabase(repoId);
    let symbols: SymbolRecord[];
    try {
      symbols = ftsSearchSymbols(db, repoId, ftsQuery);
    } finally {
      db.close();
    }
    const ranked = rankSymbols(symbols, 'format');

    expect(ranked.length).toBeGreaterThan(0);
    for (const r of ranked) {
      expect(r).toHaveProperty('symbol');
      expect(r).toHaveProperty('score');
      expect(r).toHaveProperty('matchReason');
      expect(typeof r.score).toBe('number');
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });

  it('exact name match (formatDiagnostic) has matchReason "exact_name"', () => {
    const ftsQuery = preprocessQuery('formatDiagnostic');
    const db = openDatabase(repoId);
    let symbols: SymbolRecord[];
    try {
      symbols = ftsSearchSymbols(db, repoId, ftsQuery);
    } finally {
      db.close();
    }
    const ranked = rankSymbols(symbols, 'formatDiagnostic');
    const top = ranked[0];
    expect(top.symbol.name).toBe('formatDiagnostic');
    expect(top.matchReason).toBe('exact_name');
  });
});

// ─── Empty query safety ───────────────────────────────────────────────────────

describe('search pipeline — empty query safety', () => {
  it('empty string does not throw when called via handler', async () => {
    // The handler catches FTS errors and falls back to LIKE gracefully
    await expect(
      searchHandler({ repoId, query: '', mode: 'keyword' }),
    ).resolves.not.toThrow();
  });

  it('preprocessQuery of empty string returns empty string', () => {
    expect(preprocessQuery('')).toBe('');
  });

  it('runPipeline with empty query returns empty array (no crash)', () => {
    expect(runPipeline('')).toHaveLength(0);
  });
});
