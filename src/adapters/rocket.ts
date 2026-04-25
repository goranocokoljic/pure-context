/**
 * Rocket framework adapter (Rust).
 *
 * Extracts route, catcher, fairing (middleware), and guard symbols from Rocket
 * web applications. Rocket uses procedural macros for route definitions:
 *
 *   #[get("/path")]                     → GET /path
 *   #[post("/path")]                    → POST /path
 *   #[route(GET, path = "/path")]       → GET /path
 *   #[catch(404)]                       → error catcher for 404
 *   impl Fairing for LogFairing         → fairing (middleware)
 *   #[derive(FromForm)]                 → request guard / form type
 *   #[derive(FromRequest)]              → request guard
 *
 * Path parameters use `<param>` syntax: `/users/<id>`.
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

const ROCKET_HTTP_METHODS = [
  'get', 'post', 'put', 'patch', 'delete', 'head', 'options',
] as const;

// ─── Simple macro route extraction ────────────────────────────────────────────

/**
 * Extract routes defined via simple Rocket attribute macros:
 *   #[get("/users")]          → GET /users
 *   #[post("/users/<id>")]    → POST /users/<id>
 *   #[rocket::get("/path")]   → GET /path  (fully qualified)
 *
 * The attribute must be immediately followed by either another attribute, or a
 * `fn`/`async fn` definition. The route path is taken from the first string
 * argument of the macro.
 */
function extractRocketMacroRoutes(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  const methodPat = ROCKET_HTTP_METHODS.join('|');
  // Match: #[optional::path::get("/path")]  or  #[get("/path", ...)]
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
      summary: `Rocket route: ${routeName}`,
      frameworkMeta: {
        http_method: method,
        route_path: routePath,
        rocket_route: true,
      },
    });
  }

  return symbols;
}

// ─── Generic #[route(...)] macro extraction ───────────────────────────────────

/**
 * Extract routes defined via the generic `#[route]` macro:
 *   #[route(GET, path = "/users/<id>")]   → GET /users/<id>
 *   #[rocket::route(POST, path = "/")]    → POST /
 *
 * The first argument is the HTTP method (unquoted identifier), and `path` is a
 * named parameter.
 */
function extractRocketGenericRoutes(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  // Match: #[optional::route(METHOD, path = "/path")]
  const re =
    /#\[(?:[\w]+::)*route\s*\(\s*([A-Z]+)\s*,\s*path\s*=\s*"([^"]+)"/g;

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
      signature: `#[route(${method}, path = "${routePath}")]`,
      summary: `Rocket route: ${routeName}`,
      frameworkMeta: {
        http_method: method,
        route_path: routePath,
        rocket_route: true,
      },
    });
  }

  return symbols;
}

// ─── Error catcher extraction ─────────────────────────────────────────────────

/**
 * Extract error catchers defined via `#[catch(code)]`:
 *   #[catch(404)]   → catcher for HTTP 404
 *   #[catch(500)]   → catcher for HTTP 500
 *   #[catch(default)] → default catch-all catcher (code = null)
 *
 * Each catcher is emitted as a `route` symbol with `rocket_catcher: true` and
 * the `status_code` populated (or null for the default catcher).
 */
function extractRocketCatchers(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  // Match: #[catch(404)]  or  #[rocket::catch(404)]  or  #[catch(default)]
  const re = /#\[(?:[\w]+::)*catch\s*\(\s*([\w]+)\s*\)/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const codeStr = m[1]!;
    const isDefault = codeStr === 'default';
    const statusCode = isDefault ? null : parseInt(codeStr, 10);
    const symbolName = isDefault ? 'CATCH default' : `CATCH ${codeStr}`;

    if (seen.has(symbolName)) continue;
    seen.add(symbolName);

    symbols.push({
      id: makeId(filePath, symbolName, 'route'),
      name: symbolName,
      kind: 'route',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `#[catch(${codeStr})]`,
      summary: `Rocket error catcher: ${symbolName}`,
      frameworkMeta: {
        rocket_catcher: true,
        status_code: statusCode,
      },
    });
  }

  return symbols;
}

// ─── Fairing (middleware) extraction ─────────────────────────────────────────

/**
 * Extract Rocket fairings by scanning for `impl [<bounds>] [path::]Fairing for TypeName`.
 * Fairings are the Rocket equivalent of middleware — lifecycle hooks that run
 * on attach, launch, request, and response events.
 */
function extractRocketFairings(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  // impl [<...>] [path::]Fairing [<...>] for TypeName
  const implRe =
    /\bimpl(?:\s*<[^>]*>)?\s+(?:\w+::)*Fairing(?:\s*<[^>]*>)?\s+for\s+([A-Za-z][A-Za-z0-9_]*)/g;

  let m: RegExpExecArray | null;
  while ((m = implRe.exec(source)) !== null) {
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);

    symbols.push({
      id: makeId(filePath, name, 'middleware'),
      name,
      kind: 'middleware',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `impl Fairing for ${name}`,
      summary: `Rocket fairing: ${name}`,
      frameworkMeta: { rocket_fairing: true },
    });
  }

  return symbols;
}

// ─── Request guard / form type extraction ────────────────────────────────────

/**
 * Extract request guard and form types derived via procedural macros:
 *   #[derive(FromForm)]     → form guard (data validation)
 *   #[derive(FromRequest)]  → request guard (auth / extraction)
 *
 * Both are emitted as `type` symbols with `rocket_guard: true`.
 */
function extractRocketGuards(source: string, filePath: string): SymbolRecord[] {
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
      signature: `#[derive(FromForm/FromRequest)] struct ${name}`,
      summary: `Rocket guard: ${name}`,
      frameworkMeta: { rocket_guard: true },
    });
  }

  // #[derive(..., FromForm, ...)] / #[derive(..., FromRequest, ...)]
  // followed by pub? struct|enum Name
  const deriveRe =
    /#\[derive\([^\]]*\b(?:FromForm|FromRequest)\b[^\]]*\)\][\s\S]*?(?:pub\s+(?:\([^)]*\)\s+)?)?(?:struct|enum)\s+([A-Za-z][A-Za-z0-9_]*)/g;

  let m: RegExpExecArray | null;
  while ((m = deriveRe.exec(source)) !== null) {
    emit(m[1]!);
  }

  return symbols;
}

// ─── Rocket import guard ──────────────────────────────────────────────────────

/**
 * Quick check — only process files that reference rocket. Avoids scanning
 * every `.rs` file in projects that happen to use similar patterns.
 */
function hasRocketUsage(source: string): boolean {
  return /\brocket\b/.test(source);
}

// ─── Rocket adapter ───────────────────────────────────────────────────────────

export const rocketAdapter: FrameworkAdapter = {
  name: 'rocket',

  /** `.rs` files are handled by the Rust language handler — no new extension. */
  extensions: () => [],

  // ── Detection ─────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    try {
      const cargoToml = readFileSync(join(projectRoot, 'Cargo.toml'), 'utf8');
      // Match `rocket = "..."` or `rocket = { version = "..." }`
      return /\brocket\s*=/.test(cargoToml);
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

    if (!hasRocketUsage(sourceStr)) return [];

    return [
      ...extractRocketMacroRoutes(sourceStr, filePath),
      ...extractRocketGenericRoutes(sourceStr, filePath),
      ...extractRocketCatchers(sourceStr, filePath),
      ...extractRocketFairings(sourceStr, filePath),
      ...extractRocketGuards(sourceStr, filePath),
    ];
  },

  // ── Metadata enrichment ────────────────────────────────────────────────────

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(rocketAdapter);
logger.debug("Adapter 'rocket' registered");
