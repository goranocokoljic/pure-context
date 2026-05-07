/**
 * Tests for search debug mode (Task 135).
 *
 * Verifies that search_symbols and search_semantic return _score breakdowns
 * when debug: true, and omit them when debug: false (or not set).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as searchSymbolsHandler } from '../../src/server/tools/search-symbols.js';
import { rankSymbols } from '../../src/core/search/relevance-ranker.js';
import type { SymbolRecord } from '../../src/core/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

let repoId: string;

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  const result = await indexFolder(FIXTURE, { fileLimit: 50 });
  repoId = result.repoId;
  expect(result.symbolsFound).toBeGreaterThan(0);
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

function parseResult(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// ─── search_symbols debug mode ────────────────────────────────────────────────

describe('search_symbols debug mode', () => {
  it('returns _score on each result when debug: true (keyword mode)', async () => {
    const result = await searchSymbolsHandler({
      repoId,
      query: 'search',
      mode: 'keyword',
      debug: true,
    });

    const parsed = parseResult(result);
    const symbols = parsed.symbols as Array<Record<string, unknown>>;
    expect(symbols.length).toBeGreaterThan(0);

    for (const sym of symbols) {
      expect(sym).toHaveProperty('_score');
      const score = sym._score as Record<string, number>;
      expect(typeof score.total).toBe('number');
      expect(typeof score.nameExact).toBe('number');
      expect(typeof score.namePrefix).toBe('number');
      expect(typeof score.nameFuzzy).toBe('number');
      expect(typeof score.wordOverlap).toBe('number');
      expect(typeof score.signatureMatch).toBe('number');
      expect(typeof score.summaryMatch).toBe('number');
      expect(score.kindBoost).toBe(0);
      expect(score.recencyBoost).toBe(0);
    }
  });

  it('omits _score when debug: false (keyword mode)', async () => {
    const result = await searchSymbolsHandler({
      repoId,
      query: 'search',
      mode: 'keyword',
      debug: false,
    });

    const parsed = parseResult(result);
    const symbols = parsed.symbols as Array<Record<string, unknown>>;
    expect(symbols.length).toBeGreaterThan(0);

    for (const sym of symbols) {
      expect(sym).not.toHaveProperty('_score');
    }
  });

  it('omits _score when debug is not provided', async () => {
    const result = await searchSymbolsHandler({
      repoId,
      query: 'search',
      mode: 'keyword',
    });

    const parsed = parseResult(result);
    const symbols = parsed.symbols as Array<Record<string, unknown>>;
    expect(symbols.length).toBeGreaterThan(0);

    for (const sym of symbols) {
      expect(sym).not.toHaveProperty('_score');
    }
  });
});

// ─── rankSymbols debug scores ──────────────────────────────────────────────────

describe('rankSymbols debug score breakdown', () => {
  function makeSymbol(name: string, signature = '', summary = ''): SymbolRecord {
    return {
      id: name,
      name,
      kind: 'function',
      filePath: 'test.ts',
      startByte: 0,
      endByte: 10,
      signature,
      summary,
    };
  }

  it('exact name match gives nameExact=100, others=0', () => {
    const [result] = rankSymbols([makeSymbol('parseSymbol')], 'parseSymbol', true);
    expect(result.debugScore).toBeDefined();
    expect(result.debugScore!.nameExact).toBe(100);
    expect(result.debugScore!.namePrefix).toBe(0);
    expect(result.debugScore!.nameFuzzy).toBe(0);
  });

  it('prefix name match gives namePrefix=60, nameExact=0', () => {
    const [result] = rankSymbols([makeSymbol('parseSymbolFull')], 'parseSymbol', true);
    expect(result.debugScore).toBeDefined();
    expect(result.debugScore!.nameExact).toBe(0);
    expect(result.debugScore!.namePrefix).toBe(60);
    expect(result.debugScore!.nameFuzzy).toBe(0);
  });

  it('contains match gives nameFuzzy=40', () => {
    const [result] = rankSymbols([makeSymbol('fullParseSymbolHelper')], 'parseSymbol', true);
    expect(result.debugScore).toBeDefined();
    expect(result.debugScore!.nameExact).toBe(0);
    expect(result.debugScore!.namePrefix).toBe(0);
    expect(result.debugScore!.nameFuzzy).toBe(40);
  });

  it('signature match contributes signatureMatch', () => {
    const sym = makeSymbol('doThing', 'function doThing(parseSymbol: string)');
    const [result] = rankSymbols([sym], 'parseSymbol', true);
    expect(result.debugScore!.signatureMatch).toBeGreaterThan(0);
  });

  it('summary match contributes summaryMatch', () => {
    const sym = makeSymbol('doThing', '', 'parses a parseSymbol from the source');
    const [result] = rankSymbols([sym], 'parseSymbol', true);
    expect(result.debugScore!.summaryMatch).toBeGreaterThan(0);
  });

  it('score components sum to total', () => {
    const sym = makeSymbol('parseSymbol', 'function parseSymbol()', 'Parses a symbol');
    const [result] = rankSymbols([sym], 'parse', true);
    const d = result.debugScore!;
    const sum = d.nameExact + d.namePrefix + d.nameFuzzy + d.wordOverlap +
                d.signatureMatch + d.summaryMatch + d.kindBoost + d.recencyBoost;
    expect(d.total).toBe(sum);
  });

  it('debug: false omits debugScore', () => {
    const [result] = rankSymbols([makeSymbol('parseSymbol')], 'parseSymbol', false);
    expect(result.debugScore).toBeUndefined();
  });

  it('debug omitted defaults to false (no debugScore)', () => {
    const [result] = rankSymbols([makeSymbol('parseSymbol')], 'parseSymbol');
    expect(result.debugScore).toBeUndefined();
  });
});
