/**
 * Axum framework adapter (Rust).
 *
 * Extracts route, middleware (layer), and extractor symbols from Axum web
 * applications. Axum uses a tower-based routing DSL with method chaining:
 *
 *   Router::new().route("/path", get(handler))           → GET /path
 *   .route("/path", get(h).post(h2))                     → GET /path, POST /path
 *   .nest("/api", sub_router)                            → nested prefix
 *   .layer(CorsLayer::permissive())                      → middleware
 *   impl FromRequest<S> for AuthUser                     → extractor type
 *   #[derive(FromRequest)]                               → extractor type
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

// ─── Constants ────────────────────────────────────────────────────────────────

const AXUM_HTTP_METHODS = [
  'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace',
] as const;

// ─── Argument collector ───────────────────────────────────────────────────────

/**
 * Collect the full text inside a parenthesised call, handling nested parens
 * and string literals. `pos` must point to the character immediately after
 * the opening `(`. Returns the inner text (excluding the outer parens), or
 * null if the parens are unbalanced.
 */
function collectArgs(source: string, pos: number): string | null {
  let depth = 1;
  const start = pos;
  let inString = false;
  let stringChar = '';

  while (pos < source.length && depth > 0) {
    const ch = source[pos]!;
    if (inString) {
      if (ch === '\\') {
        pos++; // skip escaped character
      } else if (ch === stringChar) {
        inString = false;
      }
    } else {
      if (ch === '"' || ch === '\'') {
        inString = true;
        stringChar = ch;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
      }
    }
    pos++;
  }

  if (depth !== 0) return null;
  return source.slice(start, pos - 1);
}

// ─── Route extraction ─────────────────────────────────────────────────────────

/**
 * Extract HTTP method names from an Axum method chain such as
 * `get(handler).post(h2).delete(h3)`.
 */
function extractMethods(methodChain: string): string[] {
  const methods: string[] = [];
  const re = new RegExp(`\\b(${AXUM_HTTP_METHODS.join('|')})\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(methodChain)) !== null) {
    const upper = m[1]!.toUpperCase();
    if (!methods.includes(upper)) methods.push(upper);
  }
  return methods;
}

/**
 * Scan for `.route("path", method_chain)` calls and emit one route symbol per
 * HTTP method found in the second argument.
 */
function extractAxumRoutes(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  const routeRe = /\.route\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = routeRe.exec(source)) !== null) {
    const argsPos = m.index + m[0]!.length;
    const argsText = collectArgs(source, argsPos);
    if (!argsText) continue;

    // First argument: a string literal path
    const pathMatch = argsText.match(/^\s*"([^"]+)"\s*,/);
    if (!pathMatch) continue;
    const routePath = pathMatch[1]!;

    // Second argument: method handler chain
    const afterPath = argsText.slice(pathMatch[0]!.length);
    const methods = extractMethods(afterPath);

    for (const method of methods) {
      const routeName = `${method} ${routePath}`;
      if (seen.has(routeName)) continue;
      seen.add(routeName);

      symbols.push({
        id: makeId(filePath, routeName, 'route'),
        name: routeName,
        kind: 'route',
        filePath,
        startByte: 0,
        endByte: 0,
        signature: `.route("${routePath}", ${method.toLowerCase()}(...))`,
        summary: `Axum route: ${routeName}`,
        frameworkMeta: {
          http_method: method,
          route_path: routePath,
          axum_route: true,
        },
      });
    }
  }

  return symbols;
}

// ─── Nested router extraction ─────────────────────────────────────────────────

/**
 * Scan for `.nest("/prefix", sub_router)` calls and emit a route symbol
 * representing the mount point. The prefix is preserved so callers can
 * understand the URL hierarchy.
 */
function extractAxumNests(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  const nestRe = /\.nest\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = nestRe.exec(source)) !== null) {
    const argsPos = m.index + m[0]!.length;
    const argsText = collectArgs(source, argsPos);
    if (!argsText) continue;

    const pathMatch = argsText.match(/^\s*"([^"]+)"\s*,/);
    if (!pathMatch) continue;
    const prefix = pathMatch[1]!;

    if (seen.has(prefix)) continue;
    seen.add(prefix);

    symbols.push({
      id: makeId(filePath, `NEST ${prefix}`, 'route'),
      name: `NEST ${prefix}`,
      kind: 'route',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `.nest("${prefix}", ...)`,
      summary: `Axum nested router prefix: ${prefix}`,
      frameworkMeta: {
        route_path: prefix,
        axum_nest: true,
      },
    });
  }

  return symbols;
}

// ─── Layer (middleware) extraction ────────────────────────────────────────────

/**
 * Scan for `.layer(...)` calls and emit a middleware symbol named after the
 * first type identifier in the argument (e.g. `CorsLayer` from
 * `CorsLayer::permissive()`).
 */
function extractAxumLayers(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  const layerRe = /\.layer\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = layerRe.exec(source)) !== null) {
    const argsPos = m.index + m[0]!.length;
    const argsText = collectArgs(source, argsPos);
    if (!argsText) continue;

    // Extract the leading type path: `CorsLayer::permissive` → `CorsLayer`
    const typeMatch = argsText.trim().match(
      /^([A-Za-z][A-Za-z0-9_]*(?:::[A-Za-z][A-Za-z0-9_]*)*)/,
    );
    if (!typeMatch) continue;

    // Use only the first segment as the symbol name (e.g. `CorsLayer`)
    const typeName = typeMatch[1]!.split('::')[0]!;

    if (seen.has(typeName)) continue;
    seen.add(typeName);

    symbols.push({
      id: makeId(filePath, typeName, 'middleware'),
      name: typeName,
      kind: 'middleware',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `.layer(${typeName}(...))`,
      summary: `Axum layer: ${typeName}`,
      frameworkMeta: {
        axum_layer: true,
      },
    });
  }

  return symbols;
}

// ─── FromRequest extractor extraction ────────────────────────────────────────

/**
 * Scan for Axum request extractor types:
 *   - `#[derive(..., FromRequest, ...)]` on a struct or enum
 *   - `impl [<bounds>] [path::]FromRequest[<params>] for TypeName`
 *
 * Both forms emit a `type` symbol with `axum_extractor: true`.
 */
function extractAxumExtractors(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  function emit(name: string): void {
    if (seen.has(name)) return;
    seen.add(name);
    symbols.push({
      id: makeId(filePath, name, 'type'),
      name,
      kind: 'type',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `impl FromRequest for ${name}`,
      summary: `Axum extractor: ${name}`,
      frameworkMeta: { axum_extractor: true },
    });
  }

  // #[derive(...FromRequest...)] followed by pub? struct|enum Name
  const deriveRe =
    /#\[derive\([^\]]*\bFromRequest\b[^\]]*\)\][\s\S]*?(?:pub\s+(?:\([^)]*\)\s+)?)?(?:struct|enum)\s+([A-Za-z][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = deriveRe.exec(source)) !== null) {
    emit(m[1]!);
  }

  // impl [<...>] [path::]FromRequest[<...>] for TypeName
  const implRe =
    /\bimpl(?:\s*<[^>]*>)?\s+(?:\w+::)*FromRequest(?:\s*<[^>]*>)?\s+for\s+([A-Za-z][A-Za-z0-9_]*)/g;
  while ((m = implRe.exec(source)) !== null) {
    emit(m[1]!);
  }

  return symbols;
}

// ─── Axum import guard ────────────────────────────────────────────────────────

/**
 * Quick check — only process files that reference axum. Avoids scanning
 * every `.rs` file in non-Axum projects that happen to use the same patterns.
 */
function hasAxumUsage(source: string): boolean {
  return /\baxum\b/.test(source);
}

// ─── Axum adapter ─────────────────────────────────────────────────────────────

export const axumAdapter: FrameworkAdapter = {
  name: 'axum',

  /** `.rs` files are handled by the Rust language handler — no new extension. */
  extensions: () => [],

  // ── Detection ─────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    try {
      const cargoToml = readFileSync(join(projectRoot, 'Cargo.toml'), 'utf8');
      // Match `axum = "..."` or `axum = { version = "..." }`
      return /\baxum\s*=/.test(cargoToml);
    } catch {
      return false;
    }
  },

  // ── File routing ───────────────────────────────────────────────────────────

  fileFilter: (filePath: string): boolean => filePath.endsWith('.rs'),

  // ── Framework symbol extraction ────────────────────────────────────────────

  extractFrameworkSymbols(
    _tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    const sourceStr = source.toString('utf8');

    if (!hasAxumUsage(sourceStr)) return [];

    return [
      ...extractAxumRoutes(sourceStr, filePath),
      ...extractAxumNests(sourceStr, filePath),
      ...extractAxumLayers(sourceStr, filePath),
      ...extractAxumExtractors(sourceStr, filePath),
    ];
  },

  // ── Metadata enrichment ────────────────────────────────────────────────────

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(axumAdapter);
logger.debug("Adapter 'axum' registered");
