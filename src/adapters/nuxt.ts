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
import { existsSync, readdirSync, type Dirent } from 'fs';
import type { FrameworkAdapter, SymbolRecord, Tree } from '../core/types.js';
import { registerAdapter } from './adapter-registry.js';
import { logger } from '../core/logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

const NUXT_CONFIG_NAMES = [
  'nuxt.config.ts',
  'nuxt.config.mts',
  'nuxt.config.js',
  'nuxt.config.mjs',
];

// ─── Detection helpers ──────────────────────────────────────────────────────

/**
 * Directory names that never contain a first-party Nuxt app root — skipped
 * during the recursive detection scan to keep it fast and avoid false positives
 * from bundled dependencies.
 */
const DETECT_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.nuxt',
  '.output',
  '.next',
  'coverage',
  'vendor',
  'target',
  '.cache',
  '.turbo',
  '.svelte-kit',
]);

/** Max directory depth and total directories visited by the detection scan. */
const DETECT_MAX_DEPTH = 6;
const DETECT_MAX_DIRS = 2000;

const NUXT_CONFIG_SET = new Set(NUXT_CONFIG_NAMES);

/**
 * Bounded recursive scan: returns true on the first `nuxt.config.{ts,mts,js,mjs}`
 * found anywhere in the tree. Handles monorepos where the Nuxt app lives in a
 * subdirectory (apps/web/, frontend/, …) rather than the indexed root. Skips
 * heavy/irrelevant directories and caps depth + total directories so the scan
 * stays cheap. Symlinked directories are not followed (Dirent.isDirectory() is
 * false for symlinks), avoiding cycles.
 */
function scanForNuxtConfig(dir: string, depth: number, budget: { dirs: number }): boolean {
  if (depth > DETECT_MAX_DEPTH || budget.dirs >= DETECT_MAX_DIRS) return false;
  budget.dirs++;

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false; // unreadable directory — skip
  }

  const subDirs: string[] = [];
  for (const e of entries) {
    if (e.isFile()) {
      if (NUXT_CONFIG_SET.has(e.name)) return true;
    } else if (e.isDirectory() && !DETECT_IGNORE_DIRS.has(e.name)) {
      subDirs.push(e.name);
    }
  }

  for (const name of subDirs) {
    if (scanForNuxtConfig(`${dir}/${name}`, depth + 1, budget)) return true;
  }

  return false;
}

// ─── Route path helpers ───────────────────────────────────────────────────────

/**
 * Convert a single path segment with Nuxt dynamic syntax to a URL parameter.
 *   '[id]'      → ':id'
 *   '[...slug]' → '*slug'
 *   'index'     → kept as-is (caller removes trailing index)
 */
function convertSegment(seg: string): string {
  if (seg.startsWith('[...') && seg.endsWith(']')) return '*' + seg.slice(4, -1);
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
    pathStr = filePath.slice('server/routes/'.length).replace(/\.ts$/, '');
  } else {
    pathStr = filePath.slice('server/'.length).replace(/\.ts$/, '');
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
 * Resolve the path of a file relative to its Nuxt app root.
 *
 * When indexing a monorepo, file paths are relative to the indexed repo root
 * (e.g. `apps/web/server/api/users.ts`), but Nuxt category detection and route
 * derivation expect paths relative to the Nuxt app root (`server/api/users.ts`).
 * This finds the first recognized Nuxt convention-directory boundary and returns
 * the path from there. Returns null when no boundary is found.
 *
 * Stateless by design: the parallel worker pool resolves adapters from its own
 * registry, so the app root cannot be cached during detect() — it must be
 * derivable from the file path alone.
 *
 *   'server/api/users.ts'             → 'server/api/users.ts'   (no-op, non-monorepo)
 *   'apps/web/server/api/users.ts'    → 'server/api/users.ts'
 *   'packages/site/pages/index.vue'   → 'pages/index.vue'
 *   'server/plugins/foo.ts'           → 'server/plugins/foo.ts' (categoryOf → null)
 *   'src/utils/helpers.ts'            → null
 */
export function toNuxtRelative(filePath: string): string | null {
  const segments = filePath.replace(/\\/g, '/').split('/');
  for (let i = 0; i < segments.length; i++) {
    if (NUXT_ROOT_SEGMENTS.has(segments[i]!)) {
      return segments.slice(i).join('/');
    }
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
  if (rel.startsWith('server/api/') && rel.endsWith('.ts')) return 'server-api';
  if (rel.startsWith('server/routes/') && rel.endsWith('.ts')) return 'server-route';
  if (rel.startsWith('plugins/') && rel.endsWith('.ts')) return 'plugin';
  if (rel.startsWith('middleware/') && rel.endsWith('.ts')) return 'middleware';
  if (rel.startsWith('composables/') && rel.endsWith('.ts')) return 'composable';
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

    // Monorepo / sub-app fallback: bounded recursive scan for a nuxt.config.*
    // anywhere in the tree (e.g. apps/web/, frontend/). Skips heavy dirs and
    // caps depth + total directories.
    return scanForNuxtConfig(projectRoot, 0, { dirs: 0 });
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
        const name = basename(filePath, '.ts');
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
            frameworkMeta: { nuxt_plugin: true },
          },
        ];
      }

      case 'middleware': {
        const name = basename(filePath, '.ts');
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
            frameworkMeta: { nuxt_middleware: true },
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

    // Page component: add route metadata
    if (symbol.kind === 'component' && rel && rel.startsWith('pages/')) {
      const routePath = derivePageRoutePath(rel);
      return {
        ...symbol,
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
