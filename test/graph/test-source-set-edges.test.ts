/**
 * Task 549 (Phase 89): production files get no edges into test source sets.
 *
 * Report Issue B: 28.6% of edges on the Android corpus pointed from
 * production source into src/test/ stubs. The dependency only exists in the
 * reverse direction.
 */
import { describe, it, expect } from 'vitest';
import { createJvmResolver } from '../../src/graph/jvm-resolver.js';
import { buildDiEdges } from '../../src/graph/di-edges.js';
import { isTestFilePath } from '../../src/core/test-paths.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { upsertFile } from '../../src/core/db/file-store.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import type { SymbolRecord, SymbolKind } from '../../src/core/types.js';

const REPO = 'testsettest';

function sym(
  name: string,
  filePath: string,
  kind: SymbolKind = 'class',
  frameworkMeta?: Record<string, unknown>,
): SymbolRecord {
  return {
    id: `${name}-${filePath}`.replace(/[^a-z0-9]/gi, '').slice(0, 16).padEnd(16, '0'),
    name,
    kind,
    filePath,
    startByte: 0,
    endByte: 10,
    signature: name,
    summary: name,
    ...(frameworkMeta ? { frameworkMeta } : {}),
  };
}

function seedDb() {
  const db = openInMemoryDatabase();
  upsertRepo(db, {
    id: REPO,
    rootPath: '/tmp/testsettest',
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

function addFile(db: ReturnType<typeof seedDb>, path: string, pkg: string | null) {
  upsertFile(db, REPO, path, 'hash', undefined, 'local', pkg);
}

describe('isTestFilePath — shared predicate', () => {
  it('covers the Gradle source sets from the report', () => {
    expect(isTestFilePath('lib/src/test/java/com/app/Stub.java')).toBe(true);
    expect(isTestFilePath('app/src/androidTest/kotlin/com/app/UiTest.kt')).toBe(true);
    expect(isTestFilePath('lib/src/testFixtures/kotlin/com/app/Fixture.kt')).toBe(true);
  });

  it('covers the .NET sibling test-project convention', () => {
    expect(isTestFilePath('src/Foo.Tests/BarTests.cs')).toBe(true);
    expect(isTestFilePath('src/Foo.Test/BarTests.cs')).toBe(true);
    expect(isTestFilePath('src/Foo/Bar.cs')).toBe(false);
  });

  it('keeps the conventions of the five retired private copies', () => {
    expect(isTestFilePath('src/__tests__/thing.js')).toBe(true);
    expect(isTestFilePath('src/core/index.test.ts')).toBe(true);
    expect(isTestFilePath('pkg/store_test.go')).toBe(true);
    expect(isTestFilePath('app/test_models.py')).toBe(true);
    expect(isTestFilePath('src/main/kotlin/com/app/Main.kt')).toBe(false);
    // "attest"/"contest" style segments must not match.
    expect(isTestFilePath('src/contest/Ranking.kt')).toBe(false);
  });
});

describe('jvm resolver — production never edges into test source sets', () => {
  /** Same package declared by a main file and a test stub. */
  function seedMixedRepo() {
    const db = seedDb();
    addFile(db, 'app/src/main/kotlin/com/app/Main.kt', 'com.app');
    addFile(db, 'core/src/main/kotlin/com/core/Service.kt', 'com.core');
    addFile(db, 'core/src/test/kotlin/com/core/Service.kt', 'com.core');
    addFile(db, 'core/src/test/kotlin/com/core/OnlyInTest.kt', 'com.core');
    insertSymbols(db, REPO, [
      sym('Service', 'core/src/main/kotlin/com/core/Service.kt'),
      sym('Service', 'core/src/test/kotlin/com/core/Service.kt'),
      sym('OnlyInTest', 'core/src/test/kotlin/com/core/OnlyInTest.kt'),
    ]);
    return db;
  }

  it('a main importer resolves only to the main candidate', () => {
    const db = seedMixedRepo();
    const r = createJvmResolver(db, REPO, '/tmp/testsettest');
    expect(r.resolve('com.core.Service', 'app/src/main/kotlin/com/app/Main.kt')).toEqual([
      'core/src/main/kotlin/com/core/Service.kt',
    ]);
    db.close();
  });

  it('a main importer of a test-only symbol gets NO edge (stub, not dependency)', () => {
    const db = seedMixedRepo();
    const r = createJvmResolver(db, REPO, '/tmp/testsettest');
    expect(r.resolve('com.core.OnlyInTest', 'app/src/main/kotlin/com/app/Main.kt')).toEqual([]);
    db.close();
  });

  it('a TEST importer may still resolve into test source sets', () => {
    const db = seedMixedRepo();
    const r = createJvmResolver(db, REPO, '/tmp/testsettest');
    const hits = r.resolve('com.core.OnlyInTest', 'core/src/test/kotlin/com/core/ATest.kt');
    expect(hits).toEqual(['core/src/test/kotlin/com/core/OnlyInTest.kt']);
    db.close();
  });

  it('a wildcard import from main excludes test files from the fanout', () => {
    const db = seedMixedRepo();
    const r = createJvmResolver(db, REPO, '/tmp/testsettest');
    const hits = r.resolve('com.core', 'app/src/main/kotlin/com/app/Main.kt');
    expect(hits).toEqual(['core/src/main/kotlin/com/core/Service.kt']);
    db.close();
  });
});

describe('di edges — production consumer never depends on a test-double provider', () => {
  it('drops the @TestInstallIn fake, keeps the real module', () => {
    const db = seedDb();
    addFile(db, 'app/src/main/kotlin/com/app/RepoModule.kt', 'com.app');
    addFile(db, 'app/src/test/kotlin/com/app/FakeRepoModule.kt', 'com.app');
    addFile(db, 'app/src/main/kotlin/com/app/ViewModel.kt', 'com.app');
    insertSymbols(db, REPO, [
      sym('RepoModule', 'app/src/main/kotlin/com/app/RepoModule.kt', 'class', {
        di: { role: 'provider', providedType: 'UserRepository' },
      }),
      sym('FakeRepoModule', 'app/src/test/kotlin/com/app/FakeRepoModule.kt', 'class', {
        di: { role: 'provider', providedType: 'UserRepository' },
      }),
      sym('MyViewModel', 'app/src/main/kotlin/com/app/ViewModel.kt', 'class', {
        di: { role: 'consumer', injectConstructor: true, consumedTypes: ['UserRepository'] },
      }),
    ]);
    const edges = buildDiEdges(db, REPO);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.targetFile).toBe('app/src/main/kotlin/com/app/RepoModule.kt');
    db.close();
  });

  it('a TEST consumer may depend on the fake', () => {
    const db = seedDb();
    addFile(db, 'app/src/test/kotlin/com/app/FakeRepoModule.kt', 'com.app');
    addFile(db, 'app/src/test/kotlin/com/app/RepoTest.kt', 'com.app');
    insertSymbols(db, REPO, [
      sym('FakeRepoModule', 'app/src/test/kotlin/com/app/FakeRepoModule.kt', 'class', {
        di: { role: 'provider', providedType: 'UserRepository' },
      }),
      sym('RepoTest', 'app/src/test/kotlin/com/app/RepoTest.kt', 'class', {
        di: { role: 'consumer', injectConstructor: true, consumedTypes: ['UserRepository'] },
      }),
    ]);
    const edges = buildDiEdges(db, REPO);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.targetFile).toBe('app/src/test/kotlin/com/app/FakeRepoModule.kt');
    db.close();
  });
});
