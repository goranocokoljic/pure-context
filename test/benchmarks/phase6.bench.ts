/**
 * Phase 6 performance benchmarks — Task 66.
 *
 * Measures indexing throughput for C++, Lua, Dart, and Flutter.
 * Verifies that C++ namespace-qualified name generation does not
 * degrade performance compared to the C handler baseline.
 *
 * Run with:  npx vitest bench test/benchmarks/phase6.bench.ts
 */

import { bench, describe, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { cHandler } from '../../src/handlers/c.js';
import { cppHandler } from '../../src/handlers/cpp.js';
import { luaHandler } from '../../src/handlers/lua.js';
import { dartHandler } from '../../src/handlers/dart.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { flutterAdapter } from '../../src/adapters/flutter.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';
import { _resetForTesting as resetAdapters } from '../../src/adapters/adapter-registry.js';

// ─── Paths ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const C_FIXTURE       = resolve(__dirname, '../fixtures/c-project');
const CPP_FIXTURE     = resolve(__dirname, '../fixtures/cpp-project');
const LUA_FIXTURE     = resolve(__dirname, '../fixtures/lua-project');
const DART_FIXTURE    = resolve(__dirname, '../fixtures/dart-project');
const FLUTTER_FIXTURE = resolve(__dirname, '../fixtures/flutter-project');

// ─── Setup ────────────────────────────────────────────────────────────────────

let cRepoId:       string;
let cppRepoId:     string;
let dartRepoId:    string;
let flutterRepoId: string;

beforeAll(async () => {
  _resetForTesting();
  resetAdapters();

  registerHandler(cHandler);
  registerHandler(cppHandler);
  registerHandler(luaHandler);
  registerHandler(dartHandler);

  await initParser();

  // Pre-index for search latency benchmarks
  const [cResult, cppResult, dartResult, flutterResult] = await Promise.all([
    indexFolder(C_FIXTURE),
    indexFolder(CPP_FIXTURE),
    indexFolder(DART_FIXTURE),
    indexFolder(FLUTTER_FIXTURE, { adapters: [flutterAdapter] }),
  ]);

  cRepoId       = cResult.repoId;
  cppRepoId     = cppResult.repoId;
  dartRepoId    = dartResult.repoId;
  flutterRepoId = flutterResult.repoId;
}, 60_000);

afterAll(() => {
  for (const id of [cRepoId, cppRepoId, dartRepoId, flutterRepoId]) {
    if (id) deleteIndex(id);
  }
});

// ─── C indexing baseline ──────────────────────────────────────────────────────

describe('C handler indexing (baseline)', () => {
  let tmpId: string;

  bench(
    'index c-project (~4 files)',
    async () => {
      if (tmpId) deleteIndex(tmpId);
      const result = await indexFolder(C_FIXTURE);
      tmpId = result.repoId;
    },
    { time: 3000 },
  );

  afterAll(() => { if (tmpId) deleteIndex(tmpId); });
});

// ─── C++ indexing (with namespace qualification) ──────────────────────────────

describe('C++ handler indexing (namespace qualification)', () => {
  let tmpId: string;

  bench(
    'index cpp-project (~5 files)',
    async () => {
      if (tmpId) deleteIndex(tmpId);
      const result = await indexFolder(CPP_FIXTURE);
      tmpId = result.repoId;
    },
    { time: 3000 },
  );

  afterAll(() => { if (tmpId) deleteIndex(tmpId); });
});

// ─── Lua indexing ─────────────────────────────────────────────────────────────

describe('Lua handler indexing', () => {
  let tmpId: string;

  bench(
    'index lua-project (~3 files)',
    async () => {
      if (tmpId) deleteIndex(tmpId);
      const result = await indexFolder(LUA_FIXTURE);
      tmpId = result.repoId;
    },
    { time: 3000 },
  );

  afterAll(() => { if (tmpId) deleteIndex(tmpId); });
});

// ─── Dart indexing ────────────────────────────────────────────────────────────

describe('Dart handler indexing', () => {
  let tmpId: string;

  bench(
    'index dart-project (~4 files)',
    async () => {
      if (tmpId) deleteIndex(tmpId);
      const result = await indexFolder(DART_FIXTURE);
      tmpId = result.repoId;
    },
    { time: 3000 },
  );

  afterAll(() => { if (tmpId) deleteIndex(tmpId); });
});

// ─── Flutter indexing (with adapter) ─────────────────────────────────────────

describe('Flutter adapter indexing', () => {
  let tmpId: string;

  bench(
    'index flutter-project (~5 files, with flutter adapter)',
    async () => {
      if (tmpId) deleteIndex(tmpId);
      const result = await indexFolder(FLUTTER_FIXTURE, { adapters: [flutterAdapter] });
      tmpId = result.repoId;
    },
    { time: 3000 },
  );

  afterAll(() => { if (tmpId) deleteIndex(tmpId); });
});

// ─── Symbol search latency ────────────────────────────────────────────────────

describe('C++ symbol search latency', () => {
  bench('search "Auth" in cpp-project', () => {
    const db      = openDatabase(cppRepoId);
    const results = searchSymbols(db, cppRepoId, 'Auth', { limit: 50 });
    db.close();
    return results;
  });

  bench('search kind:namespace in cpp-project', () => {
    const db      = openDatabase(cppRepoId);
    const results = searchSymbols(db, cppRepoId, '', { kind: 'namespace', limit: 50 });
    db.close();
    return results;
  });
});

describe('Flutter widget search latency', () => {
  bench('search kind:widget in flutter-project', () => {
    const db      = openDatabase(flutterRepoId);
    const results = searchSymbols(db, flutterRepoId, '', { kind: 'widget', limit: 50 });
    db.close();
    return results;
  });
});
