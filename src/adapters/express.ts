/**
 * Express framework adapter.
 *
 * Extracts route symbols from Express procedural route definitions.
 * Only extracts routes with string literal paths (not dynamic constructions).
 *
 * Patterns recognised:
 *   app.get('/path', handler)
 *   app.post('/path', handler)
 *   router.get('/path', handler)
 *   app.use('/path', middleware) → kind 'middleware'
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
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

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

// ─── Route extraction ─────────────────────────────────────────────────────────

/**
 * Heuristic: check if the source declares an Express app or router.
 * Returns true if `express()` or `express.Router()` is called.
 */
function hasExpressSetup(sourceStr: string): boolean {
  return (
    /\bexpress\s*\(\s*\)/.test(sourceStr) ||
    /\bexpress\.Router\s*\(\s*\)/.test(sourceStr) ||
    /require\s*\(\s*['"]express['"]\s*\)/.test(sourceStr) ||
    /from\s+['"]express['"]/.test(sourceStr)
  );
}

/**
 * Extract Express route symbols from source text.
 * Only extracts routes where the path is a string literal.
 */
function extractExpressRoutes(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];

  // Match: identifier.method('path', ...) where method is an HTTP verb or 'use'
  // The identifier can be app, router, or any variable that assigned express()/Router()
  const allMethods = [...HTTP_METHODS, 'use'];
  const methodPattern = allMethods.join('|');

  // Regex: \w+.(get|post|...)('/path', ...) with string literal path
  const routeRe = new RegExp(
    `\\b(\\w+)\\.(${methodPattern})\\s*\\(\\s*(['"\`])([^'"\`]+)\\3`,
    'g',
  );

  let m;
  while ((m = routeRe.exec(sourceStr)) !== null) {
    const varName = m[1]!;
    const method = m[2]!;
    const path = m[4]!;

    // Heuristic: skip if this doesn't look like Express usage
    // Allow common Express variable names
    if (
      !['app', 'router', 'server', 'api', 'v1', 'v2'].includes(varName) &&
      !varName.endsWith('Router') &&
      !varName.endsWith('App')
    ) {
      continue;
    }

    if (method === 'use') {
      const routeName = `MW ${path}`;
      if (!symbols.some((s) => s.name === routeName)) {
        symbols.push({
          id: makeId(filePath, routeName, 'middleware'),
          name: routeName,
          kind: 'middleware',
          filePath,
          startByte: 0,
          endByte: 0,
          signature: `${varName}.use('${path}', ...)`,
          summary: `Express middleware: ${path}`,
          frameworkMeta: { http_framework: 'express', prefix_unknown: true },
        });
      }
    } else {
      const httpMethod = method.toUpperCase();
      const routeName = `${httpMethod} ${path}`;
      if (!symbols.some((s) => s.name === routeName)) {
        symbols.push({
          id: makeId(filePath, routeName, 'route'),
          name: routeName,
          kind: 'route',
          filePath,
          startByte: 0,
          endByte: 0,
          signature: `${varName}.${method}('${path}', ...)`,
          summary: `Express route: ${routeName}`,
          frameworkMeta: { http_method: httpMethod, http_framework: 'express' },
        });
      }
    }
  }

  return symbols;
}

// ─── Express adapter ──────────────────────────────────────────────────────────

export const expressAdapter: FrameworkAdapter = {
  name: 'express',

  extensions: () => [],

  async detect(projectRoot: string): Promise<boolean> {
    try {
      const raw = readFileSync(`${projectRoot}/package.json`, 'utf8');
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      const deps = Object.assign(
        {},
        pkg['dependencies'] as Record<string, string> | undefined,
        pkg['devDependencies'] as Record<string, string> | undefined,
      );
      return 'express' in deps;
    } catch {
      return false;
    }
  },

  fileFilter: (filePath: string): boolean =>
    filePath.endsWith('.ts') || filePath.endsWith('.js'),

  extractFrameworkSymbols(
    _tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    const sourceStr = source.toString('utf8');

    // Quick check — skip files that don't look like Express
    if (!hasExpressSetup(sourceStr)) return [];

    return extractExpressRoutes(sourceStr, filePath);
  },

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(expressAdapter);
logger.debug("Adapter 'express' registered");
