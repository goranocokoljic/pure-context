import { describe, it, expect } from 'vitest';
import { preprocessQuery } from '../../src/core/search/query-preprocessor.js';

// ─── camelCase splitting ──────────────────────────────────────────────────────

describe('preprocessQuery — camelCase splitting', () => {
  it('expands parseFile to include parse and file', () => {
    const result = preprocessQuery('parseFile');
    expect(result).toContain('parse');
    expect(result).toContain('file');
    // Original token preserved as first term
    expect(result.split(' OR ')[0]).toBe('parseFile');
  });

  it('expands HybridSearcher to include hybrid and searcher', () => {
    const result = preprocessQuery('HybridSearcher');
    const lower = result.toLowerCase();
    expect(lower).toContain('hybrid');
    expect(lower).toContain('searcher');
  });

  it('does not split all-caps acronym MCP', () => {
    const result = preprocessQuery('MCP');
    expect(result).toBe('MCP');
  });

  it('does not split all-caps acronym HTTP', () => {
    const result = preprocessQuery('HTTP');
    expect(result).toBe('HTTP');
  });

  it('handles PascalCase with multiple words', () => {
    const result = preprocessQuery('IndexManager');
    expect(result.toLowerCase()).toContain('index');
    expect(result.toLowerCase()).toContain('manager');
  });

  it('handles camelCase with acronym in middle (getHTTPStatus)', () => {
    const result = preprocessQuery('getHTTPStatus');
    const lower = result.toLowerCase();
    expect(lower).toContain('get');
    expect(lower).toContain('status');
  });
});

// ─── snake_case splitting ─────────────────────────────────────────────────────

describe('preprocessQuery — snake_case splitting', () => {
  it('expands get_symbol_source to include get, symbol, source', () => {
    const result = preprocessQuery('get_symbol_source');
    expect(result).toContain('get');
    expect(result).toContain('symbol');
    expect(result).toContain('source');
    // Original token preserved
    expect(result.split(' OR ')[0]).toBe('get_symbol_source');
  });

  it('expands index_folder to include index and folder', () => {
    const result = preprocessQuery('index_folder');
    expect(result).toContain('index');
    expect(result).toContain('folder');
  });

  it('returns token unchanged when no multi-part snake_case', () => {
    const result = preprocessQuery('simple');
    expect(result).toBe('simple');
  });
});

// ─── natural language passthrough ────────────────────────────────────────────

describe('preprocessQuery — natural language passthrough', () => {
  it('passes orchestrate indexing pipeline through unchanged', () => {
    const result = preprocessQuery('orchestrate indexing pipeline');
    expect(result).toBe('orchestrate indexing pipeline');
  });

  it('passes a two-word phrase through unchanged', () => {
    const result = preprocessQuery('format diagnostic');
    expect(result).toBe('format diagnostic');
  });

  it('trims extra whitespace in multi-word queries', () => {
    const result = preprocessQuery('  blast   radius  ');
    expect(result).toBe('blast radius');
  });
});

// ─── FTS5 special character escaping ─────────────────────────────────────────

describe('preprocessQuery — special char escaping', () => {
  it('strips double quotes from query', () => {
    const result = preprocessQuery('"dangerous query"');
    expect(result).not.toContain('"');
    expect(result).toContain('dangerous');
    expect(result).toContain('query');
  });

  it('strips parentheses', () => {
    const result = preprocessQuery('foo(bar)');
    expect(result).not.toContain('(');
    expect(result).not.toContain(')');
  });

  it('strips caret and asterisk', () => {
    const result = preprocessQuery('foo^*bar');
    expect(result).not.toContain('^');
    expect(result).not.toContain('*');
  });

  it('returns empty string for all-special-char input', () => {
    const result = preprocessQuery('"()*^');
    expect(result).toBe('');
  });

  it('replaces hyphens to avoid FTS5 column-filter syntax error', () => {
    // "tree-sitter" would become column filter "tree:sitter" in FTS5 — must be sanitised
    const result = preprocessQuery('tree-sitter');
    expect(result).not.toContain('-');
    expect(result).toContain('tree');
    expect(result).toContain('sitter');
  });

  it('multi-word query with hyphen passes both words through', () => {
    const result = preprocessQuery('parse tree-sitter ast');
    expect(result).not.toContain('-');
    expect(result).toContain('parse');
    expect(result).toContain('ast');
  });
});

// ─── Short token filter ───────────────────────────────────────────────────────

describe('preprocessQuery — short token filter', () => {
  it('drops single-char tokens from camelCase expansion', () => {
    // 'aFile' splits to 'a' and 'file' — 'a' should be dropped
    const result = preprocessQuery('aFile');
    const terms = result.split(' OR ');
    // 'a' should not appear as a standalone OR term after the original
    expect(terms.filter((t) => t === 'a')).toHaveLength(0);
    expect(terms.some((t) => t.toLowerCase() === 'file')).toBe(true);
  });

  it('keeps two-char tokens like "go"', () => {
    // 'goRun' → 'go' and 'run'; 'go' has length 2 and should be kept
    const result = preprocessQuery('goRun');
    const lower = result.toLowerCase();
    expect(lower).toContain('go');
    expect(lower).toContain('run');
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('preprocessQuery — edge cases', () => {
  it('returns empty string for empty input', () => {
    expect(preprocessQuery('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(preprocessQuery('   ')).toBe('');
  });

  it('handles single lowercase word', () => {
    expect(preprocessQuery('format')).toBe('format');
  });

  it('preserves numbers within identifiers', () => {
    const result = preprocessQuery('phase14');
    // Numbers don't trigger camelCase split — returned as-is
    expect(result).toBe('phase14');
  });
});
