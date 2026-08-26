/**
 * Task 531 (Phase 86): PHP import resolver.
 *
 * Seeds an in-memory DB with .php files (declared namespaces + qualified
 * symbols) and real composer.json files on disk, and asserts `use` specifiers
 * resolve to repo files — declared-namespace map first, PSR-4 fallback for
 * files without a namespace row, external namespaces dropped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { createPhpResolver, isPhpSourceFile } from '../../src/graph/php-resolver.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { upsertFile } from '../../src/core/db/file-store.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import type { SymbolRecord, SymbolKind } from '../../src/core/types.js';

const REPO = 'phptest01';

let root: string;

function write(relPath: string, content: string) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

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

function addFile(db: ReturnType<typeof seedDb>, path: string, ns: string | null = null) {
  upsertFile(db, REPO, path, 'hash', undefined, 'local', ns);
}

describe('isPhpSourceFile', () => {
  it('accepts .php and rejects others', () => {
    expect(isPhpSourceFile('app/Models/User.php')).toBe(true);
    expect(isPhpSourceFile('app/Models/User.PHP')).toBe(true);
    expect(isPhpSourceFile('app/user.py')).toBe(false);
    expect(isPhpSourceFile('composer.json')).toBe(false);
  });
});

describe('createPhpResolver', () => {
  let db: ReturnType<typeof seedDb>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pc-php-resolver-'));
    db = seedDb();
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves via the declared namespace + file basename', () => {
    addFile(db, 'app/Http/Controllers/UserController.php', 'App\\Http\\Controllers');
    addFile(db, 'routes/web.php', null);
    const r = createPhpResolver(db, REPO, root);
    expect(r.resolve('App\\Http\\Controllers\\UserController', 'routes/web.php')).toEqual([
      'app/Http/Controllers/UserController.php',
    ]);
  });

  it('resolves via the fully-qualified symbol name when the basename differs', () => {
    addFile(db, 'src/Support/helpers.php', 'App\\Support');
    addFile(db, 'src/Kernel.php', 'App');
    insertSymbols(db, REPO, [sym('App\\Support\\ArrHelper', 'src/Support/helpers.php')]);
    const r = createPhpResolver(db, REPO, root);
    expect(r.resolve('App\\Support\\ArrHelper', 'src/Kernel.php')).toEqual([
      'src/Support/helpers.php',
    ]);
  });

  it('falls back to the composer.json PSR-4 map for files without a namespace row', () => {
    write(
      'composer.json',
      JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'src/' } } }),
    );
    // No declared namespace stored (e.g. pre-index rows)
    addFile(db, 'src/Billing/Invoice.php', null);
    addFile(db, 'public/index.php', null);
    const r = createPhpResolver(db, REPO, root);
    expect(r.resolve('App\\Billing\\Invoice', 'public/index.php')).toEqual([
      'src/Billing/Invoice.php',
    ]);
  });

  it('reads autoload-dev PSR-4 entries and nested composer.json files', () => {
    write(
      'packages/billing/composer.json',
      JSON.stringify({ 'autoload-dev': { 'psr-4': { 'Billing\\Tests\\': 'tests/' } } }),
    );
    addFile(db, 'packages/billing/tests/InvoiceTest.php', null);
    addFile(db, 'packages/billing/src/Invoice.php', null);
    const r = createPhpResolver(db, REPO, root);
    expect(
      r.resolve('Billing\\Tests\\InvoiceTest', 'packages/billing/src/Invoice.php'),
    ).toEqual(['packages/billing/tests/InvoiceTest.php']);
  });

  it('resolves a whole-namespace use to all namespace files', () => {
    addFile(db, 'app/Models/User.php', 'App\\Models');
    addFile(db, 'app/Models/Order.php', 'App\\Models');
    addFile(db, 'app/Kernel.php', 'App');
    const r = createPhpResolver(db, REPO, root);
    expect(r.resolve('App\\Models', 'app/Kernel.php').sort()).toEqual([
      'app/Models/Order.php',
      'app/Models/User.php',
    ]);
  });

  it('prefers candidates in the importing file\'s own composer root on ambiguity', () => {
    write('pkg-a/composer.json', JSON.stringify({ name: 'a' }));
    write('pkg-b/composer.json', JSON.stringify({ name: 'b' }));
    addFile(db, 'pkg-a/src/Logger.php', 'Shared');
    addFile(db, 'pkg-b/src/Logger.php', 'Shared');
    addFile(db, 'pkg-a/src/App.php', 'Shared');
    const r = createPhpResolver(db, REPO, root);
    expect(r.resolve('Shared\\Logger', 'pkg-a/src/App.php')).toEqual(['pkg-a/src/Logger.php']);
  });

  it('drops external namespaces (Symfony, PHP built-ins)', () => {
    addFile(db, 'app/Kernel.php', 'App');
    const r = createPhpResolver(db, REPO, root);
    expect(r.resolve('Symfony\\Component\\HttpFoundation\\Response', 'app/Kernel.php')).toEqual([]);
    expect(r.resolve('DateTimeImmutable', 'app/Kernel.php')).toEqual([]);
  });

  it('never emits a self-edge', () => {
    addFile(db, 'app/Models/User.php', 'App\\Models');
    const r = createPhpResolver(db, REPO, root);
    expect(r.resolve('App\\Models\\User', 'app/Models/User.php')).toEqual([]);
  });
});
