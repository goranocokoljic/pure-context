/**
 * Actix-web framework adapter (Rust).
 *
 * Extracts route, middleware, and extractor symbols from Actix-web applications.
 * Actix supports two route definition styles:
 *
 *   Attribute macros (common):
 *     #[get("/users")]
 *     async fn list_users() -> impl Responder { ... }
 *
 *   Programmatic (web::resource / web::scope):
 *     web::resource("/users")
 *         .route(web::get().to(list_users))
 *         .route(web::post().to(create_user))
 *
 *   Scope prefix:
 *     web::scope("/api/v2")
 *         .service(...)
 *
 *   Middleware via .wrap():
 *     .wrap(actix_web::middleware::Logger::default())
 *
 *   Extractor via impl FromRequest:
 *     impl FromRequest for AuthUser { ... }
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

const ACTIX_HTTP_METHODS = [
  'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace', 'connect',
] as const;

// ─── Argument collector ───────────────────────────────────────────────────────

/**
 * Collect the full text inside a parenthesised call, handling nested parens
 * and string literals. `pos` must point immediately after the opening `(`.
 * Returns inner text (sans outer parens), or null if unbalanced.
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
        pos++;
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

/**
 * Collect a method-chaining expression starting at `pos`. Advances until a
 * semicolon or unmatched closing bracket/paren/brace at depth 0 is reached.
 */
function collectMethodChain(source: string, pos: number): string {
  let depth = 0;
  const start = pos;

  while (pos < source.length) {
    const ch = source[pos]!;
    if (ch === '(' || ch === '{' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === '}' || ch === ']') {
      if (depth === 0) break;
      depth--;
    } else if (ch === ';' && depth === 0) {
      break;
    }
    pos++;
  }

  return source.slice(start, pos);
}

// ─── Attribute macro route extraction ────────────────────────────────────────

/**
 * Extract routes defined via Actix attribute macros:
 *   #[get("/path")]          → GET /path
 *   #[actix_web::get("/path")] → GET /path
 *   #[route(GET, path = "/path")] is not handled (use programmatic style instead)
 *
 * The attribute immediately precedes an `async fn` or `fn` declaration; the
 * route path is taken from the attribute argument.
 */
function extractActixMacroRoutes(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  const methodPat = ACTIX_HTTP_METHODS.join('|');
  // Match: #[optional::path::get("/path")]
  const re = new RegExp(
    `#\\[(?:[\\w]+::)*(${methodPat})\\s*\\(\\s*"([^"]+)"`,
    'g',
  );

  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const method = m[1]!.toUpperCase();
    const routePath = m[2]!;
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
      signature: `#[${m[1]!}("${routePath}")]`,
      summary: `Actix route: ${routeName}`,
      frameworkMeta: {
        http_method: method,
        route_path: routePath,
        actix_route: true,
      },
    });
  }

  return symbols;
}

// ─── Programmatic route extraction (web::resource) ────────────────────────────

/**
 * Extract routes from `web::resource("/path").route(web::METHOD().to(handler))`
 * chains. Collects the full method chain after each `web::resource(...)` call
 * and scans it for `.route(web::METHOD()...)` patterns.
 */
function extractActixResourceRoutes(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  const methodPat = ACTIX_HTTP_METHODS.join('|');
  // Inner pattern: .route(web::METHOD()...)
  const innerRouteRe = new RegExp(
    `\\.route\\s*\\(\\s*web::(${methodPat})\\s*\\(`,
    'g',
  );

  const resourceRe = /\bweb::resource\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = resourceRe.exec(source)) !== null) {
    const pathArgPos = m.index + m[0]!.length;
    const pathArgs = collectArgs(source, pathArgPos);
    if (!pathArgs) continue;

    const pathMatch = pathArgs.match(/^\s*"([^"]+)"\s*$/);
    if (!pathMatch) continue;
    const resourcePath = pathMatch[1]!;

    // Collect the chained .route() calls that follow
    const chainStart = pathArgPos + pathArgs.length + 1; // skip closing )
    const chain = collectMethodChain(source, chainStart);

    innerRouteRe.lastIndex = 0;
    let rm: RegExpExecArray | null;
    while ((rm = innerRouteRe.exec(chain)) !== null) {
      const method = rm[1]!.toUpperCase();
      const routeName = `${method} ${resourcePath}`;
      if (seen.has(routeName)) continue;
      seen.add(routeName);

      symbols.push({
        id: makeId(filePath, routeName, 'route'),
        name: routeName,
        kind: 'route',
        filePath,
        startByte: 0,
        endByte: 0,
        signature: `web::resource("${resourcePath}").route(web::${method.toLowerCase()}().to(...))`,
        summary: `Actix route: ${routeName}`,
        frameworkMeta: {
          http_method: method,
          route_path: resourcePath,
          actix_route: true,
        },
      });
    }
  }

  return symbols;
}

// ─── Scope prefix extraction ──────────────────────────────────────────────────

/**
 * Extract `web::scope("/prefix")` mount points and emit them as route symbols
 * with `actix_scope: true`. The prefix is preserved for URL hierarchy
 * understanding.
 */
function extractActixScopes(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  const scopeRe = /\bweb::scope\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = scopeRe.exec(source)) !== null) {
    const argsPos = m.index + m[0]!.length;
    const argsText = collectArgs(source, argsPos);
    if (!argsText) continue;

    const pathMatch = argsText.match(/^\s*"([^"]+)"\s*$/);
    if (!pathMatch) continue;
    const prefix = pathMatch[1]!;

    if (seen.has(prefix)) continue;
    seen.add(prefix);

    symbols.push({
      id: makeId(filePath, `SCOPE ${prefix}`, 'route'),
      name: `SCOPE ${prefix}`,
      kind: 'route',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `web::scope("${prefix}")`,
      summary: `Actix scope prefix: ${prefix}`,
      frameworkMeta: {
        route_path: prefix,
        actix_scope: true,
      },
    });
  }

  return symbols;
}

// ─── Middleware extraction ────────────────────────────────────────────────────

/**
 * Extract middleware symbols from `.wrap(...)` calls.
 * The middleware name is taken from the first type segment of the argument
 * (e.g. `Logger` from `actix_web::middleware::Logger::default()`).
 */
function extractActixMiddleware(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  const wrapRe = /\.wrap\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = wrapRe.exec(source)) !== null) {
    const argsPos = m.index + m[0]!.length;
    const argsText = collectArgs(source, argsPos);
    if (!argsText) continue;

    // Capture the full path, then pick the first PascalCase segment as the type name.
    // e.g. `actix_web::middleware::Logger::default()` → segments ['actix_web', 'middleware', 'Logger', 'default']
    //      first PascalCase → 'Logger'
    // e.g. `AuthMiddleware` → 'AuthMiddleware'
    // e.g. `CorsMiddleware::new()` → 'CorsMiddleware'
    const typeMatch = argsText.trim().match(
      /^([A-Za-z][A-Za-z0-9_]*(?:::[A-Za-z][A-Za-z0-9_]*)*)/,
    );
    if (!typeMatch) continue;
    const segments = typeMatch[1]!.split('::');
    const typeName = segments.find((s) => /^[A-Z]/.test(s)) ?? segments[0]!;

    if (seen.has(typeName)) continue;
    seen.add(typeName);

    symbols.push({
      id: makeId(filePath, typeName, 'middleware'),
      name: typeName,
      kind: 'middleware',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `.wrap(${argsText.trim().split('(')[0]!.trim()}(...))`,
      summary: `Actix middleware: ${typeName}`,
      frameworkMeta: {
        actix_middleware: true,
      },
    });
  }

  return symbols;
}

// ─── FromRequest extractor extraction ────────────────────────────────────────

/**
 * Scan for `impl [<bounds>] [path::]FromRequest for TypeName` and emit a
 * `type` symbol with `actix_extractor: true`.
 */
function extractActixExtractors(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  // impl [<...>] [path::]FromRequest [<...>] for TypeName
  const implRe =
    /\bimpl(?:\s*<[^>]*>)?\s+(?:\w+::)*FromRequest(?:\s*<[^>]*>)?\s+for\s+([A-Za-z][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;

  while ((m = implRe.exec(source)) !== null) {
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);

    symbols.push({
      id: makeId(filePath, name, 'type'),
      name,
      kind: 'type',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `impl FromRequest for ${name}`,
      summary: `Actix extractor: ${name}`,
      frameworkMeta: { actix_extractor: true },
    });
  }

  return symbols;
}

// ─── Actix import guard ───────────────────────────────────────────────────────

/**
 * Quick check — only process files that reference actix_web. Avoids scanning
 * every `.rs` file in projects that use similar patterns.
 */
function hasActixUsage(source: string): boolean {
  return /\bactix_web\b/.test(source);
}

// ─── Actix-web adapter ────────────────────────────────────────────────────────

export const actixWebAdapter: FrameworkAdapter = {
  name: 'actix-web',

  /** `.rs` files are handled by the Rust language handler — no new extension. */
  extensions: () => [],

  // ── Detection ─────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    try {
      const cargoToml = readFileSync(join(projectRoot, 'Cargo.toml'), 'utf8');
      // Match `actix-web = "..."` or `actix-web = { version = "..." }`
      return /\bactix-web\s*=/.test(cargoToml);
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

    if (!hasActixUsage(sourceStr)) return [];

    return [
      ...extractActixMacroRoutes(sourceStr, filePath),
      ...extractActixResourceRoutes(sourceStr, filePath),
      ...extractActixScopes(sourceStr, filePath),
      ...extractActixMiddleware(sourceStr, filePath),
      ...extractActixExtractors(sourceStr, filePath),
    ];
  },

  // ── Metadata enrichment ────────────────────────────────────────────────────

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(actixWebAdapter);
logger.debug("Adapter 'actix-web' registered");
