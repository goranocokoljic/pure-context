/**
 * Task 533 (Phase 86): Elixir import resolver.
 *
 * Module-name → file map built from module-kind SYMBOLS (multiple defmodule
 * per file are legal), exact match first, longest known module prefix as the
 * nested-module fallback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElixirResolver, isElixirSourceFile } from '../../src/graph/elixir-resolver.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { upsertFile } from '../../src/core/db/file-store.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import type { SymbolRecord, SymbolKind } from '../../src/core/types.js';

const REPO = 'extest01';

function sym(name: string, filePath: string, kind: SymbolKind = 'class'): SymbolRecord {
  return {
    id: `${name}-${filePath}`.replace(/[^a-z0-9]/gi, '').slice(0, 16).padEnd(16, '0'),
    name,
    kind,
    filePath,
    startByte: 0,
    endByte: 10,
    signature: name,
    summary: name,
  };
}

function seedDb() {
  const db = openInMemoryDatabase();
  upsertRepo(db, {
    id: REPO,
    rootPath: '/tmp/extest',
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

describe('isElixirSourceFile', () => {
  it('accepts .ex and .exs, rejects others', () => {
    expect(isElixirSourceFile('lib/app/accounts.ex')).toBe(true);
    expect(isElixirSourceFile('test/app_test.exs')).toBe(true);
    expect(isElixirSourceFile('lib/app.erl')).toBe(false);
  });
});

describe('createElixirResolver', () => {
  let db: ReturnType<typeof seedDb>;

  beforeEach(() => {
    db = seedDb();
  });

  afterEach(() => {
    db.close();
  });

  it('resolves an alias by exact module symbol name', () => {
    addFile(db, 'lib/app/accounts.ex');
    addFile(db, 'lib/app_web/user_controller.ex');
    insertSymbols(db, REPO, [sym('App.Accounts', 'lib/app/accounts.ex')]);
    const r = createElixirResolver(db, REPO);
    expect(r.resolve('App.Accounts', 'lib/app_web/user_controller.ex')).toEqual([
      'lib/app/accounts.ex',
    ]);
  });

  it('falls back to the longest known module prefix for nested modules', () => {
    addFile(db, 'lib/app/accounts.ex');
    addFile(db, 'lib/app_web/user_controller.ex');
    insertSymbols(db, REPO, [sym('App.Accounts', 'lib/app/accounts.ex')]);
    const r = createElixirResolver(db, REPO);
    // App.Accounts.User has no symbol of its own — its parent module's file wins
    expect(r.resolve('App.Accounts.User', 'lib/app_web/user_controller.ex')).toEqual([
      'lib/app/accounts.ex',
    ]);
  });

  it('handles multiple defmodule per file', () => {
    addFile(db, 'lib/app/schemas.ex');
    addFile(db, 'lib/app/context.ex');
    insertSymbols(db, REPO, [
      sym('App.User', 'lib/app/schemas.ex'),
      sym('App.Order', 'lib/app/schemas.ex'),
    ]);
    const r = createElixirResolver(db, REPO);
    expect(r.resolve('App.User', 'lib/app/context.ex')).toEqual(['lib/app/schemas.ex']);
    expect(r.resolve('App.Order', 'lib/app/context.ex')).toEqual(['lib/app/schemas.ex']);
  });

  it('resolves defprotocol modules (kind interface)', () => {
    addFile(db, 'lib/app/size.ex');
    addFile(db, 'lib/app/context.ex');
    insertSymbols(db, REPO, [sym('App.Size', 'lib/app/size.ex', 'interface')]);
    const r = createElixirResolver(db, REPO);
    expect(r.resolve('App.Size', 'lib/app/context.ex')).toEqual(['lib/app/size.ex']);
  });

  it('drops external modules (Ecto, Phoenix, stdlib)', () => {
    addFile(db, 'lib/app/context.ex');
    insertSymbols(db, REPO, [sym('App.Context', 'lib/app/context.ex')]);
    const r = createElixirResolver(db, REPO);
    expect(r.resolve('Ecto.Changeset', 'lib/app/context.ex')).toEqual([]);
    expect(r.resolve('Enum', 'lib/app/context.ex')).toEqual([]);
  });

  it('never emits a self-edge (and does not fall through to a wrong prefix)', () => {
    addFile(db, 'lib/app/accounts.ex');
    insertSymbols(db, REPO, [sym('App.Accounts', 'lib/app/accounts.ex')]);
    const r = createElixirResolver(db, REPO);
    expect(r.resolve('App.Accounts', 'lib/app/accounts.ex')).toEqual([]);
  });
});
