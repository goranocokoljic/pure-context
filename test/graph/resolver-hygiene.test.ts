/**
 * Phase 98, Task 611 — resolver hygiene wave: foreign-directory boundary,
 * test-candidate drop, Haskell suffix guard, PHP vendor/autoload-dev,
 * Erlang closest include, Fortran intrinsics, shared library-path predicate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { createElixirResolver } from '../../src/graph/elixir-resolver.js';
import { createHaskellResolver } from '../../src/graph/haskell-resolver.js';
import { createPhpResolver } from '../../src/graph/php-resolver.js';
import { createErlangResolver } from '../../src/graph/erlang-resolver.js';
import { createFortranResolver } from '../../src/graph/fortran-resolver.js';
import { isForeignPath, dropForeignCandidates, isLibraryPath } from '../../src/core/library-paths.js';
import { isLibraryPath as rankerIsLibraryPath } from '../../src/core/search/relevance-ranker.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { upsertFile } from '../../src/core/db/file-store.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import type { SymbolRecord, SymbolKind } from '../../src/core/types.js';

const REPO = 'hygtest01';

function sym(name: string, filePath: string, kind: SymbolKind = 'class', signature = name): SymbolRecord {
  return {
    id: `${name}-${filePath}`.replace(/[^a-z0-9]/gi, '').slice(0, 16).padEnd(16, '0'),
    name, kind, filePath, startByte: 0, endByte: 10, signature, summary: name,
  };
}

function seedDb(root = '/tmp/hygtest') {
  const db = openInMemoryDatabase();
  upsertRepo(db, {
    id: REPO, rootPath: root, symbolCount: 0, fileCount: 0, languages: [],
    indexedAt: Date.now(), schemaVersion: SCHEMA_VERSION, clonePath: null, tenantId: 'local',
  });
  return db;
}
type Db = ReturnType<typeof seedDb>;
const addFile = (db: Db, path: string, ns: string | null = null) => upsertFile(db, REPO, path, 'hash', undefined, 'local', ns);

describe('library-paths (shared predicate)', () => {
  it('foreign = dependency / build-output segments; ranker list is re-exported unchanged', () => {
    expect(isForeignPath('deps/rabbit/src/x.erl')).toBe(true);
    expect(isForeignPath('vendor/pkg/a.php')).toBe(true);
    expect(isForeignPath('lib/_build/x.ex')).toBe(true);
    expect(isForeignPath('src/engine/x.cc')).toBe(false); // ranker-only segment
    expect(isLibraryPath('src/engine/x.cc')).toBe(true);
    expect(rankerIsLibraryPath('src/engine/x.cc')).toBe(true);
  });

  it('boundary rule: a foreign importer keeps foreign candidates (rabbitmq layout)', () => {
    expect(dropForeignCandidates(['deps/rabbit/src/a.erl', 'src/b.erl'], 'lib/app.erl')).toEqual(['src/b.erl']);
    expect(dropForeignCandidates(['deps/rabbit/src/a.erl'], 'deps/rabbit/src/z.erl')).toEqual(['deps/rabbit/src/a.erl']);
  });
});

describe('Elixir hygiene', () => {
  let db: Db;
  beforeEach(() => { db = seedDb(); });
  afterEach(() => { db.close(); });

  it('a Phoenix app never resolves into deps/ or test/support doubles; the prefix walk continues', () => {
    addFile(db, 'lib/my_app/repo.ex');
    addFile(db, 'test/support/repo_mock.ex');
    addFile(db, 'deps/ecto/lib/ecto/repo.ex');
    addFile(db, 'lib/my_app/web.ex');
    addFile(db, 'test/my_app/web_test.exs');
    insertSymbols(db, REPO, [
      sym('MyApp.Repo', 'lib/my_app/repo.ex'),
      sym('MyApp.Repo', 'test/support/repo_mock.ex'),
      sym('Ecto.Repo', 'deps/ecto/lib/ecto/repo.ex'),
      sym('Ecto.Repo.Queryable', 'deps/ecto/lib/ecto/repo.ex'),
    ], 'local');
    const r = createElixirResolver(db, REPO);
    expect(r.resolve('MyApp.Repo', 'lib/my_app/web.ex')).toEqual(['lib/my_app/repo.ex']);
    expect(r.resolve('Ecto.Repo.Queryable', 'lib/my_app/web.ex')).toEqual([]);
    // a test importer may still reach the double
    expect(r.resolve('MyApp.Repo', 'test/my_app/web_test.exs').sort()).toEqual(['lib/my_app/repo.ex', 'test/support/repo_mock.ex']);
  });
});

describe('Haskell hygiene', () => {
  let db: Db;
  beforeEach(() => { db = seedDb(); });
  afterEach(() => { db.close(); });

  it('a headerless Types.hs no longer answers `import Types` from anywhere; two-segment suffixes still do', () => {
    addFile(db, 'test/Mock/Types.hs');
    addFile(db, 'src/Data/Util.hs');
    addFile(db, 'src/Main.hs');
    const r = createHaskellResolver(db, REPO);
    expect(r.resolve('Types', 'src/Main.hs')).toEqual([]);
    expect(r.resolve('Data.Util', 'src/Main.hs')).toEqual(['src/Data/Util.hs']);
  });
});

describe('PHP hygiene', () => {
  let root: string; let db: Db;
  const write = (rel: string, content: string) => { const abs = join(root, rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content); };
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pc-php-hyg-')); db = seedDb(root); });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it('vendor composer.json never routes; autoload-dev serves test importers only', () => {
    write('composer.json', JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'src/' } }, 'autoload-dev': { 'psr-4': { 'Tests\\': 'tests/' } } }));
    write('vendor/acme/lib/composer.json', JSON.stringify({ autoload: { 'psr-4': { 'Acme\\': 'src/' } } }));
    addFile(db, 'src/Http/Kernel.php');
    addFile(db, 'tests/Support/Helper.php');
    addFile(db, 'vendor/acme/lib/src/Client.php');
    addFile(db, 'src/Boot.php');
    addFile(db, 'tests/BootTest.php');
    const r = createPhpResolver(db, REPO, root);
    expect(r.resolve('App\\Http\\Kernel', 'src/Boot.php')).toEqual(['src/Http/Kernel.php']);
    expect(r.resolve('Acme\\Client', 'src/Boot.php')).toEqual([]);
    expect(r.resolve('Tests\\Support\\Helper', 'src/Boot.php')).toEqual([]);
    expect(r.resolve('Tests\\Support\\Helper', 'tests/BootTest.php')).toEqual(['tests/Support/Helper.php']);
  });
});

describe('Erlang hygiene', () => {
  let db: Db;
  beforeEach(() => { db = seedDb(); });
  afterEach(() => { db.close(); });

  it('prefers the closest header on umbrella apps and drops test headers for production importers', () => {
    addFile(db, 'apps/a/include/defs.hrl');
    addFile(db, 'apps/b/include/defs.hrl');
    addFile(db, 'apps/a/src/worker.erl');
    addFile(db, 'test/defs.hrl');
    const r = createErlangResolver(db, REPO);
    expect(r.resolve('defs.hrl', 'apps/a/src/worker.erl')).toEqual(['apps/a/include/defs.hrl']);
  });

  it('a rabbitmq-style deps/ layout keeps resolving between its own components', () => {
    addFile(db, 'deps/rabbit/src/rabbit_channel.erl');
    addFile(db, 'deps/rabbit_common/src/rabbit_misc.erl');
    const r = createErlangResolver(db, REPO);
    expect(r.resolve('rabbit_misc:foo/1', 'deps/rabbit/src/rabbit_channel.erl')).toEqual(['deps/rabbit_common/src/rabbit_misc.erl']);
  });
});

describe('Fortran hygiene', () => {
  let db: Db;
  beforeEach(() => { db = seedDb(); });
  afterEach(() => { db.close(); });

  it('intrinsic modules are external even when a same-named shim is indexed', () => {
    addFile(db, 'src/shims/iso_c_binding.f90');
    addFile(db, 'src/main.f90');
    addFile(db, 'src/geom.f90');
    insertSymbols(db, REPO, [
      sym('iso_c_binding', 'src/shims/iso_c_binding.f90', 'class', 'MODULE iso_c_binding'),
      sym('geometry', 'src/geom.f90', 'class', 'MODULE geometry'),
    ], 'local');
    const r = createFortranResolver(db, REPO);
    expect(r.resolve('iso_c_binding', 'src/main.f90')).toEqual([]);
    expect(r.resolve('geometry', 'src/main.f90')).toEqual(['src/geom.f90']);
  });
});
