import { describe, it, expect } from 'vitest';
import { rankSymbols } from '../../src/core/search/relevance-ranker.js';
import type { SymbolRecord } from '../../src/core/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sym(
  name: string,
  opts: Partial<Pick<SymbolRecord, 'kind' | 'filePath' | 'signature' | 'summary'>> = {},
): SymbolRecord {
  return {
    id: `id-${name}`,
    name,
    kind: opts.kind ?? 'function',
    filePath: opts.filePath ?? 'src/index.ts',
    startByte: 0,
    endByte: 100,
    signature: opts.signature ?? `function ${name}()`,
    summary: opts.summary ?? `Does ${name}`,
  };
}

// ─── Exact name beats everything ─────────────────────────────────────────────

describe('rankSymbols — exact name match ranked first', () => {
  it('indexFolder at rank 1 when query is "indexFolder"', () => {
    const symbols = [sym('indexRepo'), sym('getBlastRadius'), sym('indexFolder')];
    const results = rankSymbols(symbols, 'indexFolder');
    expect(results[0].symbol.name).toBe('indexFolder');
    expect(results[0].matchReason).toBe('exact_name');
  });

  it('exact match score is 100 or more', () => {
    const results = rankSymbols([sym('indexFolder'), sym('indexRepo')], 'indexFolder');
    expect(results[0].score).toBeGreaterThanOrEqual(100);
  });

  it('exact match always beats prefix match', () => {
    // 'parseFile' is exact; 'parseFileAsync' is prefix
    const results = rankSymbols([sym('parseFileAsync'), sym('parseFile')], 'parseFile');
    expect(results[0].symbol.name).toBe('parseFile');
    expect(results[0].matchReason).toBe('exact_name');
    expect(results[1].matchReason).toBe('prefix_name');
  });

  it('prefix always beats name_contains', () => {
    const results = rankSymbols([sym('findParseFile'), sym('parseFileContent')], 'parseFile');
    // 'parseFileContent' starts with 'parseFile' → prefix
    // 'findParseFile' contains 'parseFile' → name_contains
    expect(results[0].symbol.name).toBe('parseFileContent');
    expect(results[0].matchReason).toBe('prefix_name');
    expect(results[1].matchReason).toBe('name_contains');
  });
});

// ─── Multi-word query: word overlap ──────────────────────────────────────────

describe('rankSymbols — multi-word query word overlap', () => {
  it('"blast radius" ranks getBlastRadius above buildGraph', () => {
    const results = rankSymbols([sym('buildGraph'), sym('getBlastRadius')], 'blast radius');
    expect(results[0].symbol.name).toBe('getBlastRadius');
    expect(results[0].matchReason).toBe('word_overlap');
  });

  it('word_overlap score >= 30 when all query words appear in name', () => {
    const results = rankSymbols([sym('getBlastRadius')], 'blast radius');
    // all words ('blast', 'radius') appear in name → 30 + 10 + 10 = 50
    expect(results[0].score).toBeGreaterThanOrEqual(30);
  });

  it('partial word match scores lower than all-words match', () => {
    // 'getBlastRadius' has both words; 'getBlastZone' has only 'blast'
    const results = rankSymbols([sym('getBlastZone'), sym('getBlastRadius')], 'blast radius');
    expect(results[0].symbol.name).toBe('getBlastRadius');
    expect(results[1].symbol.name).toBe('getBlastZone');
  });
});

// ─── CamelCase query expansion ────────────────────────────────────────────────

describe('rankSymbols — camelCase query', () => {
  it('indexFolder query scores indexFolder (exact) above indexRepo (partial word)', () => {
    const results = rankSymbols([sym('indexRepo'), sym('indexFolder')], 'indexFolder');
    expect(results[0].symbol.name).toBe('indexFolder');
  });

  it('camelCase query words match against name components', () => {
    // Query 'parseFile' has words ['parsefile', 'parse', 'file']
    // 'parseSymbols' contains 'parse' → word_overlap
    const results = rankSymbols([sym('buildGraph'), sym('parseSymbols')], 'parseFile');
    expect(results[0].symbol.name).toBe('parseSymbols');
    expect(results[0].matchReason).toBe('word_overlap');
  });
});

// ─── Signature and summary scoring ───────────────────────────────────────────

describe('rankSymbols — content matching', () => {
  it('signature match scores higher than summary-only match', () => {
    const sigMatch = sym('buildA', { signature: 'function buildA(indexFolder: string)', summary: 'builds stuff' });
    const sumMatch = sym('buildB', { signature: 'function buildB()', summary: 'calls indexFolder internally' });
    const results = rankSymbols([sumMatch, sigMatch], 'indexFolder');
    // sigMatch has 8pts for phrase in sig; sumMatch has 5pts for phrase in summary
    expect(results[0].symbol.name).toBe('buildA');
  });

  it('matchReason is content_match when only signature/summary matched', () => {
    const s = sym('utilHelper', {
      signature: 'function utilHelper()',
      summary: 'formats and displays output',
    });
    const results = rankSymbols([s], 'formats displays');
    expect(results[0].matchReason).toBe('content_match');
  });
});

// ─── Tie-breaking ────────────────────────────────────────────────────────────

describe('rankSymbols — tie-breaking preserves FTS order', () => {
  it('equal-score symbols keep their original array order', () => {
    // Both symbols have zero relevance to 'zzz' — should stay in original order
    const a = sym('alphaFn');
    const b = sym('betaFn');
    const c = sym('gammaFn');
    const results = rankSymbols([a, b, c], 'zzz');
    expect(results[0].symbol.name).toBe('alphaFn');
    expect(results[1].symbol.name).toBe('betaFn');
    expect(results[2].symbol.name).toBe('gammaFn');
  });
});

// ─── score and matchReason fields ────────────────────────────────────────────

describe('rankSymbols — output structure', () => {
  it('each result has symbol, score, and matchReason', () => {
    const results = rankSymbols([sym('formatDiagnostic')], 'format');
    expect(results[0]).toHaveProperty('symbol');
    expect(results[0]).toHaveProperty('score');
    expect(results[0]).toHaveProperty('matchReason');
    expect(typeof results[0].score).toBe('number');
  });

  it('returns empty array for empty input', () => {
    expect(rankSymbols([], 'query')).toHaveLength(0);
  });

  it('score is non-negative', () => {
    const results = rankSymbols([sym('foo'), sym('bar')], 'baz');
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });
});
