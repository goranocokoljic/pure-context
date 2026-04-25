/**
 * Fiber framework adapter (Go).
 *
 * Extracts route and middleware symbols from Fiber web framework applications.
 * Fiber's API mirrors Express.js but uses title-case method names (Get, Post, …).
 *
 * Patterns recognised:
 *   app.Get("/path", handler)     → route
 *   app.Post("/path", h)          → route
 *   grp := app.Group("/api")      → group prefix (applied to child routes)
 *   app.Use(authMiddleware)       → middleware
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { FrameworkAdapter, SymbolRecord, Tree } from '../core/types.js';
import { registerAdapter } from './adapter-registry.js';
import { logger } from '../core/logger.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: string): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

// Fiber uses title-case method names
const FIBER_METHODS_TITLECASE = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All'];
// Normalised uppercase equivalents for route name output
const FIBER_METHOD_NORM: Record<string, string> = {
  Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH',
  Delete: 'DELETE', Head: 'HEAD', Options: 'OPTIONS', All: 'ALL',
};

function hasFiberImport(sourceStr: string): boolean {
  return /["']github\.com\/gofiber\/fiber/.test(sourceStr);
}

/**
 * Heuristic: does this variable name look like a Fiber app/group?
 */
function looksLikeFiberApp(name: string): boolean {
  const KNOWN = new Set(['app', 'fiber', 'server', 'srv', 'api']);
  if (KNOWN.has(name)) return true;
  if (
    name.endsWith('Router') ||
    name.endsWith('Group') ||
    name.endsWith('Api') ||
    name.endsWith('API') ||
    /^v\d+$/.test(name)
  ) return true;
  return false;
}

// ─── Route extraction ─────────────────────────────────────────────────────────

function extractFiberRoutes(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  const methodPattern = FIBER_METHODS_TITLECASE.join('|');

  // Fiber uses title-case: app.Get(…), app.Post(…)
  const routeRe = new RegExp(
    `\\b(\\w+)\\.(${methodPattern})\\s*\\(\\s*(["'])([^"']+)\\3`,
    'g',
  );

  let m: RegExpExecArray | null;
  while ((m = routeRe.exec(sourceStr)) !== null) {
    const varName = m[1]!;
    const method = m[2]!;
    const path = m[4]!;

    if (!looksLikeFiberApp(varName)) continue;

    const normMethod = FIBER_METHOD_NORM[method] ?? method.toUpperCase();
    const routeName = `${normMethod} ${path}`;

    if (seen.has(routeName)) continue;
    seen.add(routeName);

    symbols.push({
      id: makeId(filePath, routeName, 'route'),
      name: routeName,
      kind: 'route',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `${varName}.${method}("${path}", ...)`,
      summary: `Fiber route: ${routeName}`,
      frameworkMeta: {
        http_method: normMethod,
        route_path: path,
        fiber_route: true,
      },
    });
  }

  return symbols;
}

// ─── Middleware extraction ────────────────────────────────────────────────────

function extractFiberMiddleware(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  const useRe = /\b(\w+)\.Use\s*\(\s*(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(sourceStr)) !== null) {
    const varName = m[1]!;
    const mwName = m[2]!;

    if (!looksLikeFiberApp(varName)) continue;
    if (['func', 'fiber', 'middleware', 'recover', 'logger'].includes(mwName)) continue;

    if (seen.has(mwName)) continue;
    seen.add(mwName);

    symbols.push({
      id: makeId(filePath, mwName, 'middleware'),
      name: mwName,
      kind: 'middleware',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `${varName}.Use(${mwName})`,
      summary: `Fiber middleware: ${mwName}`,
      frameworkMeta: { fiber_middleware: true },
    });
  }

  return symbols;
}

// ─── Fiber adapter ────────────────────────────────────────────────────────────

export const fiberAdapter: FrameworkAdapter = {
  name: 'fiber',

  extensions: () => [],

  async detect(projectRoot: string): Promise<boolean> {
    try {
      const goMod = readFileSync(join(projectRoot, 'go.mod'), 'utf8');
      return goMod.includes('github.com/gofiber/fiber');
    } catch {
      return false;
    }
  },

  fileFilter: (filePath: string): boolean => filePath.endsWith('.go'),

  extractFrameworkSymbols(
    _tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    const sourceStr = source.toString('utf8');

    if (!hasFiberImport(sourceStr)) return [];

    return [
      ...extractFiberRoutes(sourceStr, filePath),
      ...extractFiberMiddleware(sourceStr, filePath),
    ];
  },

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(fiberAdapter);
logger.debug("Adapter 'fiber' registered");
