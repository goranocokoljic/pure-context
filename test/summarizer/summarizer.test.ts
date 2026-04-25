import { describe, it, expect } from 'vitest';
import { generateSummary, enrichSymbols } from '../../src/summarizer/summarizer.js';
import type { SymbolRecord } from '../../src/core/types.js';

function sym(overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    id: 'test-id',
    name: 'testFn',
    kind: 'function',
    filePath: 'src/test.ts',
    startByte: 0,
    endByte: 100,
    signature: 'function testFn(a: string, b: number): boolean',
    summary: '',
    ...overrides,
  };
}

// ─── generateSummary ──────────────────────────────────────────────────────────

describe('generateSummary', () => {
  it('uses docstring when provided', () => {
    const result = generateSummary(sym(), '/** Checks if the input is valid. */');
    expect(result).toBe('Checks if the input is valid.');
  });

  it('falls back to signature when docstring is null', () => {
    const s = sym({ signature: 'function testFn(): void' });
    expect(generateSummary(s, null)).toBe('function testFn(): void');
  });

  it('falls back to signature when docstring is empty string', () => {
    const s = sym({ signature: 'function testFn(): void' });
    expect(generateSummary(s, '')).toBe('function testFn(): void');
  });

  it('truncates signature fallback to 100 chars', () => {
    const longSig = 'function ' + 'a'.repeat(120) + '(): void';
    const s = sym({ signature: longSig });
    const result = generateSummary(s, null);
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it('falls back to signature when docstring yields no usable text', () => {
    const s = sym({ signature: 'function testFn(): void' });
    // A docstring with only @tags and no description
    const docstring = `/**\n * @param x - value\n * @returns number\n */`;
    expect(generateSummary(s, docstring)).toBe('function testFn(): void');
  });

  it('prefers @description over first paragraph when docstring has both', () => {
    const docstring = `/**\n * Title.\n * @description Real description.\n */`;
    expect(generateSummary(sym(), docstring)).toBe('Real description.');
  });
});

// ─── generateSummary — Stage 2: framework-derived ────────────────────────────

describe('generateSummary — Stage 2 (framework-derived)', () => {
  it('returns nuxt server route with method when nuxt_server + http_method', () => {
    const s = sym({ frameworkMeta: { nuxt_server: true, http_method: 'GET', route_path: '/api/users' } });
    expect(generateSummary(s, null)).toBe('GET /api/users server route');
  });

  it('returns nuxt server route without method when http_method absent', () => {
    const s = sym({ frameworkMeta: { nuxt_server: true, route_path: '/api/users' } });
    expect(generateSummary(s, null)).toBe('/api/users server route');
  });

  it('falls back to symbol.name for route_path when absent', () => {
    const s = sym({ name: 'myRoute', frameworkMeta: { nuxt_server: true } });
    expect(generateSummary(s, null)).toBe('myRoute server route');
  });

  it('returns page route for nuxt_page', () => {
    const s = sym({ frameworkMeta: { nuxt_page: true, route_path: '/blog/:slug' } });
    expect(generateSummary(s, null)).toBe('Page route /blog/:slug');
  });

  it('returns nuxt plugin summary', () => {
    const s = sym({ name: 'auth', frameworkMeta: { nuxt_plugin: true } });
    expect(generateSummary(s, null)).toBe('Nuxt plugin auth');
  });

  it('returns nuxt middleware summary', () => {
    const s = sym({ name: 'authMiddleware', frameworkMeta: { nuxt_middleware: true } });
    expect(generateSummary(s, null)).toBe('Nuxt middleware authMiddleware');
  });

  it('returns react hook summary', () => {
    const s = sym({ name: 'useAuth', frameworkMeta: { react_hook: true } });
    expect(generateSummary(s, null)).toBe('React hook useAuth');
  });

  it('returns react component summary', () => {
    const s = sym({ name: 'Button', frameworkMeta: { react_component: true } });
    expect(generateSummary(s, null)).toBe('React component Button');
  });

  it('returns vue composable summary', () => {
    const s = sym({ name: 'useCounter', frameworkMeta: { vue_composable: true } });
    expect(generateSummary(s, null)).toBe('Vue composable useCounter');
  });

  it('returns vue component summary', () => {
    const s = sym({ name: 'MyCard', frameworkMeta: { vue_component: true } });
    expect(generateSummary(s, null)).toBe('Vue component MyCard');
  });

  it('prefers docstring (Stage 1) over framework-derived (Stage 2)', () => {
    const s = sym({ name: 'Button', frameworkMeta: { react_component: true } });
    expect(generateSummary(s, '/** A clickable button. */')).toBe('A clickable button.');
  });

  it('uses Stage 2 when docstring is present but empty', () => {
    const s = sym({ name: 'Button', frameworkMeta: { react_component: true } });
    expect(generateSummary(s, '')).toBe('React component Button');
  });

  it('falls back to Stage 4 when frameworkMeta has no recognized key', () => {
    const s = sym({ name: 'Foo', signature: 'function Foo()', frameworkMeta: { unknown_key: true } });
    expect(generateSummary(s, null)).toBe('function Foo()');
  });

  it('falls back to Stage 4 when frameworkMeta is absent', () => {
    const s = sym({ name: 'Foo', signature: 'function Foo()' });
    expect(generateSummary(s, null)).toBe('function Foo()');
  });
});

// ─── enrichSymbols ────────────────────────────────────────────────────────────

describe('enrichSymbols', () => {
  it('refines existing summary through the docstring extractor', () => {
    const symbols = [
      sym({ summary: 'Format a diagnostic message for display.' }),
    ];
    const result = enrichSymbols(symbols);
    // Summary is already clean — should pass through unchanged
    expect(result[0].summary).toBe('Format a diagnostic message for display.');
  });

  it('falls back to signature when summary is empty', () => {
    const symbols = [
      sym({ summary: '', signature: 'function testFn(): void' }),
    ];
    const result = enrichSymbols(symbols);
    expect(result[0].summary).toBe('function testFn(): void');
  });

  it('does not mutate the original array', () => {
    const symbols = [sym({ summary: '' })];
    const original = symbols[0].summary;
    enrichSymbols(symbols);
    expect(symbols[0].summary).toBe(original);
  });

  it('handles an empty array', () => {
    expect(enrichSymbols([])).toEqual([]);
  });

  it('processes multiple symbols independently', () => {
    const symbols = [
      sym({ summary: 'First function.' }),
      sym({ summary: '', signature: 'class Foo' }),
    ];
    const result = enrichSymbols(symbols);
    expect(result[0].summary).toBe('First function.');
    expect(result[1].summary).toBe('class Foo');
  });
});
