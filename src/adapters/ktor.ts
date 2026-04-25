/**
 * Ktor framework adapter (Kotlin).
 *
 * Extracts route symbols from Ktor server applications using regex-based
 * scanning on Kotlin source text.
 *
 * Patterns recognised:
 *   get("/path") { ... }                   → route
 *   post("/path") { ... }                  → route
 *   route("/prefix") { get("/sub") { } }   → nested route with combined path
 *   authenticate { get("/secure") { } }    → route with authenticated: true
 *
 * Path parameters use Ktor's {param} syntax — preserved as-is.
 * Only string-literal routes are handled (type-safe routing is out of scope).
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

function joinPaths(prefix: string, path: string): string {
  if (!prefix) return path;
  // Avoid double slashes
  const left = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const right = path.startsWith('/') ? path : `/${path}`;
  return left + right;
}

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

// ─── Route extraction ─────────────────────────────────────────────────────────

/**
 * Scan Kotlin source text for Ktor routing DSL calls, resolving nested
 * `route()` prefixes and `authenticate {}` blocks.
 *
 * Strategy: single-pass character scan tracking brace depth so we know when
 * each `route { }` or `authenticate { }` block ends, letting us pop the
 * prefix/authenticated stack correctly.
 */
function extractKtorRoutes(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  // Stack frames: each entry is a prefix and whether we're in an auth block
  const stack: Array<{ prefix: string; authenticated: boolean }> = [
    { prefix: '', authenticated: false },
  ];

  // We'll do a regex pass over lines for simplicity. For Ktor's typical
  // single-function-per-line style this is reliable.
  //
  // Approach: scan token by token looking for:
  //   route("path") {     → push prefix
  //   authenticate {      → push authenticated flag
  //   get/post/... ("path") {  → emit route
  //   closing }           → potentially pop stack
  //
  // We track brace depth per stack frame to know when a block ends.

  // Frame brace depths: how many { we've seen inside the current routing block
  const frameDepths: number[] = [0];
  let braceDepth = 0; // global brace depth at each frame push

  const frameStartDepths: number[] = [0]; // brace depth when frame was pushed

  // Reset stacks
  stack.length = 0;
  stack.push({ prefix: '', authenticated: false });
  frameStartDepths.length = 0;
  frameStartDepths.push(-1); // root frame never ends

  // ── regex patterns ──────────────────────────────────────────────────────────

  // route("/path") {
  const routeBlockRe = /\broute\s*\(\s*["']([^"']+)["']\s*\)\s*\{/g;
  // authenticate(...) { — optional argument (e.g. authenticate("jwt") {)
  const authBlockRe = /\bauthenticate\s*(?:\([^)]*\))?\s*\{/g;
  // get/post/... ("/path") {
  const methodRe = new RegExp(
    `\\b(${HTTP_METHODS.join('|')})\\s*\\(\\s*["']([^"']+)["']\\s*\\)\\s*\\{`,
    'g',
  );
  // A brace open that isn't part of a routing call (for depth tracking)
  const openBraceRe = /\{/g;
  const closeBraceRe = /\}/g;

  // Collect all events with their positions and process in source order
  interface Event {
    pos: number;
    type: 'route' | 'auth' | 'method' | 'open' | 'close';
    path?: string;
    method?: HttpMethod;
  }

  const events: Event[] = [];

  let m: RegExpExecArray | null;

  routeBlockRe.lastIndex = 0;
  while ((m = routeBlockRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'route', path: m[1] });
  }

  authBlockRe.lastIndex = 0;
  while ((m = authBlockRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'auth' });
  }

  methodRe.lastIndex = 0;
  while ((m = methodRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'method', method: m[1] as HttpMethod, path: m[2] });
  }

  openBraceRe.lastIndex = 0;
  while ((m = openBraceRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'open' });
  }

  closeBraceRe.lastIndex = 0;
  while ((m = closeBraceRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'close' });
  }

  // Sort by position; open/close after semantic events at the same position
  // so a `route("x") {` open brace is processed after the route event.
  const ORDER: Record<Event['type'], number> = {
    route: 0,
    auth: 0,
    method: 0,
    open: 1,
    close: 2,
  };
  events.sort((a, b) => a.pos - b.pos || ORDER[a.type] - ORDER[b.type]);

  // depth when each frame was pushed (so we know when to pop)
  const framePushDepths: number[] = [-1]; // root never pops
  let depth = 0;
  // flags: are we expecting the NEXT open-brace to push a new frame?
  let pendingFrame: { prefix: string; authenticated: boolean } | null = null;

  for (const ev of events) {
    switch (ev.type) {
      case 'route': {
        const current = stack[stack.length - 1]!;
        const newPrefix = joinPaths(current.prefix, ev.path!);
        pendingFrame = { prefix: newPrefix, authenticated: current.authenticated };
        break;
      }
      case 'auth': {
        const current = stack[stack.length - 1]!;
        pendingFrame = { prefix: current.prefix, authenticated: true };
        break;
      }
      case 'method': {
        const current = stack[stack.length - 1]!;
        const fullPath = joinPaths(current.prefix, ev.path!);
        const httpMethod = ev.method!.toUpperCase();
        const routeName = `${httpMethod} ${fullPath}`;
        if (!seen.has(routeName)) {
          seen.add(routeName);
          symbols.push({
            id: makeId(filePath, routeName, 'route'),
            name: routeName,
            kind: 'route',
            filePath,
            startByte: ev.pos,
            endByte: ev.pos,
            signature: `${ev.method}("${fullPath}") { ... }`,
            summary: `Ktor route: ${routeName}`,
            frameworkMeta: {
              http_method: httpMethod,
              route_path: fullPath,
              ktor_route: true,
              ...(current.authenticated ? { authenticated: true } : {}),
            },
          });
        }
        break;
      }
      case 'open': {
        depth++;
        if (pendingFrame !== null) {
          stack.push(pendingFrame);
          framePushDepths.push(depth);
          pendingFrame = null;
        }
        break;
      }
      case 'close': {
        // Pop frames that were pushed at this depth
        while (
          framePushDepths.length > 1 &&
          framePushDepths[framePushDepths.length - 1] === depth
        ) {
          stack.pop();
          framePushDepths.pop();
        }
        depth--;
        break;
      }
    }
  }

  return symbols;
}

// ─── Ktor adapter ─────────────────────────────────────────────────────────────

export const ktorAdapter: FrameworkAdapter = {
  name: 'ktor',

  extensions: () => [],

  async detect(projectRoot: string): Promise<boolean> {
    // Check build.gradle or build.gradle.kts for io.ktor
    for (const buildFile of ['build.gradle.kts', 'build.gradle']) {
      try {
        const content = readFileSync(join(projectRoot, buildFile), 'utf8');
        if (content.includes('io.ktor')) return true;
      } catch {
        // file absent — try next
      }
    }
    // Check pom.xml
    try {
      const pom = readFileSync(join(projectRoot, 'pom.xml'), 'utf8');
      if (pom.includes('<groupId>io.ktor</groupId>')) return true;
    } catch {
      // no pom.xml
    }
    return false;
  },

  fileFilter: (filePath: string): boolean => filePath.endsWith('.kt'),

  extractFrameworkSymbols(
    _tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    return extractKtorRoutes(source.toString('utf8'), filePath);
  },

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(ktorAdapter);
logger.debug("Adapter 'ktor' registered");
