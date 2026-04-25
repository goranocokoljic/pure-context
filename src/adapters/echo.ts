/**
 * Echo framework adapter (Go).
 *
 * Extracts route and middleware symbols from Echo web framework applications
 * by regex-scanning Go source files for router method calls.
 *
 * Patterns recognised:
 *   e.GET("/path", handler)       → route
 *   e.POST("/path", h)            → route
 *   g := e.Group("/api")          → group prefix (applied to child routes)
 *   e.Use(middleware.Logger())    → middleware
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

// Echo HTTP method names are uppercase (same as Gin)
const ECHO_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'Any'];

function hasEchoImport(sourceStr: string): boolean {
  return /["']github\.com\/labstack\/echo/.test(sourceStr);
}

/**
 * Heuristic: does this variable name look like an Echo instance/group?
 */
function looksLikeEchoRouter(name: string): boolean {
  const KNOWN = new Set(['e', 'echo', 'server', 'srv', 'app', 'api', 'g']);
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

function extractEchoRoutes(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  const methodPattern = ECHO_METHODS.join('|');

  const routeRe = new RegExp(
    `\\b(\\w+)\\.(${methodPattern})\\s*\\(\\s*(["'])([^"']+)\\3`,
    'g',
  );

  let m: RegExpExecArray | null;
  while ((m = routeRe.exec(sourceStr)) !== null) {
    const varName = m[1]!;
    const method = m[2]!;
    const path = m[4]!;

    if (!looksLikeEchoRouter(varName)) continue;

    const routeName = method === 'Any' ? `ANY ${path}` : `${method} ${path}`;

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
      summary: `Echo route: ${routeName}`,
      frameworkMeta: {
        http_method: method === 'Any' ? 'ANY' : method,
        route_path: path,
        echo_route: true,
      },
    });
  }

  return symbols;
}

// ─── Middleware extraction ────────────────────────────────────────────────────

function extractEchoMiddleware(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  // Match: identifier.Use(SomeName) or identifier.Use(pkg.SomeName())
  // Capture the first token (function or package) as the middleware name
  const useRe = /\b(\w+)\.Use\s*\(\s*(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(sourceStr)) !== null) {
    const varName = m[1]!;
    const mwName = m[2]!;

    if (!looksLikeEchoRouter(varName)) continue;
    if (['func', 'echo', 'middleware'].includes(mwName)) continue;

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
      summary: `Echo middleware: ${mwName}`,
      frameworkMeta: { echo_middleware: true },
    });
  }

  return symbols;
}

// ─── Echo adapter ─────────────────────────────────────────────────────────────

export const echoAdapter: FrameworkAdapter = {
  name: 'echo',

  extensions: () => [],

  async detect(projectRoot: string): Promise<boolean> {
    try {
      const goMod = readFileSync(join(projectRoot, 'go.mod'), 'utf8');
      return goMod.includes('github.com/labstack/echo');
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

    if (!hasEchoImport(sourceStr)) return [];

    return [
      ...extractEchoRoutes(sourceStr, filePath),
      ...extractEchoMiddleware(sourceStr, filePath),
    ];
  },

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(echoAdapter);
logger.debug("Adapter 'echo' registered");
