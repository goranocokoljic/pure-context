/**
 * Task 526 (Phase 85): Hilt/Dagger DI edges.
 *
 * Seeds an in-memory DB with symbols carrying frameworkMeta.di (as the android
 * adapter records them) and asserts the edges buildDiEdges derives: provider →
 * consumer wiring, @Binds interface bindings, ambiguous-provider fan-out
 * (over-approximation rule), self-file suppression, and the zero-DI fast path.
 */
import { describe, it, expect } from 'vitest';
import { buildDiEdges } from '../../src/graph/di-edges.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import type { SymbolRecord, SymbolKind } from '../../src/core/types.js';

const REPO = 'ditest';

let nextId = 0;
function sym(
  name: string,
  filePath: string,
  di?: Record<string, unknown>,
  kind: SymbolKind = 'class',
): SymbolRecord {
  return {
    id: `di${String(nextId++).padStart(14, '0')}`,
    name,
    kind,
    filePath,
    startByte: 0,
    endByte: 10,
    signature: name,
    summary: name,
    ...(di ? { frameworkMeta: { di } } : {}),
  };
}

function seedDb(symbols: SymbolRecord[]) {
  const db = openInMemoryDatabase();
  upsertRepo(db, {
    id: REPO,
    rootPath: '/tmp/ditest',
    symbolCount: 0,
    fileCount: 0,
    languages: [],
    indexedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
    clonePath: null,
    tenantId: 'local',
  });
  if (symbols.length > 0) insertSymbols(db, REPO, symbols);
  return db;
}

describe('buildDiEdges', () => {
  it('creates a consumer → provider edge for a @Provides match', () => {
    const db = seedDb([
      sym('provideAppDatabase', 'core/DataModule.kt', { role: 'provider', providedType: 'AppDatabase' }, 'method'),
      sym('UserRepositoryImpl', 'core/UserRepository.kt', {
        role: 'consumer',
        injectConstructor: true,
        consumedTypes: ['AppDatabase'],
      }),
    ]);
    const edges = buildDiEdges(db, REPO);
    const dbEdge = edges.find((e) => e.specifier === 'di:AppDatabase');
    expect(dbEdge).toBeDefined();
    expect(dbEdge!.sourceFile).toBe('core/UserRepository.kt');
    expect(dbEdge!.targetFile).toBe('core/DataModule.kt');
    expect(dbEdge!.edgeType).toBe('di');
  });

  it('wires an @Binds interface binding: consumer of the interface reaches the module', () => {
    const db = seedDb([
      sym('bindUserRepository', 'core/DataModule.kt', {
        role: 'provider',
        providedType: 'UserRepository',
        binds: true,
        consumedTypes: ['UserRepositoryImpl'],
      }, 'method'),
      sym('UserRepositoryImpl', 'core/UserRepositoryImpl.kt', {
        role: 'consumer',
        injectConstructor: true,
      }),
      sym('HomeViewModel', 'app/HomeViewModel.kt', {
        role: 'consumer',
        injectConstructor: true,
        consumedTypes: ['UserRepository'],
      }),
    ]);
    const edges = buildDiEdges(db, REPO);
    // ViewModel consumes the bound interface → edge to the binding module
    expect(edges).toContainEqual(
      expect.objectContaining({
        sourceFile: 'app/HomeViewModel.kt',
        targetFile: 'core/DataModule.kt',
        specifier: 'di:UserRepository',
      }),
    );
    // The module consumes the impl → edge to the impl's file
    expect(edges).toContainEqual(
      expect.objectContaining({
        sourceFile: 'core/DataModule.kt',
        targetFile: 'core/UserRepositoryImpl.kt',
        specifier: 'di:UserRepositoryImpl',
      }),
    );
  });

  it('fans out to ALL providers when a type name is ambiguous (over-approximation)', () => {
    const db = seedDb([
      sym('provideTracker', 'feature-a/ModuleA.kt', { role: 'provider', providedType: 'Tracker' }, 'method'),
      sym('provideTracker', 'feature-b/ModuleB.kt', { role: 'provider', providedType: 'Tracker' }, 'method'),
      sym('MainViewModel', 'app/MainViewModel.kt', {
        role: 'consumer',
        injectConstructor: true,
        consumedTypes: ['Tracker'],
      }),
    ]);
    const edges = buildDiEdges(db, REPO);
    const targets = edges.filter((e) => e.sourceFile === 'app/MainViewModel.kt').map((e) => e.targetFile).sort();
    expect(targets).toEqual(['feature-a/ModuleA.kt', 'feature-b/ModuleB.kt']);
  });

  it('an @Inject-constructor class provides its own type', () => {
    const db = seedDb([
      sym('Logger', 'core/Logger.kt', { role: 'consumer', injectConstructor: true }),
      sym('HomeViewModel', 'app/HomeViewModel.kt', {
        role: 'consumer',
        injectConstructor: true,
        consumedTypes: ['Logger'],
      }),
    ]);
    const edges = buildDiEdges(db, REPO);
    expect(edges).toContainEqual(
      expect.objectContaining({
        sourceFile: 'app/HomeViewModel.kt',
        targetFile: 'core/Logger.kt',
        specifier: 'di:Logger',
      }),
    );
  });

  it('matches package-qualified consumed types by bare name', () => {
    const db = seedDb([
      sym('provideDb', 'core/DataModule.kt', { role: 'provider', providedType: 'AppDatabase' }, 'method'),
      sym('Repo', 'app/Repo.kt', {
        role: 'consumer',
        injectConstructor: true,
        consumedTypes: ['com.example.core.AppDatabase'],
      }),
    ]);
    const edges = buildDiEdges(db, REPO);
    expect(edges).toContainEqual(
      expect.objectContaining({ sourceFile: 'app/Repo.kt', targetFile: 'core/DataModule.kt' }),
    );
  });

  it('suppresses same-file edges', () => {
    const db = seedDb([
      sym('provideDb', 'core/All.kt', { role: 'provider', providedType: 'AppDatabase' }, 'method'),
      sym('Repo', 'core/All.kt', {
        role: 'consumer',
        injectConstructor: true,
        consumedTypes: ['AppDatabase'],
      }),
    ]);
    expect(buildDiEdges(db, REPO)).toEqual([]);
  });

  it('unknown (external/framework) consumed types produce no edge', () => {
    const db = seedDb([
      sym('HomeViewModel', 'app/HomeViewModel.kt', {
        role: 'consumer',
        injectConstructor: true,
        consumedTypes: ['SavedStateHandle'],
      }),
    ]);
    expect(buildDiEdges(db, REPO)).toEqual([]);
  });

  it('returns zero edges for a repo without DI metadata', () => {
    const db = seedDb([sym('PlainClass', 'src/Plain.kt')]);
    expect(buildDiEdges(db, REPO)).toEqual([]);
  });

  it('deduplicates repeated consumer/provider/type triples', () => {
    const db = seedDb([
      sym('provideDb', 'core/DataModule.kt', { role: 'provider', providedType: 'AppDatabase' }, 'method'),
      sym('Repo', 'app/Repo.kt', {
        role: 'consumer',
        injectConstructor: true,
        consumedTypes: ['AppDatabase', 'AppDatabase'],
      }),
    ]);
    expect(buildDiEdges(db, REPO)).toHaveLength(1);
  });
});
