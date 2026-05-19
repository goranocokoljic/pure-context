/**
 * Tests for search_symbols handler — negative evidence (Task 267)
 * and rendering domain detection (Task 268).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../../src/handlers/typescript.js';
import { javascriptHandler } from '../../../src/handlers/javascript.js';
import { initParser } from '../../../src/core/parse-dispatcher.js';
import { handler as searchHandler } from '../../../src/server/tools/search-symbols.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../../fixtures/basic-ts-project');

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

function parseResult(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// ─── Negative evidence (Task 267) ─────────────────────────────────────────────

describe('search_symbols negative_evidence', () => {
  it('includes negative_evidence when query has no match', async () => {
    // Use a single-token gibberish string that can't match any real symbol name
    const result = await searchHandler({
      repoId,
      query: 'xqzxqzxqz',
      mode: 'keyword',
    });
    const parsed = parseResult(result);
    expect(parsed.count).toBe(0);
    expect(parsed.negative_evidence).toBeDefined();
    const neg = parsed.negative_evidence as Record<string, unknown>;
    expect(neg.verdict).toBe('no_match');
    expect(typeof neg.query).toBe('string');
    expect(typeof neg.suggestion).toBe('string');
  });

  it('negative_evidence.suggestion references search_text as fallback', async () => {
    const result = await searchHandler({
      repoId,
      query: 'zzzqqqxxx',
      mode: 'keyword',
    });
    const parsed = parseResult(result);
    const neg = parsed.negative_evidence as Record<string, unknown> | undefined;
    expect(neg?.suggestion).toContain('search_text');
  });

  it('does not return negative_evidence when results exist', async () => {
    const result = await searchHandler({
      repoId,
      query: 'format',
      mode: 'keyword',
    });
    const parsed = parseResult(result);
    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.negative_evidence).toBeUndefined();
  });

  it('negative_evidence.searched_repos includes the queried repoId', async () => {
    const result = await searchHandler({
      repoId,
      query: 'xqzmissing',
      mode: 'keyword',
    });
    const parsed = parseResult(result);
    const neg = parsed.negative_evidence as Record<string, unknown> | undefined;
    expect(Array.isArray(neg?.searched_repos)).toBe(true);
    expect((neg?.searched_repos as string[]).includes(repoId)).toBe(true);
  });

  it('negative_evidence.query matches the original search query', async () => {
    const query = 'xqzabsent';
    const result = await searchHandler({ repoId, query, mode: 'keyword' });
    const parsed = parseResult(result);
    const neg = parsed.negative_evidence as Record<string, unknown> | undefined;
    expect(neg?.query).toBe(query);
  });
});

// ─── Rendering domain detection (Task 268) ────────────────────────────────────

describe('rendering domain detection', () => {
  it('does not apply rendering synonyms for non-rendering repo names', async () => {
    // The basic-ts-project repo should NOT be classified as rendering domain.
    // Querying "render" should not expand to "draw OR display OR paint" in non-rendering repos.
    // We verify this by checking the query preprocessor directly.
    const { preprocessQuery } = await import('../../../src/core/search/query-preprocessor.js');
    const withoutDomain = preprocessQuery('render scene');
    // Without rendering domain, "render" and "scene" should not get rendering synonyms
    expect(withoutDomain).not.toContain('draw');
    expect(withoutDomain).not.toContain('display');
  });

  it('applies rendering synonyms only when domain is "rendering"', async () => {
    const { preprocessQuery } = await import('../../../src/core/search/query-preprocessor.js');
    const withDomain = preprocessQuery('render scene', 'rendering');
    // With rendering domain, "render" should expand
    expect(withDomain).toContain('draw');
    expect(withDomain).toContain('display');
  });

  it('expandVerbSynonyms suppresses rendering synonyms without domain', async () => {
    const { expandVerbSynonyms } = await import('../../../src/core/search/query-preprocessor.js');
    expect(expandVerbSynonyms('render')).toEqual([]);
    expect(expandVerbSynonyms('trace')).toEqual([]);
    expect(expandVerbSynonyms('emit')).toEqual([]);
    expect(expandVerbSynonyms('light')).toEqual([]);
    expect(expandVerbSynonyms('bsdf')).toEqual([]);
  });

  it('expandVerbSynonyms returns rendering synonyms with rendering domain', async () => {
    const { expandVerbSynonyms } = await import('../../../src/core/search/query-preprocessor.js');
    expect(expandVerbSynonyms('render', 'rendering')).toContain('draw');
    expect(expandVerbSynonyms('trace', 'rendering')).toContain('ray');
    expect(expandVerbSynonyms('light', 'rendering')).toContain('emitter');
  });

  it('non-rendering synonyms are unaffected by domain parameter', async () => {
    const { expandVerbSynonyms } = await import('../../../src/core/search/query-preprocessor.js');
    // 'remove' → ['delete', 'clear'] should work regardless of domain
    expect(expandVerbSynonyms('remove')).toContain('delete');
    expect(expandVerbSynonyms('remove', 'rendering')).toContain('delete');
    expect(expandVerbSynonyms('fetch')).toContain('get');
    expect(expandVerbSynonyms('fetch', 'rendering')).toContain('get');
  });
});
