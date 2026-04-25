/**
 * Flask framework adapter.
 *
 * Extracts route symbols from Flask applications by scanning for decorator
 * patterns on view functions. Only extracts routes where the path is a string
 * literal inside the decorator.
 *
 * Patterns recognised:
 *   @app.route('/path')                        → GET /path (default)
 *   @app.route('/path', methods=['GET','POST']) → GET /path + POST /path
 *   @app.get('/path')                          → GET /path
 *   @app.post('/path')                         → POST /path
 *   @bp.route('/path')                         → GET /path  (Blueprint)
 *   class MyView(MethodView): ...              → view symbol
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
 * Normalise Flask path parameters from <type:name> / <name> to :name.
 * e.g. /users/<int:user_id> → /users/:user_id
 *      /posts/<slug>        → /posts/:slug
 */
function normalisePath(path: string): string {
  return path.replace(/<(?:[a-zA-Z_][a-zA-Z0-9_]*:)?([a-zA-Z_][a-zA-Z0-9_]*)>/g, ':$1');
}

/**
 * Return true if source file imports Flask (classic or factory pattern).
 */
function hasFlaskImport(sourceStr: string): boolean {
  return (
    /from\s+flask\s+import/.test(sourceStr) ||
    /import\s+flask\b/.test(sourceStr)
  );
}

/**
 * Extract HTTP methods from a `methods=[...]` keyword argument string.
 * e.g. "methods=['GET', 'POST']" → ['GET', 'POST']
 * Returns null if no methods argument is found (caller should use default).
 */
function extractMethods(decoratorArgs: string): string[] | null {
  const m = decoratorArgs.match(/methods\s*=\s*\[([^\]]*)\]/);
  if (!m) return null;
  const methods: string[] = [];
  const inner = m[1]!;
  for (const match of inner.matchAll(/['"]([A-Za-z]+)['"]/g)) {
    methods.push(match[1]!.toUpperCase());
  }
  return methods.length > 0 ? methods : null;
}

// ─── Route extraction ─────────────────────────────────────────────────────────

function extractFlaskRoutes(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  function addRoute(
    httpMethod: string,
    rawPath: string,
    varName: string,
    decoratorLine: string,
  ): void {
    const normPath = normalisePath(rawPath);
    const routeName = `${httpMethod.toUpperCase()} ${normPath}`;
    if (seen.has(routeName)) return;
    seen.add(routeName);
    symbols.push({
      id: makeId(filePath, routeName, 'route'),
      name: routeName,
      kind: 'route',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `@${varName}.${httpMethod}('${rawPath}', ...)`,
      summary: `Flask route: ${routeName}`,
      frameworkMeta: {
        http_method: httpMethod.toUpperCase(),
        route_path: rawPath,
        flask_route: true,
        decorator: decoratorLine.trim().slice(0, 80),
      },
    });
  }

  // Pattern 1: @identifier.route('/path', ...)
  // Captures: (varName, path, rest-of-args-on-same-line)
  const routeRe = /^[ \t]*@([\w]+)\.route\s*\(\s*(['"])([^'"]+)\2([^)]*)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = routeRe.exec(sourceStr)) !== null) {
    const varName = m[1]!;
    const rawPath = m[3]!;
    const rest = m[4]!;
    const fullDecorator = m[0]!;
    const methods = extractMethods(rest);
    for (const method of (methods ?? ['GET'])) {
      addRoute(method, rawPath, varName, fullDecorator);
    }
  }

  // Pattern 2: @identifier.get('/path') / .post() / etc.
  const methodPattern = HTTP_METHODS.join('|');
  const shorthandRe = new RegExp(
    `^[ \\t]*@([\\w]+)\\.(${methodPattern})\\s*\\(\\s*(['"])([^'"]+)\\3`,
    'gm',
  );
  while ((m = shorthandRe.exec(sourceStr)) !== null) {
    const varName = m[1]!;
    const method = m[2]!;
    const rawPath = m[4]!;
    addRoute(method, rawPath, varName, m[0]!);
  }

  return symbols;
}

/**
 * Extract class-based view symbols (MethodView / View subclasses).
 */
function extractClassViews(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  // Match: class Name(MethodView): or class Name(View):
  const re = /^class\s+(\w+)\s*\([^)]*(?:MethodView|View)[^)]*\)\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sourceStr)) !== null) {
    const name = m[1]!;
    symbols.push({
      id: makeId(filePath, name, 'view'),
      name,
      kind: 'view',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: m[0]!.trim(),
      summary: `Flask class-based view: ${name}`,
      frameworkMeta: { flask_class_view: true },
    });
  }
  return symbols;
}

// ─── Flask adapter ────────────────────────────────────────────────────────────

export const flaskAdapter: FrameworkAdapter = {
  name: 'flask',

  extensions: () => [],

  async detect(projectRoot: string): Promise<boolean> {
    // Check requirements.txt
    try {
      const req = readFileSync(join(projectRoot, 'requirements.txt'), 'utf8');
      if (/^\s*[Ff]lask\s*([>=<!]|$)/m.test(req)) return true;
    } catch { /* file absent */ }

    // Check pyproject.toml
    try {
      const toml = readFileSync(join(projectRoot, 'pyproject.toml'), 'utf8');
      if (/["']flask\b/i.test(toml)) return true;
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

    // Quick guard — skip files that don't import Flask
    if (!hasFlaskImport(sourceStr)) return [];

    return [
      ...extractFlaskRoutes(sourceStr, filePath),
      ...extractClassViews(sourceStr, filePath),
    ];
  },

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(flaskAdapter);
logger.debug("Adapter 'flask' registered");
