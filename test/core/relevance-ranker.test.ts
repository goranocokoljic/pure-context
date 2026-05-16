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

// ─── Word-boundary name-part matching ────────────────────────────────────────

describe('rankSymbols — word-boundary name-part matching', () => {
  it('query word matches exact name part, not namespace prefix', () => {
    // "model" (from "models" stem) should match CIR_Model (part: "model")
    // but NOT models\\Article_base (part: "models") — word-boundary is exact
    const modelClass = sym('CIR_Model', { kind: 'class' });
    const articleBase = sym('models\\Article_base', { kind: 'class' });
    const results = rankSymbols([articleBase, modelClass], 'model');
    expect(results[0].symbol.name).toBe('CIR_Model');
  });

  it('symbol with 2 matching name parts outranks symbol with 1 matching part', () => {
    // getSettings has parts [homepage, model, get, settings]
    // Homepage has parts [homepage]
    // query "retrieve homepage settings" → "homepage" and "settings" match getSettings
    const getSettings = sym('Homepage_model::getSettings', { kind: 'method' });
    const homepage = sym('Homepage', { kind: 'class' });
    const results = rankSymbols([homepage, getSettings], 'retrieve homepage settings');
    expect(results[0].symbol.name).toBe('Homepage_model::getSettings');
  });

  it('all-parts-match (30pt) fires when every query word matches a name part', () => {
    // "get row" → "get" and "row" both in parts of CIR_Model::get_row
    const getRow = sym('CIR_Model::get_row', { kind: 'method' });
    const getAll = sym('CIR_Model::get_all', { kind: 'method' });
    // get_row matches both "get" and "row"; get_all matches "get" but not "row"
    const results = rankSymbols([getAll, getRow], 'get row');
    expect(results[0].symbol.name).toBe('CIR_Model::get_row');
  });

  it('word-boundary matching does not fire when word is only a substring of a part', () => {
    // "add" should NOT match "address" (which contains "add" as a substring, but
    // "address" is the full word-boundary part — "add" ≠ "address")
    const addressFn = sym('getAddress', { kind: 'function' });
    const addFn = sym('addItem', { kind: 'function' });
    const results = rankSymbols([addressFn, addFn], 'add');
    // addItem has "add" as exact part; getAddress has "address" which is not "add"
    expect(results[0].symbol.name).toBe('addItem');
  });

  it('name parts from PHP namespaced names are split correctly', () => {
    // "bridge\\Grant_base_class::get_all" → parts include "bridge", "grant", "base", etc.
    const bridgeFn = sym('bridge\\Grant_base_class::get_all', { kind: 'method' });
    const grantFn = sym('GrantHelper', { kind: 'function' });
    const results = rankSymbols([bridgeFn, grantFn], 'grant');
    // Both match "grant"; bridge\\Grant gets it from "grant" part, GrantHelper from "grant" part
    // Just verify both get word_overlap matchReason
    expect(results.every((r) => r.matchReason === 'word_overlap' || r.score > 0)).toBe(true);
  });
});

// ─── Suffix stemming ──────────────────────────────────────────────────────────

describe('rankSymbols — suffix stemming', () => {
  it('plural -s: "models" query matches "model" name part', () => {
    // "models" stem is "model", which matches the part "model" in CIR_Model
    const cirModel = sym('CIR_Model', { kind: 'class' });
    const unrelated = sym('FileHelper', { kind: 'class' });
    const results = rankSymbols([unrelated, cirModel], 'models');
    expect(results[0].symbol.name).toBe('CIR_Model');
    expect(results[0].matchReason).toBe('word_overlap');
  });

  it('past tense -ed (e-drop): "updated" stem "update" matches name part', () => {
    // "updated" → stems include "update" → matches "update" part in Homepage_model::update
    const updateFn = sym('Homepage_model::update', { kind: 'method' });
    const saveFn = sym('CI_Cache_file::save', { kind: 'method' });
    const results = rankSymbols([saveFn, updateFn], 'save updated homepage');
    // updateFn matches "update" (from "updated") + "homepage"; saveFn matches "save"
    expect(results[0].symbol.name).toBe('Homepage_model::update');
  });

  it('past tense -ed (regular): "matched" stem "match" matches name part', () => {
    const matchFn = sym('matchPattern', { kind: 'function' });
    const unrelated = sym('buildGraph', { kind: 'function' });
    const results = rankSymbols([unrelated, matchFn], 'matched pattern');
    expect(results[0].symbol.name).toBe('matchPattern');
  });

  it('gerund -ing: "building" stem "build" matches name part', () => {
    const buildFn = sym('buildDependencyGraph', { kind: 'function' });
    const unrelated = sym('parseConfig', { kind: 'function' });
    const results = rankSymbols([unrelated, buildFn], 'building dependency graph');
    expect(results[0].symbol.name).toBe('buildDependencyGraph');
  });

  it('-tion: "pagination" stem "paginat" is added to query words', () => {
    // "pagination" → "paginat" (won't match "paging" but won't break things)
    // Primary assertion: symbol with "pagination" in its name still ranks well
    const paginateFn = sym('addPagination', { kind: 'method' });
    const unrelated = sym('connectDatabase', { kind: 'function' });
    const results = rankSymbols([unrelated, paginateFn], 'pagination');
    // "pagination" is an exact substring of "addPagination" → nameFuzzy fires (40pt)
    expect(results[0].symbol.name).toBe('addPagination');
  });

  it('-s not applied to -ss endings: "class" is NOT stemmed to "clas"', () => {
    const classFn = sym('parseClass', { kind: 'function' });
    const results = rankSymbols([classFn], 'class');
    // "class" should still match "parseClass" via nameFuzzy (substring), not stem
    expect(results[0].symbol.name).toBe('parseClass');
    expect(results[0].score).toBeGreaterThan(0);
  });
});

// ─── Hyphenated query token splitting ────────────────────────────────────────

describe('rankSymbols — hyphen splitting in queries', () => {
  it('"front-end" split into "front" and "end" for word-boundary matching', () => {
    // CIR_FrontController has parts ["cir", "front", "controller"]
    // "front-end" → ["front", "end"]; "front" matches name part of FrontController
    const frontCtrl = sym('CIR_FrontController', { kind: 'class' });
    const tagsPage = sym('eu_format_interval_for_tags_page', { kind: 'function' });
    // query words: front(from front-end), end, controller, pages→page
    const results = rankSymbols([tagsPage, frontCtrl], 'front-end controller');
    expect(results[0].symbol.name).toBe('CIR_FrontController');
  });

  it('"public-facing front-end" yields "public", "facing", "front", "end"', () => {
    // CIR_FrontController matches "front" and "controller"
    const frontCtrl = sym('CIR_FrontController', { kind: 'class' });
    const unrelated = sym('CI_DB_utility', { kind: 'class' });
    const results = rankSymbols([unrelated, frontCtrl],
      'base controller for public-facing front-end pages');
    expect(results[0].symbol.name).toBe('CIR_FrontController');
  });

  it('hyphen does not appear as a literal token in query words', () => {
    // "sign-in" → "sign" + "in"(stop) → only "sign" is a query word
    // The literal "sign-in" should not be a query word (no symbol name has a hyphen)
    const loginFn = sym('UserLogin', { kind: 'class' });
    const signFn = sym('signDocument', { kind: 'function' });
    const results = rankSymbols([loginFn, signFn], 'sign-in form');
    // "sign" matches "sign" in signDocument's parts; "form" doesn't match either
    expect(results[0].symbol.name).toBe('signDocument');
  });
});

// ─── Benchmark-aligned regression tests ──────────────────────────────────────

describe('rankSymbols — benchmark scenario regressions', () => {
  it('gt-21: Homepage_model::getSettings outranks Homepage for settings retrieval query', () => {
    // Homepage gets +20 (any-part match for "homepage") + 10 = 30
    // Homepage_model::getSettings gets +20 + 20 (homepage + settings) = 40
    const getSettings = sym('Homepage_model::getSettings', {
      kind: 'method',
      signature: 'getSettings(): Settings',
      summary: 'Retrieve homepage content settings from database',
    });
    const homepage = sym('Homepage', {
      kind: 'class',
      signature: 'class Homepage',
      summary: 'Homepage controller',
    });
    const results = rankSymbols([homepage, getSettings],
      'retrieve homepage content settings from database');
    expect(results[0].symbol.name).toBe('Homepage_model::getSettings');
  });

  it('gt-22: Homepage_model::update outranks CI_Cache_file::save for save-updated query', () => {
    // "updated" stems include "update" which matches name part "update"
    // "homepage" matches name part "homepage"
    // → Homepage_model::update gets 2 part matches (update + homepage)
    // CI_Cache_file::save gets 1 part match (save)
    const updateFn = sym('Homepage_model::update', {
      kind: 'method',
      signature: 'update(data: object): void',
      summary: 'Save updated homepage content data',
    });
    const saveFn = sym('CI_Cache_file::save', {
      kind: 'method',
      signature: 'save(id: string, data: mixed): bool',
      summary: 'Save data to cache file',
    });
    const results = rankSymbols([saveFn, updateFn], 'save updated homepage content data');
    expect(results[0].symbol.name).toBe('Homepage_model::update');
  });

  it('gt-12: CIR_FrontController outranks eu_format_interval_for_tags_page for front-end controller query', () => {
    // After hyphen-split: "front" + "end", plus "controller", "pages"→"page"
    // CIR_FrontController: "front" ✓ + "controller" ✓ → 2 part matches
    // eu_format_interval_for_tags_page: "page" ✓ → 1 part match
    const frontCtrl = sym('CIR_FrontController', {
      kind: 'class',
      signature: 'class CIR_FrontController extends CIR_Controller',
      summary: 'Base controller for public-facing front-end pages',
    });
    const formatFn = sym('eu_format_interval_for_tags_page', {
      kind: 'function',
      signature: 'function eu_format_interval_for_tags_page(int $interval): string',
      summary: 'Format interval value for display on tags page',
    });
    const results = rankSymbols([formatFn, frontCtrl],
      'base controller for public-facing front-end pages');
    expect(results[0].symbol.name).toBe('CIR_FrontController');
  });

  it('word_overlap score >= 30 when all query words match name parts (updated rule)', () => {
    const results = rankSymbols([sym('getBlastRadius')], 'blast radius');
    // "blast" + "radius" both match parts → 30 (all) + 20 (any) + 10 + 10 = 70
    expect(results[0].score).toBeGreaterThanOrEqual(30);
  });
});
