import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { nuxtAdapter, derivePageRoutePath, deriveServerRoute } from '../../src/adapters/nuxt.js';
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
  ])('matches %s', (filePath) => {
    expect(nuxtAdapter.fileFilter(filePath)).toBe(true);
  });

  it.each([
    'pages/index.vue',        // .vue handled by Vue adapter
    'src/utils.ts',           // generic TS
    'components/Button.vue',  // generic Vue component
    'server/api/users.js',    // .js not .ts
    'server/plugins/foo.ts',  // wrong directory (server/plugins ≠ plugins)
  ])('does not match %s', (filePath) => {
    expect(nuxtAdapter.fileFilter(filePath)).toBe(false);
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
    ['pages/[...catch].vue',         '/*catch'],
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
