#!/usr/bin/env node
/**
 * Executable launcher for purecontext-mcp.
 *
 * This is intentionally tiny. It imports the Node version guard first (a
 * dependency-free check), and only then dynamically imports the real entry
 * point. The dynamic import means the heavy module graph — including the
 * native `better-sqlite3` binding — is not parsed or evaluated until after
 * the guard has confirmed a supported runtime. On an unsupported Node the
 * guard prints a clear message and exits before anything can crash cryptically.
 *
 * `import(...).catch(...)` (rather than top-level await) is used so this file
 * itself parses on older Node runtimes, letting the guard message through.
 */

import './node-guard.js';

import('./index.js').catch((err: unknown) => {
  const detail = err instanceof Error && err.stack ? err.stack : String(err);
  process.stderr.write(detail + '\n');
  process.exit(1);
});
