/**
 * Phase 85 e2e: the android fixture through the full indexFolder pipeline.
 *
 * Asserts the four Phase-85 capabilities end to end against the real DB:
 *   Compose kind upgrades (Task 524), DI edges in dep_edges (Task 526),
 *   manifest entry points incl. the get_entry_points branch (Task 527),
 *   Gradle module attribution (Task 528) — plus the find_cycles di-exclusion
 *   and reindexFiles parity for DI edges.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'path';
import { indexFolder, reindexFiles, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { kotlinHandler } from '../../src/handlers/kotlin.js';
import { javaHandler } from '../../src/handlers/java.js';
import { xmlHandler } from '../../src/handlers/xml.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { findImportCycles } from '../../src/graph/graph-traversal.js';
import { androidAdapter } from '../../src/adapters/android.js';
import { handler as entryPointsHandler } from '../../src/server/tools/get-entry-points.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/android-project');

let repoId: string;

interface SymRow {
  name: string;
  kind: string;
  file_path: string;
  framework_meta: string | null;
}

interface EdgeRow {
  source_file: string;
  target_file: string;
  specifier: string;
}

function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

function allSymbols(db: ReturnType<typeof openDatabase>): SymRow[] {
  return db
    .prepare<[string], SymRow>(
      'SELECT name, kind, file_path, framework_meta FROM symbols WHERE repo_id = ?',
    )
    .all(repoId);
}

function diEdges(db: ReturnType<typeof openDatabase>): EdgeRow[] {
  return db
    .prepare<[string], EdgeRow>(
      "SELECT source_file, target_file, specifier FROM dep_edges WHERE repo_id = ? AND edge_type = 'di'",
    )
    .all(repoId)
    .map((e) => ({
      source_file: norm(e.source_file),
      target_file: norm(e.target_file),
      specifier: e.specifier,
    }));
}

function meta(row: SymRow): Record<string, unknown> {
  return row.framework_meta ? (JSON.parse(row.framework_meta) as Record<string, unknown>) : {};
}

beforeAll(async () => {
  _resetForTesting();
  registerHandler(kotlinHandler);
  registerHandler(javaHandler);
  registerHandler(xmlHandler);
  await initParser();

  const result = await indexFolder(FIXTURE_ROOT, {
    adapters: [androidAdapter],
    fileLimit: 100,
  });
  repoId = result.repoId;
}, 60_000);

afterAll(() => {
  if (repoId) deleteIndex(repoId);
});

describe('android fixture end to end (Phase 85)', () => {
  it('upgrades @Composable functions to kind composable, preview flagged', () => {
    const db = openDatabase(repoId);
    try {
      const syms = allSymbols(db);
      const home = syms.find((s) => s.name === 'HomeScreen' && s.kind === 'composable');
      expect(home).toBeDefined();
      expect(meta(home!)['android']).toBe('compose');

      const preview = syms.find((s) => s.name === 'HomeScreenPreview');
      expect(preview?.kind).toBe('composable');
      expect(meta(preview!)['preview']).toBe(true);

      // Non-annotated fun in the same file stays a plain function
      const plain = syms.find((s) => s.name === 'formatTitle');
      expect(plain?.kind).toBe('function');
    } finally {
      db.close();
    }
  });

  it('emits manifest components as route symbols with launcher detection', () => {
    const db = openDatabase(repoId);
    try {
      const routes = allSymbols(db).filter((s) => meta(s)['android'] === 'manifest');
      const components = routes.map((s) => meta(s)['component']).sort();
      expect(components).toEqual(['activity', 'provider', 'receiver', 'service']);

      const launcher = routes.find((s) => meta(s)['launcher'] === true);
      expect(launcher?.name).toBe('com.example.app.MainActivity');
      expect(meta(launcher!)['exported']).toBe(true);
    } finally {
      db.close();
    }
  });

  it('builds DI edges the import graph cannot see', () => {
    const db = openDatabase(repoId);
    try {
      const edges = diEdges(db);

      // ViewModel → module that @Binds its repository interface
      expect(edges).toContainEqual({
        source_file: 'app/src/main/java/com/example/app/HomeViewModel.kt',
        target_file: 'core/src/main/java/com/example/core/DataModule.kt',
        specifier: 'di:UserRepository',
      });
      // Impl → module that @Provides its database
      expect(edges).toContainEqual({
        source_file: 'core/src/main/java/com/example/core/UserRepository.kt',
        target_file: 'core/src/main/java/com/example/core/DataModule.kt',
        specifier: 'di:AppDatabase',
      });
      // Module → the impl it binds
      expect(edges).toContainEqual({
        source_file: 'core/src/main/java/com/example/core/DataModule.kt',
        target_file: 'core/src/main/java/com/example/core/UserRepository.kt',
        specifier: 'di:UserRepositoryImpl',
      });
      // Java consumer → Kotlin module (cross-language)
      expect(edges).toContainEqual({
        source_file: 'app/src/main/java/com/example/app/AnalyticsTracker.java',
        target_file: 'core/src/main/java/com/example/core/DataModule.kt',
        specifier: 'di:AppDatabase',
      });
    } finally {
      db.close();
    }
  });

  it('attributes symbols to their Gradle module', () => {
    const db = openDatabase(repoId);
    try {
      const syms = allSymbols(db);
      const vm = syms.find((s) => s.name === 'HomeViewModel' && s.kind === 'class');
      expect(meta(vm!)['gradleModule']).toBe(':app');
      const impl = syms.find((s) => s.name === 'UserRepositoryImpl');
      expect(meta(impl!)['gradleModule']).toBe(':core');
    } finally {
      db.close();
    }
  });

  it('find_cycles does not report the @Binds module ↔ impl pair as a cycle', () => {
    const db = openDatabase(repoId);
    try {
      const result = findImportCycles(repoId, db, undefined, 50, 2);
      const involvingModule = result.cycles.filter((c) =>
        c.files.some((f) => norm(f).endsWith('DataModule.kt')),
      );
      expect(involvingModule).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('get_entry_points surfaces manifest components, LAUNCHER activity ranked high', async () => {
    const result = await entryPointsHandler({ repoId, kind: 'android_component' });
    const output = JSON.parse((result.content[0] as { text: string }).text) as {
      entryPoints: Array<{ name: string; kind: string; confidence: string; reason: string }>;
    };
    expect(output.entryPoints.length).toBe(4);
    const first = output.entryPoints[0]!;
    expect(first.name).toBe('com.example.app.MainActivity');
    expect(first.confidence).toBe('high');
    expect(first.reason).toContain('LAUNCHER');
  });

  it('targeted re-index rebuilds DI edges without loss or duplication', async () => {
    const dbBefore = openDatabase(repoId);
    const before = diEdges(dbBefore);
    dbBefore.close();
    await reindexFiles(
      repoId,
      ['app/src/main/java/com/example/app/HomeViewModel.kt'],
      [],
      { adapters: [androidAdapter] },
    );
    const db = openDatabase(repoId);
    try {
      const after = diEdges(db);
      expect(after.length).toBe(before.length);
      expect(after).toContainEqual({
        source_file: 'app/src/main/java/com/example/app/HomeViewModel.kt',
        target_file: 'core/src/main/java/com/example/core/DataModule.kt',
        specifier: 'di:UserRepository',
      });
    } finally {
      db.close();
    }
  });
});
