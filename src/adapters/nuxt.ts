/**
 * Nuxt framework adapter.
 *
 * Handles Nuxt-specific .ts files (server routes, plugins, middleware,
 * composables) and enriches page component symbols (emitted by the Vue adapter)
 * with route path metadata via cross-adapter enrichMetadata.
 *
 * Detection: presence of nuxt.config.{ts,mts,js,mjs} in the project root.
 *
 * File categories handled:
 *   server/api/...ts    → route symbol  (path derived from file path)
 *   server/routes/...ts  → route symbol  (path at root, no /routes/ prefix)
 *   plugins/...ts        → middleware symbol
 *   middleware/...ts     → middleware symbol
 *   composables/...ts    → (TS handler extracts; enrichMetadata adds auto_import)
 *
 * Cross-adapter enrichment (via enrichMetadata):
 *   pages/...vue component symbols → add route_path + nuxt_page: true
 *   composables/... symbols        → add nuxt_auto_import: true
 */

import { createHash } from 'crypto';
import { basename } from 'path';
import { existsSync } from 'fs';
import { scanForFramework } from './detect-utils.js';
import type { FrameworkAdapter, SymbolRecord, Tree } from '../core/types.js';
import { registerAdapter } from './adapter-registry.js';
import { logger } from '../core/logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/**
 * Extensions a Nuxt app's script files may use (Phase 93, V-8). Nuxt apps are
 * frequently plain JavaScript — requiring `.ts` made every JS Nuxt app index
 * to zero route/plugin/middleware symbols (kurirfe).
 */
const NUXT_SCRIPT_EXT = /\.(ts|js|mts|mjs|cts|cjs)$/;

/**
 * Nuxt mode suffixes on plugin/middleware filenames (Phase 93, V-9):
 * `auth.client.ts` registers as plugin `auth` running only on the client.
 */
const NUXT_MODE_SUFFIX = /\.(client|server|global|dev)$/;

/**
 * Derive the symbol name + optional mode from a plugin/middleware file path.
 *   'plugins/auth.client.ts'   → { name: 'auth', mode: 'client' }
 *   'middleware/auth.global.ts'→ { name: 'auth', mode: 'global' }
 *   'plugins/analytics.ts'     → { name: 'analytics', mode: null }
 */
function nuxtScriptName(filePath: string): { name: string; mode: string | null } {
  let stem = basename(filePath).replace(NUXT_SCRIPT_EXT, '');
  const m = stem.match(NUXT_MODE_SUFFIX);
  if (m) {
    stem = stem.slice(0, -m[0]!.length);
    return { name: stem, mode: m[1]! };
  }
  return { name: stem, mode: null };
}

const NUXT_CONFIG_NAMES = [
  'nuxt.config.ts',
  'nuxt.config.mts',
  'nuxt.config.js',
  'nuxt.config.mjs',
];

// ─── Detection helpers ──────────────────────────────────────────────────────

const NUXT_CONFIG_SET = new Set(NUXT_CONFIG_NAMES);

/**
 * Fixture/test directories excluded from Nuxt detection (Phase 93, V-7): a
 * nuxt.config.* inside a test fixture tree must not activate the adapter for
 * the whole repo.
 */
const FIXTURE_IGNORE_DIRS = new Set(['test', 'tests', 'fixtures', '__fixtures__', 'examples', 'e2e']);

// ─── Route path helpers ───────────────────────────────────────────────────────

/**
 * Convert a single path segment with Nuxt dynamic syntax to a URL parameter
 * (matching what Nuxt itself renders):
 *   '[id]'      → ':id'
 *   '[[id]]'    → ':id?'   (optional param)
 *   '[...slug]' → '**:slug' (catch-all)
 *   'index'     → kept as-is (caller removes trailing index)
 */
function convertSegment(seg: string): string {
  if (seg.startsWith('[[') && seg.endsWith(']]')) return ':' + seg.slice(2, -2) + '?';
  if (seg.startsWith('[...') && seg.endsWith(']')) return '**:' + seg.slice(4, -1);
  if (seg.startsWith('[') && seg.endsWith(']')) return ':' + seg.slice(1, -1);
  return seg;
}

/**
 * Derive the URL route path from a pages/ file path.
 *   'pages/index.vue'          → '/'
 *   'pages/about.vue'          → '/about'
 *   'pages/blog/index.vue'     → '/blog'
 *   'pages/blog/[slug].vue'    → '/blog/:slug'
 *   'pages/[...catch].vue'     → '/*catch'
 */
export function derivePageRoutePath(filePath: string): string {
  const withoutPrefix = filePath.slice('pages/'.length).replace(/\.vue$/, '');
  const parts = withoutPrefix.split('/').map(convertSegment);
  // Remove trailing 'index' segment (it represents the parent route)
  if (parts[parts.length - 1] === 'index') parts.pop();
  if (parts.length === 0) return '/';
  return '/' + parts.join('/');
}

/**
 * Derive the URL route path and HTTP method from a server/ file path.
 *
 * server/api/users.get.ts      → { routePath: '/api/users', method: 'GET' }
 * server/api/users.ts          → { routePath: '/api/users', method: null }
 * server/api/[id].delete.ts    → { routePath: '/api/:id',  method: 'DELETE' }
 * server/routes/health.ts      → { routePath: '/health',   method: null }
 */
export function deriveServerRoute(filePath: string): { routePath: string; method: string | null } {
  // server/routes/ maps to root (/), server/api/ keeps the api/ prefix
  let pathStr: string;
  if (filePath.startsWith('server/routes/')) {
    pathStr = filePath.slice('server/routes/'.length).replace(NUXT_SCRIPT_EXT, '');
  } else {
    pathStr = filePath.slice('server/'.length).replace(NUXT_SCRIPT_EXT, '');
  }

  // Detect HTTP method suffix: `users.get` → method GET, pathStr → `users`
  let method: string | null = null;
  const lastDot = pathStr.lastIndexOf('.');
  if (lastDot !== -1) {
    const candidate = pathStr.slice(lastDot + 1).toLowerCase();
    if (HTTP_METHODS.has(candidate)) {
      method = candidate.toUpperCase();
      pathStr = pathStr.slice(0, lastDot);
    }
  }

  const parts = pathStr.split('/').map(convertSegment);
  if (parts[parts.length - 1] === 'index') parts.pop();

  const routePath = '/' + parts.join('/');
  return { routePath, method };
}

// ─── Symbol ID helper ─────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: string): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

// ─── Nuxt-relative path resolution ──────────────────────────────────────────

/**
 * Top-level Nuxt convention directories that sit directly under the app root.
 * The first occurrence of one of these marks the app-root boundary. `server` is
 * included so that a path like `server/plugins/foo.ts` resolves relative to the
 * `server/` tree (and is correctly *not* treated as an app-root `plugins/` file).
 */
const NUXT_ROOT_SEGMENTS = new Set(['server', 'plugins', 'middleware', 'composables', 'pages']);

/**
 * Leading path segments that mark a directory tree as NOT a Nuxt app root.
 * A `pages/` or `plugins/` directory nested under one of these belongs to a
 * library, a test fixture, or generated output — treating it as an app root
 * fabricated 111 phantom `middleware` + 24 phantom `route` symbols in the nuxt
 * benchmark repo (V-1). Checked case-insensitively.
 */
const NUXT_REJECT_PRECEDING = new Set([
  'src',
  'dist',
  'test',
  'tests',
  '__tests__',
  'fixtures',
  'runtime',
  'templates',
  'node_modules',
]);

/**
 * Resolve the path of a file relative to its Nuxt app root.
 *
 * When indexing a monorepo, file paths are relative to the indexed repo root
 * (e.g. `apps/web/server/api/users.ts`), but Nuxt category detection and route
 * derivation expect paths relative to the Nuxt app root (`server/api/users.ts`).
 * This finds the first recognized Nuxt convention-directory boundary and returns
 * the path from there. Returns null when no boundary is found.
 *
 * Anchoring (Phase 93, Task 576): the boundary segment must sit near the repo
 * root — at most 2 leading segments (monorepo sub-app: `apps/web/pages/…`), or
 * 3 when the segment directly above it is Nuxt 4's `app/` directory
 * (`apps/web/app/pages/…`). Additionally no leading segment may be in
 * NUXT_REJECT_PRECEDING — a `pages/` dir under `src/`, `test/`, `runtime/` etc.
 * is a library/fixture/output tree, not a Nuxt app root.
 *
 * Stateless by design: the parallel worker pool resolves adapters from its own
 * registry, so the app root cannot be cached during detect() — it must be
 * derivable from the file path alone.
 *
 *   'server/api/users.ts'             → 'server/api/users.ts'   (no-op, non-monorepo)
 *   'apps/web/server/api/users.ts'    → 'server/api/users.ts'
 *   'app/pages/index.vue'             → 'pages/index.vue'       (Nuxt 4 layout)
 *   'packages/site/pages/index.vue'   → 'pages/index.vue'
 *   'server/plugins/foo.ts'           → 'server/plugins/foo.ts' (categoryOf → null)
 *   'src/pages/runtime/x.vue'         → null                    (rejected: src/)
 *   'src/utils/helpers.ts'            → null
 */
export function toNuxtRelative(filePath: string): string | null {
  const segments = filePath.replace(/\\/g, '/').split('/');
  for (let i = 0; i < segments.length; i++) {
    if (!NUXT_ROOT_SEGMENTS.has(segments[i]!)) continue;
    // Boundary must be near the repo root (depth ≤ 2; ≤ 3 under Nuxt 4 `app/`).
    const maxDepth = segments[i - 1] === 'app' ? 3 : 2;
    if (i > maxDepth) return null;
    // No leading segment may be a known non-app-root directory.
    for (let j = 0; j < i; j++) {
      if (NUXT_REJECT_PRECEDING.has(segments[j]!.toLowerCase())) return null;
    }
    return segments.slice(i).join('/');
  }
  return null;
}

// ─── File category ────────────────────────────────────────────────────────────

type FileCategory =
  | 'server-api'
  | 'server-route'
  | 'plugin'
  | 'middleware'
  | 'composable'
  | null;

/** Classify an already-Nuxt-relative path into a file category. */
function categoryOf(rel: string): FileCategory {
  if (!NUXT_SCRIPT_EXT.test(rel)) return null;
  if (rel.startsWith('server/api/')) return 'server-api';
  if (rel.startsWith('server/routes/')) return 'server-route';
  if (rel.startsWith('plugins/')) return 'plugin';
  if (rel.startsWith('middleware/')) return 'middleware';
  if (rel.startsWith('composables/')) return 'composable';
  return null;
}

function getCategory(filePath: string): FileCategory {
  const rel = toNuxtRelative(filePath);
  return rel ? categoryOf(rel) : null;
}

// ─── Nuxt adapter ─────────────────────────────────────────────────────────────

export const nuxtAdapter: FrameworkAdapter = {
  name: 'nuxt',

  /**
   * Nuxt-specific .ts files add no new file extensions beyond what the TS
   * handler already covers. Pages/.vue are handled by the Vue adapter.
   */
  extensions: () => [],

  // ── Detection ───────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    // Fast path: nuxt.config.* in the indexed root (common case).
    if (NUXT_CONFIG_NAMES.some((name) => existsSync(`${projectRoot}/${name}`))) {
      return true;
    }

    // Monorepo / sub-app fallback (shared scanner, Phase 93 consolidation):
    // bounded recursive scan for a nuxt.config.* anywhere in the tree
    // (e.g. apps/web/, frontend/). Fixture/test dirs are ignored (V-7).
    return scanForFramework(projectRoot, {
      matchesFile: (name) => NUXT_CONFIG_SET.has(name),
      pkgDeclares: () => false, // detection keys on the config file only
      extraIgnoreDirs: FIXTURE_IGNORE_DIRS,
    });
  },

  // ── File routing ─────────────────────────────────────────────────────────────

  fileFilter(filePath: string): boolean {
    return getCategory(filePath) !== null;
  },

  // No preProcess — the TypeScript handler parses .ts files directly.
  // extractFrameworkSymbols receives the parsed tree and derives symbols from
  // the file path (route paths, plugin names, etc.).

  // ── Framework symbol extraction ──────────────────────────────────────────────

  extractFrameworkSymbols(tree: Tree | null, source: Buffer, filePath: string): SymbolRecord[] {
    // `rel` is the path relative to the Nuxt app root (handles monorepo sub-apps).
    // The stored symbol filePath stays repo-relative so files can still be opened.
    const rel = toNuxtRelative(filePath);
    const category = rel ? categoryOf(rel) : null;

    switch (category) {
      case 'server-api':
      case 'server-route': {
        const { routePath, method } = deriveServerRoute(rel!);
        const name = routePath;
        const methodLabel = method ? `${method} ` : '';
        return [
          {
            id: makeId(filePath, name, 'route'),
            name,
            kind: 'route',
            filePath,
            startByte: 0,
            endByte: source.length,
            signature: `${methodLabel}${routePath}`,
            summary: `${methodLabel}${routePath} server route`,
            frameworkMeta: {
              route_path: routePath,
              ...(method ? { http_method: method } : {}),
              nuxt_server: true,
            },
          },
        ];
      }

      case 'plugin': {
        const { name, mode } = nuxtScriptName(filePath);
        return [
          {
            id: makeId(filePath, name, 'middleware'),
            name,
            kind: 'middleware',
            filePath,
            startByte: 0,
            endByte: source.length,
            signature: `plugin: ${name}`,
            summary: `Nuxt plugin ${name}`,
            frameworkMeta: { nuxt_plugin: true, ...(mode ? { nuxt_mode: mode } : {}) },
          },
        ];
      }

      case 'middleware': {
        const { name, mode } = nuxtScriptName(filePath);
        return [
          {
            id: makeId(filePath, name, 'middleware'),
            name,
            kind: 'middleware',
            filePath,
            startByte: 0,
            endByte: source.length,
            signature: `middleware: ${name}`,
            summary: `Nuxt middleware ${name}`,
            frameworkMeta: { nuxt_middleware: true, ...(mode ? { nuxt_mode: mode } : {}) },
          },
        ];
      }

      case 'composable':
        // The TypeScript handler + Vue adapter already extract composables.
        // enrichMetadata adds nuxt_auto_import; no extra symbols needed here.
        return [];

      default:
        return [];
    }
  },

  // ── Metadata enrichment (cross-adapter) ──────────────────────────────────────

  /**
   * Enrich symbols from other adapters:
   *
   * - Component symbols in pages/ get route_path and nuxt_page: true added.
   *   (These component symbols are emitted by the Vue adapter; Nuxt enriches them.)
   *
   * - Any symbol in composables/ gets nuxt_auto_import: true.
   */
  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    // Resolve to the Nuxt-app-root-relative path so monorepo sub-app symbols
    // (e.g. apps/web/pages/index.vue) are enriched the same as root-level ones.
    const rel = toNuxtRelative(symbol.filePath);

    // Page component: add route metadata. The summary is overwritten with the
    // route so users see it in search results and FTS carries its words — the
    // Vue adapter's "Vue component X" summary otherwise made the summarizer's
    // nuxt_page branch unreachable (Phase 93, V-2).
    if (symbol.kind === 'component' && rel && rel.startsWith('pages/')) {
      const routePath = derivePageRoutePath(rel);
      return {
        ...symbol,
        summary: `Page route ${routePath}`,
        frameworkMeta: {
          ...symbol.frameworkMeta,
          route_path: routePath,
          nuxt_page: true,
        },
      };
    }

    // Composable (or any symbol) in composables/ — mark as auto-imported
    if (rel && rel.startsWith('composables/')) {
      return {
        ...symbol,
        frameworkMeta: {
          ...symbol.frameworkMeta,
          nuxt_auto_import: true,
        },
      };
    }

    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(nuxtAdapter);
logger.debug("Adapter 'nuxt' registered");
