/**
 * FastAPI framework adapter.
 *
 * Extracts route symbols from FastAPI applications by scanning for decorator
 * patterns on endpoint functions. Only extracts routes where the path is a
 * string literal inside the decorator.
 *
 * Patterns recognised:
 *   @app.get('/path')         → GET /path
 *   @app.post('/path')        → POST /path
 *   @router.get('/path')      → GET /path  (APIRouter)
 *   @api.delete('/path')      → DELETE /path
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

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/**
 * Normalise FastAPI path parameters from {param_name} to :param_name.
 * e.g. /users/{user_id}      → /users/:user_id
 *      /items/{item_id}/tags → /items/:item_id/tags
 */
function normalisePath(path: string): string {
  return path.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, ':$1');
}

/**
 * Return true if source file imports FastAPI.
 */
function hasFastApiImport(sourceStr: string): boolean {
  return (
    /from\s+fastapi\s+import/.test(sourceStr) ||
    /import\s+fastapi\b/.test(sourceStr)
  );
}

// ─── Route extraction ─────────────────────────────────────────────────────────

function extractFastApiRoutes(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  const methodPattern = HTTP_METHODS.join('|');

  // Match: @identifier.get('/path') / @identifier.post('/path') etc.
  const routeRe = new RegExp(
    `^[ \\t]*@([\\w]+)\\.(${methodPattern})\\s*\\(\\s*(['"])([^'"]+)\\3`,
    'gm',
  );

  let m: RegExpExecArray | null;
  while ((m = routeRe.exec(sourceStr)) !== null) {
    const varName = m[1]!;
    const method = m[2]!;
    const rawPath = m[4]!;
    const normPath = normalisePath(rawPath);
    const routeName = `${method.toUpperCase()} ${normPath}`;

    if (seen.has(routeName)) continue;
    seen.add(routeName);

    symbols.push({
      id: makeId(filePath, routeName, 'route'),
      name: routeName,
      kind: 'route',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `@${varName}.${method}('${rawPath}', ...)`,
      summary: `FastAPI route: ${routeName}`,
      frameworkMeta: {
        http_method: method.toUpperCase(),
        route_path: rawPath,
        fastapi_route: true,
      },
    });
  }

  return symbols;
}

// ─── FastAPI adapter ──────────────────────────────────────────────────────────

export const fastapiAdapter: FrameworkAdapter = {
  name: 'fastapi',

  extensions: () => [],

  async detect(projectRoot: string): Promise<boolean> {
    // Check requirements.txt
    try {
      const req = readFileSync(join(projectRoot, 'requirements.txt'), 'utf8');
      if (/^\s*fastapi\b/im.test(req)) return true;
    } catch { /* file absent */ }

    // Check pyproject.toml
    try {
      const toml = readFileSync(join(projectRoot, 'pyproject.toml'), 'utf8');
      if (/["']fastapi\b/i.test(toml)) return true;
    } catch { /* file absent */ }

    return false;
  },

  fileFilter: (filePath: string): boolean => filePath.endsWith('.py'),

  extractFrameworkSymbols(
    _tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    const sourceStr = source.toString('utf8');

    // Quick guard — skip files that don't import FastAPI
    if (!hasFastApiImport(sourceStr)) return [];

    return extractFastApiRoutes(sourceStr, filePath);
  },

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(fastapiAdapter);
logger.debug("Adapter 'fastapi' registered");
