/**
 * Plain-JS bootstrap for the TypeScript indexing worker.
 *
 * Used in source/test context (vitest, dev) where workers run as .ts files but
 * Node.js cannot natively execute TypeScript. We use tsx's programmatic API
 * (tsImport) to transpile and load indexing-worker.ts at runtime.
 *
 * In compiled dist/ context, worker-pool.ts points directly to indexing-worker.js
 * and this file is never used.
 */

import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load tsx's tsImport API — available as tsx/esm/api
const { tsImport } = require('tsx/esm/api');

// Import the TypeScript worker — this runs the module's top-level code,
// including the `if (!isMainThread) { parentPort.on(...) }` setup.
await tsImport(
  pathToFileURL(join(__dirname, 'indexing-worker.ts')).href,
  import.meta.url,
);
