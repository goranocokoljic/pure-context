import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { computeRepoId, openDatabase } from '../../src/core/db/schema.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');
const repoId = computeRepoId(FIXTURE);

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();
});

afterEach(() => {
  try {
    deleteIndex(repoId);
  } catch {
    // may already be deleted
  }
});

describe('indexing correctness regression — all Phase 15 optimizations active (Task 118)', () => {
  it('IndexResult.totalSymbolsInDb equals SELECT COUNT(*) FROM symbols (no parallel write drops)', async () => {
    const result = await indexFolder(FIXTURE);

    const db = openDatabase(repoId);
    const row = db
      .prepare<[string], { count: number }>('SELECT COUNT(*) AS count FROM symbols WHERE repo_id = ?')
      .get(repoId);
    db.close();

    expect(result.errors).toHaveLength(0);
    expect(result.totalSymbolsInDb).toBeGreaterThan(0);
    expect(result.totalSymbolsInDb).toBe(row?.count ?? -1);
  });

  it('FTS table row count matches symbols table (no orphaned or missing FTS entries)', async () => {
    await indexFolder(FIXTURE);

    const db = openDatabase(repoId);
    const symRow = db
      .prepare<[string], { count: number }>('SELECT COUNT(*) AS count FROM symbols WHERE repo_id = ?')
      .get(repoId);
    const ftsRow = db
      .prepare<[string], { count: number }>('SELECT COUNT(*) AS count FROM fts_symbols WHERE repo_id = ?')
      .get(repoId);
    db.close();

    expect(ftsRow?.count).toBe(symRow?.count);
    expect(ftsRow?.count).toBeGreaterThan(0);
  });

  it('import edge count is stable across two independent full indexes', async () => {
    const r1 = await indexFolder(FIXTURE);
    deleteIndex(repoId);
    const r2 = await indexFolder(FIXTURE);

    expect(r1.edgesFound).toBeGreaterThan(0);
    expect(r2.edgesFound).toBe(r1.edgesFound);
  });

  it('re-index with unchanged files: filesIndexed = 0, filesSkipped = N', async () => {
    const r1 = await indexFolder(FIXTURE);
    expect(r1.filesIndexed).toBeGreaterThan(0);

    const r2 = await indexFolder(FIXTURE);

    expect(r2.filesIndexed).toBe(0);
    expect(r2.filesSkipped).toBe(r1.filesIndexed);
    expect(r2.totalSymbolsInDb).toBe(r1.totalSymbolsInDb);
  });

  it('two full independent indexes produce identical symbol and edge counts', async () => {
    const r1 = await indexFolder(FIXTURE);
    deleteIndex(repoId);
    const r2 = await indexFolder(FIXTURE);

    expect(r2.symbolsFound).toBe(r1.symbolsFound);
    expect(r2.totalSymbolsInDb).toBe(r1.totalSymbolsInDb);
    expect(r2.edgesFound).toBe(r1.edgesFound);
  });
});
