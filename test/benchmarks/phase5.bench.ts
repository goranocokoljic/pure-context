/**
 * Phase 5 performance benchmarks — Task 60.
 *
 * Measures indexing throughput for the new Phase 5 language handlers
 * and framework adapters: Python, Go, PHP, Ruby, Kotlin, C.
 *
 * Run with:  npx vitest bench test/benchmarks/phase5.bench.ts
 */

import { bench, describe, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { pythonHandler } from '../../src/handlers/python.js';
import { goHandler } from '../../src/handlers/go.js';
import { phpHandler } from '../../src/handlers/php.js';
import { rubyHandler } from '../../src/handlers/ruby.js';
import { kotlinHandler } from '../../src/handlers/kotlin.js';
import { cHandler } from '../../src/handlers/c.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { flaskAdapter } from '../../src/adapters/flask.js';
import { fastapiAdapter } from '../../src/adapters/fastapi.js';
import { djangoAdapter } from '../../src/adapters/django.js';
import { ginAdapter } from '../../src/adapters/gin.js';
import { laravelAdapter } from '../../src/adapters/laravel.js';
import { railsAdapter } from '../../src/adapters/rails.js';
import { ktorAdapter } from '../../src/adapters/ktor.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';
import { _resetForTesting as resetAdapters } from '../../src/adapters/adapter-registry.js';

// ─── Paths ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const FLASK_FIXTURE   = resolve(__dirname, '../fixtures/flask-project');
const FASTAPI_FIXTURE = resolve(__dirname, '../fixtures/fastapi-project');
const DJANGO_FIXTURE  = resolve(__dirname, '../fixtures/django-project');
const GIN_FIXTURE     = resolve(__dirname, '../fixtures/gin-project');
const PHP_FIXTURE     = resolve(__dirname, '../fixtures/php-project');
const LARAVEL_FIXTURE = resolve(__dirname, '../fixtures/laravel-project');
const RUBY_FIXTURE    = resolve(__dirname, '../fixtures/ruby-project');
const RAILS_FIXTURE   = resolve(__dirname, '../fixtures/rails-project');
const KOTLIN_FIXTURE  = resolve(__dirname, '../fixtures/kotlin-project');
const KTOR_FIXTURE    = resolve(__dirname, '../fixtures/ktor-project');
const C_FIXTURE       = resolve(__dirname, '../fixtures/c-project');

// ─── Setup ────────────────────────────────────────────────────────────────────

let phpRepoId:   string;
let rubyRepoId:  string;
let cRepoId:     string;
let ginRepoId:   string;
let ktorRepoId:  string;

beforeAll(async () => {
  _resetForTesting();
  resetAdapters();

  registerHandler(typescriptHandler);
  registerHandler(pythonHandler);
  registerHandler(goHandler);
  registerHandler(phpHandler);
  registerHandler(rubyHandler);
  registerHandler(kotlinHandler);
  registerHandler(cHandler);

  await initParser();

  // Pre-index for search latency benchmarks
  const [phpResult, rubyResult, cResult, ginResult, ktorResult] = await Promise.all([
    indexFolder(PHP_FIXTURE),
    indexFolder(RUBY_FIXTURE),
    indexFolder(C_FIXTURE),
    indexFolder(GIN_FIXTURE,  { adapters: [ginAdapter] }),
    indexFolder(KTOR_FIXTURE, { adapters: [ktorAdapter] }),
  ]);

  phpRepoId  = phpResult.repoId;
  rubyRepoId = rubyResult.repoId;
  cRepoId    = cResult.repoId;
  ginRepoId  = ginResult.repoId;
  ktorRepoId = ktorResult.repoId;
}, 60_000);

afterAll(() => {
  for (const id of [phpRepoId, rubyRepoId, cRepoId, ginRepoId, ktorRepoId]) {
    if (id) deleteIndex(id);
  }
});

// ─── Python / Flask indexing ──────────────────────────────────────────────────

describe('Flask indexing', () => {
  let tmpId: string;

  bench(
    'index flask-project (~3 files)',
    async () => {
      if (tmpId) deleteIndex(tmpId);
      const result = await indexFolder(FLASK_FIXTURE, { adapters: [flaskAdapter] });
      tmpId = result.repoId;
    },
    { time: 3000 },
  );
});

describe('FastAPI indexing', () => {
  let tmpId: string;

  bench(
    'index fastapi-project (~4 files)',
    async () => {
      if (tmpId) deleteIndex(tmpId);
      const result = await indexFolder(FASTAPI_FIXTURE, { adapters: [fastapiAdapter] });
      tmpId = result.repoId;
    },
    { time: 3000 },
  );
});

describe('Django indexing', () => {
  let tmpId: string;

  bench(
    'index django-project (~5 files)',
    async () => {
      if (tmpId) deleteIndex(tmpId);
      const result = await indexFolder(DJANGO_FIXTURE, { adapters: [djangoAdapter] });
      tmpId = result.repoId;
    },
    { time: 3000 },
  );
});

// ─── Go / Gin indexing ────────────────────────────────────────────────────────

describe('Gin indexing', () => {
  let tmpId: string;

  bench(
    'index gin-project (~2 files)',
    async () => {
      if (tmpId) deleteIndex(tmpId);
      const result = await indexFolder(GIN_FIXTURE, { adapters: [ginAdapter] });
      tmpId = result.repoId;
    },
    { time: 3000 },
  );
});

// ─── PHP / Laravel indexing ───────────────────────────────────────────────────

describe('PHP handler indexing', () => {
  let tmpId: string;

  bench(
    'index php-project (3 source files)',
    async () => {
      if (tmpId) deleteIndex(tmpId);
      const result = await indexFolder(PHP_FIXTURE);
      tmpId = result.repoId;
    },
    { time: 3000 },
  );
});

describe('Laravel indexing', () => {
  let tmpId: string;

  bench(
    'index laravel-project (~8 files)',
    async () => {
      if (tmpId) deleteIndex(tmpId);
      const result = await indexFolder(LARAVEL_FIXTURE, { adapters: [laravelAdapter] });
      tmpId = result.repoId;
    },
    { time: 3000 },
  );
});

// ─── Ruby / Rails indexing ────────────────────────────────────────────────────

describe('Ruby handler indexing', () => {
  let tmpId: string;

  bench(
    'index ruby-project (3 source files)',
    async () => {
      if (tmpId) deleteIndex(tmpId);
      const result = await indexFolder(RUBY_FIXTURE);
      tmpId = result.repoId;
    },
    { time: 3000 },
  );
});

describe('Rails indexing', () => {
  let tmpId: string;

  bench(
    'index rails-project (~7 files)',
    async () => {
      if (tmpId) deleteIndex(tmpId);
      const result = await indexFolder(RAILS_FIXTURE, { adapters: [railsAdapter] });
      tmpId = result.repoId;
    },
    { time: 3000 },
  );
});

// ─── Kotlin / Ktor indexing ───────────────────────────────────────────────────

describe('Kotlin handler indexing', () => {
  let tmpId: string;

  bench(
    'index kotlin-project (2 source files)',
    async () => {
      if (tmpId) deleteIndex(tmpId);
      const result = await indexFolder(KOTLIN_FIXTURE);
      tmpId = result.repoId;
    },
    { time: 3000 },
  );
});

describe('Ktor indexing', () => {
  let tmpId: string;

  bench(
    'index ktor-project (~1 source file)',
    async () => {
      if (tmpId) deleteIndex(tmpId);
      const result = await indexFolder(KTOR_FIXTURE, { adapters: [ktorAdapter] });
      tmpId = result.repoId;
    },
    { time: 3000 },
  );
});

// ─── C handler indexing ───────────────────────────────────────────────────────

describe('C handler indexing', () => {
  let tmpId: string;

  bench(
    'index c-project (2 .c + 2 .h files)',
    async () => {
      if (tmpId) deleteIndex(tmpId);
      const result = await indexFolder(C_FIXTURE);
      tmpId = result.repoId;
    },
    { time: 3000 },
  );
});

// ─── Symbol search latency ────────────────────────────────────────────────────

describe('PHP symbol search latency', () => {
  bench(
    'searchSymbols across php-project',
    () => {
      const db = openDatabase(phpRepoId);
      const results = searchSymbols(db, phpRepoId, '', { limit: 50 });
      db.close();
      if (results.length === 0) throw new Error('no PHP symbols indexed');
    },
    { time: 3000 },
  );
});

describe('Ruby symbol search latency', () => {
  bench(
    'searchSymbols across ruby-project',
    () => {
      const db = openDatabase(rubyRepoId);
      const results = searchSymbols(db, rubyRepoId, '', { limit: 50 });
      db.close();
      if (results.length === 0) throw new Error('no Ruby symbols indexed');
    },
    { time: 3000 },
  );
});

describe('C symbol search latency', () => {
  bench(
    'searchSymbols across c-project',
    () => {
      const db = openDatabase(cRepoId);
      const results = searchSymbols(db, cRepoId, '', { limit: 50 });
      db.close();
      if (results.length === 0) throw new Error('no C symbols indexed');
    },
    { time: 3000 },
  );
});

describe('Gin route search latency', () => {
  bench(
    "searchSymbols kind:'route' across gin-project",
    () => {
      const db = openDatabase(ginRepoId);
      const results = searchSymbols(db, ginRepoId, '', { kind: 'route', limit: 50 });
      db.close();
      if (results.length === 0) throw new Error('no Gin routes indexed');
    },
    { time: 3000 },
  );
});

describe('Ktor route search latency', () => {
  bench(
    "searchSymbols kind:'route' across ktor-project",
    () => {
      const db = openDatabase(ktorRepoId);
      const results = searchSymbols(db, ktorRepoId, '', { kind: 'route', limit: 50 });
      db.close();
      if (results.length === 0) throw new Error('no Ktor routes indexed');
    },
    { time: 3000 },
  );
});
