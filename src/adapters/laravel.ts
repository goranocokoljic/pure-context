/**
 * Laravel framework adapter.
 *
 * Extracts route, controller, model, and middleware symbols from Laravel
 * applications using regex-based scanning on PHP source text.
 *
 * Patterns recognised:
 *   Route::get('/users', ...)                      → route (GET)
 *   Route::post('/users', ...)                     → route (POST)
 *   Route::resource('users', Controller::class)    → routes (index/show/store/update/destroy)
 *   Route::group(['prefix' => '/api'], ...)        → applies prefix to child routes
 *   class UserController extends Controller        → class (laravel_controller)
 *   public function index() { ... }               → view (laravel_action, inside controller)
 *   class User extends Model                       → model (laravel_model)
 *   class VerifyCsrfToken + handle(Request, Closure) → middleware (laravel_middleware)
 */

import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
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

/**
 * Return the string value of the first quoted argument in `text` starting at
 * `offset`. Handles single and double quotes. Returns null if not found.
 */
function extractQuotedString(text: string, offset: number): string | null {
  const sub = text.slice(offset);
  const m = sub.match(/^\s*(?:'([^']*)'|"([^"]*)")/);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : (m[2] ?? null);
}

/**
 * Find the text of the closure/function body starting from `offset` in `text`.
 * Walks forward to the first `{`, then matches braces. Returns the body text
 * (contents between `{` and `}`) and the index just after the closing `}`.
 */
function findBraceBody(text: string, offset: number): { body: string; end: number } | null {
  let i = offset;
  // Skip to the first opening brace
  while (i < text.length && text[i] !== '{') i++;
  if (i >= text.length) return null;
  const start = i + 1;
  let depth = 1;
  i++;
  while (i < text.length && depth > 0) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    i++;
  }
  if (depth !== 0) return null;
  return { body: text.slice(start, i - 1), end: i };
}

// ─── Class block finder ───────────────────────────────────────────────────────

interface ClassBlock {
  name: string;
  extendsName: string;
  signature: string;
  start: number;
  bodyStart: number;
  bodyEnd: number;
}

const CLASS_HEADER_RE =
  /class\s+(\w+)(?:\s+extends\s+([\w\\]+))?(?:\s+implements\s+[^{]*)?(?:\s*\{)/g;

function findClasses(sourceStr: string): ClassBlock[] {
  const classes: ClassBlock[] = [];
  CLASS_HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLASS_HEADER_RE.exec(sourceStr)) !== null) {
    const name = m[1]!;
    const extendsName = m[2] ?? '';
    const bodyStart = m.index + m[0].length;
    // Match braces to find body end
    let depth = 1;
    let i = bodyStart;
    while (i < sourceStr.length && depth > 0) {
      if (sourceStr[i] === '{') depth++;
      else if (sourceStr[i] === '}') depth--;
      i++;
    }
    classes.push({
      name,
      extendsName,
      signature: m[0].slice(0, -1).trim(), // strip trailing '{'
      start: m.index,
      bodyStart,
      bodyEnd: i - 1,
    });
  }
  return classes;
}

// ─── Route extraction ─────────────────────────────────────────────────────────

/** HTTP methods supported by Route:: */
const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'any'] as const;

/** Resource routes: name → [method, path-suffix] */
const RESOURCE_ROUTES: [string, string][] = [
  ['GET',    ''],        // index
  ['POST',   ''],        // store
  ['GET',    '/{id}'],   // show
  ['PUT',    '/{id}'],   // update
  ['DELETE', '/{id}'],   // destroy
];

const ROUTE_METHOD_PATTERN =
  `Route\\s*::\\s*(${HTTP_METHODS.join('|')})\\s*\\(`;
const ROUTE_METHOD_RE = new RegExp(ROUTE_METHOD_PATTERN, 'gi');

const ROUTE_RESOURCE_RE = /Route\s*::\s*resource\s*\(/gi;

/**
 * Regex to find Route::group calls with a 'prefix' key. Captures the prefix
 * value and the position of the opening `(` to let us locate the closure body.
 */
const ROUTE_GROUP_RE = /Route\s*::\s*group\s*\(/gi;

interface GroupClosure {
  prefix: string;
  body: string;
  /** Start byte of the `Route::group(` call in `sourceStr` */
  start: number;
  /** Byte just past the closing `)` of the group call */
  end: number;
}

/** Locate all Route::group closures in `sourceStr`, returning prefix + body for each. */
function findGroupClosures(sourceStr: string): GroupClosure[] {
  const groups: GroupClosure[] = [];
  ROUTE_GROUP_RE.lastIndex = 0;
  let gm: RegExpExecArray | null;
  while ((gm = ROUTE_GROUP_RE.exec(sourceStr)) !== null) {
    const start = gm.index;
    const afterParen = gm.index + gm[0].length;

    // Extract prefix from options array
    const arrayMatch = sourceStr.slice(afterParen).match(/^\s*\[([^\]]*)\]/s);
    let groupPrefix = '';
    if (arrayMatch) {
      const prefixMatch = arrayMatch[1]!.match(/'prefix'\s*=>\s*(?:'([^']*)'|"([^"]*)")/);
      if (prefixMatch) {
        groupPrefix = prefixMatch[1] !== undefined ? prefixMatch[1] : (prefixMatch[2] ?? '');
      }
    }

    // Walk past the options array to find the closure keyword
    let searchOffset = afterParen;
    const arrEnd = sourceStr.indexOf(']', afterParen);
    if (arrEnd !== -1) searchOffset = arrEnd + 1;

    const closureMatch = sourceStr.slice(searchOffset).match(
      /function\s*\([^)]*\)\s*(?:use\s*\([^)]*\)\s*)?\{/,
    );
    if (!closureMatch) continue;

    const closureBodyOffset = searchOffset + closureMatch.index! + closureMatch[0].length;
    const brace = findBraceBody(sourceStr, closureBodyOffset - 1);
    if (!brace) continue;

    groups.push({ prefix: groupPrefix, body: brace.body, start, end: brace.end });
  }
  return groups;
}

function extractRoutes(
  sourceStr: string,
  filePath: string,
  prefixStack: string,
): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];

  // Pre-collect group closures so we can (a) exclude their byte ranges from the
  // top-level scan and (b) recurse without corrupting module-level regex state.
  const groups = findGroupClosures(sourceStr);
  const isInsideGroup = (index: number): boolean =>
    groups.some((g) => index >= g.start && index < g.end);

  // ── Route::get|post|put|delete|patch|options|any ──────────────────────────
  ROUTE_METHOD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROUTE_METHOD_RE.exec(sourceStr)) !== null) {
    if (isInsideGroup(m.index)) continue; // handled by recursive group call
    const httpMethod = m[1]!.toUpperCase();
    const afterParen = m.index + m[0].length;
    const routePath = extractQuotedString(sourceStr, afterParen);
    if (!routePath) continue;

    const fullPath = prefixStack + routePath;
    const name = `${httpMethod} ${fullPath}`;
    symbols.push({
      id: makeId(filePath, name, 'route'),
      name,
      kind: 'route',
      filePath,
      startByte: 0,
      endByte: 0,
      signature: `Route::${httpMethod.toLowerCase()}('${fullPath}', ...)`,
      summary: `Laravel route: ${name}`,
      frameworkMeta: {
        laravel_route: true,
        http_method: httpMethod,
        route_path: fullPath,
      },
    });
  }

  // ── Route::resource ───────────────────────────────────────────────────────
  ROUTE_RESOURCE_RE.lastIndex = 0;
  while ((m = ROUTE_RESOURCE_RE.exec(sourceStr)) !== null) {
    if (isInsideGroup(m.index)) continue;
    const afterParen = m.index + m[0].length;
    const resourceName = extractQuotedString(sourceStr, afterParen);
    if (!resourceName) continue;

    const basePath = prefixStack + '/' + resourceName.replace(/^\//, '');

    for (const [httpMethod, suffix] of RESOURCE_ROUTES) {
      const fullPath = basePath + suffix;
      const name = `${httpMethod} ${fullPath}`;
      symbols.push({
        id: makeId(filePath, name, 'route'),
        name,
        kind: 'route',
        filePath,
        startByte: 0,
        endByte: 0,
        signature: `Route::resource('${resourceName}', ...) → ${httpMethod} ${fullPath}`,
        summary: `Laravel resource route: ${name}`,
        frameworkMeta: {
          laravel_route: true,
          http_method: httpMethod,
          route_path: fullPath,
          laravel_resource: true,
        },
      });
    }
  }

  // ── Route::group — recurse into each closure body ────────────────────────
  for (const group of groups) {
    const childSymbols = extractRoutes(group.body, filePath, prefixStack + group.prefix);
    symbols.push(...childSymbols);
  }

  return symbols;
}

// ─── Controller extraction ────────────────────────────────────────────────────

const PUBLIC_METHOD_RE = /public\s+function\s+(\w+)\s*\(/g;

function extractControllers(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const classes = findClasses(sourceStr);

  for (const cls of classes) {
    // Detect controllers: extends Controller (any depth, e.g. Http\Controllers\Controller)
    const extendsBase = cls.extendsName.split('\\').pop() ?? '';
    if (extendsBase !== 'Controller') continue;

    symbols.push({
      id: makeId(filePath, cls.name, 'class'),
      name: cls.name,
      kind: 'class',
      filePath,
      startByte: cls.start,
      endByte: cls.bodyEnd + 1,
      signature: cls.signature,
      summary: `Laravel controller: ${cls.name}`,
      frameworkMeta: { laravel_controller: true },
    });

    // Public methods are controller actions
    const body = sourceStr.slice(cls.bodyStart, cls.bodyEnd);
    PUBLIC_METHOD_RE.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = PUBLIC_METHOD_RE.exec(body)) !== null) {
      const methodName = mm[1]!;
      const byteOffset = cls.bodyStart + mm.index;
      const qualName = `${cls.name}::${methodName}`;
      symbols.push({
        id: makeId(filePath, qualName, 'view'),
        name: qualName,
        kind: 'view',
        filePath,
        startByte: byteOffset,
        endByte: byteOffset + mm[0].length,
        signature: `public function ${methodName}(...)`,
        summary: `Laravel controller action: ${qualName}`,
        frameworkMeta: { laravel_action: true },
      });
    }
  }

  return symbols;
}

// ─── Model extraction ─────────────────────────────────────────────────────────

/** Base classes that indicate a Laravel Eloquent model */
const MODEL_BASES = new Set(['Model', 'Authenticatable', 'Pivot', 'MorphPivot']);

function extractModels(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const classes = findClasses(sourceStr);

  for (const cls of classes) {
    const extendsBase = cls.extendsName.split('\\').pop() ?? '';
    if (!MODEL_BASES.has(extendsBase)) continue;

    symbols.push({
      id: makeId(filePath, cls.name, 'model'),
      name: cls.name,
      kind: 'model',
      filePath,
      startByte: cls.start,
      endByte: cls.bodyEnd + 1,
      signature: cls.signature,
      summary: `Laravel Eloquent model: ${cls.name}`,
      frameworkMeta: { laravel_model: true },
    });
  }

  return symbols;
}

// ─── Middleware extraction ────────────────────────────────────────────────────

/** Regex to detect a handle(Request $request, Closure $next) method signature. */
const HANDLE_METHOD_RE = /function\s+handle\s*\(\s*\w+\s+\$\w+\s*,\s*Closure\s+\$\w+/i;

function extractMiddleware(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const classes = findClasses(sourceStr);

  for (const cls of classes) {
    const body = sourceStr.slice(cls.bodyStart, cls.bodyEnd);
    if (!HANDLE_METHOD_RE.test(body)) continue;

    symbols.push({
      id: makeId(filePath, cls.name, 'middleware'),
      name: cls.name,
      kind: 'middleware',
      filePath,
      startByte: cls.start,
      endByte: cls.bodyEnd + 1,
      signature: cls.signature,
      summary: `Laravel middleware: ${cls.name}`,
      frameworkMeta: { laravel_middleware: true },
    });
  }

  return symbols;
}

// ─── Laravel adapter ──────────────────────────────────────────────────────────

export const laravelAdapter: FrameworkAdapter = {
  name: 'laravel',

  extensions: () => [],

  async detect(projectRoot: string): Promise<boolean> {
    const composerPath = join(projectRoot, 'composer.json');
    if (!existsSync(composerPath)) return false;
    try {
      const json = JSON.parse(readFileSync(composerPath, 'utf8')) as Record<string, unknown>;
      const require = json['require'] as Record<string, unknown> | undefined;
      return !!(require && 'laravel/framework' in require);
    } catch {
      return false;
    }
  },

  fileFilter(filePath: string): boolean {
    if (!filePath.endsWith('.php')) return false;
    return (
      /^routes[\\/]/.test(filePath) ||
      /app[\\/]Http[\\/]Controllers[\\/]/.test(filePath) ||
      /app[\\/]Models[\\/]/.test(filePath) ||
      /app[\\/]Http[\\/]Middleware[\\/]/.test(filePath)
    );
  },

  extractFrameworkSymbols(
    _tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    const sourceStr = source.toString('utf8');
    const symbols: SymbolRecord[] = [];

    // Route files
    if (/^routes[\\/]/.test(filePath) || filePath.includes('/routes/')) {
      symbols.push(...extractRoutes(sourceStr, filePath, ''));
      return symbols;
    }

    // Controllers
    if (/app[\\/]Http[\\/]Controllers[\\/]/.test(filePath)) {
      symbols.push(...extractControllers(sourceStr, filePath));
      return symbols;
    }

    // Models
    if (/app[\\/]Models[\\/]/.test(filePath)) {
      symbols.push(...extractModels(sourceStr, filePath));
      return symbols;
    }

    // Middleware
    if (/app[\\/]Http[\\/]Middleware[\\/]/.test(filePath)) {
      symbols.push(...extractMiddleware(sourceStr, filePath));
      return symbols;
    }

    return symbols;
  },

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(laravelAdapter);
logger.debug("Adapter 'laravel' registered");
