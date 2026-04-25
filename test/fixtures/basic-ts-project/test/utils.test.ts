import { formatDiagnostic } from '../src/utils.js';

// Minimal fixture test (not run by the purecontext test suite)
const d = { message: 'oops', severity: 'error' as const, file: 'foo.ts', line: 1 };
console.assert(formatDiagnostic(d) === '[ERROR] foo.ts:1 — oops');
