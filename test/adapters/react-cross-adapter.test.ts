/**
 * Phase 92 (Task 569c) — cross-adapter integration tests.
 *
 * The class of test whose absence let B1 live: Vue and React active together
 * in the real bootstrap order ([vue, ..., react]), indexed through the full
 * pipeline. Verifies extension-gated ownership:
 *   - React hooks in hooks/ .ts files and in .tsx files → kind 'hook'
 *   - Vue composables in composables/ .ts files → kind 'composable'
 *   - .vue components untouched
 *   - other languages (Kotlin) never touched by either adapter
 *
 * Also the Vue-only kind-snapshot guard (P1/R5): a pure Vue fixture indexed
 * with both adapters produces the same kinds as with the Vue adapter alone.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { vueAdapter } from '../../src/adapters/vue.js';
import { reactAdapter } from '../../src/adapters/react.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';
import { registerHandler, _resetForTesting as resetHandlers } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { kotlinHandler } from '../../src/handlers/kotlin.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { indexFolder, deleteIndex, computeRepoId } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-xadapter-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir: string, relPath: string, content: string): void {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

// ─── Global setup ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  resetHandlers();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  registerHandler(kotlinHandler);
  await initParser();
});

beforeEach(() => {
  _resetForTesting();
});

// ─── Vue + React active together (real bootstrap order) ──────────────────────

describe('Phase 92 — vue + react cross-adapter ownership', () => {
  it('assigns hook/composable/component kinds by file territory', async () => {
    const dir = tmpDir();
    const repoId = computeRepoId(dir);
    try {
      // The novu shape: a React-Query hook in a hooks/ .ts file
      writeFile(dir, 'apps/dashboard/src/hooks/useCreateWorkflow.ts', `
export function useCreateWorkflow() {
  return { create: () => {} };
}
      `.trim());

      // A hook defined inside a .tsx component file
      writeFile(dir, 'apps/dashboard/src/components/Widget.tsx', `
export function useWidget() {
  return { open: false };
}
export function Widget() {
  return <div />;
}
      `.trim());

      // Vue keeps its territory: composables/ .ts file
      writeFile(dir, 'apps/web/composables/useFetch.ts', `
export function useFetch() {
  return { data: null };
}
      `.trim());

      // A .vue page component
      writeFile(dir, 'apps/web/pages/index.vue', `
<script setup lang="ts">
const msg = 'hi';
</script>
<template><div>{{ msg }}</div></template>
      `.trim());

      // Cross-language guard: a Kotlin useCase must stay a function
      writeFile(dir, 'app/src/main/kotlin/UseCases.kt', `
fun useCase(): Int = 42
      `.trim());

      // Real bootstrap order: vue before react
      await indexFolder(dir, { adapters: [vueAdapter, reactAdapter] });

      const db = openDatabase(repoId);
      const all = searchSymbols(db, repoId, '');
      db.close();

      const byName = new Map(all.map((s) => [s.name, s]));

      // React's hooks
      expect(byName.get('useCreateWorkflow')?.kind).toBe('hook');
      expect(byName.get('useCreateWorkflow')?.frameworkMeta?.['react_hook']).toBe(true);
      expect(byName.get('useCreateWorkflow')?.frameworkMeta?.['vue_composable']).toBeUndefined();
      expect(byName.get('useWidget')?.kind).toBe('hook');
      expect(byName.get('Widget')?.kind).toBe('component');

      // Vue's composable
      expect(byName.get('useFetch')?.kind).toBe('composable');
      expect(byName.get('useFetch')?.frameworkMeta?.['vue_composable']).toBe(true);

      // Vue page component (name derived from filename: index → Index)
      const vueComponent = all.find(
        (s) => s.filePath.endsWith('index.vue') && s.kind === 'component',
      );
      expect(vueComponent).toBeDefined();
      expect(vueComponent?.frameworkMeta?.['vue_component']).toBe(true);

      // Kotlin untouched
      expect(byName.get('useCase')?.kind).toBe('function');
    } finally {
      deleteIndex(repoId);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('order-independence: react-before-vue yields the same kinds (P3)', async () => {
    const dir = tmpDir();
    const repoId = computeRepoId(dir);
    try {
      writeFile(dir, 'src/hooks/useAuth.ts', 'export function useAuth() { return 1; }');
      writeFile(dir, 'src/composables/useTheme.ts', 'export function useTheme() { return 1; }');

      await indexFolder(dir, { adapters: [reactAdapter, vueAdapter] });

      const db = openDatabase(repoId);
      const all = searchSymbols(db, repoId, '');
      db.close();

      const byName = new Map(all.map((s) => [s.name, s]));
      // hooks/ → react wins regardless of order (hook output kind is never
      // touched by vue); composables/ .ts → vue's composable (react's hook rule
      // does not fire outside hooks/, and vue upgrades it whether it runs
      // before or after react).
      expect(byName.get('useAuth')?.kind).toBe('hook');
      expect(byName.get('useTheme')?.kind).toBe('composable');
    } finally {
      deleteIndex(repoId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Vue-only kind snapshot guard (P1 / R5) ──────────────────────────────────

describe('Phase 92 — Vue-only fixture kind snapshot guard', () => {
  async function indexAndCollectKinds(adapters: import('../../src/core/types.js').FrameworkAdapter[]): Promise<Map<string, string>> {
    const dir = tmpDir();
    const repoId = computeRepoId(dir);
    try {
      writeFile(dir, 'package.json', JSON.stringify({ dependencies: { vue: '^3.0.0' } }));
      writeFile(dir, 'src/App.vue', `
<script setup lang="ts">
function handleClick() {}
</script>
<template><button @click="handleClick" /></template>
      `.trim());
      writeFile(dir, 'src/composables/useCounter.ts', 'export function useCounter() { return 0; }');
      writeFile(dir, 'src/utils/format.ts', 'export function formatDate(d: Date) { return d.toISOString(); }');

      await indexFolder(dir, { adapters });

      const db = openDatabase(repoId);
      const all = searchSymbols(db, repoId, '');
      db.close();
      return new Map(all.map((s) => [`${s.filePath}::${s.name}`, s.kind]));
    } finally {
      deleteIndex(repoId);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('kinds are identical with vue alone vs vue + react active', async () => {
    const vueOnly = await indexAndCollectKinds([vueAdapter]);
    const withReact = await indexAndCollectKinds([vueAdapter, reactAdapter]);

    expect(withReact.size).toBe(vueOnly.size);
    for (const [key, kind] of vueOnly) {
      expect(withReact.get(key), key).toBe(kind);
    }

    // And the expected kinds themselves (the snapshot):
    const kinds = [...vueOnly.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort();
    expect(kinds.some((k) => k.endsWith('useCounter=composable'))).toBe(true);
    expect(kinds.some((k) => k.endsWith('formatDate=function'))).toBe(true);
    expect(kinds.some((k) => k.includes('App.vue') && k.endsWith('=component'))).toBe(true);
  }, 30000);
});
