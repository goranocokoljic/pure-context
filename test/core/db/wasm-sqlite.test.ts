/**
 * Validates the WASM SQLite fallback adapter against the real schema and the
 * better-sqlite3 API surface the codebase relies on: DDL incl. FTS5, named +
 * positional params, get/all/run, transactions (commit + rollback), BLOB
 * round-trips, and file persistence (export on close -> deserialize on reopen).
 *
 * The backend is forced to WASM via PCTX_SQLITE_BACKEND before the loader runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  getSqliteFactory,
  _setSqliteFactoryForTests,
  _resetSqliteBackendForTests,
} from '../../../src/core/db/sqlite-loader.js';
import { createWasmFactory } from '../../../src/core/db/wasm-sqlite.js';
import {
  openInMemoryDatabase,
  upsertRepo,
  listRepos,
  getRepo,
} from '../../../src/core/db/schema.js';
import type { RepoMetadata } from '../../../src/core/types.js';

const repoMeta = (id: string, rootPath: string): RepoMetadata => ({
  id,
  rootPath,
  symbolCount: 3,
  fileCount: 2,
  languages: ['typescript', 'vue'],
  indexedAt: 1_700_000_000_000,
  schemaVersion: 8,
  clonePath: null,
  tenantId: 'local',
});

let tmp: string;

beforeAll(async () => {
  // Force the WASM backend for this file only — via injection, not env, so it
  // can't leak into other test files sharing the worker's process.env.
  _setSqliteFactoryForTests(await createWasmFactory());
  tmp = mkdtempSync(join(tmpdir(), 'pctx-wasm-'));
});

afterAll(() => {
  _resetSqliteBackendForTests();
  rmSync(tmp, { recursive: true, force: true });
});

describe('WASM SQLite backend selection', () => {
  it('selects the wasm backend when forced', () => {
    expect(getSqliteFactory().backend).toBe('wasm');
  });
});

describe('WASM adapter — schema, named params, get/all', () => {
  it('runs the real DDL (incl. FTS5) and round-trips repos via named params', () => {
    const db = openInMemoryDatabase();
    try {
      upsertRepo(db, repoMeta('repo_a', '/projects/a'));
      upsertRepo(db, repoMeta('repo_b', '/projects/b'));

      // get() with positional param
      const a = getRepo(db, 'repo_a');
      expect(a?.rootPath).toBe('/projects/a');
      expect(a?.languages).toEqual(['typescript', 'vue']);

      // all() returns both
      const repos = listRepos(db);
      expect(repos.map((r) => r.id).sort()).toEqual(['repo_a', 'repo_b']);
    } finally {
      db.close();
    }
  });

  it('supports FTS5 MATCH queries', () => {
    const db = openInMemoryDatabase();
    try {
      const ins = db.prepare(
        'INSERT INTO fts_symbols(symbol_id, repo_id, content) VALUES (@sid, @rid, @content)',
      );
      ins.run({ sid: 's1', rid: 'r1', content: 'blast radius traversal graph' });
      ins.run({ sid: 's2', rid: 'r1', content: 'unrelated helper function' });

      const hits = db
        .prepare("SELECT symbol_id FROM fts_symbols WHERE fts_symbols MATCH ?")
        .all('blast') as Array<{ symbol_id: string }>;
      expect(hits.map((h) => h.symbol_id)).toEqual(['s1']);
    } finally {
      db.close();
    }
  });
});

describe('WASM adapter — transactions', () => {
  it('commits a transaction and reports changes', () => {
    const db = openInMemoryDatabase();
    try {
      const insert = db.prepare(
        'INSERT INTO fts_symbols(symbol_id, repo_id, content) VALUES (?, ?, ?)',
      );
      const insertMany = db.transaction((rows: Array<[string, string, string]>) => {
        for (const r of rows) insert.run(...r);
        return rows.length;
      });
      const n = insertMany([
        ['s1', 'r1', 'alpha'],
        ['s2', 'r1', 'beta'],
        ['s3', 'r1', 'gamma'],
      ]);
      expect(n).toBe(3);
      const count = db.prepare('SELECT COUNT(*) AS c FROM fts_symbols').get() as { c: number };
      expect(count.c).toBe(3);
    } finally {
      db.close();
    }
  });

  it('rolls back a failed transaction', () => {
    const db = openInMemoryDatabase();
    try {
      db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)').run();
      const tx = db.transaction(() => {
        db.prepare('INSERT INTO t(id, v) VALUES (1, ?)').run('ok');
        // Violates NOT NULL -> throws -> whole tx rolls back
        db.prepare('INSERT INTO t(id, v) VALUES (2, ?)').run(null);
      });
      expect(() => tx()).toThrow();
      const count = db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number };
      expect(count.c).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('WASM adapter — BLOB round-trip', () => {
  it('stores and returns a Buffer', () => {
    const db = openInMemoryDatabase();
    try {
      db.prepare('CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)').run();
      const payload = Buffer.from([0, 1, 2, 250, 255]);
      db.prepare('INSERT INTO blobs(id, data) VALUES (1, ?)').run(payload);
      const row = db.prepare('SELECT data FROM blobs WHERE id = 1').get() as { data: Buffer };
      expect(Buffer.isBuffer(row.data)).toBe(true);
      expect(Buffer.compare(row.data, payload)).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('WASM adapter — file persistence', () => {
  it('persists on close and reloads on reopen', () => {
    const file = join(tmp, 'persist.db');
    const factory = getSqliteFactory();

    const db1 = factory.open(file);
    db1.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)');
    db1.prepare('INSERT INTO kv(k, v) VALUES (@k, @v)').run({ k: 'hello', v: 'world' });
    db1.close(); // flushes export to disk

    const db2 = factory.open(file);
    try {
      const row = db2.prepare('SELECT v FROM kv WHERE k = ?').get('hello') as { v: string } | undefined;
      expect(row?.v).toBe('world');
    } finally {
      db2.close();
    }
  });
});
