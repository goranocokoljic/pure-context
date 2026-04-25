/**
 * Worker thread pool for parallel file parsing.
 *
 * Creates `concurrency` Worker instances each running indexing-worker.ts.
 * A job queue feeds idle workers. All results are collected and returned in
 * input order once every job has completed.
 *
 * Environment detection:
 *   - Compiled (.js): worker runs as plain JS — no loader needed.
 *   - Source (.ts, vitest/dev): worker runs through tsx for TS transpilation.
 */

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import type { ParseJob, ParseResult } from './indexing-worker.js';
import { logger } from './logger.js';

// Re-export for index-manager
export type { ParseJob, ParseResult };

// ─── Worker factory ───────────────────────────────────────────────────────────

// True when running from compiled dist/ output (not TypeScript source).
const IS_COMPILED = import.meta.url.endsWith('.js');

function spawnWorker(): Worker {
  if (IS_COMPILED) {
    // In dist/, worker lives beside this file as a compiled .js module.
    return new Worker(fileURLToPath(new URL('./indexing-worker.js', import.meta.url)));
  }
  // Development / test: use the plain-JS bootstrap which loads the TypeScript
  // worker via tsx's programmatic tsImport API (no --loader or --import flag
  // needed — avoids Windows path issues with Node.js --import handling).
  return new Worker(fileURLToPath(new URL('./indexing-worker-boot.mjs', import.meta.url)));
}

// ─── Pool ─────────────────────────────────────────────────────────────────────

export interface WorkerPool {
  /**
   * Run all jobs in parallel across the pool.
   * Returns results in the same order as the input jobs array.
   */
  run(jobs: ParseJob[]): Promise<ParseResult[]>;
  /** Terminate all worker threads. */
  terminate(): Promise<void>;
}

export function createWorkerPool(concurrency: number): WorkerPool {
  const workers: Worker[] = Array.from({ length: concurrency }, () => spawnWorker());

  // Log any uncaught worker errors at the pool level.
  for (const w of workers) {
    w.on('error', (err) => logger.warn(`Worker uncaught error: ${err.message}`));
  }

  return {
    async run(jobs: ParseJob[]): Promise<ParseResult[]> {
      if (jobs.length === 0) return [];

      const results: ParseResult[] = new Array(jobs.length);
      // queue entries: [original index, job]
      const queue: Array<[number, ParseJob]> = jobs.map((j, i) => [i, j]);
      let pending = jobs.length;

      return new Promise((resolve) => {
        function dispatch(worker: Worker): void {
          const next = queue.shift();
          if (!next) return; // No more jobs for this worker.

          const [jobIndex, job] = next;

          const onMessage = (result: ParseResult) => {
            worker.off('message', onMessage);
            worker.off('error', onWorkerError);
            results[jobIndex] = result;
            if (--pending === 0) {
              resolve(results);
            } else {
              dispatch(worker);
            }
          };

          const onWorkerError = (err: Error) => {
            worker.off('message', onMessage);
            worker.off('error', onWorkerError);
            results[jobIndex] = {
              relPath: job.relPath,
              symbols: [],
              imports: [],
              error: `Worker error: ${err.message}`,
            };
            if (--pending === 0) {
              resolve(results);
            } else {
              dispatch(worker);
            }
          };

          worker.once('message', onMessage);
          worker.once('error', onWorkerError);
          worker.postMessage(job);
        }

        // Seed all workers — each picks up its first job.
        for (const worker of workers) {
          if (queue.length > 0) {
            dispatch(worker);
          }
        }
      });
    },

    async terminate(): Promise<void> {
      await Promise.all(workers.map((w) => w.terminate()));
    },
  };
}
