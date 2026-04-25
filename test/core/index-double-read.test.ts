import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { computeRepoId } from '../../src/core/db/schema.js';
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
  deleteIndex(repoId);
});

describe('index-manager — no double file reads (Task 115)', () => {
  it('indexes files and reports correct counts on a fresh run', async () => {
    const result = await indexFolder(FIXTURE);

    expect(result.errors).toHaveLength(0);
    expect(result.filesIndexed).toBeGreaterThan(0);
    expect(result.totalSymbolsInDb).toBeGreaterThan(0);
  });

  it('skips all unchanged files on re-index (hash carried correctly from step 5)', async () => {
    // First run — full index
    const r1 = await indexFolder(FIXTURE);
    expect(r1.filesIndexed).toBeGreaterThan(0);

    // Second run — nothing changed, hash cache populated from first run
    const r2 = await indexFolder(FIXTURE);

    expect(r2.filesIndexed).toBe(0);
    expect(r2.filesSkipped).toBeGreaterThan(0);
    // DB state unchanged
    expect(r2.totalSymbolsInDb).toBe(r1.totalSymbolsInDb);
  });

  it('produces identical symbol counts across two independent full indexes', async () => {
    const r1 = await indexFolder(FIXTURE);
    deleteIndex(repoId);

    const r2 = await indexFolder(FIXTURE);

    expect(r2.symbolsFound).toBe(r1.symbolsFound);
    expect(r2.filesIndexed).toBe(r1.filesIndexed);
    expect(r2.totalSymbolsInDb).toBe(r1.totalSymbolsInDb);
  });

  it('reports no errors during indexing', async () => {
    const result = await indexFolder(FIXTURE);
    expect(result.errors).toHaveLength(0);
  });
});
