#!/usr/bin/env node
/**
 * Postinstall canary: verify better-sqlite3 loads correctly.
 * Exits with code 0 regardless of outcome so `npm install` never fails
 * due to this check — but prints a clear diagnostic if the binary is broken.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);

try {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE _check (id INTEGER PRIMARY KEY)');
  db.close();
  // Silent success — no noise on a clean install.
} catch (err) {
  process.stderr.write(
    '\n' +
    '╔══════════════════════════════════════════════════════════════╗\n' +
    '║  PureContext MCP — native module load failed                 ║\n' +
    '╠══════════════════════════════════════════════════════════════╣\n' +
    '║  better-sqlite3 could not load its native binary.            ║\n' +
    '║                                                              ║\n' +
    '║  This usually means:                                         ║\n' +
    '║    • Your Node.js version is not 18, 20, or 22.              ║\n' +
    '║    • The prebuilt binary for your platform is missing.       ║\n' +
    '║                                                              ║\n' +
    '║  To rebuild from source (requires Python + build tools):     ║\n' +
    '║    npm rebuild better-sqlite3                                ║\n' +
    '║                                                              ║\n' +
    '║  To report an issue:                                         ║\n' +
    '║    https://github.com/Goran-Ocokoljic/purecontext-mcp/issues ║\n' +
    '╚══════════════════════════════════════════════════════════════╝\n' +
    '\n' +
    '  Error detail: ' + err.message + '\n\n'
  );
  // Exit 0 intentionally — do not block `npm install`.
  process.exit(0);
}
