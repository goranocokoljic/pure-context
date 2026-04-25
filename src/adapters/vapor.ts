/**
 * Vapor framework adapter (server-side Swift).
 *
 * Detects Vapor projects via Package.swift containing `vapor/vapor`.
 * Extracts route and middleware symbols from Swift source files using
 * regex-based pattern matching on Vapor's routing DSL:
 *
 *   app.get("users", ":id", use: handler)       → GET /users/:id
 *   app.post("users", use: create)              → POST /users
 *   app.webSocket("chat", onUpgrade: handler)   → WEBSOCKET /chat
 *   app.middleware.use(CORSMiddleware())         → middleware
 *
 * Also emits `RouteCollection`-conforming classes/structs as class symbols
 * with `vapor_route_collection: true`.
 *
 * Path components that are not string literals (e.g. PathComponent.catchall)
 * are skipped; only `"string"` and `":param"` literals are recognised.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { extname } from 'path';
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

// ─── Constants ────────────────────────────────────────────────────────────────

const VAPOR_HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

/** All Vapor router variable names / patterns to recognise. */
const VAPOR_ROUTER_RE = /^(?:app|routes?|router|grouped|api|v\d+)$/;

// ─── Route extraction helpers ─────────────────────────────────────────────────

/**
 * Extract consecutive string-literal path components from a Vapor argument list.
 *
 * Vapor uses variadic path components:
 *   `app.get("users", ":id", use: handler)`
 *
 * We read args until we hit a non-string-literal argument (e.g. `use:`, a
 * variable reference, or a closure). Returns an array of path segments.
 */
function extractPathComponents(argsText: string): string[] {
  const parts: string[] = [];
  // Match all leading string literals (before any `label:` keyword argument)
  // Pattern: optional leading whitespace, a double-quoted string, optionally followed by ,
  const re = /^\s*"([^"\\]*)"\s*(?:,\s*)?/;
  let remaining = argsText.trim();

  while (remaining.length > 0) {
    // Stop at keyword arguments (e.g. `use:`, `onUpgrade:`, `body:`)
    if (/^[a-zA-Z_]\w*\s*:/.test(remaining)) break;

    const m = remaining.match(re);
    if (!m) break; // not a string literal — stop

    parts.push(m[1]!);
    remaining = remaining.slice(m[0]!.length);
  }

  return parts;
}

/**
 * Build a URL path string from Vapor path segments.
 * Segments starting with `:` are kept as-is (dynamic params).
 * Returns `/` for empty paths, or `/<seg1>/<seg2>/...` otherwise.
 */
function buildRoutePath(segments: string[]): string {
  if (segments.length === 0) return '/';
  return '/' + segments.join('/');
}

// ─── Route extraction ─────────────────────────────────────────────────────────

interface RouteMatch {
  varName: string;
  method: string;
  argsText: string;
  fullMatch: string;
}

/**
 * Find all `varName.method(args)` calls for Vapor HTTP methods.
 * Uses a simple scanner that reads character-by-character to handle
 * nested parentheses correctly.
 */
function findVaporRouteCalls(source: string): RouteMatch[] {
  const methods = [...VAPOR_HTTP_METHODS, 'webSocket'] as string[];
  const methodSet = new Set(methods);
  const results: RouteMatch[] = [];

  // Quick check — avoid expensive processing on non-Vapor files
  if (!methods.some((m) => source.includes(`.${m}(`))) return results;

  const pattern = new RegExp(
    `\\b(\\w+)\\.(${methods.join('|')})\\s*\\(`,
    'g',
  );

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const varName = match[1]!;
    const method = match[2]!;

    if (!methodSet.has(method)) continue;
    if (!VAPOR_ROUTER_RE.test(varName)) continue;

    // Collect the argument text up to the matching closing paren
    const openPos = match.index + match[0]!.length;
    let depth = 1;
    let i = openPos;
    while (i < source.length && depth > 0) {
      const ch = source[i]!;
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === '"') {
        // Skip string literals to avoid counting parens inside strings
        i++;
        while (i < source.length && source[i] !== '"') {
          if (source[i] === '\\') i++; // skip escaped char
          i++;
        }
      }
      i++;
    }
    const argsText = source.slice(openPos, i - 1);
    const fullMatch = source.slice(match.index, i);

    results.push({ varName, method, argsText, fullMatch });
  }

  return results;
}

/**
 * Extract Vapor route symbols from the source text of a `.swift` file.
 */
function extractVaporRoutes(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  const calls = findVaporRouteCalls(source);

  for (const { method, argsText } of calls) {
    const isWebSocket = method === 'webSocket';
    const httpMethod = isWebSocket ? 'WEBSOCKET' : method.toUpperCase();

    const segments = extractPathComponents(argsText);
    const routePath = buildRoutePath(segments);
    const routeName = `${httpMethod} ${routePath}`;

    if (seen.has(routeName)) continue;
    seen.add(routeName);

    symbols.push({
      id: makeId(filePath, routeName, 'route'),
      name: routeName,
      kind: 'route',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `${method}(${segments.map((s) => `"${s}"`).join(', ')})`,
      summary: `Vapor route: ${routeName}`,
      frameworkMeta: {
        http_method: httpMethod,
        route_path: routePath,
        vapor_route: true,
      },
    });
  }

  return symbols;
}

// ─── Middleware extraction ────────────────────────────────────────────────────

/**
 * Extract `app.middleware.use(SomeMiddleware(...))` calls.
 * Returns the middleware type names as 'middleware' symbols.
 */
function extractVaporMiddleware(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  // Pattern: app.middleware.use(TypeName(...)) or app.middleware.use(TypeName())
  const re = /\b\w+\.middleware\.use\s*\(\s*([A-Z][A-Za-z0-9_]*)\s*[(\)]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const typeName = m[1]!;
    if (seen.has(typeName)) continue;
    seen.add(typeName);

    symbols.push({
      id: makeId(filePath, typeName, 'middleware'),
      name: typeName,
      kind: 'middleware',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `app.middleware.use(${typeName}(...))`,
      summary: `Vapor middleware: ${typeName}`,
      frameworkMeta: { vapor_middleware: true },
    });
  }

  return symbols;
}

// ─── RouteCollection extraction ───────────────────────────────────────────────

/**
 * Find classes and structs conforming to `RouteCollection` and emit them
 * as 'class' symbols with `vapor_route_collection: true`.
 */
function extractRouteCollections(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  // Pattern: `class Name: ..., RouteCollection, ...` or `struct Name: RouteCollection`
  // Also handles `class Name: RouteCollection` with optional protocol list
  const re = /\b(class|struct)\s+([A-Z][A-Za-z0-9_]*)\s*:[^{]*\bRouteCollection\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const declKind = m[1]!;
    const name = m[2]!;
    if (seen.has(name)) continue;
    seen.add(name);

    // Build a short signature from the declaration line up to `{`
    const declStart = m.index;
    const braceIdx = source.indexOf('{', declStart);
    const declLine = (braceIdx >= 0 ? source.slice(declStart, braceIdx) : m[0]!)
      .replace(/\s+/g, ' ')
      .trim();
    const sig = declLine.length > 120 ? declLine.slice(0, 117) + '...' : declLine;

    symbols.push({
      id: makeId(filePath, name, 'class'),
      name,
      kind: 'class',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: sig,
      summary: `Vapor RouteCollection: ${name}`,
      frameworkMeta: {
        vapor_route_collection: true,
        declaration_kind: declKind,
      },
    });
  }

  return symbols;
}

// ─── Vapor adapter ─────────────────────────────────────────────────────────────

export const vaporAdapter: FrameworkAdapter = {
  name: 'vapor',

  /** `.swift` files are handled by the Swift handler — no new extension needed. */
  extensions: () => [],

  // ── Detection ─────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    try {
      const content = readFileSync(`${projectRoot}/Package.swift`, 'utf8');
      // Check for Vapor dependency: `.package(url: "...vapor/vapor...", ...)`
      return /\.package\s*\(.*["']https:\/\/github\.com\/vapor\/vapor/i.test(content);
    } catch {
      return false;
    }
  },

  // ── File routing ───────────────────────────────────────────────────────────

  fileFilter: (filePath: string) => extname(filePath) === '.swift',

  // ── Framework symbol extraction ────────────────────────────────────────────

  extractFrameworkSymbols(
    _tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    const sourceStr = source.toString('utf8');

    // Quick bail — avoid scanning non-Vapor files
    const hasVaporImport =
      /\bimport\s+Vapor\b/.test(sourceStr) ||
      /\bRouteCollection\b/.test(sourceStr) ||
      /\bmiddleware\.use\b/.test(sourceStr) ||
      VAPOR_HTTP_METHODS.some((m) => sourceStr.includes(`.${m}(`));
    if (!hasVaporImport) return [];

    return [
      ...extractVaporRoutes(sourceStr, filePath),
      ...extractVaporMiddleware(sourceStr, filePath),
      ...extractRouteCollections(sourceStr, filePath),
    ];
  },

  // ── Metadata enrichment ────────────────────────────────────────────────────

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(vaporAdapter);
logger.debug("Adapter 'vapor' registered");
