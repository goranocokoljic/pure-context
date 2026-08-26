/**
 * Task 548 (Phase 89): reserved namespaces never resolve locally.
 *
 * The 1.18.0 report's Issue A: vendored AOSP shims and per-module unit-test
 * stubs declare `package android.util` (standard Android practice), so
 * `import android.util.Log` — present in most Android files — resolved to
 * every stub at once. Reserved namespaces are external by definition.
 */
import { describe, it, expect } from 'vitest';
import { createJvmResolver } from '../../src/graph/jvm-resolver.js';
import { buildDiEdges } from '../../src/graph/di-edges.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { upsertFile } from '../../src/core/db/file-store.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import { validateConfig } from '../../src/config/config-schema.js';
import type { SymbolRecord, SymbolKind } from '../../src/core/types.js';

const REPO = 'reservedtest';

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
    rootPath: '/tmp/reservedtest',
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

/** Repo with a real class plus an android.util.Log test stub. */
function seedShimRepo() {
  const db = seedDb();
  addFile(db, 'app/src/main/kotlin/com/app/Main.kt', 'com.app');
  addFile(db, 'lib/src/test/java/android/util/Log.java', 'android.util');
  addFile(db, 'app/src/main/kotlin/com/app/RealThing.kt', 'com.app');
  insertSymbols(db, REPO, [
    sym('Log', 'lib/src/test/java/android/util/Log.java'),
    sym('RealThing', 'app/src/main/kotlin/com/app/RealThing.kt'),
  ]);
  return db;
}

describe('reserved namespaces — jvm resolver (Issue A)', () => {
  it('an android.* import produces no edge even when a local stub declares the package', () => {
    const db = seedShimRepo();
    const r = createJvmResolver(db, REPO, '/tmp/reservedtest');
    expect(r.resolve('android.util.Log', 'app/src/main/kotlin/com/app/Main.kt')).toEqual([]);
    db.close();
  });

  it('a reserved wildcard/bare-package import produces no edge', () => {
    const db = seedShimRepo();
    const r = createJvmResolver(db, REPO, '/tmp/reservedtest');
    expect(r.resolve('android.util', 'app/src/main/kotlin/com/app/Main.kt')).toEqual([]);
    expect(r.resolve('android.util.*', 'app/src/main/kotlin/com/app/Main.kt')).toEqual([]);
    db.close();
  });

  it('the stub file is not reachable through the symbol-table fallback either', () => {
    const db = seedShimRepo();
    const r = createJvmResolver(db, REPO, '/tmp/reservedtest');
    // A non-reserved specifier ending in the stub's symbol name must not
    // land on the reserved-declaring file via basename/symbol matching.
    const hits = r.resolve('com.thirdparty.Log', 'app/src/main/kotlin/com/app/Main.kt');
    expect(hits).not.toContain('lib/src/test/java/android/util/Log.java');
    db.close();
  });

  it('non-reserved packages resolve exactly as before', () => {
    const db = seedShimRepo();
    const r = createJvmResolver(db, REPO, '/tmp/reservedtest');
    expect(r.resolve('com.app.RealThing', 'app/src/main/kotlin/com/app/Main.kt')).toEqual([
      'app/src/main/kotlin/com/app/RealThing.kt',
    ]);
    db.close();
  });

  it('opt-out (reservedNamespaces: []) restores local resolution for an AOSP-fork shim', () => {
    // The shim lives OUTSIDE any test source set here (the AOSP-fork case —
    // e.g. a vendored compat tree), so only the namespace rule is in play.
    const db = seedDb();
    addFile(db, 'app/src/main/kotlin/com/app/Main.kt', 'com.app');
    addFile(db, 'inputmethods/compat/android/util/Log.java', 'android.util');
    insertSymbols(db, REPO, [sym('Log', 'inputmethods/compat/android/util/Log.java')]);
    const r = createJvmResolver(db, REPO, '/tmp/reservedtest', { reservedNamespaces: [] });
    expect(r.resolve('android.util.Log', 'app/src/main/kotlin/com/app/Main.kt')).toEqual([
      'inputmethods/compat/android/util/Log.java',
    ]);
    db.close();
  });

  it('a prefix matches only whole segments (androidx ≠ android)', () => {
    const db = seedDb();
    addFile(db, 'lib/src/main/kotlin/com/app/A.kt', 'com.app');
    // "androide.custom" must NOT be caught by the "android" prefix.
    addFile(db, 'lib/src/main/kotlin/androide/custom/B.kt', 'androide.custom');
    insertSymbols(db, REPO, [sym('B', 'lib/src/main/kotlin/androide/custom/B.kt')]);
    const r = createJvmResolver(db, REPO, '/tmp/reservedtest');
    expect(r.resolve('androide.custom.B', 'lib/src/main/kotlin/com/app/A.kt')).toEqual([
      'lib/src/main/kotlin/androide/custom/B.kt',
    ]);
    db.close();
  });
});

describe('reserved namespaces — DI edges (pre-bare check)', () => {
  it('a provider of a reserved qualified type registers no bare-name provider', () => {
    const db = seedDb();
    addFile(db, 'shim/Log.kt', 'android.util');
    addFile(db, 'app/Consumer.kt', 'com.app');
    insertSymbols(db, REPO, [
      // Local shim "provides" android.util.Log.
      sym('ShimModule', 'shim/Log.kt', 'class', {
        di: { role: 'provider', providedType: 'android.util.Log' },
      }),
      // Consumer consumes bare "Log" — must NOT edge to the shim.
      sym('Consumer', 'app/Consumer.kt', 'class', {
        di: { role: 'consumer', injectConstructor: true, consumedTypes: ['Log'] },
      }),
    ]);
    const edges = buildDiEdges(db, REPO);
    expect(edges.filter((e) => e.targetFile === 'shim/Log.kt')).toEqual([]);
    db.close();
  });

  it('a consumer of a reserved qualified type gets no edge to a local bare-name provider', () => {
    const db = seedDb();
    addFile(db, 'app/LogModule.kt', 'com.app');
    addFile(db, 'app/Consumer.kt', 'com.app');
    insertSymbols(db, REPO, [
      sym('LogModule', 'app/LogModule.kt', 'class', {
        di: { role: 'provider', providedType: 'Log' },
      }),
      // Consumes the PLATFORM Log — the SDK provides it, not the local module.
      sym('Consumer', 'app/Consumer.kt', 'class', {
        di: { role: 'consumer', injectConstructor: true, consumedTypes: ['android.util.Log'] },
      }),
    ]);
    const edges = buildDiEdges(db, REPO);
    expect(edges.filter((e) => e.edgeType === 'di')).toEqual([]);
    db.close();
  });

  it('non-reserved DI matching is unchanged', () => {
    const db = seedDb();
    addFile(db, 'app/RepoModule.kt', 'com.app');
    addFile(db, 'app/ViewModel.kt', 'com.app');
    insertSymbols(db, REPO, [
      sym('RepoModule', 'app/RepoModule.kt', 'class', {
        di: { role: 'provider', providedType: 'UserRepository' },
      }),
      sym('MyViewModel', 'app/ViewModel.kt', 'class', {
        di: { role: 'consumer', injectConstructor: true, consumedTypes: ['UserRepository'] },
      }),
    ]);
    const edges = buildDiEdges(db, REPO);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.targetFile).toBe('app/RepoModule.kt');
    db.close();
  });
});

describe('config validation', () => {
  it('accepts a string array and rejects bad shapes', () => {
    expect(validateConfig({ graph: { reservedNamespaces: ['android', 'java'] } }).valid).toBe(true);
    expect(validateConfig({ graph: { reservedNamespaces: [] } }).valid).toBe(true);
    expect(validateConfig({ graph: { reservedNamespaces: 'android' } }).valid).toBe(false);
    expect(validateConfig({ graph: { reservedNamespaces: [42] } }).valid).toBe(false);
  });
});
