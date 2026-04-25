/**
 * Next.js framework adapter.
 *
 * Handles both the Pages Router and App Router conventions, emitting route,
 * component, and middleware symbols from file-path analysis and (for App Router
 * API routes) lightweight AST scanning.
 *
 * Detection: presence of next.config.{js,ts,mjs,cjs} OR `next` in package.json
 * dependencies.
 *
 * Works alongside the React adapter — React promotes functions to components/hooks,
 * Next.js emits route symbols and enriches those components with route metadata.
 *
 * File categories handled:
 *   pages/[*]  (not pages/api/)        → route symbol (Pages Router page)
 *   pages/api/[*]                       → route symbol (Pages Router API)
 *   app/[*]/page.{tsx,jsx}             → route symbol (App Router page)
 *   app/[*]/layout|loading|error|not-found.{tsx,jsx} → component symbol (special file)
 *   app/[*]/route.{ts,js}             → route symbols per exported HTTP method
 *   middleware.{ts,js}                  → middleware symbol
 *
 * All paths also support an optional src/ prefix (Next.js convention).
 */

import { createHash } from 'crypto';
import { basename, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import type { FrameworkAdapter, SymbolRecord, Tree } from '../core/types.js';
import { registerAdapter } from './adapter-registry.js';
import { logger } from '../core/logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const NEXT_CONFIG_NAMES = [
  'next.config.js',
  'next.config.ts',
  'next.config.mjs',
  'next.config.cjs',
];

const HTTP_METHODS = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
]);

const APP_SPECIAL_FILES: Record<string, string> = {
  'layout': 'layout',
  'loading': 'loading',
  'error': 'error',
  'not-found': 'not-found',
};

// ─── Symbol ID ────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: string): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

// ─── Path normalisation ───────────────────────────────────────────────────────

/** Strip optional src/ prefix so categorisation logic only has one form to handle. */
function normalizePath(filePath: string): string {
  return filePath.startsWith('src/') ? filePath.slice(4) : filePath;
}

// ─── Route path derivation ─────────────────────────────────────────────────

/**
 * Convert a single path segment with Next.js dynamic syntax to a URL parameter.
 *   '[id]'           → ':id'
 *   '[...slug]'      → '*slug'
 *   '[[...optional]]'→ '*optional?'
 *   '(group)'        → null (App Router route groups — strip from path)
 *   normal segment   → unchanged
 */
function convertSegment(seg: string, stripGroups: boolean): string | null {
  if (stripGroups && seg.startsWith('(') && seg.endsWith(')')) return null;
  if (seg.startsWith('[[...') && seg.endsWith(']]')) return '*' + seg.slice(5, -2) + '?';
  if (seg.startsWith('[...') && seg.endsWith(']')) return '*' + seg.slice(4, -1);
  if (seg.startsWith('[') && seg.endsWith(']')) return ':' + seg.slice(1, -1);
  return seg;
}

/**
 * Derive the URL route path for a Pages Router file.
 *   'pages/index.tsx'          → '/'
 *   'pages/about.tsx'          → '/about'
 *   'pages/blog/[slug].tsx'    → '/blog/:slug'
 *   'pages/[...catch].tsx'     → '/*catch'
 *   'pages/[[...opt]].tsx'     → '/*opt?'
 *
 * normalizedPath must already have any src/ prefix stripped.
 */
export function derivePageRouterPath(normalizedPath: string): string {
  const withoutPrefix = normalizedPath.slice('pages/'.length);
  const withoutExt = withoutPrefix.replace(/\.(tsx|jsx|ts|js)$/, '');
  const parts = withoutExt
    .split('/')
    .map((seg) => convertSegment(seg, false))
    .filter((s): s is string => s !== null);
  if (parts[parts.length - 1] === 'index') parts.pop();
  if (parts.length === 0) return '/';
  return '/' + parts.join('/');
}

/**
 * Derive the URL route path for an App Router file (page.tsx, layout.tsx, route.ts…).
 * The path is determined by the directory containing the file, not the filename.
 *   'app/page.tsx'                        → '/'
 *   'app/about/page.tsx'                  → '/about'
 *   'app/blog/[slug]/page.tsx'            → '/blog/:slug'
 *   'app/(marketing)/about/page.tsx'      → '/about'
 *   'app/api/users/route.ts'              → '/api/users'
 *
 * normalizedPath must already have any src/ prefix stripped.
 */
export function deriveAppRouterPath(normalizedPath: string): string {
  const withoutApp = normalizedPath.slice('app/'.length);
  const dir = dirname(withoutApp);
  if (dir === '.') return '/';
  const parts = dir
    .split('/')
    .map((seg) => convertSegment(seg, true))  // strip route groups
    .filter((s): s is string => s !== null);
  if (parts.length === 0) return '/';
  return '/' + parts.join('/');
}

// ─── File category ────────────────────────────────────────────────────────────

type NextCategory =
  | 'pages-router-page'
  | 'pages-router-api'
  | 'app-router-page'
  | 'app-router-special'   // layout | loading | error | not-found
  | 'app-router-api'
  | 'root-middleware'
  | null;

function getCategory(normalizedPath: string): NextCategory {
  // Middleware at project root (after src/ stripping)
  if (normalizedPath === 'middleware.ts' || normalizedPath === 'middleware.js') {
    return 'root-middleware';
  }

  // Pages Router API must be checked before generic pages
  if (
    normalizedPath.startsWith('pages/api/') &&
    /\.(ts|js)$/.test(normalizedPath)
  ) {
    return 'pages-router-api';
  }

  // Pages Router pages
  if (
    normalizedPath.startsWith('pages/') &&
    /\.(tsx|jsx|ts|js)$/.test(normalizedPath)
  ) {
    return 'pages-router-page';
  }

  // App Router files — categorise by filename
  if (normalizedPath.startsWith('app/')) {
    const base = basename(normalizedPath, '.tsx').replace(/\.(jsx|ts|js)$/, '');
    if (base === 'page') return 'app-router-page';
    if (base === 'route') return 'app-router-api';
    if (base in APP_SPECIAL_FILES) return 'app-router-special';
  }

  return null;
}

// ─── AST helpers ──────────────────────────────────────────────────────────────

/**
 * Scan a parsed TypeScript/JavaScript tree for top-level exported names.
 * Used to find which HTTP methods are exported from App Router route.ts files.
 */
function findExportedNames(tree: Tree | null): Set<string> {
  const names = new Set<string>();
  if (!tree) return names;

  for (const node of tree.rootNode.children) {
    if (node.type !== 'export_statement') continue;
    for (const child of node.children) {
      if (child.type === 'function_declaration') {
        const ident = child.children.find((c) => c.type === 'identifier');
        if (ident) names.add(ident.text);
      } else if (child.type === 'lexical_declaration') {
        for (const decl of child.children) {
          if (decl.type === 'variable_declarator') {
            const ident = decl.children.find((c) => c.type === 'identifier');
            if (ident) names.add(ident.text);
          }
        }
      }
    }
  }
  return names;
}

/** Check for 'use client' directive at the top of the file. */
function hasUseClientDirective(source: Buffer): boolean {
  const top = source.slice(0, 200).toString('utf8').trimStart();
  return top.startsWith("'use client'") || top.startsWith('"use client"');
}

// ─── Next.js adapter ──────────────────────────────────────────────────────────

export const nextjsAdapter: FrameworkAdapter = {
  name: 'nextjs',

  /** No new extensions — TS/JS handlers already cover .tsx/.jsx/.ts/.js. */
  extensions: () => [],

  // ── Detection ───────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    // Config file presence is the most reliable signal
    if (NEXT_CONFIG_NAMES.some((name) => existsSync(`${projectRoot}/${name}`))) {
      return true;
    }
    // Fall back to package.json dependency check
    try {
      const raw = readFileSync(`${projectRoot}/package.json`, 'utf8');
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      const deps = Object.assign(
        {},
        pkg['dependencies'] as Record<string, string> | undefined,
        pkg['devDependencies'] as Record<string, string> | undefined,
      );
      return 'next' in deps;
    } catch {
      return false;
    }
  },

  // ── File routing ─────────────────────────────────────────────────────────────

  fileFilter(filePath: string): boolean {
    return getCategory(normalizePath(filePath)) !== null;
  },

  // No preProcess — TS/JS handlers parse .tsx/.jsx/.ts/.js files directly.

  // ── Framework symbol extraction ──────────────────────────────────────────────

  extractFrameworkSymbols(
    tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    const p = normalizePath(filePath);
    const category = getCategory(p);
    if (!category) return [];

    switch (category) {
      case 'pages-router-page': {
        const routePath = derivePageRouterPath(p);
        return [
          {
            id: makeId(filePath, routePath, 'route'),
            name: routePath,
            kind: 'route',
            filePath,
            startByte: 0,
            endByte: source.length,
            signature: `GET ${routePath}`,
            summary: `Next.js page ${routePath}`,
            frameworkMeta: {
              route_path: routePath,
              router: 'pages',
              nextjs_page: true,
            },
          },
        ];
      }

      case 'pages-router-api': {
        const routePath = derivePageRouterPath(p.replace('/api', '')).replace(
          /^\//, '/api/',
        ).replace('/api//', '/api/');
        // Simpler: just strip pages/ prefix and /api/ is preserved
        const apiPath = '/' + p.slice('pages/'.length).replace(/\.(ts|js)$/, '');
        const cleanPath = apiPath
          .split('/')
          .map((seg) => convertSegment(seg, false))
          .filter((s): s is string => s !== null)
          .join('/');
        const finalPath = '/' + cleanPath.replace(/^\//, '').replace(/\/index$/, '');
        return [
          {
            id: makeId(filePath, finalPath, 'route'),
            name: finalPath,
            kind: 'route',
            filePath,
            startByte: 0,
            endByte: source.length,
            signature: finalPath,
            summary: `Next.js API route ${finalPath}`,
            frameworkMeta: {
              route_path: finalPath,
              api_route: true,
              router: 'pages',
            },
          },
        ];
      }

      case 'app-router-page': {
        const routePath = deriveAppRouterPath(p);
        const isClient = hasUseClientDirective(source);
        return [
          {
            id: makeId(filePath, routePath, 'route'),
            name: routePath,
            kind: 'route',
            filePath,
            startByte: 0,
            endByte: source.length,
            signature: `GET ${routePath}`,
            summary: `Next.js App Router page ${routePath}`,
            frameworkMeta: {
              route_path: routePath,
              router: 'app',
              nextjs_page: true,
              ...(isClient ? { client_component: true } : { server_component: true }),
            },
          },
        ];
      }

      case 'app-router-special': {
        const fileBase = basename(p, '.tsx').replace(/\.(jsx|ts|js)$/, '');
        const specialKind = APP_SPECIAL_FILES[fileBase] ?? fileBase;
        const routePath = deriveAppRouterPath(p);
        const name = `${fileBase}:${routePath}`;
        return [
          {
            id: makeId(filePath, name, 'component'),
            name,
            kind: 'component',
            filePath,
            startByte: 0,
            endByte: source.length,
            signature: `${fileBase} ${routePath}`,
            summary: `Next.js ${specialKind} for ${routePath}`,
            frameworkMeta: {
              route_path: routePath,
              router: 'app',
              nextjs_special: specialKind,
            },
          },
        ];
      }

      case 'app-router-api': {
        const routePath = deriveAppRouterPath(p);
        const exportedNames = findExportedNames(tree);
        const methods = [...HTTP_METHODS].filter((m) => exportedNames.has(m));

        // If no known HTTP method exports found, emit a generic route symbol
        if (methods.length === 0) {
          return [
            {
              id: makeId(filePath, routePath, 'route'),
              name: routePath,
              kind: 'route',
              filePath,
              startByte: 0,
              endByte: source.length,
              signature: routePath,
              summary: `Next.js API route ${routePath}`,
              frameworkMeta: { route_path: routePath, api_route: true, router: 'app' },
            },
          ];
        }

        return methods.map((method) => ({
          id: makeId(filePath, `${method}:${routePath}`, 'route'),
          name: `${method} ${routePath}`,
          kind: 'route' as const,
          filePath,
          startByte: 0,
          endByte: source.length,
          signature: `${method} ${routePath}`,
          summary: `Next.js API route ${method} ${routePath}`,
          frameworkMeta: {
            route_path: routePath,
            http_method: method,
            api_route: true,
            router: 'app',
          },
        }));
      }

      case 'root-middleware': {
        return [
          {
            id: makeId(filePath, 'middleware', 'middleware'),
            name: 'middleware',
            kind: 'middleware',
            filePath,
            startByte: 0,
            endByte: source.length,
            signature: 'middleware',
            summary: 'Next.js middleware',
            frameworkMeta: { nextjs_middleware: true },
          },
        ];
      }

      default:
        return [];
    }
  },

  // ── Metadata enrichment ──────────────────────────────────────────────────────

  /**
   * Enrich component symbols emitted by the React adapter:
   *
   * - Components in pages/ → add route_path + nextjs_page: true
   * - Components in app/**\/page.{tsx,jsx} → add route_path + nextjs_page: true
   */
  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    if (symbol.kind !== 'component') return symbol;

    const p = normalizePath(symbol.filePath);

    // Pages Router component → enrich with route path
    if (p.startsWith('pages/') && !p.startsWith('pages/api/')) {
      const routePath = derivePageRouterPath(p);
      return {
        ...symbol,
        frameworkMeta: {
          ...symbol.frameworkMeta,
          route_path: routePath,
          nextjs_page: true,
        },
      };
    }

    // App Router page component
    if (p.startsWith('app/') && getCategory(p) === 'app-router-page') {
      const routePath = deriveAppRouterPath(p);
      return {
        ...symbol,
        frameworkMeta: {
          ...symbol.frameworkMeta,
          route_path: routePath,
          nextjs_page: true,
          router: 'app',
        },
      };
    }

    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(nextjsAdapter);
logger.debug("Adapter 'nextjs' registered");
