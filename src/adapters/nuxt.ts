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

// ─── File category ────────────────────────────────────────────────────────────

type FileCategory =
  | 'server-api'
  | 'server-route'
  | 'plugin'
  | 'middleware'
  | 'composable'
  | null;

function getCategory(filePath: string): FileCategory {
  if (filePath.startsWith('server/api/') && filePath.endsWith('.ts')) return 'server-api';
  if (filePath.startsWith('server/routes/') && filePath.endsWith('.ts')) return 'server-route';
  if (filePath.startsWith('plugins/') && filePath.endsWith('.ts')) return 'plugin';
  if (filePath.startsWith('middleware/') && filePath.endsWith('.ts')) return 'middleware';
  if (filePath.startsWith('composables/') && filePath.endsWith('.ts')) return 'composable';
  return null;
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
    return NUXT_CONFIG_NAMES.some((name) => existsSync(`${projectRoot}/${name}`));
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
    const category = getCategory(filePath);

    switch (category) {
      case 'server-api':
      case 'server-route': {
        const { routePath, method } = deriveServerRoute(filePath);
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
    // Page component: add route metadata
    if (symbol.kind === 'component' && symbol.filePath.startsWith('pages/')) {
      const routePath = derivePageRoutePath(symbol.filePath);
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
    if (symbol.filePath.startsWith('composables/')) {
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
