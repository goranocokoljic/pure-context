/**
 * search_text tool tests.
 *
 * Strategy: index basic-ts-project once so raw_content is stored,
 * then run search scenarios against the real DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as searchTextHandler } from '../../src/server/tools/search-text.js';

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
  expect(result.filesIndexed).toBeGreaterThan(0);
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// ─── repo not found ───────────────────────────────────────────────────────────

describe('search_text — repo validation', () => {
  it('returns error for nonexistent repo', () => {
    const result = searchTextHandler({ repoId: 'deadbeef00000000', query: 'foo' });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: expect.stringContaining('not found') });
  });
});

// ─── literal search ───────────────────────────────────────────────────────────

describe('search_text — literal search', () => {
  it('finds a string that exists in exactly one file', () => {
    // 'DiagnosticRunner' is defined in src/index.ts of the fixture
    const result = searchTextHandler({ repoId, query: 'DiagnosticRunner' });
    const data = parse(result);

    expect(data['total_matches']).toBeGreaterThan(0);
    expect(data['files_searched']).toBeGreaterThan(0);

    const matches = data['matches'] as Array<Record<string, unknown>>;
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]['file']).toMatch(/index\.ts/);
    expect(matches[0]['line']).toBeTypeOf('number');
    expect(matches[0]['column']).toBeTypeOf('number');
    expect(typeof matches[0]['context']).toBe('string');
  });

  it('returns empty matches for a string that does not exist', () => {
    const result = searchTextHandler({ repoId, query: 'XYZZY_NONEXISTENT_TOKEN_ABC' });
    const data = parse(result);
    expect(data['total_matches']).toBe(0);
    expect(data['truncated']).toBe(false);
  });

  it('match line numbers are 1-based', () => {
    const result = searchTextHandler({ repoId, query: 'export' });
    const matches = (parse(result)['matches'] as Array<Record<string, unknown>>);
    for (const m of matches) {
      expect(m['line'] as number).toBeGreaterThanOrEqual(1);
    }
  });

  it('match columns are 1-based', () => {
    const result = searchTextHandler({ repoId, query: 'export' });
    const matches = (parse(result)['matches'] as Array<Record<string, unknown>>);
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m['column'] as number).toBeGreaterThanOrEqual(1);
    }
  });

  it('context contains the matching line', () => {
    const result = searchTextHandler({ repoId, query: 'DiagnosticRunner', contextLines: 1 });
    const matches = (parse(result)['matches'] as Array<Record<string, unknown>>);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]['context'] as string).toContain('DiagnosticRunner');
  });

  it('contextLines: 0 still returns the matching line', () => {
    const result = searchTextHandler({ repoId, query: 'DiagnosticRunner', contextLines: 0 });
    const matches = (parse(result)['matches'] as Array<Record<string, unknown>>);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]['context'] as string).toContain('DiagnosticRunner');
  });
});

// ─── regex search ─────────────────────────────────────────────────────────────

describe('search_text — regex search', () => {
  it('finds matches using a simple regex', () => {
    const result = searchTextHandler({ repoId, query: 'export (class|function)', isRegex: true });
    const data = parse(result);
    expect(data['total_matches']).toBeGreaterThan(0);
  });

  it('regex matches correct text', () => {
    const result = searchTextHandler({ repoId, query: 'export \\w+', isRegex: true });
    const matches = (parse(result)['matches'] as Array<Record<string, unknown>>);
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m['match'] as string).toMatch(/^export \w+/);
    }
  });

  it('returns error for invalid regex', () => {
    const result = searchTextHandler({ repoId, query: '[invalid(regex', isRegex: true });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: expect.stringContaining('Invalid regex') });
  });
});

// ─── file_pattern filtering ───────────────────────────────────────────────────

describe('search_text — filePattern', () => {
  it('restricts search to files matching the pattern', () => {
    // Only search test files
    const allResult = searchTextHandler({ repoId, query: 'export' });
    const filteredResult = searchTextHandler({
      repoId,
      query: 'export',
      filePattern: 'test/**/*.ts',
    });

    const allData = parse(allResult);
    const filteredData = parse(filteredResult);

    // Filtered should search fewer files
    expect(filteredData['files_searched'] as number).toBeLessThan(
      allData['files_searched'] as number,
    );
  });

  it('returns no matches when pattern matches no files', () => {
    const result = searchTextHandler({
      repoId,
      query: 'export',
      filePattern: '**/*.go', // No Go files in basic-ts-project
    });
    const data = parse(result);
    expect(data['total_matches']).toBe(0);
    expect(data['files_searched']).toBe(0);
  });
});

// ─── maxResults truncation ────────────────────────────────────────────────────

describe('search_text — maxResults', () => {
  it('truncates results when maxResults is exceeded', () => {
    // 'e' will appear many times
    const result = searchTextHandler({ repoId, query: 'e', maxResults: 3 });
    const data = parse(result);

    expect(data['total_matches']).toBe(3);
    expect(data['truncated']).toBe(true);
  });

  it('truncated is false when results fit within limit', () => {
    const result = searchTextHandler({ repoId, query: 'XYZZY_UNLIKELY_STRING', maxResults: 50 });
    const data = parse(result);
    expect(data['truncated']).toBe(false);
  });
});

// ─── token estimate ───────────────────────────────────────────────────────────

describe('search_text — output shape', () => {
  it('includes _meta with timing, savings, and powered_by', () => {
    const result = searchTextHandler({ repoId, query: 'export' });
    const data = parse(result) as {
      _meta: { timing_ms: number; tokens_saved: number; powered_by: string };
    };
    expect(typeof data._meta.timing_ms).toBe('number');
    expect(data._meta.tokens_saved).toBeGreaterThan(0);
    expect(data._meta.powered_by).toBe('PureContext MCP');
  });
});
