/**
 * Task 539 (Phase 87): Rust dependency edges, end to end.
 *
 * Authors a real Cargo workspace (root crate + one sibling crate), runs the
 * full indexFolder pipeline once, and asserts `use` declarations become
 * dependency edges — crate::, self::, super::, glob, and workspace-crate-name
 * forms — plus blast radius and the Phase 87 visibility indexing, through the
 * worker path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { rustHandler } from '../../src/handlers/rust.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { getBlastRadius } from '../../src/graph/graph-traversal.js';

let root: string;
let repoId: string;

function write(relPath: string, content: string) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** dep_edges targets for a source file, path-normalized to forward slashes. */
function edgesFrom(sourceSuffix: string): string[] {
  const db = openDatabase(repoId);
  const rows = db
    .prepare<[string], { source_file: string; target_file: string }>(
      'SELECT source_file, target_file FROM dep_edges WHERE repo_id = ?',
    )
    .all(repoId);
  db.close();
  return rows
    .filter((r) => r.source_file.replace(/\\/g, '/').endsWith(sourceSuffix))
    .map((r) => r.target_file.replace(/\\/g, '/'))
    .sort();
}

beforeAll(async () => {
  _resetForTesting();
  registerHandler(rustHandler);
  await initParser();

  root = resolve(mkdtempSync(join(tmpdir(), 'pc-rust-e2e-')));

  write('Cargo.toml', '[package]\nname = "main-app"\nedition = "2021"\n');
  write(
    'src/lib.rs',
    [
      'mod auth;',
      'mod net;',
      'mod prelude;',
      '',
      'use crate::auth::Session;',
      'use util_crate::helper;',
      '',
      '/// Root config.',
      'pub struct Config { pub session: Session }',
      '',
      'pub fn boot() -> u32 { helper() }',
      '',
    ].join('\n'),
  );
  write(
    'src/auth.rs',
    [
      'use crate::prelude::*;',
      '',
      '/// A login session.',
      'pub struct Session { pub token: String }',
      '',
      'fn secret_helper() -> bool { true }',
      '',
    ].join('\n'),
  );
  write(
    'src/prelude.rs',
    'pub const VERSION: u32 = 1;\n',
  );
  write(
    'src/net/mod.rs',
    [
      'mod http;',
      '',
      'use crate::auth::Session;',
      'use self::http::Request;',
      '',
      'pub fn serve(_s: Session, _r: Request) {}',
      '',
    ].join('\n'),
  );
  write(
    'src/net/http.rs',
    [
      'use super::super::auth::Session;',
      '',
      'pub struct Request { pub session: Session }',
      '',
    ].join('\n'),
  );

  // Sibling workspace crate, imported by name (dash→underscore)
  write('libs/util_crate/Cargo.toml', '[package]\nname = "util-crate"\nedition = "2021"\n');
  write('libs/util_crate/src/lib.rs', 'pub fn helper() -> u32 { 42 }\n');

  const result = await indexFolder(root, { fileLimit: 100 });
  repoId = result.repoId;
}, 120_000);

afterAll(() => {
  if (repoId) deleteIndex(repoId);
  rmSync(root, { recursive: true, force: true });
});

describe('Rust dependency edges end to end (Task 539)', () => {
  it('the crate no longer indexes to zero dependency edges', () => {
    const db = openDatabase(repoId);
    const row = db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM dep_edges WHERE repo_id = ?')
      .get(repoId);
    db.close();
    expect(row!.n).toBeGreaterThanOrEqual(5);
  });

  it('crate:: and workspace-crate-name imports resolve from the root file', () => {
    expect(edgesFrom('src/lib.rs')).toEqual(['libs/util_crate/src/lib.rs', 'src/auth.rs']);
  });

  it('self:: and crate:: imports resolve from mod.rs', () => {
    expect(edgesFrom('src/net/mod.rs')).toEqual(['src/auth.rs', 'src/net/http.rs']);
  });

  it('chained super::super:: resolves to the crate-root sibling module', () => {
    expect(edgesFrom('src/net/http.rs')).toEqual(['src/auth.rs']);
  });

  it('a glob import resolves to the target module file', () => {
    expect(edgesFrom('src/auth.rs')).toEqual(['src/prelude.rs']);
  });

  it('blast radius of a used symbol reaches its importers', () => {
    const db = openDatabase(repoId);
    const sym = db
      .prepare<[string, string], { id: string }>(
        'SELECT id FROM symbols WHERE repo_id = ? AND name = ?',
      )
      .get(repoId, 'Session');
    expect(sym).toBeDefined();
    const radius = getBlastRadius(sym!.id, repoId, db, 3);
    db.close();
    const files = radius.files.map((f) => f.replace(/\\/g, '/'));
    expect(files).toContain('src/lib.rs');
    expect(files).toContain('src/net/mod.rs');
    expect(files).toContain('src/net/http.rs');
  });

  it('module-private items are indexed with visibility metadata (worker path)', () => {
    const db = openDatabase(repoId);
    const row = db
      .prepare<[string, string], { framework_meta: string | null }>(
        'SELECT framework_meta FROM symbols WHERE repo_id = ? AND name = ?',
      )
      .get(repoId, 'secret_helper');
    db.close();
    expect(row).toBeDefined();
    const meta = row!.framework_meta ? JSON.parse(row!.framework_meta) : {};
    expect(meta.visibility).toBe('module');
  });
});
