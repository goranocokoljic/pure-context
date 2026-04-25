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
  try {
    deleteIndex(repoId);
  } catch {
    // May already be deleted
  }
});

describe('parallel indexing (Task 117)', () => {
  it('concurrency:1 (sequential) produces correct symbol count', async () => {
    const result = await indexFolder(FIXTURE, { concurrency: 1 });

    expect(result.errors).toHaveLength(0);
    expect(result.filesIndexed).toBeGreaterThan(0);
    expect(result.totalSymbolsInDb).toBeGreaterThan(0);
  });

  it('concurrency:2 (parallel) produces same symbol count as sequential', async () => {
    // Sequential baseline
    const seq = await indexFolder(FIXTURE, { concurrency: 1 });
    deleteIndex(repoId);

    // Parallel run
    const par = await indexFolder(FIXTURE, { concurrency: 2 });

    expect(par.errors).toHaveLength(0);
    expect(par.filesIndexed).toBe(seq.filesIndexed);
    expect(par.symbolsFound).toBe(seq.symbolsFound);
    expect(par.totalSymbolsInDb).toBe(seq.totalSymbolsInDb);
  });

  it('concurrency:2 — all symbols written to DB without race conditions', async () => {
    const result = await indexFolder(FIXTURE, { concurrency: 2 });

    // totalSymbolsInDb is a SELECT COUNT(*) — if any race condition dropped rows
    // it would show here.
    expect(result.totalSymbolsInDb).toBe(result.symbolsFound);
    expect(result.errors).toHaveLength(0);
  });

  it('concurrency:2 — re-index skips all unchanged files', async () => {
    await indexFolder(FIXTURE, { concurrency: 2 });
    const r2 = await indexFolder(FIXTURE, { concurrency: 2 });

    // Nothing changed — parallel path should be bypassed (toProcess.length < 2)
    // or fall through with 0 jobs. Either way: no files indexed.
    expect(r2.filesIndexed).toBe(0);
    expect(r2.filesSkipped).toBeGreaterThan(0);
  });

  it('edges found matches between sequential and parallel runs', async () => {
    const seq = await indexFolder(FIXTURE, { concurrency: 1 });
    deleteIndex(repoId);
    const par = await indexFolder(FIXTURE, { concurrency: 2 });

    expect(par.edgesFound).toBe(seq.edgesFound);
  });
});
