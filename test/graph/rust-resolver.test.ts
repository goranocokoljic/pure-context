/**
 * Task 538 (Phase 87): Rust import resolver — the mod tree.
 *
 * Module map derived from file layout under src/ (mod.rs + file layouts),
 * `crate::`/`self::`/`super::` resolved against the source file's module
 * position, leaf items via a module-scoped symbol-table check, globs expand
 * to the module subtree, workspace crates resolve by Cargo.toml name, and
 * external crates (std, serde) produce no edge.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { createRustResolver, isRustSourceFile } from '../../src/graph/rust-resolver.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { upsertFile } from '../../src/core/db/file-store.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import type { SymbolRecord, SymbolKind } from '../../src/core/types.js';

const REPO = 'rstest01';
// Nonexistent root: no Cargo.toml anywhere → repo root is the fallback crate dir
const NO_CARGO_ROOT = join(tmpdir(), 'pc-rust-resolver-no-cargo-root');

function sym(name: string, filePath: string, kind: SymbolKind = 'class'): SymbolRecord {
  return {
    id: `${name}-${filePath}`.replace(/[^a-z0-9]/gi, '').slice(0, 16).padEnd(16, '0'),
    name,
    kind,
    filePath,
    startByte: 0,
    endByte: 10,
    signature: name,
    summary: '',
  };
}

function seedDb() {
  const db = openInMemoryDatabase();
  upsertRepo(db, {
    id: REPO,
    rootPath: '/tmp/rstest',
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

describe('isRustSourceFile', () => {
  it('accepts .rs, rejects others', () => {
    expect(isRustSourceFile('src/lib.rs')).toBe(true);
    expect(isRustSourceFile('src/Main.RS')).toBe(true);
    expect(isRustSourceFile('src/lib.ts')).toBe(false);
  });
});

describe('createRustResolver (single crate, no Cargo.toml → repo-root fallback)', () => {
  let db: ReturnType<typeof seedDb>;

  beforeEach(() => {
    db = seedDb();
    addFile(db, 'src/lib.rs');
    addFile(db, 'src/auth.rs');
    addFile(db, 'src/net/mod.rs');
    addFile(db, 'src/net/http.rs');
    addFile(db, 'src/net/tcp.rs');
    insertSymbols(db, REPO, [
      sym('Session', 'src/auth.rs'),
      sym('Request', 'src/net/http.rs'),
      sym('Config', 'src/lib.rs'),
    ]);
  });

  afterEach(() => {
    db.close();
  });

  it('resolves crate:: to a module file (file layout)', () => {
    const r = createRustResolver(db, REPO, NO_CARGO_ROOT);
    expect(r.resolve('crate::auth', 'src/lib.rs')).toEqual(['src/auth.rs']);
  });

  it('resolves both mod.rs and nested-file layouts', () => {
    const r = createRustResolver(db, REPO, NO_CARGO_ROOT);
    expect(r.resolve('crate::net', 'src/lib.rs')).toEqual(['src/net/mod.rs']);
    expect(r.resolve('crate::net::http', 'src/lib.rs')).toEqual(['src/net/http.rs']);
  });

  it('resolves a leaf item through the module-scoped symbol table', () => {
    const r = createRustResolver(db, REPO, NO_CARGO_ROOT);
    expect(r.resolve('crate::auth::Session', 'src/lib.rs')).toEqual(['src/auth.rs']);
    expect(r.resolve('crate::net::http::Request', 'src/lib.rs')).toEqual(['src/net/http.rs']);
  });

  it('falls back to the module file for an item the index does not know (inline mod / macro)', () => {
    const r = createRustResolver(db, REPO, NO_CARGO_ROOT);
    // `helpers` is an inline `mod helpers { … }` inside auth.rs — layout can't see it
    expect(r.resolve('crate::auth::helpers::hash', 'src/lib.rs')).toEqual(['src/auth.rs']);
  });

  it('resolves a crate-root item to the root file', () => {
    const r = createRustResolver(db, REPO, NO_CARGO_ROOT);
    expect(r.resolve('crate::Config', 'src/auth.rs')).toEqual(['src/lib.rs']);
  });

  it('resolves super:: relative to the source module', () => {
    const r = createRustResolver(db, REPO, NO_CARGO_ROOT);
    // from net::http, super:: is net
    expect(r.resolve('super::tcp', 'src/net/http.rs')).toEqual(['src/net/tcp.rs']);
    // from net (mod.rs), super:: is the crate root
    expect(r.resolve('super::auth', 'src/net/mod.rs')).toEqual(['src/auth.rs']);
  });

  it('resolves chained super::super::', () => {
    const r = createRustResolver(db, REPO, NO_CARGO_ROOT);
    expect(r.resolve('super::super::auth::Session', 'src/net/http.rs')).toEqual(['src/auth.rs']);
  });

  it('resolves self:: relative to the source module', () => {
    const r = createRustResolver(db, REPO, NO_CARGO_ROOT);
    // src/net/mod.rs IS module net, so self::http is net::http
    expect(r.resolve('self::http', 'src/net/mod.rs')).toEqual(['src/net/http.rs']);
  });

  it('expands a glob to the module and everything under it', () => {
    const r = createRustResolver(db, REPO, NO_CARGO_ROOT);
    expect(r.resolve('crate::net', 'src/lib.rs', ['*']).sort()).toEqual([
      'src/net/http.rs',
      'src/net/mod.rs',
      'src/net/tcp.rs',
    ]);
  });

  it('resolves 2018 uniform paths (bare top-level module name)', () => {
    const r = createRustResolver(db, REPO, NO_CARGO_ROOT);
    expect(r.resolve('auth::Session', 'src/lib.rs')).toEqual(['src/auth.rs']);
  });

  it('drops external crates and std', () => {
    const r = createRustResolver(db, REPO, NO_CARGO_ROOT);
    expect(r.resolve('std::collections::HashMap', 'src/lib.rs')).toEqual([]);
    expect(r.resolve('serde::Deserialize', 'src/lib.rs')).toEqual([]);
    expect(r.resolve('tokio::spawn', 'src/lib.rs')).toEqual([]);
  });

  it('never emits a self-edge', () => {
    const r = createRustResolver(db, REPO, NO_CARGO_ROOT);
    expect(r.resolve('crate::auth', 'src/auth.rs')).toEqual([]);
    expect(r.resolve('self::http', 'src/net/http.rs')).toEqual([]);
  });
});

describe('createRustResolver (workspace: crate names from Cargo.toml)', () => {
  let db: ReturnType<typeof seedDb>;
  let root: string;

  beforeEach(() => {
    db = seedDb();
    root = mkdtempSync(join(tmpdir(), 'pc-rust-resolver-ws-'));
    const write = (rel: string, content: string) => {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    };
    write('Cargo.toml', '[workspace]\nmembers = ["crates/core", "crates/app"]\n');
    write(
      'crates/core/Cargo.toml',
      '[package]\nauthors = ["someone <x@y.z>"]\nname = "my-core"\nedition = "2021"\n',
    );
    write('crates/app/Cargo.toml', '[package]\nname = "my-app"\nedition = "2021"\n');
    addFile(db, 'crates/core/src/lib.rs');
    addFile(db, 'crates/core/src/util.rs');
    addFile(db, 'crates/app/src/main.rs');
    insertSymbols(db, REPO, [sym('helper', 'crates/core/src/util.rs', 'function')]);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves a sibling workspace crate by its dash→underscore name', () => {
    const r = createRustResolver(db, REPO, root);
    expect(r.resolve('my_core::util::helper', 'crates/app/src/main.rs')).toEqual([
      'crates/core/src/util.rs',
    ]);
  });

  it('crate:: stays inside the OWN crate (nearest Cargo.toml wins)', () => {
    const r = createRustResolver(db, REPO, root);
    // crate::util from the app crate must NOT jump into core
    expect(r.resolve('crate::util', 'crates/app/src/main.rs')).toEqual([]);
    expect(r.resolve('crate::util', 'crates/core/src/lib.rs')).toEqual(['crates/core/src/util.rs']);
  });

  it('an unknown crate name is external', () => {
    const r = createRustResolver(db, REPO, root);
    expect(r.resolve('rand::random', 'crates/app/src/main.rs')).toEqual([]);
  });
});
