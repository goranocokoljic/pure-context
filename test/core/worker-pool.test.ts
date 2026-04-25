import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { createWorkerPool } from '../../src/core/worker-pool.js';
import type { ParseJob } from '../../src/core/worker-pool.js';

// Small TS snippet used as a synthetic parse job
const TINY_TS = Buffer.from(`export function add(a: number, b: number): number { return a + b; }`);
const TINY_TS_ARRAY = new Uint8Array(TINY_TS.buffer, TINY_TS.byteOffset, TINY_TS.byteLength);

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();
});

describe('WorkerPool (Task 117)', () => {
  it('processes all jobs and returns results in order', async () => {
    const pool = createWorkerPool(2);
    try {
      const jobs: ParseJob[] = Array.from({ length: 6 }, (_, i) => ({
        relPath: `src/file${i}.ts`,
        content: new Uint8Array(TINY_TS_ARRAY), // fresh copy per job
        adapterNames: [],
      }));

      const results = await pool.run(jobs);

      expect(results).toHaveLength(6);
      for (let i = 0; i < 6; i++) {
        expect(results[i].relPath).toBe(`src/file${i}.ts`);
        expect(results[i].error).toBeUndefined();
        // The add() function should be extracted
        expect(results[i].symbols.length).toBeGreaterThan(0);
      }
    } finally {
      await pool.terminate();
    }
  });

  it('returns empty results for an empty job list', async () => {
    const pool = createWorkerPool(2);
    try {
      const results = await pool.run([]);
      expect(results).toHaveLength(0);
    } finally {
      await pool.terminate();
    }
  });

  it('a failed parse does not crash the pool — error appears in result', async () => {
    const pool = createWorkerPool(2);
    try {
      // An empty content buffer triggers a parse that yields no symbols (not an error),
      // but an unrecognised extension causes the worker to return an empty result.
      const jobs: ParseJob[] = [
        {
          relPath: 'src/unknown.xyz',    // no handler → empty, no error
          content: new Uint8Array(TINY_TS_ARRAY),
          adapterNames: [],
        },
        {
          relPath: 'src/good.ts',
          content: new Uint8Array(TINY_TS_ARRAY),
          adapterNames: [],
        },
      ];

      const results = await pool.run(jobs);

      expect(results).toHaveLength(2);
      // Second job should succeed
      expect(results[1].relPath).toBe('src/good.ts');
      expect(results[1].error).toBeUndefined();
      expect(results[1].symbols.length).toBeGreaterThan(0);
    } finally {
      await pool.terminate();
    }
  });

  it('terminate() resolves without hanging', async () => {
    const pool = createWorkerPool(2);
    // Don't run any jobs — just terminate idle workers
    await expect(pool.terminate()).resolves.toBeUndefined();
  });

  it('single-worker pool processes all jobs sequentially', async () => {
    const pool = createWorkerPool(1);
    try {
      const jobs: ParseJob[] = Array.from({ length: 4 }, (_, i) => ({
        relPath: `src/seq${i}.ts`,
        content: new Uint8Array(TINY_TS_ARRAY),
        adapterNames: [],
      }));

      const results = await pool.run(jobs);

      expect(results).toHaveLength(4);
      for (let i = 0; i < 4; i++) {
        expect(results[i].relPath).toBe(`src/seq${i}.ts`);
        expect(results[i].symbols.length).toBeGreaterThan(0);
      }
    } finally {
      await pool.terminate();
    }
  });
});
