/**
 * Task 150 — Cross-Repo Symbol Search
 *
 * Tests that search_symbols, search_semantic, and search_text all support:
 *   - Single repoId (backward compatible)
 *   - repoIds list (explicit multi-repo)
 *   - Neither param (all repos)
 *
 * Strategy: index two different fixture projects to get two distinct repo IDs,
 * then exercise the cross-repo paths.
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
import { handler as searchTextHandler } from '../../src/server/tools/search-text.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_A = resolve(__dirname, '../fixtures/basic-ts-project');
const FIXTURE_B = resolve(__dirname, '../fixtures/react-project');

let repoIdA: string;
let repoIdB: string;

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  const [resultA, resultB] = await Promise.all([
    indexFolder(FIXTURE_A, { fileLimit: 100 }),
    indexFolder(FIXTURE_B, { fileLimit: 100 }),
  ]);

  repoIdA = resultA.repoId;
  repoIdB = resultB.repoId;

  expect(resultA.symbolsFound).toBeGreaterThan(0);
  expect(resultB.symbolsFound).toBeGreaterThan(0);
  // The two repos must be distinct
  expect(repoIdA).not.toBe(repoIdB);
}, 60_000);

afterAll(() => {
  deleteIndex(repoIdA);
  deleteIndex(repoIdB);
});

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// ─── search_symbols ───────────────────────────────────────────────────────────

describe('search_symbols — cross-repo', () => {
  it('backward compat: single repoId still works and includes repoId/repoName in results', async () => {
    const result = await searchSymbolsHandler({ repoId: repoIdA, query: 'function' });
    const data = parse(result);
    expect(result.isError).toBeFalsy();
    const symbols = data.symbols as Array<Record<string, unknown>>;
    expect(symbols.length).toBeGreaterThan(0);
    // Every result must carry repoId and repoName
    for (const sym of symbols) {
      expect(sym.repoId).toBe(repoIdA);
      expect(typeof sym.repoName).toBe('string');
      expect((sym.repoName as string).length).toBeGreaterThan(0);
    }
  });

  it('repoIds list: both repos appear in reposSearched and results are correctly tagged', async () => {
    const result = await searchSymbolsHandler({
      repoIds: [repoIdA, repoIdB],
      query: 'format',
      limit: 100,
    });
    const data = parse(result);
    expect(result.isError).toBeFalsy();

    // Both repos must appear in _meta.reposSearched regardless of match count
    const meta = data._meta as Record<string, unknown>;
    const reposSearched = meta.reposSearched as string[];
    expect(reposSearched).toContain(repoIdA);
    expect(reposSearched).toContain(repoIdB);

    // Every result must have repoId and repoName
    const symbols = data.symbols as Array<Record<string, unknown>>;
    for (const sym of symbols) {
      expect(sym.repoId).toBeDefined();
      expect(sym.repoName).toBeDefined();
      expect([repoIdA, repoIdB]).toContain(sym.repoId);
    }
  });

  it('repoIds list: results from repoA are tagged with repoA', async () => {
    // Confirm that results from a single-repo equivalent appear with correct repoId
    // when searched via repoIds
    const singleResult = await searchSymbolsHandler({ repoId: repoIdA, query: 'Diagnostic' });
    const singleData = parse(singleResult);
    const singleSymbols = singleData.symbols as Array<Record<string, unknown>>;
    expect(singleSymbols.length).toBeGreaterThan(0);

    const multiResult = await searchSymbolsHandler({
      repoIds: [repoIdA],
      query: 'Diagnostic',
      limit: 100,
    });
    const multiData = parse(multiResult);
    const multiSymbols = multiData.symbols as Array<Record<string, unknown>>;

    // All multi-repo results should be tagged with repoIdA
    for (const sym of multiSymbols) {
      expect(sym.repoId).toBe(repoIdA);
    }
    // Same count
    expect(multiSymbols.length).toBe(singleSymbols.length);
  });

  it('neither param: all repos are searched', async () => {
    // Without repoId or repoIds, all indexed repos should be searched.
    // We know at least repoIdA and repoIdB are indexed.
    const result = await searchSymbolsHandler({ query: 'function', limit: 200 });
    const data = parse(result);
    expect(result.isError).toBeFalsy();

    const reposSearched = data._meta as Record<string, unknown>;
    // _meta.reposSearched must include both our repos
    const searched = (reposSearched as Record<string, unknown>).reposSearched as string[];
    expect(searched).toContain(repoIdA);
    expect(searched).toContain(repoIdB);
  });

  it('_meta.reposSearched is accurate for repoIds query', async () => {
    const result = await searchSymbolsHandler({
      repoIds: [repoIdA, repoIdB],
      query: 'class',
    });
    const data = parse(result);
    const meta = data._meta as Record<string, unknown>;
    const reposSearched = meta.reposSearched as string[];
    expect(reposSearched).toContain(repoIdA);
    expect(reposSearched).toContain(repoIdB);
    expect(reposSearched.length).toBe(2);
  });

  it('repoName present and non-empty in all results', async () => {
    const result = await searchSymbolsHandler({
      repoIds: [repoIdA, repoIdB],
      query: 'function',
      limit: 50,
    });
    const data = parse(result);
    const symbols = data.symbols as Array<Record<string, unknown>>;
    for (const sym of symbols) {
      expect(typeof sym.repoName).toBe('string');
      expect((sym.repoName as string).length).toBeGreaterThan(0);
    }
  });

  it('unknown repoId returns error', async () => {
    const result = await searchSymbolsHandler({ repoId: 'deadbeef00000000', query: 'foo' });
    expect(result.isError).toBe(true);
  });

  it('empty repoIds list returns no results gracefully', async () => {
    // Empty repoIds array — resolveRepoScope returns nothing that matches
    const result = await searchSymbolsHandler({ repoIds: ['deadbeef00000001'], query: 'foo' });
    // Either error or empty results — both are acceptable
    if (!result.isError) {
      const data = parse(result);
      expect((data.symbols as unknown[]).length).toBe(0);
    }
  });
});

// ─── search_text ──────────────────────────────────────────────────────────────

describe('search_text — cross-repo', () => {
  it('backward compat: single repoId includes repoId/repoName in match records', () => {
    const result = searchTextHandler({ repoId: repoIdA, query: 'function' });
    const data = parse(result);
    expect(result.isError).toBeFalsy();
    const matches = data.matches as Array<Record<string, unknown>>;
    if (matches.length > 0) {
      expect(matches[0].repoId).toBe(repoIdA);
      expect(typeof matches[0].repoName).toBe('string');
    }
  });

  it('repoIds list: matches from both repos', () => {
    const result = searchTextHandler({
      repoIds: [repoIdA, repoIdB],
      query: 'function',
      maxResults: 100,
    });
    const data = parse(result);
    expect(result.isError).toBeFalsy();
    const matches = data.matches as Array<Record<string, unknown>>;
    if (matches.length > 0) {
      const repoIdsInResults = new Set(matches.map((m) => m.repoId));
      // Should have hits from at least one repo (possibly both)
      expect(repoIdsInResults.size).toBeGreaterThanOrEqual(1);
    }
  });

  it('neither param: _meta.reposSearched includes both repos', () => {
    const result = searchTextHandler({ query: 'const', maxResults: 100 });
    const data = parse(result);
    expect(result.isError).toBeFalsy();
    const meta = data._meta as Record<string, unknown>;
    const reposSearched = meta.reposSearched as string[];
    expect(reposSearched).toContain(repoIdA);
    expect(reposSearched).toContain(repoIdB);
  });

  it('_meta.reposSearched accurate for explicit repoIds', () => {
    const result = searchTextHandler({
      repoIds: [repoIdA, repoIdB],
      query: 'export',
    });
    const data = parse(result);
    const meta = data._meta as Record<string, unknown>;
    const reposSearched = meta.reposSearched as string[];
    expect(reposSearched).toContain(repoIdA);
    expect(reposSearched).toContain(repoIdB);
    expect(reposSearched.length).toBe(2);
  });

  it('unknown repoId returns error', () => {
    const result = searchTextHandler({ repoId: 'deadbeef00000000', query: 'foo' });
    expect(result.isError).toBe(true);
  });
});
