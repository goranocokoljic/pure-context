/**
 * Tests for FTS5 keyword search integration (Task 109).
 *
 * Strategy: index the basic-ts-project fixture once in beforeAll (FTS is
 * populated by Task 108's pipeline), then exercise the search_symbols handler
 * and ftsSearchSymbols directly against the real DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase, computeRepoId } from '../../src/core/db/schema.js';
import { ftsSearchSymbols, hasFtsIndex } from '../../src/core/db/symbol-store.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as searchHandler } from '../../src/server/tools/search-symbols.js';

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

function parseResult(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// ─── hasFtsIndex ─────────────────────────────────────────────────────────────

describe('hasFtsIndex', () => {
  it('returns true after indexing (FTS is populated)', () => {
    const db = openDatabase(repoId);
    const result = hasFtsIndex(db, repoId);
    db.close();
    expect(result).toBe(true);
  });

  it('returns false for unknown repoId', () => {
    const db = openDatabase(repoId);
    const result = hasFtsIndex(db, 'nonexistent-repo-id-x');
    db.close();
    expect(result).toBe(false);
  });
});

// ─── ftsSearchSymbols ─────────────────────────────────────────────────────────

describe('ftsSearchSymbols', () => {
  it('finds a symbol by single word matching its name', () => {
    const db = openDatabase(repoId);
    const results = ftsSearchSymbols(db, repoId, 'format');
    db.close();
    const names = results.map((s) => s.name);
    expect(names).toContain('formatDiagnostic');
  });

  it('finds a symbol via multi-word query matching signature/summary', () => {
    const db = openDatabase(repoId);
    // 'format diagnostic' should hit formatDiagnostic via FTS content
    const results = ftsSearchSymbols(db, repoId, 'format diagnostic');
    db.close();
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((s) => s.name);
    expect(names).toContain('formatDiagnostic');
  });

  it('applies kind filter — returns only symbols of the given kind', () => {
    const db = openDatabase(repoId);
    const results = ftsSearchSymbols(db, repoId, 'format', { kind: 'function' });
    db.close();
    expect(results.length).toBeGreaterThan(0);
    for (const s of results) {
      expect(s.kind).toBe('function');
    }
  });

  it('applies filePath filter — returns only symbols from that file', () => {
    const db = openDatabase(repoId);
    const results = ftsSearchSymbols(db, repoId, 'format', { filePath: 'src/utils.ts' });
    db.close();
    expect(results.length).toBeGreaterThan(0);
    for (const s of results) {
      expect(s.filePath).toBe('src/utils.ts');
    }
  });

  it('returns empty array for a query that matches nothing', () => {
    const db = openDatabase(repoId);
    const results = ftsSearchSymbols(db, repoId, 'zzz_no_match_token_xyz');
    db.close();
    expect(results).toHaveLength(0);
  });

  it('respects limit option', () => {
    const db = openDatabase(repoId);
    const results = ftsSearchSymbols(db, repoId, 'Diagnostic', { limit: 1 });
    db.close();
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

// ─── search_symbols handler — FTS mode ───────────────────────────────────────

describe('search_symbols handler — FTS mode', () => {
  it('returns search_mode: fts when FTS index exists', async () => {
    const result = await searchHandler({ repoId, query: 'format', mode: 'keyword' });
    const parsed = parseResult(result);
    const meta = parsed._meta as Record<string, unknown>;
    expect(meta.search_mode).toBe('fts');
  });

  it('finds formatDiagnostic via multi-word query', async () => {
    const result = await searchHandler({ repoId, query: 'format diagnostic', mode: 'keyword' });
    const parsed = parseResult(result);
    const symbols = parsed.symbols as Array<{ name: string }>;
    const names = symbols.map((s) => s.name);
    expect(names).toContain('formatDiagnostic');
  });

  it('applies kind filter in FTS mode', async () => {
    const result = await searchHandler({ repoId, query: 'format', kind: 'function', mode: 'keyword' });
    const parsed = parseResult(result);
    const symbols = parsed.symbols as Array<{ kind: string }>;
    expect(symbols.length).toBeGreaterThan(0);
    for (const s of symbols) {
      expect(s.kind).toBe('function');
    }
  });

  it('applies filePath filter in FTS mode', async () => {
    const result = await searchHandler({ repoId, query: 'format', filePath: 'src/utils.ts', mode: 'keyword' });
    const parsed = parseResult(result);
    const symbols = parsed.symbols as Array<{ filePath: string }>;
    expect(symbols.length).toBeGreaterThan(0);
    for (const s of symbols) {
      expect(s.filePath).toBe('src/utils.ts');
    }
  });
});

// ─── search_symbols handler — LIKE fallback mode ─────────────────────────────

describe('search_symbols handler — LIKE fallback', () => {
  it('falls back to LIKE and sets search_mode: like_fallback when FTS is empty', async () => {
    // Index a fresh fixture to get a real DB, then clear the FTS table
    const result = await indexFolder(FIXTURE, { fileLimit: 50 });
    const tmpRepoId = result.repoId; // same as repoId but DB was reopened fresh

    const db = openDatabase(tmpRepoId);
    db.prepare('DELETE FROM fts_symbols WHERE repo_id = ?').run(tmpRepoId);
    db.close();

    try {
      const handlerResult = await searchHandler({ repoId: tmpRepoId, query: 'format', mode: 'keyword' });
      const parsed = parseResult(handlerResult);
      const meta = parsed._meta as Record<string, unknown>;
      expect(meta.search_mode).toBe('like_fallback');
      // LIKE mode still returns results
      const symbols = parsed.symbols as Array<{ name: string }>;
      const names = symbols.map((s) => s.name);
      expect(names).toContain('formatDiagnostic');
    } finally {
      deleteIndex(tmpRepoId);
    }
  });
});
