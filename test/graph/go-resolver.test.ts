/**
 * Task 518 (Phase 84): Go import resolver.
 *
 * Seeds an in-memory DB with .go files and real go.mod files on disk, and
 * asserts module-path specifiers resolve to every file of the target package
 * directory (the true Go package semantic).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { createGoResolver, isGoSourceFile } from '../../src/graph/go-resolver.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { upsertFile } from '../../src/core/db/file-store.js';

const REPO = 'gotest01';

let root: string;

function write(relPath: string, content: string) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function seedDb() {
  const db = openInMemoryDatabase();
  upsertRepo(db, {
    id: REPO,
    rootPath: root,
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

describe('isGoSourceFile', () => {
  it('accepts .go and rejects others', () => {
    expect(isGoSourceFile('a/b.go')).toBe(true);
    expect(isGoSourceFile('a/b_test.go')).toBe(true);
    expect(isGoSourceFile('a/b.py')).toBe(false);
    expect(isGoSourceFile('go.mod')).toBe(false);
  });
});

describe('createGoResolver', () => {
  let db: ReturnType<typeof seedDb>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pc-go-resolver-'));
    db = seedDb();
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves an import to every file of the target package directory', () => {
    write('go.mod', 'module github.com/acme/app\n\ngo 1.22\n');
    addFile(db, 'main.go');
    addFile(db, 'internal/store/store.go');
    addFile(db, 'internal/store/query.go');
    const r = createGoResolver(db, REPO, root);
    expect(r.resolve('github.com/acme/app/internal/store', 'main.go').sort()).toEqual([
      'internal/store/query.go',
      'internal/store/store.go',
    ]);
  });

  it('includes _test.go files of the target package', () => {
    write('go.mod', 'module github.com/acme/app\n');
    addFile(db, 'main.go');
    addFile(db, 'util/util.go');
    addFile(db, 'util/util_test.go');
    const r = createGoResolver(db, REPO, root);
    expect(r.resolve('github.com/acme/app/util', 'main.go').sort()).toEqual([
      'util/util.go',
      'util/util_test.go',
    ]);
  });

  it('longest module prefix wins in a workspace (nested go.mod)', () => {
    write('go.mod', 'module github.com/acme/app\n');
    write('libs/auth/go.mod', 'module github.com/acme/auth\n');
    addFile(db, 'main.go');
    addFile(db, 'libs/auth/token/token.go');
    const r = createGoResolver(db, REPO, root);
    // resolves against the NESTED module's path, joined to its directory
    expect(r.resolve('github.com/acme/auth/token', 'main.go')).toEqual([
      'libs/auth/token/token.go',
    ]);
  });

  it('resolves an import of the module root package', () => {
    write('go.mod', 'module github.com/acme/app\n');
    addFile(db, 'app.go');
    addFile(db, 'cmd/cli/main.go');
    const r = createGoResolver(db, REPO, root);
    expect(r.resolve('github.com/acme/app', 'cmd/cli/main.go')).toEqual(['app.go']);
  });

  it('handles a /v2 module path suffix', () => {
    write('go.mod', 'module github.com/acme/app/v2\n');
    addFile(db, 'main.go');
    addFile(db, 'pkg/core/core.go');
    const r = createGoResolver(db, REPO, root);
    expect(r.resolve('github.com/acme/app/v2/pkg/core', 'main.go')).toEqual([
      'pkg/core/core.go',
    ]);
  });

  it('drops stdlib and external imports', () => {
    write('go.mod', 'module github.com/acme/app\n');
    addFile(db, 'main.go');
    addFile(db, 'util/util.go');
    const r = createGoResolver(db, REPO, root);
    expect(r.resolve('fmt', 'main.go')).toEqual([]);
    expect(r.resolve('net/http', 'main.go')).toEqual([]);
    expect(r.resolve('github.com/other/dep/pkg', 'main.go')).toEqual([]);
  });

  it('never emits edges into vendor/', () => {
    write('go.mod', 'module github.com/acme/app\n');
    addFile(db, 'main.go');
    addFile(db, 'vendor/github.com/acme/app/util/util.go');
    const r = createGoResolver(db, REPO, root);
    expect(r.resolve('github.com/acme/app/util', 'main.go')).toEqual([]);
  });

  it('never emits a self-edge', () => {
    write('go.mod', 'module github.com/acme/app\n');
    addFile(db, 'util/a.go');
    addFile(db, 'util/b.go');
    const r = createGoResolver(db, REPO, root);
    expect(r.resolve('github.com/acme/app/util', 'util/a.go')).toEqual(['util/b.go']);
  });
});
