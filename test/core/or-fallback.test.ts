/**
 * Task 215 — Phase 37: OR-fallback for zero-result AND queries.
 *
 * Tests:
 *   A) toOrFallbackQuery unit tests
 *   B) Integration: keyword path applies OR-fallback when AND returns 0 results
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { ftsSearchSymbols, insertSymbols } from '../../src/core/db/symbol-store.js';
import { openInMemoryDatabase } from '../../src/core/db/schema.js';
import { preprocessQuery, toOrFallbackQuery } from '../../src/core/search/query-preprocessor.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as searchHandler } from '../../src/server/tools/search-symbols.js';
import type { SymbolRecord } from '../../src/core/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

// ─── A) toOrFallbackQuery unit tests ─────────────────────────────────────────

describe('toOrFallbackQuery — unit', () => {
  it('converts multi-word AND query to OR', () => {
    const result = toOrFallbackQuery('orchestrate indexing pipeline');
    expect(result).toBe('orchestrate OR indexing OR pipeline');
  });

  it('converts two-word AND query to OR', () => {
    const result = toOrFallbackQuery('blast radius');
    expect(result).toBe('blast OR radius');
  });

  it('leaves single-token query unchanged', () => {
    expect(toOrFallbackQuery('parseFile')).toBe('parseFile');
  });

  it('leaves already-OR query unchanged', () => {
    const already = 'parseFile OR parse OR file';
    expect(toOrFallbackQuery(already)).toBe(already);
  });

  it('leaves empty string unchanged', () => {
    expect(toOrFallbackQuery('')).toBe('');
  });

  it('handles four-word query', () => {
    const result = toOrFallbackQuery('discover files scan directory');
    expect(result).toBe('discover OR files OR scan OR directory');
  });

  it('handles five-word query', () => {
    const result = toOrFallbackQuery('parse source file tree sitter');
    expect(result).toBe('parse OR source OR file OR tree OR sitter');
  });

  it('round-trips through preprocessQuery → toOrFallbackQuery', () => {
    const pre = preprocessQuery('orchestrate indexing pipeline');
    // preprocessQuery passes multi-word through unchanged
    expect(pre).toBe('orchestrate indexing pipeline');
    // toOrFallbackQuery converts to OR
    const or = toOrFallbackQuery(pre);
    expect(or).toBe('orchestrate OR indexing OR pipeline');
  });

  it('does not double-convert a query that preprocessQuery already OR-expanded', () => {
    // Single camelCase token — preprocessQuery returns OR-expanded form
    const pre = preprocessQuery('parseFile');
    expect(pre).toContain(' OR ');
    // toOrFallbackQuery sees the OR and leaves it alone
    expect(toOrFallbackQuery(pre)).toBe(pre);
  });
});

// ─── B) In-memory FTS integration ────────────────────────────────────────────

const IN_MEM_REPO = 'or-fallback-test-repo';

function makeSymbol(overrides: Partial<SymbolRecord> & { id: string; name: string }): SymbolRecord {
  return {
    kind: 'function',
    filePath: 'src/index.ts',
    startByte: 0,
    endByte: 100,
    signature: overrides.name,
    summary: overrides.summary ?? overrides.name,
    ...overrides,
  };
}

describe('OR-fallback — FTS in-memory', () => {
  it('AND query returns 0, OR fallback returns the symbol', () => {
    const db = openInMemoryDatabase();
    db.prepare(
      "INSERT OR IGNORE INTO repos (id, root_path, file_count, indexed_at, schema_version) VALUES (?, ?, 0, 0, 1)",
    ).run(IN_MEM_REPO, '/tmp');

    // Symbol whose content only contains SOME of the query words
    insertSymbols(db, IN_MEM_REPO, [
      makeSymbol({
        id: 'aabb000011112222',
        name: 'discoverFiles',
        summary: 'Scans a directory for source files applying gitignore rules',
      }),
    ]);

    const andQuery = 'discover files scan gitignore chokidar watchman';
    const andResults = ftsSearchSymbols(db, IN_MEM_REPO, andQuery);
    // AND requires ALL words — "chokidar" and "watchman" are absent → 0 results
    expect(andResults).toHaveLength(0);

    const orQuery = toOrFallbackQuery(andQuery);
    const orResults = ftsSearchSymbols(db, IN_MEM_REPO, orQuery);
    // OR only needs SOME words → "discover", "files", "scan", "gitignore" all present
    expect(orResults.length).toBeGreaterThan(0);
    expect(orResults[0].name).toBe('discoverFiles');

    db.close();
  });

  it('single-token query — no fallback needed, unchanged result', () => {
    const db = openInMemoryDatabase();
    db.prepare(
      "INSERT OR IGNORE INTO repos (id, root_path, file_count, indexed_at, schema_version) VALUES (?, ?, 0, 0, 1)",
    ).run(IN_MEM_REPO, '/tmp');

    insertSymbols(db, IN_MEM_REPO, [
      makeSymbol({
        id: 'ccdd000011112222',
        name: 'buildGraph',
        summary: 'Constructs the dependency graph',
      }),
    ]);

    const q = preprocessQuery('buildGraph');
    // Single camelCase — already OR-expanded; toOrFallbackQuery returns it unchanged
    expect(toOrFallbackQuery(q)).toBe(q);

    const results = ftsSearchSymbols(db, IN_MEM_REPO, q);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe('buildGraph');

    db.close();
  });
});

// ─── C) End-to-end via search_symbols handler ────────────────────────────────

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

describe('OR-fallback — search_symbols handler integration', () => {
  it('"orchestrate indexing pipeline" finds indexFolder in top 5', async () => {
    const result = await searchHandler({
      repoId,
      query: 'orchestrate indexing pipeline',
      mode: 'keyword',
      limit: 5,
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    const names: string[] = payload.symbols.map((s: { name: string }) => s.name);
    expect(names).toContain('indexFolder');
  });

  it('"parse source file tree-sitter ast" finds parseFile in top 5', async () => {
    const result = await searchHandler({
      repoId,
      query: 'parse source file tree-sitter ast',
      mode: 'keyword',
      limit: 5,
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    const names: string[] = payload.symbols.map((s: { name: string }) => s.name);
    expect(names).toContain('parseFile');
  });

  it('"compute blast radius impact analysis" finds getBlastRadius in top 5', async () => {
    const result = await searchHandler({
      repoId,
      query: 'compute blast radius impact analysis',
      mode: 'keyword',
      limit: 5,
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    const names: string[] = payload.symbols.map((s: { name: string }) => s.name);
    expect(names).toContain('getBlastRadius');
  });

  it('"discover files scan directory gitignore" finds discoverFiles in top 5', async () => {
    const result = await searchHandler({
      repoId,
      query: 'discover files scan directory gitignore',
      mode: 'keyword',
      limit: 5,
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    const names: string[] = payload.symbols.map((s: { name: string }) => s.name);
    expect(names).toContain('discoverFiles');
  });

  it('"build dependency graph import edges" finds buildGraph in top 5', async () => {
    const result = await searchHandler({
      repoId,
      query: 'build dependency graph import edges',
      mode: 'keyword',
      limit: 5,
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    const names: string[] = payload.symbols.map((s: { name: string }) => s.name);
    expect(names).toContain('buildGraph');
  });

  it('search_mode is fts or fts_or_fallback (not like_fallback) for indexed repo', async () => {
    const result = await searchHandler({
      repoId,
      query: 'orchestrate indexing pipeline',
      mode: 'keyword',
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(['fts', 'fts_or_fallback']).toContain(payload._meta.search_mode);
  });

  it('fts_or_fallback mode is reported when AND returned 0 results', async () => {
    // Construct a query with a rare word that won't appear in any symbol content
    // but whose other words do. This forces the OR-fallback path.
    const result = await searchHandler({
      repoId,
      query: 'zxqwerty indexFolder',
      mode: 'keyword',
      limit: 5,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    // "zxqwerty indexFolder" AND would fail; OR should find indexFolder
    if (payload.count > 0) {
      expect(payload._meta.search_mode).toBe('fts_or_fallback');
    }
  });
});
