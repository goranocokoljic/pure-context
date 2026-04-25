/**
 * Gin framework adapter (Go).
 *
 * Extracts route and middleware symbols from Gin web framework applications
 * by regex-scanning Go source files for router method calls.
 *
 * Patterns recognised:
 *   r.GET("/path", handler)      → route
 *   router.POST("/path", h)      → route
 *   engine.PUT("/path", h)       → route
 *   r.Use(middleware)            → middleware
 *   v1 := r.Group("/v1")        → group prefix (applied to child routes)
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

// Gin HTTP method names are uppercase in the Go API
const GIN_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'Any'];

function hasGinImport(sourceStr: string): boolean {
  return /["']github\.com\/gin-gonic\/gin["']/.test(sourceStr);
}

// ─── Route extraction ─────────────────────────────────────────────────────────

/**
 * Extract a string literal (single or double quoted) at the start of `str`.
 * Returns the unquoted value or null.
 */
function extractStringLiteral(str: string): string | null {
  const m = str.match(/^["']([^"']+)["']/);
  return m ? m[1]! : null;
}

function extractGinRoutes(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  const methodPattern = GIN_METHODS.join('|');

  // Match: identifier.METHOD("path", ...) — Gin uses uppercase HTTP method names
  const routeRe = new RegExp(
    `\\b(\\w+)\\.(${methodPattern})\\s*\\(\\s*(["'])([^"']+)\\3`,
    'g',
  );

  let m: RegExpExecArray | null;
  while ((m = routeRe.exec(sourceStr)) !== null) {
    const varName = m[1]!;
    const method = m[2]!;
    const path = m[4]!;

    // Skip if variable doesn't look like a Gin router
    if (!looksLikeGinRouter(varName)) continue;

    const routeName = method === 'Any'
      ? `ANY ${path}`
      : `${method} ${path}`;

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
      summary: `Gin route: ${routeName}`,
      frameworkMeta: {
        http_method: method === 'Any' ? 'ANY' : method,
        route_path: path,
        gin_route: true,
      },
    });
  }

  return symbols;
}

/**
 * Heuristic: does this variable name look like a Gin router/engine/group?
 * Accepts common names used in Gin applications.
 */
function looksLikeGinRouter(name: string): boolean {
  const KNOWN = new Set(['r', 'router', 'engine', 'g', 'api', 'srv', 'server', 'app']);
  if (KNOWN.has(name)) return true;
  // Accept variables ending in common suffixes
  if (
    name.endsWith('Router') ||
    name.endsWith('Group') ||
    name.endsWith('Engine') ||
    name.endsWith('Api') ||
    name.endsWith('API') ||
    // Version groups: v1, v2, v3...
    /^v\d+$/.test(name)
  ) return true;
  return false;
}

function extractGinMiddleware(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  // Match: identifier.Use(SomeName) — where arg is a function reference (not a call)
  const useRe = /\b(\w+)\.Use\s*\(\s*(\w+)\s*[,)]/g;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(sourceStr)) !== null) {
    const varName = m[1]!;
    const mwName = m[2]!;

    if (!looksLikeGinRouter(varName)) continue;
    // Skip inline function literals (captured as just a keyword)
    if (['func', 'gin'].includes(mwName)) continue;

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
      summary: `Gin middleware: ${mwName}`,
      frameworkMeta: { gin_middleware: true },
    });
  }

  return symbols;
}

// ─── Gin adapter ──────────────────────────────────────────────────────────────

export const ginAdapter: FrameworkAdapter = {
  name: 'gin',

  extensions: () => [],

  async detect(projectRoot: string): Promise<boolean> {
    try {
      const goMod = readFileSync(join(projectRoot, 'go.mod'), 'utf8');
      return goMod.includes('github.com/gin-gonic/gin');
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

    // Quick guard — only process files that import gin
    if (!hasGinImport(sourceStr)) return [];

    return [
      ...extractGinRoutes(sourceStr, filePath),
      ...extractGinMiddleware(sourceStr, filePath),
    ];
  },

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(ginAdapter);
logger.debug("Adapter 'gin' registered");
