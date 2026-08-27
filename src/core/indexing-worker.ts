/**
 * Worker thread entry point for parallel file parsing.
 *
 * Each worker maintains its own web-tree-sitter Parser instance — no shared
 * state, no mutex needed. Adapters are imported here so they self-register into
 * this worker's own adapter-registry instance.
 *
 * Protocol (main thread → worker):
 *   ParseJob       — process one file, respond with ParseResult
 *   ShutdownMsg    — graceful exit (worker calls process.exit)
 */

import { parentPort, isMainThread } from 'worker_threads';
import type { FrameworkAdapter, SymbolRecord, ImportRecord } from './types.js';
import { initParser, isInitialized } from './parse-dispatcher.js';
import { processFile } from './file-processor.js';
import { getRegisteredAdapters } from '../adapters/adapter-registry.js';

// ─── Registration (Task 553): ONE shared list ─────────────────────────────────
// Workers have their own module instance — importing bootstrap-registry here
// registers handlers + adapters into THIS worker's own registries.

import { registerStandardHandlers } from './bootstrap-registry.js';

registerStandardHandlers();

// ─── Message types ─────────────────────────────────────────────────────────────

export interface ParseJob {
  relPath: string;
  /**
   * File content as Uint8Array. Sent via structured clone (not transferred) so
   * the main thread can still access the original Buffer for upsertFile.
   */
  content: Uint8Array;
  adapterNames: string[];
  /**
   * Absolute repo root (Phase 94, Task 585) — forwarded to handlers as
   * HandlerContext.rootPath for filesystem colocation checks.
   */
  rootPath?: string;
}

export interface ParseResult {
  relPath: string;
  symbols: SymbolRecord[];
  imports: ImportRecord[];
  /** Package the file declares (JVM languages) — see ProcessedResult.declaredPackage. */
  declaredPackage?: string | null;
  /** Set if an unrecoverable parse error occurred — worker stays alive. */
  error?: string;
}

interface ShutdownMsg {
  type: 'shutdown';
}

// ─── Worker entry point ───────────────────────────────────────────────────────

if (!isMainThread) {
  parentPort!.on('message', async (msg: ParseJob | ShutdownMsg) => {
    if ('type' in msg && msg.type === 'shutdown') {
      process.exit(0);
    }

    const job = msg as ParseJob;

    // Lazy-initialize parser on first message — one init per worker lifetime.
    if (!isInitialized()) {
      await initParser();
    }

    // Resolve adapters by name from this worker's self-registered registry.
    const allAdapters = getRegisteredAdapters();
    const adapters = job.adapterNames
      .map((name) => allAdapters.find((a) => a.name === name))
      .filter((a): a is FrameworkAdapter => a !== undefined);

    try {
      // Reconstruct a Buffer from the Uint8Array received via structured clone.
      const content = Buffer.from(job.content.buffer, job.content.byteOffset, job.content.byteLength);
      const { symbols, imports, declaredPackage } = await processFile(
        job.relPath, content, adapters,
        job.rootPath !== undefined ? { rootPath: job.rootPath } : undefined,
      );

      const result: ParseResult = { relPath: job.relPath, symbols, imports, declaredPackage };
      parentPort!.postMessage(result);
    } catch (err) {
      // Catch all errors so the worker stays alive for subsequent jobs.
      const result: ParseResult = {
        relPath: job.relPath,
        symbols: [],
        imports: [],
        error: err instanceof Error ? err.message : String(err),
      };
      parentPort!.postMessage(result);
    }
  });
}
