/**
 * Phase 93 (Task 580) — language-agnostic test-fixture path penalty.
 *
 * Symbols under test/fixture/playground directory segments get −25 so fixture
 * symbols stop outranking production code (nuxt: top-5 was `App` ×5, all from
 * test/fixtures/). Query-intent exemption: a query asking for tests still
 * finds them.
 */

import { describe, it, expect } from 'vitest';
import { rankSymbols } from '../../src/core/search/relevance-ranker.js';
import type { SymbolRecord } from '../../src/core/types.js';

function sym(
  name: string,
  opts: Partial<Pick<SymbolRecord, 'kind' | 'filePath' | 'signature' | 'summary'>> = {},
): SymbolRecord {
  return {
    id: `id-${name}-${opts.filePath ?? 'x'}`,
    name,
    kind: opts.kind ?? 'function',
    filePath: opts.filePath ?? 'src/index.ts',
    startByte: 0,
    endByte: 100,
    signature: opts.signature ?? `function ${name}()`,
    summary: opts.summary ?? `Does ${name}`,
  };
}

describe('Phase 93 — test-fixture path penalty', () => {
  it('a production symbol outranks an identical fixture symbol', () => {
    const results = rankSymbols(
      [
        sym('renderPage', { filePath: 'test/fixtures/basic/render-page.ts', summary: 'Renders the page' }),
        sym('renderPage', { filePath: 'src/render-page.ts', summary: 'Renders the page' }),
      ],
      'render the page',
    );
    expect(results[0]!.symbol.filePath).toBe('src/render-page.ts');
  });

  it.each([
    'test/App.vue',
    'tests/App.vue',
    '__tests__/App.vue',
    'packages/nuxt/test/fixtures/App.vue',
    'e2e/__fixtures__/App.vue',
    'playground/App.vue',
  ])('penalizes %s', (fixturePath) => {
    const results = rankSymbols(
      [
        sym('App', { kind: 'component', filePath: fixturePath, summary: 'Vue component App' }),
        sym('App', { kind: 'component', filePath: 'src/App.vue', summary: 'Vue component App' }),
      ],
      'app root component',
    );
    expect(results[0]!.symbol.filePath).toBe('src/App.vue');
  });

  it('does NOT penalize when the query asks for tests', () => {
    const fixture = sym('renderPage', {
      filePath: 'test/fixtures/render-page.ts',
      summary: 'Renders the page',
    });
    const prod = sym('renderPage', { filePath: 'src/render-page.ts', summary: 'Renders the page' });
    const results = rankSymbols([fixture, prod], 'test fixture that renders the page');
    const fixtureScore = results.find((r) => r.symbol.filePath.startsWith('test/'))!.score;
    const prodScore = results.find((r) => r.symbol.filePath.startsWith('src/'))!.score;
    // No penalty applied — same base ranking signals, so scores stay close;
    // the fixture is not 25 points behind.
    expect(prodScore - fixtureScore).toBeLessThan(25);
  });

  it('does NOT penalize a _test.go FILE (filename, not a directory segment)', () => {
    const results = rankSymbols(
      [
        sym('parseConfig', { filePath: 'internal/config/parse_test.go', summary: 'Parses config' }),
        sym('parseConfig', { filePath: 'internal/config/parse.go', summary: 'Parses config' }),
      ],
      'parse the config file',
    );
    const testScore = results.find((r) => r.symbol.filePath.endsWith('_test.go'))!.score;
    const prodScore = results.find((r) => r.symbol.filePath.endsWith('/parse.go'))!.score;
    expect(prodScore - testScore).toBeLessThan(25);
  });

  it('does NOT penalize a directory merely containing the word (e.g. contest/)', () => {
    const results = rankSymbols(
      [
        sym('scoreEntry', { filePath: 'src/contest/score-entry.ts', summary: 'Scores an entry' }),
        sym('scoreEntry', { filePath: 'src/scoring/score-entry.ts', summary: 'Scores an entry' }),
      ],
      'score a submitted entry',
    );
    // neither path is penalized — exact-segment matching only
    const a = results[0]!.score;
    const b = results[1]!.score;
    expect(Math.abs(a - b)).toBeLessThan(25);
  });

  it('stacks with the library-path penalty instead of replacing it', () => {
    const both = sym('helper', {
      filePath: 'node_modules/lib/test/helper.ts',
      summary: 'A helper',
    });
    const libOnly = sym('helper', { filePath: 'node_modules/lib/helper.ts', summary: 'A helper' });
    const results = rankSymbols([both, libOnly], 'helper for parsing');
    const bothScore = results.find((r) => r.symbol.filePath.includes('/test/'))!.score;
    const libScore = results.find((r) => !r.symbol.filePath.includes('/test/'))!.score;
    expect(libScore - bothScore).toBe(25);
  });
});
