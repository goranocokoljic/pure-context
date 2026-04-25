/**
 * Phase 2 integration tests — Task 23.
 *
 * Validates the full adapter pipeline against the three framework fixtures:
 *   1.  Vue: UserCard.vue produces a `component` symbol
 *   2.  Vue: useAuth produces kind `composable`
 *   3.  Vue: get-symbol-source returns correct slice for a <script setup> symbol
 *   4.  Nuxt: pages/index.vue produces a route with path `/`
 *   5.  Nuxt: pages/blog/[slug].vue produces route path `/blog/:slug`
 *   6.  Nuxt: server/api/users.get.ts produces route with method GET
 *   7.  Nuxt: plugins/analytics.ts produces a middleware symbol
 *   8.  React: Button.tsx produces kind `component`
 *   9.  React: useLocalStorage produces kind `hook`
 *   10. React: cn.ts utility stays kind `function`
 *   11. Stage 2 summarizer: component gets a framework-derived summary
 *   12. Incremental reindex: modify UserCard.vue → symbol count unchanged, content updated
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { indexFolder, reindexFiles, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase, computeRepoId } from '../../src/core/db/schema.js';
import { searchSymbols, getSymbolsByFile } from '../../src/core/db/symbol-store.js';
import { getFileContent } from '../../src/core/db/file-store.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { vueAdapter } from '../../src/adapters/vue.js';
import { nuxtAdapter } from '../../src/adapters/nuxt.js';
import { reactAdapter } from '../../src/adapters/react.js';
import { _resetForTesting as resetAdapters } from '../../src/adapters/adapter-registry.js';

// ─── Fixture paths ────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const VUE_FIXTURE   = resolve(__dirname, '../fixtures/vue-project');
const NUXT_FIXTURE  = resolve(__dirname, '../fixtures/nuxt-project');
const REACT_FIXTURE = resolve(__dirname, '../fixtures/react-project');

// ─── Shared state ─────────────────────────────────────────────────────────────

let vueRepoId: string;
let nuxtRepoId: string;
let reactRepoId: string;

// ─── Global setup ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  resetAdapters();

  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  // Index all three fixtures concurrently.
  // Nuxt uses both adapters: Vue handles .vue files, Nuxt enriches pages/ and handles .ts routes.
  const [vueResult, nuxtResult, reactResult] = await Promise.all([
    indexFolder(VUE_FIXTURE,   { adapters: [vueAdapter] }),
    indexFolder(NUXT_FIXTURE,  { adapters: [nuxtAdapter, vueAdapter] }),
    indexFolder(REACT_FIXTURE, { adapters: [reactAdapter] }),
  ]);

  vueRepoId   = vueResult.repoId;
  nuxtRepoId  = nuxtResult.repoId;
  reactRepoId = reactResult.repoId;
}, 60_000);

afterAll(() => {
  deleteIndex(vueRepoId);
  deleteIndex(nuxtRepoId);
  deleteIndex(reactRepoId);
});

// ─── Vue fixture ──────────────────────────────────────────────────────────────

describe('Vue adapter integration', () => {
  it('1. UserCard.vue produces a component symbol', () => {
    const db = openDatabase(vueRepoId);
    const symbols = searchSymbols(db, vueRepoId, 'UserCard');
    db.close();

    const component = symbols.find((s) => s.name === 'UserCard');
    expect(component).toBeDefined();
    expect(component!.kind).toBe('component');
    expect(component!.frameworkMeta?.['vue_component']).toBe(true);
  });

  it('2. useAuth composable is extracted with kind `composable`', () => {
    const db = openDatabase(vueRepoId);
    const symbols = searchSymbols(db, vueRepoId, 'useAuth');
    db.close();

    const composable = symbols.find((s) => s.name === 'useAuth');
    expect(composable).toBeDefined();
    expect(composable!.kind).toBe('composable');
    expect(composable!.frameworkMeta?.['vue_composable']).toBe(true);
  });

  it('3. get-symbol-source for a script-block symbol returns correct slice', () => {
    const db = openDatabase(vueRepoId);
    const symbols = getSymbolsByFile(db, vueRepoId, 'src/composables/useAuth.ts');
    const content  = getFileContent(db, vueRepoId, 'src/composables/useAuth.ts');
    db.close();

    expect(content).not.toBeNull();
    const useAuthSym = symbols.find((s) => s.name === 'useAuth');
    expect(useAuthSym).toBeDefined();

    const slice = content!.slice(useAuthSym!.startByte, useAuthSym!.endByte).toString('utf8');
    expect(slice).toContain('useAuth');
    expect(slice).toContain('isAuthenticated');
  });

  it('4. format.ts utilities stay as plain functions (not promoted)', () => {
    const db = openDatabase(vueRepoId);
    const symbols = searchSymbols(db, vueRepoId, 'format');
    db.close();

    const formatCurrency = symbols.find((s) => s.name === 'formatCurrency');
    expect(formatCurrency).toBeDefined();
    expect(formatCurrency!.kind).toBe('function');
  });

  it('5. Component summary is framework-derived (Stage 2)', () => {
    const db = openDatabase(vueRepoId);
    const symbols = searchSymbols(db, vueRepoId, 'UserCard');
    db.close();

    const component = symbols.find((s) => s.name === 'UserCard' && s.kind === 'component');
    expect(component).toBeDefined();
    // Stage 2 derives: "Vue component UserCard"
    expect(component!.summary).toBe('Vue component UserCard');
  });
});

// ─── Nuxt fixture ─────────────────────────────────────────────────────────────

describe('Nuxt adapter integration', () => {
  it('6. pages/index.vue produces a component with nuxt_page and route_path `/`', () => {
    // Page .vue files are processed by the Vue adapter (kind=component) then enriched
    // by the Nuxt adapter's enrichMetadata which adds nuxt_page + route_path.
    const db = openDatabase(nuxtRepoId);
    const symbols = getSymbolsByFile(db, nuxtRepoId, 'pages/index.vue');
    db.close();

    const page = symbols.find((s) => s.kind === 'component');
    expect(page).toBeDefined();
    expect(page!.frameworkMeta?.['route_path']).toBe('/');
    expect(page!.frameworkMeta?.['nuxt_page']).toBe(true);
  });

  it('7. pages/blog/[slug].vue produces component with route_path `/blog/:slug`', () => {
    const db = openDatabase(nuxtRepoId);
    const symbols = getSymbolsByFile(db, nuxtRepoId, 'pages/blog/[slug].vue');
    db.close();

    const page = symbols.find((s) => s.kind === 'component');
    expect(page).toBeDefined();
    expect(page!.frameworkMeta?.['route_path']).toBe('/blog/:slug');
    expect(page!.frameworkMeta?.['nuxt_page']).toBe(true);
  });

  it('8. server/api/users.get.ts produces a GET route', () => {
    const db = openDatabase(nuxtRepoId);
    const symbols = getSymbolsByFile(db, nuxtRepoId, 'server/api/users.get.ts');
    db.close();

    const route = symbols.find((s) => s.kind === 'route');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.['http_method']).toBe('GET');
    expect(route!.frameworkMeta?.['route_path']).toBe('/api/users');
    expect(route!.frameworkMeta?.['nuxt_server']).toBe(true);
  });

  it('9. server/api/users.post.ts produces a POST route', () => {
    const db = openDatabase(nuxtRepoId);
    const symbols = getSymbolsByFile(db, nuxtRepoId, 'server/api/users.post.ts');
    db.close();

    const route = symbols.find((s) => s.kind === 'route');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.['http_method']).toBe('POST');
  });

  it('10. plugins/analytics.ts produces a middleware symbol', () => {
    const db = openDatabase(nuxtRepoId);
    const symbols = getSymbolsByFile(db, nuxtRepoId, 'plugins/analytics.ts');
    db.close();

    const plugin = symbols.find((s) => s.kind === 'middleware');
    expect(plugin).toBeDefined();
    expect(plugin!.name).toBe('analytics');
    expect(plugin!.frameworkMeta?.['nuxt_plugin']).toBe(true);
  });

  it('11. middleware/auth.ts produces a middleware symbol', () => {
    const db = openDatabase(nuxtRepoId);
    const symbols = getSymbolsByFile(db, nuxtRepoId, 'middleware/auth.ts');
    db.close();

    const mw = symbols.find((s) => s.kind === 'middleware');
    expect(mw).toBeDefined();
    expect(mw!.name).toBe('auth');
    expect(mw!.frameworkMeta?.['nuxt_middleware']).toBe(true);
  });

  it('12. Nuxt server route summary is framework-derived (Stage 2)', () => {
    const db = openDatabase(nuxtRepoId);
    const symbols = getSymbolsByFile(db, nuxtRepoId, 'server/api/users.get.ts');
    db.close();

    const route = symbols.find((s) => s.kind === 'route');
    expect(route).toBeDefined();
    expect(route!.summary).toBe('GET /api/users server route');
  });
});

// ─── React fixture ────────────────────────────────────────────────────────────

describe('React adapter integration', () => {
  it('13. Button.tsx produces kind `component`', () => {
    const db = openDatabase(reactRepoId);
    const symbols = searchSymbols(db, reactRepoId, 'Button');
    db.close();

    const btn = symbols.find((s) => s.name === 'Button');
    expect(btn).toBeDefined();
    expect(btn!.kind).toBe('component');
    expect(btn!.frameworkMeta?.['react_component']).toBe(true);
  });

  it('14. Modal.tsx produces kind `component`', () => {
    const db = openDatabase(reactRepoId);
    const symbols = searchSymbols(db, reactRepoId, 'Modal');
    db.close();

    const modal = symbols.find((s) => s.name === 'Modal');
    expect(modal).toBeDefined();
    expect(modal!.kind).toBe('component');
  });

  it('15. useLocalStorage produces kind `hook`', () => {
    const db = openDatabase(reactRepoId);
    const symbols = searchSymbols(db, reactRepoId, 'useLocalStorage');
    db.close();

    const hook = symbols.find((s) => s.name === 'useLocalStorage');
    expect(hook).toBeDefined();
    expect(hook!.kind).toBe('hook');
    expect(hook!.frameworkMeta?.['react_hook']).toBe(true);
  });

  it('16. useDebounce produces kind `hook`', () => {
    const db = openDatabase(reactRepoId);
    const symbols = searchSymbols(db, reactRepoId, 'useDebounce');
    db.close();

    const hook = symbols.find((s) => s.name === 'useDebounce');
    expect(hook).toBeDefined();
    expect(hook!.kind).toBe('hook');
  });

  it('17. cn utility stays kind `function` (not promoted)', () => {
    const db = openDatabase(reactRepoId);
    const symbols = searchSymbols(db, reactRepoId, 'cn');
    db.close();

    const fn = symbols.find((s) => s.name === 'cn');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('18. Hook with docstring uses Stage 1 summary (docstring wins over Stage 2)', () => {
    // useLocalStorage has a JSDoc — Stage 1 (docstring) takes priority over Stage 2.
    const db = openDatabase(reactRepoId);
    const symbols = searchSymbols(db, reactRepoId, 'useLocalStorage');
    db.close();

    const hook = symbols.find((s) => s.name === 'useLocalStorage');
    expect(hook).toBeDefined();
    expect(hook!.summary).toBe('Persist state to localStorage with automatic serialization.');
  });

  it('19. React component summary is framework-derived (Stage 2)', () => {
    const db = openDatabase(reactRepoId);
    const symbols = searchSymbols(db, reactRepoId, 'Button');
    db.close();

    const btn = symbols.find((s) => s.name === 'Button' && s.kind === 'component');
    expect(btn).toBeDefined();
    expect(btn!.summary).toBe('React component Button');
  });
});

// ─── Incremental reindex ──────────────────────────────────────────────────────

describe('Incremental reindex', () => {
  it('20. Modifying UserCard.vue updates content without changing symbol count', async () => {
    const db = openDatabase(vueRepoId);
    const before = getSymbolsByFile(db, vueRepoId, 'src/components/UserCard.vue');
    db.close();

    // Write a slightly different version of UserCard.vue
    const vueFilePath = join(VUE_FIXTURE, 'src/components/UserCard.vue');
    const original = readFileSync(vueFilePath, 'utf8');
    const modified = original.replace('user.name', 'user.name + " (updated)"');
    writeFileSync(vueFilePath, modified, 'utf8');

    try {
      await reindexFiles(vueRepoId, ['src/components/UserCard.vue'], [], {
        adapters: [vueAdapter],
      });

      const dbAfter = openDatabase(vueRepoId);
      const after = getSymbolsByFile(dbAfter, vueRepoId, 'src/components/UserCard.vue');
      const content = getFileContent(dbAfter, vueRepoId, 'src/components/UserCard.vue');
      dbAfter.close();

      // Symbol count unchanged
      expect(after.length).toBe(before.length);

      // File content is updated
      expect(content?.toString('utf8')).toContain('(updated)');
    } finally {
      // Restore original
      writeFileSync(vueFilePath, original, 'utf8');
    }
  }, 30_000);
});
