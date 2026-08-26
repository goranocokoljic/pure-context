/**
 * Task 532 (Phase 86): Haskell import resolver.
 *
 * Exact declared-module → file lookup (one module per file), with a dotted
 * path-suffix fallback for files without a module header row.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHaskellResolver, isHaskellSourceFile } from '../../src/graph/haskell-resolver.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { upsertFile } from '../../src/core/db/file-store.js';

const REPO = 'hstest01';

function seedDb() {
  const db = openInMemoryDatabase();
  upsertRepo(db, {
    id: REPO,
    rootPath: '/tmp/hstest',
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

function addFile(db: ReturnType<typeof seedDb>, path: string, mod: string | null = null) {
  upsertFile(db, REPO, path, 'hash', undefined, 'local', mod);
}

describe('isHaskellSourceFile', () => {
  it('accepts .hs and .lhs, rejects others', () => {
    expect(isHaskellSourceFile('src/Data/Util.hs')).toBe(true);
    expect(isHaskellSourceFile('doc/Tutorial.lhs')).toBe(true);
    expect(isHaskellSourceFile('src/util.rs')).toBe(false);
  });
});

describe('createHaskellResolver', () => {
  let db: ReturnType<typeof seedDb>;

  beforeEach(() => {
    db = seedDb();
  });

  afterEach(() => {
    db.close();
  });

  it('resolves an import by exact declared module name', () => {
    addFile(db, 'src/Data/Util.hs', 'Data.Util');
    addFile(db, 'app/Main.hs', 'Main');
    const r = createHaskellResolver(db, REPO);
    expect(r.resolve('Data.Util', 'app/Main.hs')).toEqual(['src/Data/Util.hs']);
  });

  it('the declared name wins over the path (module ≠ directory layout)', () => {
    // File lives under lib/ but declares an unrelated hierarchical name
    addFile(db, 'lib/impl/Guts.hs', 'App.Internal.Guts');
    addFile(db, 'app/Main.hs', 'Main');
    const r = createHaskellResolver(db, REPO);
    expect(r.resolve('App.Internal.Guts', 'app/Main.hs')).toEqual(['lib/impl/Guts.hs']);
  });

  it('falls back to a dotted path suffix for headerless files (src/ layout)', () => {
    addFile(db, 'src/App/Core/Run.hs', null);
    addFile(db, 'app/Main.hs', 'Main');
    const r = createHaskellResolver(db, REPO);
    expect(r.resolve('App.Core.Run', 'app/Main.hs')).toEqual(['src/App/Core/Run.hs']);
  });

  it('drops external modules (base, package dependencies)', () => {
    addFile(db, 'app/Main.hs', 'Main');
    const r = createHaskellResolver(db, REPO);
    expect(r.resolve('Data.Map.Strict', 'app/Main.hs')).toEqual([]);
    expect(r.resolve('Control.Monad', 'app/Main.hs')).toEqual([]);
  });

  it('never emits a self-edge', () => {
    addFile(db, 'src/App.hs', 'App');
    const r = createHaskellResolver(db, REPO);
    expect(r.resolve('App', 'src/App.hs')).toEqual([]);
  });
});
