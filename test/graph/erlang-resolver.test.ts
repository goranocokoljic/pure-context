/**
 * Task 534 (Phase 86): Erlang import resolver.
 *
 * Module == file basename (`rabbit_channel` → `rabbit_channel.erl`), so
 * resolution is a basename lookup. Header includes resolve by .hrl basename.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createErlangResolver, isErlangSourceFile } from '../../src/graph/erlang-resolver.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { upsertFile } from '../../src/core/db/file-store.js';

const REPO = 'erltest01';

function seedDb() {
  const db = openInMemoryDatabase();
  upsertRepo(db, {
    id: REPO,
    rootPath: '/tmp/erltest',
    symbolCount: 0,
    fileCount: 0,
    languages: [],
    indexedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
    clonePath: null,
    tenantId: 'local',
  });
  return db;
}

function addFile(db: ReturnType<typeof seedDb>, path: string) {
  upsertFile(db, REPO, path, 'hash', undefined, 'local');
}

describe('isErlangSourceFile', () => {
  it('accepts .erl and .hrl, rejects others', () => {
    expect(isErlangSourceFile('src/rabbit_channel.erl')).toBe(true);
    expect(isErlangSourceFile('include/records.hrl')).toBe(true);
    expect(isErlangSourceFile('src/app.ex')).toBe(false);
  });
});

describe('createErlangResolver', () => {
  let db: ReturnType<typeof seedDb>;

  beforeEach(() => {
    db = seedDb();
  });

  afterEach(() => {
    db.close();
  });

  it('resolves a module:fun specifier by module basename', () => {
    addFile(db, 'src/rabbit_channel.erl');
    addFile(db, 'src/rabbit_reader.erl');
    const r = createErlangResolver(db, REPO);
    expect(r.resolve('rabbit_channel:start_link/3', 'src/rabbit_reader.erl')).toEqual([
      'src/rabbit_channel.erl',
    ]);
  });

  it('resolves an -include header by .hrl basename', () => {
    addFile(db, 'include/records.hrl');
    addFile(db, 'src/worker.erl');
    const r = createErlangResolver(db, REPO);
    expect(r.resolve('records.hrl', 'src/worker.erl')).toEqual(['include/records.hrl']);
  });

  it('resolves an -include_lib path literal by basename', () => {
    addFile(db, 'apps/myapp/include/defs.hrl');
    addFile(db, 'apps/other/src/user.erl');
    const r = createErlangResolver(db, REPO);
    expect(r.resolve('myapp/include/defs.hrl', 'apps/other/src/user.erl')).toEqual([
      'apps/myapp/include/defs.hrl',
    ]);
  });

  it('a basename collision across dirs yields ALL candidates (Phase 82 rule)', () => {
    addFile(db, 'apps/a/src/util.erl');
    addFile(db, 'apps/b/src/util.erl');
    addFile(db, 'apps/a/src/main.erl');
    const r = createErlangResolver(db, REPO);
    expect(r.resolve('util:go/0', 'apps/a/src/main.erl').sort()).toEqual([
      'apps/a/src/util.erl',
      'apps/b/src/util.erl',
    ]);
  });

  it('drops OTP stdlib and dependency modules', () => {
    addFile(db, 'src/main.erl');
    const r = createErlangResolver(db, REPO);
    expect(r.resolve('lists:map/2', 'src/main.erl')).toEqual([]);
    expect(r.resolve('gen_server:call/2', 'src/main.erl')).toEqual([]);
  });

  it('never emits a self-edge', () => {
    addFile(db, 'src/util.erl');
    const r = createErlangResolver(db, REPO);
    expect(r.resolve('util:go/0', 'src/util.erl')).toEqual([]);
  });
});
