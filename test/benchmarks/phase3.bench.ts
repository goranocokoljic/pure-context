/**
 * Phase 3 performance benchmarks — Task 32.
 *
 * Measures indexing throughput and search latency for the new handlers
 * and tools added in Phase 3.
 *
 * Run with:  npx vitest bench test/benchmarks/phase3.bench.ts
 */

import { bench, describe, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { pythonHandler } from '../../src/handlers/python.js';
import { goHandler } from '../../src/handlers/go.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as searchTextHandler } from '../../src/server/tools/search-text.js';

// ─── Paths ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PYTHON_FIXTURE = resolve(__dirname, '../fixtures/python-project');
const GO_FIXTURE     = resolve(__dirname, '../fixtures/go-project');

// ─── Setup ────────────────────────────────────────────────────────────────────

let pythonRepoId: string;
let goRepoId: string;
let searchRepoId: string;
let searchDir: string;

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  registerHandler(pythonHandler);
  registerHandler(goHandler);
  await initParser();

  // Index fixture projects once for benchmarks that measure search, not indexing
  const [pythonResult, goResult] = await Promise.all([
    indexFolder(PYTHON_FIXTURE, { fileLimit: 50 }),
    indexFolder(GO_FIXTURE, { fileLimit: 50 }),
  ]);

  pythonRepoId = pythonResult.repoId;
  goRepoId     = goResult.repoId;

  // Build a synthetic 200-file TypeScript project for the search latency benchmark
  searchDir = join(tmpdir(), `purecontext-bench-${Date.now()}`);
  mkdirSync(searchDir, { recursive: true });

  for (let i = 0; i < 200; i++) {
    writeFileSync(
      join(searchDir, `module${i}.ts`),
      [
        `/** Module ${i} utilities. */`,
        `export function compute${i}(x: number): number { return x * ${i}; }`,
        `export const CONSTANT_${i} = ${i};`,
        `// TODO: refactor compute${i}`,
      ].join('\n') + '\n',
    );
  }

  const searchResult = await indexFolder(searchDir, { fileLimit: 250 });
  searchRepoId = searchResult.repoId;
}, 60_000);

afterAll(() => {
  deleteIndex(pythonRepoId);
  deleteIndex(goRepoId);
  deleteIndex(searchRepoId);
  rmSync(searchDir, { recursive: true, force: true });
});

// ─── Python indexing ──────────────────────────────────────────────────────────

describe('Python indexing', () => {
  let tmpPyRepoId: string;

  bench(
    'index python-project (5 files)',
    async () => {
      if (tmpPyRepoId) deleteIndex(tmpPyRepoId);
      const result = await indexFolder(PYTHON_FIXTURE, { fileLimit: 50 });
      tmpPyRepoId = result.repoId;
    },
    { time: 3000 },
  );
});

// ─── Go indexing ──────────────────────────────────────────────────────────────

describe('Go indexing', () => {
  let tmpGoRepoId: string;

  bench(
    'index go-project (4 files)',
    async () => {
      if (tmpGoRepoId) deleteIndex(tmpGoRepoId);
      const result = await indexFolder(GO_FIXTURE, { fileLimit: 50 });
      tmpGoRepoId = result.repoId;
    },
    { time: 3000 },
  );
});

// ─── search_text latency ──────────────────────────────────────────────────────

describe('search_text latency', () => {
  bench(
    'literal search across 200 TypeScript files',
    () => {
      const result = searchTextHandler({
        repoId: searchRepoId,
        query: 'TODO',
        isRegex: false,
        contextLines: 2,
        maxResults: 50,
      });
      // Sanity check — if this fails the bench result is meaningless
      if (result.isError) throw new Error('search_text returned an error');
    },
    { time: 3000 },
  );

  bench(
    'regex search across 200 TypeScript files',
    () => {
      const result = searchTextHandler({
        repoId: searchRepoId,
        query: 'compute\\d+',
        isRegex: true,
        contextLines: 0,
        maxResults: 50,
      });
      if (result.isError) throw new Error('search_text returned an error');
    },
    { time: 3000 },
  );
});
