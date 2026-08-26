/**
 * Library entry point (Task 553, report Issue H).
 *
 * `import 'purecontext-mcp'` starts the MCP server (that is the product);
 * `import { ... } from 'purecontext-mcp/lib'` drives the indexer
 * programmatically — exactly what the 1.18.0 verification scripts needed,
 * which previously had to side-effect-import dist/core/indexing-worker.js.
 *
 * Typical use:
 *
 *   import { bootstrapLibrary, indexFolder } from 'purecontext-mcp/lib';
 *   await bootstrapLibrary();
 *   const result = await indexFolder('/path/to/repo');
 *
 * Importing this module has NO side effects beyond adapter registration —
 * no server starts, no stdio is bound.
 */

import { initSqliteBackend } from './core/db/sqlite-loader.js';
import { initParser } from './core/parse-dispatcher.js';
import { registerStandardHandlers } from './core/bootstrap-registry.js';

export { registerStandardHandlers } from './core/bootstrap-registry.js';
export { indexFolder, reindexFiles, deleteIndex, computeRepoId } from './core/index-manager.js';
export { openDatabase, getIndexDir } from './core/db/schema.js';
export { VERSION } from './version.js';

/**
 * One-call setup for library use: selects the SQLite backend (native
 * better-sqlite3, else the WASM fallback), registers all standard handlers
 * and adapters, and initializes tree-sitter. Idempotent.
 */
export async function bootstrapLibrary(options?: { cssVariables?: boolean }): Promise<void> {
  await initSqliteBackend();
  registerStandardHandlers(options);
  await initParser();
}
