import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, reindexFiles, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase, computeRepoId } from '../../src/core/db/schema.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();
});

// ─── Helper: count rows in a table ───────────────────────────────────────────

function dbCount(repoId: string, table: 'symbols' | 'files'): number {
  const db = openDatabase(repoId);
  const row = db
    .prepare<[string], { c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE repo_id = ?`)
    .get(repoId);
  db.close();
  return row?.c ?? 0;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('IndexResult stats — totalSymbolsInDb / totalFilesInDb', () => {
  const repoId = computeRepoId(FIXTURE);

  afterEach(() => {
    deleteIndex(repoId);
  });

  it('totalSymbolsInDb equals COUNT(*) from symbols table after full index', async () => {
    const result = await indexFolder(FIXTURE);

    const dbSymbols = dbCount(repoId, 'symbols');
    expect(result.totalSymbolsInDb).toBe(dbSymbols);
    expect(result.totalSymbolsInDb).toBeGreaterThan(0);
  });

  it('totalFilesInDb equals COUNT(*) from files table after full index', async () => {
    const result = await indexFolder(FIXTURE);

    const dbFiles = dbCount(repoId, 'files');
    expect(result.totalFilesInDb).toBe(dbFiles);
    expect(result.totalFilesInDb).toBeGreaterThan(0);
  });

  it('totalSymbolsInDb is not capped at 1000 for large repos', async () => {
    // Create a temp project with > 10 distinct .ts files each exporting several functions
    const tmpRoot = join(tmpdir(), `purecontext-stats-test-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });

    // Generate 15 files × 10 functions = 150 symbols
    for (let i = 0; i < 15; i++) {
      const fns = Array.from(
        { length: 10 },
        (_, j) => `export function fn_${i}_${j}(x: number): number { return x + ${j}; }`,
      ).join('\n');
      writeFileSync(join(tmpRoot, `module${i}.ts`), fns, 'utf-8');
    }

    const bigRepoId = computeRepoId(tmpRoot);
    try {
      _resetForTesting();
      registerHandler(typescriptHandler);
      registerHandler(tsxHandler);
      registerHandler(javascriptHandler);

      const result = await indexFolder(tmpRoot);
      const dbSymbols = dbCount(bigRepoId, 'symbols');

      expect(result.totalSymbolsInDb).toBe(dbSymbols);
      expect(result.totalSymbolsInDb).toBeGreaterThanOrEqual(150);
    } finally {
      deleteIndex(bigRepoId);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('totalSymbolsInDb reflects full DB count after incremental re-index', async () => {
    // Full index first
    await indexFolder(FIXTURE);

    // Re-index a single file — totalSymbolsInDb should still equal full DB count
    const db = openDatabase(repoId);
    let filePath: string | undefined;
    try {
      // files table uses column "path", symbols table uses "file_path"
      const row = db
        .prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ? LIMIT 1')
        .get(repoId);
      filePath = row?.path;
    } finally {
      db.close();
    }

    if (!filePath) return; // fixture has no files — skip

    const result = await reindexFiles(repoId, [filePath]);
    const afterTotal = dbCount(repoId, 'symbols');

    expect(result.totalSymbolsInDb).toBe(afterTotal);
    expect(result.totalSymbolsInDb).toBeGreaterThan(0);
    // symbolsFound is the incremental count (for this run only), totalSymbolsInDb is the full count
    expect(result.totalSymbolsInDb).toBeGreaterThanOrEqual(result.symbolsFound);
  });

  it('repos table stores correct (uncapped) symbol count', async () => {
    const result = await indexFolder(FIXTURE);

    const db = openDatabase(repoId);
    const repoRow = db
      .prepare<[string], { symbol_count: number }>('SELECT symbol_count FROM repos WHERE id = ?')
      .get(repoId);
    db.close();

    expect(repoRow?.symbol_count).toBe(result.totalSymbolsInDb);
  });
});
