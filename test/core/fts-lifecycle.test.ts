/**
 * Task 114 — Phase 14 integration: FTS5 lifecycle via search results.
 *
 * Complements fts-population.test.ts (which verifies row counts) by asserting
 * that the actual search results change correctly across index operations:
 *
 *   index → search confirms symbol found
 *   modify file + reindex → old symbol not found, new symbol found
 *   delete file + reindex → symbol no longer found
 *   empty query via handler → no crash
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { indexFolder, reindexFiles, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase, computeRepoId } from '../../src/core/db/schema.js';
import { ftsSearchSymbols, hasFtsIndex } from '../../src/core/db/symbol-store.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { preprocessQuery } from '../../src/core/search/query-preprocessor.js';
import { handler as searchHandler } from '../../src/server/tools/search-symbols.js';

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Search by name using the real FTS pipeline. Returns top-result names. */
function ftsSearch(repoId: string, rawQuery: string, limit = 10): string[] {
  const ftsQuery = preprocessQuery(rawQuery);
  if (!ftsQuery) return [];
  const db = openDatabase(repoId);
  try {
    return ftsSearchSymbols(db, repoId, ftsQuery, { limit }).map((s) => s.name);
  } finally {
    db.close();
  }
}

// ─── Full lifecycle: index → search → modify → reindex → delete ──────────────

describe('FTS lifecycle — full workflow', () => {
  let tmpRoot: string;
  let repoId: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `purecontext-fts-lifecycle-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    repoId = computeRepoId(resolve(tmpRoot));
  });

  afterEach(() => {
    deleteIndex(repoId);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('symbol is found in FTS after initial index', async () => {
    writeFileSync(
      join(tmpRoot, 'store.ts'),
      '/** Store a value in the cache. */ export function cacheStore(key: string, value: unknown): void { void key; void value; }',
    );

    await indexFolder(tmpRoot, { fileLimit: 10 });

    const names = ftsSearch(repoId, 'cacheStore');
    expect(names).toContain('cacheStore');
  });

  it('renamed symbol appears after reindex; old name disappears', async () => {
    writeFileSync(
      join(tmpRoot, 'store.ts'),
      '/** Store a value in the cache. */ export function cacheStore(key: string, value: unknown): void { void key; void value; }',
    );

    await indexFolder(tmpRoot, { fileLimit: 10 });
    expect(ftsSearch(repoId, 'cacheStore')).toContain('cacheStore');

    // Rename the function
    writeFileSync(
      join(tmpRoot, 'store.ts'),
      '/** Persist a value to the store. */ export function persistValue(key: string, value: unknown): void { void key; void value; }',
    );
    await reindexFiles(repoId, ['store.ts']);

    expect(ftsSearch(repoId, 'cacheStore'), 'old name must be gone').not.toContain('cacheStore');
    expect(ftsSearch(repoId, 'persistValue'), 'new name must be present').toContain('persistValue');
  });

  it('deleted file symbols no longer appear in FTS search', async () => {
    writeFileSync(
      join(tmpRoot, 'widget.ts'),
      '/** Render a widget component. */ export function renderWidget(): void {}',
    );

    await indexFolder(tmpRoot, { fileLimit: 10 });
    expect(ftsSearch(repoId, 'renderWidget')).toContain('renderWidget');

    // Signal deletion to reindexFiles
    await reindexFiles(repoId, [], ['widget.ts']);

    expect(ftsSearch(repoId, 'renderWidget'), 'symbol from deleted file must be gone').not.toContain(
      'renderWidget',
    );
  });

  it('FTS index is populated after indexFolder', async () => {
    writeFileSync(
      join(tmpRoot, 'app.ts'),
      '/** Application entry point. */ export function main(): void {}',
    );

    await indexFolder(tmpRoot, { fileLimit: 10 });

    const db = openDatabase(repoId);
    const populated = hasFtsIndex(db, repoId);
    db.close();
    expect(populated).toBe(true);
  });
});

// ─── Content consistency after reindex ───────────────────────────────────────

describe('FTS lifecycle — content consistency', () => {
  let tmpRoot: string;
  let repoId: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `purecontext-fts-content-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    repoId = computeRepoId(resolve(tmpRoot));
  });

  afterEach(() => {
    deleteIndex(repoId);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('updated docstring is searchable after reindex', async () => {
    // Initial version: no distinctive keywords
    writeFileSync(
      join(tmpRoot, 'util.ts'),
      'export function processData(x: unknown): void { void x; }',
    );
    await indexFolder(tmpRoot, { fileLimit: 10 });

    // Old search: "transform aggregate" → no results (not in content)
    expect(ftsSearch(repoId, 'transform aggregate')).not.toContain('processData');

    // Update with docstring containing those keywords
    writeFileSync(
      join(tmpRoot, 'util.ts'),
      '/** Transform and aggregate data records. */ export function processData(x: unknown): void { void x; }',
    );
    await reindexFiles(repoId, ['util.ts']);

    // Now the updated content is searchable
    expect(ftsSearch(repoId, 'transform aggregate')).toContain('processData');
  });
});

// ─── Empty query safety ───────────────────────────────────────────────────────

describe('FTS lifecycle — empty query safety', () => {
  let tmpRoot: string;
  let repoId: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `purecontext-fts-empty-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    repoId = computeRepoId(resolve(tmpRoot));
  });

  afterEach(() => {
    deleteIndex(repoId);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('passing empty string to handler does not throw', async () => {
    writeFileSync(join(tmpRoot, 'main.ts'), 'export function hello(): void {}');
    await indexFolder(tmpRoot, { fileLimit: 10 });

    // Empty query: preprocessQuery('') returns '' → FTS is skipped → falls back to LIKE
    await expect(
      searchHandler({ repoId, query: '', mode: 'keyword' }),
    ).resolves.not.toThrow();
  });

  it('whitespace-only query does not throw', async () => {
    writeFileSync(join(tmpRoot, 'main.ts'), 'export function hello(): void {}');
    await indexFolder(tmpRoot, { fileLimit: 10 });

    await expect(
      searchHandler({ repoId, query: '   ', mode: 'keyword' }),
    ).resolves.not.toThrow();
  });

  it('FTS5-unsafe characters in query do not cause a crash', async () => {
    writeFileSync(join(tmpRoot, 'main.ts'), 'export function hello(): void {}');
    await indexFolder(tmpRoot, { fileLimit: 10 });

    // preprocessQuery strips these; the resulting query should be safe
    await expect(
      searchHandler({ repoId, query: '"bad*(query)^', mode: 'keyword' }),
    ).resolves.not.toThrow();
  });
});
