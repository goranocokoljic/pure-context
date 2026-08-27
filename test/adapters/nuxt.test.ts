import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { nuxtAdapter, derivePageRoutePath, deriveServerRoute, toNuxtRelative } from '../../src/adapters/nuxt.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';
import type { SymbolRecord } from '../../src/core/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-nuxt-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sym(overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    id: 'aabbccddeeff0011',
    name: 'MyPage',
    kind: 'component',
    filePath: 'pages/index.vue',
    startByte: 0,
    endByte: 100,
    signature: '<MyPage>',
    summary: 'Vue component MyPage',
    ...overrides,
  };
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Metadata ─────────────────────────────────────────────────────────────────

describe('nuxtAdapter metadata', () => {
  it('has name "nuxt"', () => {
    expect(nuxtAdapter.name).toBe('nuxt');
  });

  it('declares no additional extensions (TS handler covers .ts)', () => {
    expect(nuxtAdapter.extensions()).toEqual([]);
  });

  it('has no preProcess (TS handler parses .ts directly)', () => {
    expect(nuxtAdapter.preProcess).toBeUndefined();
  });
});

// ─── detect ───────────────────────────────────────────────────────────────────

describe('nuxtAdapter.detect', () => {
  it.each(['nuxt.config.ts', 'nuxt.config.mts', 'nuxt.config.js', 'nuxt.config.mjs'])(
    'returns true when %s exists',
    async (configFile) => {
      const dir = tmpDir();
      try {
        writeFileSync(join(dir, configFile), 'export default {}');
        expect(await nuxtAdapter.detect(dir)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('returns false when no nuxt.config file exists', async () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, 'package.json'), '{}');
      expect(await nuxtAdapter.detect(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns true when nuxt.config lives in a nested sub-app (monorepo)', async () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, 'package.json'), '{}'); // non-nuxt root
      const sub = join(dir, 'apps', 'web');
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, 'nuxt.config.ts'), 'export default {}');
      expect(await nuxtAdapter.detect(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores nuxt.config inside node_modules (no false positive)', async () => {
    const dir = tmpDir();
    try {
      const sub = join(dir, 'node_modules', 'some-pkg');
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, 'nuxt.config.ts'), 'export default {}');
      expect(await nuxtAdapter.detect(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── fileFilter ───────────────────────────────────────────────────────────────

describe('nuxtAdapter.fileFilter', () => {
  it.each([
    'server/api/users.ts',
    'server/api/users.get.ts',
    'server/api/nested/items.post.ts',
    'server/routes/health.ts',
    'plugins/analytics.ts',
    'plugins/auth.client.ts',
    'middleware/auth.ts',
    'composables/useAuth.ts',
    'composables/useTheme.ts',
    // JS Nuxt apps (Phase 93, V-8): all JS/TS extensions are claimed
    'server/api/users.js',
    'server/api/users.get.mjs',
    'plugins/analytics.js',
    'middleware/auth.cjs',
    'composables/useAuth.mts',
  ])('matches %s', (filePath) => {
    expect(nuxtAdapter.fileFilter(filePath)).toBe(true);
  });

  it.each([
    'pages/index.vue',        // .vue handled by Vue adapter
    'src/utils.ts',           // generic TS
    'components/Button.vue',  // generic Vue component
    'server/api/users.json',  // not a script extension
    'server/plugins/foo.ts',  // wrong directory (server/plugins ≠ plugins)
  ])('does not match %s', (filePath) => {
    expect(nuxtAdapter.fileFilter(filePath)).toBe(false);
  });
});

// ─── toNuxtRelative (monorepo path resolution) ────────────────────────────────

describe('toNuxtRelative', () => {
  it.each<[string, string | null]>([
    // Non-monorepo (already app-root-relative) — pass through unchanged
    ['server/api/users.ts',            'server/api/users.ts'],
    ['server/routes/health.ts',        'server/routes/health.ts'],
    ['plugins/analytics.ts',           'plugins/analytics.ts'],
    ['middleware/auth.ts',             'middleware/auth.ts'],
    ['composables/useAuth.ts',         'composables/useAuth.ts'],
    ['pages/blog/[slug].vue',          'pages/blog/[slug].vue'],
    // Monorepo sub-app — strip the leading app-root prefix
    ['apps/web/server/api/users.ts',   'server/api/users.ts'],
    ['packages/site/pages/index.vue',  'pages/index.vue'],
    ['frontend/composables/useX.ts',   'composables/useX.ts'],
    // Windows backslashes normalize
    ['apps\\web\\plugins\\auth.ts',    'plugins/auth.ts'],
    // No Nuxt boundary → null
    ['src/utils/helpers.ts',           null],
    ['components/Button.vue',          null],
  ])('%s → %s', (filePath, expected) => {
    expect(toNuxtRelative(filePath)).toBe(expected);
  });

  it('matches the server boundary before a deeper pages segment', () => {
    expect(toNuxtRelative('apps/web/server/api/pages/list.ts')).toBe('server/api/pages/list.ts');
  });
});

// ─── toNuxtRelative anchoring (Phase 93, Task 576 — V-1 phantom symbols) ──────

describe('toNuxtRelative — anchoring', () => {
  // Nuxt 4 `app/` layout keeps resolving (regression protection for the
  // accident that previously worked via first-segment matching).
  it.each<[string, string]>([
    ['app/pages/index.vue',              'pages/index.vue'],
    ['app/middleware/auth.ts',           'middleware/auth.ts'],
    ['app/composables/useAuth.ts',       'composables/useAuth.ts'],
    // Nuxt 4 layout inside a monorepo sub-app (app/ grants one extra depth)
    ['apps/web/app/pages/index.vue',     'pages/index.vue'],
  ])('Nuxt 4 layout: %s → %s', (filePath, expected) => {
    expect(toNuxtRelative(filePath)).toBe(expected);
  });

  // Deeply nested or library/fixture/output trees are NOT app roots.
  it.each<string>([
    // rejected leading segments
    'src/pages/runtime/page.vue',
    'src/runtime/components/nuxt-link.ts',
    'test/fixtures/basic/pages/index.vue',
    'tests/pages/index.vue',
    '__tests__/middleware/auth.ts',
    'packages/nuxt/src/pages/runtime/router.ts',
    'fixtures/app/pages/index.vue',
    'templates/plugins/foo.ts',
    'node_modules/lib/plugins/x.ts',
    // too deep (boundary beyond depth 2 without app/ parent)
    'packages/site/deep/nested/pages/index.vue',
    'a/b/c/middleware/auth.ts',
  ])('rejects %s', (filePath) => {
    expect(toNuxtRelative(filePath)).toBe(null);
  });

  it('still allows one or two neutral leading segments', () => {
    expect(toNuxtRelative('frontend/middleware/auth.ts')).toBe('middleware/auth.ts');
    expect(toNuxtRelative('apps/web/plugins/analytics.ts')).toBe('plugins/analytics.ts');
  });
});

// ─── nested monorepo extraction + enrichment ──────────────────────────────────

describe('nuxtAdapter — nested monorepo sub-app', () => {
  it('fileFilter matches a server route in a sub-app', () => {
    expect(nuxtAdapter.fileFilter('apps/web/server/api/users.get.ts')).toBe(true);
  });

  it('derives the route from an app-root-relative portion of a nested path', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'apps/web/server/api/users.post.ts');
    expect(s!.kind).toBe('route');
    expect(s!.name).toBe('/api/users');
    expect(s!.frameworkMeta?.['http_method']).toBe('POST');
    // Stored filePath stays repo-relative so the file can still be opened
    expect(s!.filePath).toBe('apps/web/server/api/users.post.ts');
  });

  it('enriches a nested page component with route metadata', () => {
    const comp = sym({ kind: 'component', filePath: 'packages/site/pages/blog/[slug].vue' });
    const result = nuxtAdapter.enrichMetadata!(comp);
    expect(result.frameworkMeta?.['nuxt_page']).toBe(true);
    expect(result.frameworkMeta?.['route_path']).toBe('/blog/:slug');
  });

  it('marks a nested composable as auto-imported', () => {
    const fn = sym({ kind: 'function', name: 'useX', filePath: 'frontend/composables/useX.ts' });
    const result = nuxtAdapter.enrichMetadata!(fn);
    expect(result.frameworkMeta?.['nuxt_auto_import']).toBe(true);
  });
});

// ─── derivePageRoutePath ──────────────────────────────────────────────────────

describe('derivePageRoutePath', () => {
  it.each<[string, string]>([
    ['pages/index.vue',              '/'],
    ['pages/about.vue',              '/about'],
    ['pages/blog/index.vue',         '/blog'],
    ['pages/blog/post.vue',          '/blog/post'],
    ['pages/blog/[slug].vue',        '/blog/:slug'],
    ['pages/[id]/edit.vue',          '/:id/edit'],
    ['pages/[...catch].vue',         '/**:catch'],       // catch-all, as Nuxt renders it
    ['pages/[[id]].vue',             '/:id?'],           // optional param
    ['pages/users/[id]/profile.vue', '/users/:id/profile'],
  ])('%s → %s', (filePath, expected) => {
    expect(derivePageRoutePath(filePath)).toBe(expected);
  });
});

// ─── deriveServerRoute ────────────────────────────────────────────────────────

describe('deriveServerRoute — path derivation', () => {
  it.each<[string, string]>([
    ['server/api/users.ts',              '/api/users'],
    ['server/api/users.get.ts',          '/api/users'],
    ['server/api/items/[id].delete.ts',  '/api/items/:id'],
    ['server/api/index.ts',              '/api'],
    ['server/routes/health.ts',          '/health'],
    ['server/routes/v2/status.ts',       '/v2/status'],
  ])('%s → route path %s', (filePath, expected) => {
    expect(deriveServerRoute(filePath).routePath).toBe(expected);
  });
});

describe('deriveServerRoute — HTTP method extraction', () => {
  it.each<[string, string | null]>([
    ['server/api/users.get.ts',    'GET'],
    ['server/api/users.post.ts',   'POST'],
    ['server/api/users.put.ts',    'PUT'],
    ['server/api/users.patch.ts',  'PATCH'],
    ['server/api/users.delete.ts', 'DELETE'],
    ['server/api/users.head.ts',   'HEAD'],
    ['server/api/users.ts',        null],
    ['server/routes/health.ts',    null],
  ])('%s → method %s', (filePath, expected) => {
    expect(deriveServerRoute(filePath).method).toBe(expected);
  });
});

// ─── extractFrameworkSymbols ──────────────────────────────────────────────────

describe('nuxtAdapter.extractFrameworkSymbols — server routes', () => {
  it('emits a route symbol for server/api files', () => {
    const syms = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'server/api/users.get.ts');
    expect(syms).toHaveLength(1);
    expect(syms[0]!.kind).toBe('route');
  });

  it('route symbol name is the route path', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'server/api/users.ts');
    expect(s!.name).toBe('/api/users');
  });

  it('route symbol signature includes HTTP method when present', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'server/api/users.post.ts');
    expect(s!.signature).toContain('POST');
    expect(s!.signature).toContain('/api/users');
  });

  it('route signature has no method prefix when method is absent', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'server/api/users.ts');
    expect(s!.signature).toBe('/api/users');
  });

  it('frameworkMeta has route_path', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'server/api/items/[id].get.ts');
    expect(s!.frameworkMeta?.['route_path']).toBe('/api/items/:id');
  });

  it('frameworkMeta has http_method when present', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'server/api/users.delete.ts');
    expect(s!.frameworkMeta?.['http_method']).toBe('DELETE');
  });

  it('frameworkMeta has no http_method key when absent', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'server/api/users.ts');
    expect(s!.frameworkMeta).not.toHaveProperty('http_method');
  });

  it('frameworkMeta has nuxt_server: true', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'server/api/users.ts');
    expect(s!.frameworkMeta?.['nuxt_server']).toBe(true);
  });

  it('server/routes files get route symbol at root path', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'server/routes/health.ts');
    expect(s!.kind).toBe('route');
    expect(s!.frameworkMeta?.['route_path']).toBe('/health');
  });
});

describe('nuxtAdapter.extractFrameworkSymbols — plugins', () => {
  it('emits a middleware symbol for plugin files', () => {
    const syms = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'plugins/analytics.ts');
    expect(syms).toHaveLength(1);
    expect(syms[0]!.kind).toBe('middleware');
  });

  it('plugin name is derived from filename (no extension)', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'plugins/analytics.ts');
    expect(s!.name).toBe('analytics');
  });

  it('plugin frameworkMeta has nuxt_plugin: true', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'plugins/auth.ts');
    expect(s!.frameworkMeta?.['nuxt_plugin']).toBe(true);
  });
});

describe('nuxtAdapter.extractFrameworkSymbols — middleware', () => {
  it('emits a middleware symbol for middleware files', () => {
    const syms = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'middleware/auth.ts');
    expect(syms).toHaveLength(1);
    expect(syms[0]!.kind).toBe('middleware');
  });

  it('middleware name is derived from filename', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'middleware/auth.ts');
    expect(s!.name).toBe('auth');
  });

  it('middleware frameworkMeta has nuxt_middleware: true', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'middleware/auth.ts');
    expect(s!.frameworkMeta?.['nuxt_middleware']).toBe(true);
  });
});

describe('nuxtAdapter — JS apps + naming conventions (Phase 93, Task 579)', () => {
  it('emits a route symbol for a JS server route (kurirfe class)', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'server/api/users.js');
    expect(s!.kind).toBe('route');
    expect(s!.name).toBe('/api/users');
  });

  it('strips the extension AND method suffix from a .js server route', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'server/api/users.post.js');
    expect(s!.name).toBe('/api/users');
    expect(s!.frameworkMeta?.['http_method']).toBe('POST');
  });

  it('strips the mode suffix from plugin names and records nuxt_mode', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'plugins/auth.client.ts');
    expect(s!.name).toBe('auth');
    expect(s!.frameworkMeta?.['nuxt_mode']).toBe('client');
  });

  it('strips .global from middleware names and records nuxt_mode', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'middleware/auth.global.ts');
    expect(s!.name).toBe('auth');
    expect(s!.frameworkMeta?.['nuxt_mode']).toBe('global');
  });

  it('plain plugin names carry no nuxt_mode key', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'plugins/analytics.ts');
    expect(s!.name).toBe('analytics');
    expect(s!.frameworkMeta).not.toHaveProperty('nuxt_mode');
  });

  it('JS plugin gets its symbol too', () => {
    const [s] = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'plugins/analytics.js');
    expect(s!.kind).toBe('middleware');
    expect(s!.name).toBe('analytics');
  });
});

describe('nuxtAdapter.extractFrameworkSymbols — composables', () => {
  it('returns [] for composable files (enrichMetadata handles them)', () => {
    const syms = nuxtAdapter.extractFrameworkSymbols(null, buf(''), 'composables/useAuth.ts');
    expect(syms).toEqual([]);
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('nuxtAdapter.enrichMetadata — page components', () => {
  it('adds route_path to component symbols in pages/', () => {
    const result = nuxtAdapter.enrichMetadata!(sym({ filePath: 'pages/about.vue', kind: 'component' }));
    expect(result.frameworkMeta?.['route_path']).toBe('/about');
  });

  it('adds nuxt_page: true to component symbols in pages/', () => {
    const result = nuxtAdapter.enrichMetadata!(sym({ filePath: 'pages/index.vue', kind: 'component' }));
    expect(result.frameworkMeta?.['nuxt_page']).toBe(true);
  });

  it('derives dynamic route paths correctly via enrichMetadata', () => {
    const result = nuxtAdapter.enrichMetadata!(sym({ filePath: 'pages/blog/[slug].vue', kind: 'component' }));
    expect(result.frameworkMeta?.['route_path']).toBe('/blog/:slug');
  });

  it('does not modify non-component symbols in pages/', () => {
    const s = sym({ filePath: 'pages/index.vue', kind: 'function' as const });
    const result = nuxtAdapter.enrichMetadata!(s);
    expect(result.frameworkMeta?.['nuxt_page']).toBeUndefined();
  });

  it('does not modify component symbols outside pages/', () => {
    const s = sym({ filePath: 'components/Button.vue', kind: 'component' });
    const result = nuxtAdapter.enrichMetadata!(s);
    expect(result.frameworkMeta?.['nuxt_page']).toBeUndefined();
  });

  it('overwrites the summary with the page route (V-2)', () => {
    const result = nuxtAdapter.enrichMetadata!(sym({ filePath: 'pages/blog/[slug].vue', kind: 'component' }));
    expect(result.summary).toBe('Page route /blog/:slug');
  });

  it('preserves existing frameworkMeta when adding route info', () => {
    const s = sym({ filePath: 'pages/index.vue', frameworkMeta: { vue_component: true } });
    const result = nuxtAdapter.enrichMetadata!(s);
    expect(result.frameworkMeta?.['vue_component']).toBe(true);
    expect(result.frameworkMeta?.['nuxt_page']).toBe(true);
  });
});

describe('nuxtAdapter.enrichMetadata — composables', () => {
  it('adds nuxt_auto_import: true to symbols in composables/', () => {
    const s = sym({ filePath: 'composables/useAuth.ts', kind: 'composable' as const });
    const result = nuxtAdapter.enrichMetadata!(s);
    expect(result.frameworkMeta?.['nuxt_auto_import']).toBe(true);
  });

  it('adds nuxt_auto_import to any symbol kind in composables/', () => {
    const s = sym({ filePath: 'composables/helpers.ts', kind: 'function' as const });
    const result = nuxtAdapter.enrichMetadata!(s);
    expect(result.frameworkMeta?.['nuxt_auto_import']).toBe(true);
  });

  it('does not add nuxt_auto_import outside composables/', () => {
    const s = sym({ filePath: 'src/utils/format.ts', kind: 'function' as const });
    const result = nuxtAdapter.enrichMetadata!(s);
    expect(result.frameworkMeta?.['nuxt_auto_import']).toBeUndefined();
  });
});

describe('nuxtAdapter.enrichMetadata — unrelated symbols', () => {
  it('returns symbol unchanged when it does not match any rule', () => {
    const s = sym({ filePath: 'src/utils.ts', kind: 'function' as const });
    const result = nuxtAdapter.enrichMetadata!(s);
    expect(result).toEqual(s);
  });
});
