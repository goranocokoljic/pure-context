/**
 * Quarkus adapter (Java/Kotlin).
 *
 * Extracts route, bean, REST client, scheduled, and reactive route symbols from
 * Quarkus applications. Quarkus uses JAX-RS annotations for HTTP endpoints,
 * CDI annotations for beans, and its own @Route for reactive endpoints.
 *
 * Patterns recognised:
 *   @Path("/prefix") class Foo { … }             → class (quarkus_resource)
 *   @GET / @POST / @PUT / @DELETE / @PATCH        → route (quarkus_route)
 *   @ApplicationScoped / @Singleton / @Dependent  → class (quarkus_bean)
 *   @Route on method                              → route (quarkus_reactive)
 *   @Scheduled on method                          → function (quarkus_scheduled)
 *   @RegisterRestClient interface Foo { … }       → interface (quarkus_client)
 *
 * Quarkus path parameters use `{param}` syntax: `/users/{id}`.
 * JAX-RS HTTP method annotations are uppercase: @GET, @POST, etc.
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

function joinPaths(prefix: string, path: string): string {
  if (!prefix) return path || '/';
  if (!path) return prefix;
  const left = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const right = path.startsWith('/') ? path : `/${path}`;
  return left + right;
}

/**
 * Extract the first string-literal path argument from a JAX-RS annotation.
 * Handles: @Path("/path"), @Path(value = "/path"), @Route(path = "/path")
 * Returns '' when no path argument is present.
 */
function extractAnnotationPath(annotationText: string): string {
  const m = annotationText.match(
    /\(\s*(?:(?:value|path)\s*=\s*)?["']([^"']+)["']/,
  );
  return m ? m[1]! : '';
}

// ─── Frame types ──────────────────────────────────────────────────────────────

type QuarkusFrameType = 'resource' | 'bean' | 'client' | 'other';

interface ClassFrame {
  type: QuarkusFrameType;
  name: string;
  prefix: string;     // from @Path("/prefix")
  entryDepth: number; // brace depth when this class body opened
  isInterface: boolean;
}

// ─── Symbol extraction state machine ──────────────────────────────────────────

function extractQuarkusSymbols(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];

  // ── Event types ──────────────────────────────────────────────────────────────

  interface Event {
    pos: number;
    type:
      | 'path-anno'
      | 'http-anno'        // @GET, @POST, etc. (JAX-RS)
      | 'bean-scope-anno'  // @ApplicationScoped, @Singleton, @Dependent
      | 'route-anno'       // @Route (reactive)
      | 'scheduled-anno'
      | 'client-anno'      // @RegisterRestClient
      | 'class-decl'
      | 'interface-decl'
      | 'method-decl'
      | 'open'
      | 'close';
    name?: string;
    httpMethod?: string;
    path?: string;
    raw?: string;
  }

  const ORDER: Record<Event['type'], number> = {
    'path-anno': 0,
    'http-anno': 0,
    'bean-scope-anno': 0,
    'route-anno': 0,
    'scheduled-anno': 0,
    'client-anno': 0,
    'class-decl': 0,
    'interface-decl': 0,
    'method-decl': 0,
    'open': 1,
    'close': 2,
  };

  const events: Event[] = [];
  let m: RegExpExecArray | null;

  // ── Annotation scanning ───────────────────────────────────────────────────────

  // @Path("/prefix") — class or method level
  const pathAnnoRe = /@Path\s*(?:\([^)]*\))?/g;
  while ((m = pathAnnoRe.exec(source)) !== null) {
    const path = extractAnnotationPath(m[0]);
    events.push({ pos: m.index, type: 'path-anno', path, raw: m[0] });
  }

  // JAX-RS HTTP method annotations (uppercase): @GET, @POST, @PUT, @DELETE, @PATCH
  const httpAnnoRe = /@(GET|POST|PUT|DELETE|PATCH)\b/g;
  while ((m = httpAnnoRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'http-anno', httpMethod: m[1]!, raw: m[0] });
  }

  // CDI bean scope annotations
  const beanScopeRe = /@(ApplicationScoped|Singleton|Dependent)\b(?:\s*\([^)]*\))?/g;
  while ((m = beanScopeRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'bean-scope-anno', raw: m[0] });
  }

  // @Route (Vert.x reactive routes)
  const routeAnnoRe = /@Route\s*(?:\([^)]*\))?/g;
  while ((m = routeAnnoRe.exec(source)) !== null) {
    const path = extractAnnotationPath(m[0]);
    events.push({ pos: m.index, type: 'route-anno', path, raw: m[0] });
  }

  // @Scheduled
  const scheduledAnnoRe = /@Scheduled\b(?:\s*\([^)]*\))?/g;
  while ((m = scheduledAnnoRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'scheduled-anno', raw: m[0] });
  }

  // @RegisterRestClient
  const clientAnnoRe = /@RegisterRestClient\s*(?:\([^)]*\))?/g;
  while ((m = clientAnnoRe.exec(source)) !== null) {
    const path = extractAnnotationPath(m[0]);
    events.push({ pos: m.index, type: 'client-anno', path, raw: m[0] });
  }

  // ── Declaration scanning ──────────────────────────────────────────────────────

  // class ClassName (upper-case start to exclude anonymous)
  const classRe = /\bclass\s+([A-Z]\w*)/g;
  while ((m = classRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'class-decl', name: m[1] });
  }

  // interface InterfaceName
  const interfaceRe = /\binterface\s+([A-Z]\w*)/g;
  while ((m = interfaceRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'interface-decl', name: m[1] });
  }

  // Method declarations: public/protected/private ... methodName(
  const methodRe =
    /\b(?:public|protected|private)(?:[^(\n;{}]*\s)([a-z][a-zA-Z_$0-9]*)\s*\(/g;
  while ((m = methodRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'method-decl', name: m[1] });
  }

  // Braces
  const openRe = /\{/g;
  while ((m = openRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'open' });
  }

  const closeRe = /\}/g;
  while ((m = closeRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'close' });
  }

  // Sort by position; at equal position, respect ORDER
  events.sort((a, b) => a.pos - b.pos || ORDER[a.type] - ORDER[b.type]);

  // ── State machine ─────────────────────────────────────────────────────────────

  let pendingPathAnno: { path: string; raw: string } | null = null;
  let pendingHttpAnno: { httpMethod: string; raw: string } | null = null;
  let pendingBeanScopeAnno: { raw: string } | null = null;
  let pendingRouteAnno: { path: string; raw: string } | null = null;
  let pendingScheduledAnno: { raw: string } | null = null;
  let pendingClientAnno: { path: string; raw: string } | null = null;

  const classStack: ClassFrame[] = [];
  let depth = 0;
  let pendingClassFrame: ClassFrame | null = null;

  const seen = new Set<string>();

  function clearClassLevelPending(): void {
    pendingPathAnno = null;
    pendingBeanScopeAnno = null;
    pendingClientAnno = null;
    pendingHttpAnno = null;
    pendingRouteAnno = null;
    pendingScheduledAnno = null;
  }

  function clearMethodLevelPending(): void {
    pendingHttpAnno = null;
    pendingRouteAnno = null;
    pendingScheduledAnno = null;
    // path-anno may appear on methods too (sub-paths) — reset it
    pendingPathAnno = null;
  }

  for (const ev of events) {
    switch (ev.type) {
      case 'path-anno':
        pendingPathAnno = { path: ev.path ?? '', raw: ev.raw! };
        break;

      case 'http-anno':
        pendingHttpAnno = { httpMethod: ev.httpMethod!, raw: ev.raw! };
        break;

      case 'bean-scope-anno':
        pendingBeanScopeAnno = { raw: ev.raw! };
        break;

      case 'route-anno':
        pendingRouteAnno = { path: ev.path ?? '', raw: ev.raw! };
        break;

      case 'scheduled-anno':
        pendingScheduledAnno = { raw: ev.raw! };
        break;

      case 'client-anno':
        pendingClientAnno = { path: ev.path ?? '', raw: ev.raw! };
        break;

      case 'class-decl': {
        const className = ev.name!;

        if (pendingPathAnno) {
          // JAX-RS resource class
          const { path: prefix, raw: annoRaw } = pendingPathAnno;
          symbols.push({
            id: makeId(filePath, className, 'class'),
            name: className,
            kind: 'class',
            filePath,
            startByte: ev.pos,
            endByte: ev.pos,
            signature: `${annoRaw} class ${className}`,
            summary: `Quarkus JAX-RS resource: ${className}`,
            frameworkMeta: {
              quarkus_resource: true,
              ...(prefix ? { route_prefix: prefix } : {}),
            },
          });
          pendingClassFrame = { type: 'resource', name: className, prefix, entryDepth: 0, isInterface: false };
        } else if (pendingBeanScopeAnno) {
          symbols.push({
            id: makeId(filePath, className, 'class'),
            name: className,
            kind: 'class',
            filePath,
            startByte: ev.pos,
            endByte: ev.pos,
            signature: `${pendingBeanScopeAnno.raw} class ${className}`,
            summary: `Quarkus bean: ${className}`,
            frameworkMeta: { quarkus_bean: true },
          });
          pendingClassFrame = { type: 'bean', name: className, prefix: '', entryDepth: 0, isInterface: false };
        } else {
          pendingClassFrame = { type: 'other', name: className, prefix: '', entryDepth: 0, isInterface: false };
        }

        clearClassLevelPending();
        break;
      }

      case 'interface-decl': {
        const ifaceName = ev.name!;

        if (pendingClientAnno) {
          const { path: basePath, raw: annoRaw } = pendingClientAnno;
          if (!seen.has(`client:${ifaceName}`)) {
            seen.add(`client:${ifaceName}`);
            symbols.push({
              id: makeId(filePath, ifaceName, 'interface'),
              name: ifaceName,
              kind: 'interface',
              filePath,
              startByte: ev.pos,
              endByte: ev.pos,
              signature: `${annoRaw} interface ${ifaceName}`,
              summary: `Quarkus REST client: ${ifaceName}`,
              frameworkMeta: {
                quarkus_client: true,
                ...(basePath ? { base_path: basePath } : {}),
              },
            });
          }
          pendingClassFrame = { type: 'client', name: ifaceName, prefix: basePath, entryDepth: 0, isInterface: true };
        } else {
          pendingClassFrame = { type: 'other', name: ifaceName, prefix: '', entryDepth: 0, isInterface: true };
        }

        clearClassLevelPending();
        break;
      }

      case 'method-decl': {
        const methodName = ev.name ?? '<method>';
        const top = classStack[classStack.length - 1];

        // JAX-RS route: @GET/@POST/etc + optional @Path on a method inside a @Path resource
        if (top && top.type === 'resource' && depth === top.entryDepth && pendingHttpAnno) {
          const { httpMethod, raw: httpRaw } = pendingHttpAnno;
          // Method-level @Path is the sub-path
          const subPath = pendingPathAnno?.path ?? '';
          const fullPath = joinPaths(top.prefix, subPath);
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
              signature: `${httpRaw} public ... ${methodName}(...)`,
              summary: `Quarkus route: ${routeName}`,
              frameworkMeta: {
                http_method: httpMethod,
                route_path: fullPath,
                quarkus_route: true,
              },
            });
          }
        }

        // Reactive @Route
        if (pendingRouteAnno) {
          const { path: routePath, raw: routeRaw } = pendingRouteAnno;
          const top2 = classStack[classStack.length - 1];
          const prefix = (top2?.type === 'resource' || top2?.type === 'bean') ? top2.prefix : '';
          const fullPath = joinPaths(prefix, routePath);
          const routeName = `ROUTE ${fullPath || methodName}`;

          if (!seen.has(routeName)) {
            seen.add(routeName);
            symbols.push({
              id: makeId(filePath, routeName, 'route'),
              name: routeName,
              kind: 'route',
              filePath,
              startByte: ev.pos,
              endByte: ev.pos,
              signature: `${routeRaw} public void ${methodName}(...)`,
              summary: `Quarkus reactive route: ${fullPath || methodName}`,
              frameworkMeta: {
                route_path: fullPath || `/${methodName}`,
                quarkus_reactive: true,
              },
            });
          }
        }

        // @Scheduled method
        if (pendingScheduledAnno) {
          if (!seen.has(`scheduled:${methodName}`)) {
            seen.add(`scheduled:${methodName}`);
            symbols.push({
              id: makeId(filePath, methodName, 'function'),
              name: methodName,
              kind: 'function',
              filePath,
              startByte: ev.pos,
              endByte: ev.pos,
              signature: `${pendingScheduledAnno.raw} public void ${methodName}()`,
              summary: `Quarkus scheduled task: ${methodName}`,
              frameworkMeta: { quarkus_scheduled: true },
            });
          }
        }

        clearMethodLevelPending();
        break;
      }

      case 'open':
        depth++;
        if (pendingClassFrame !== null) {
          pendingClassFrame.entryDepth = depth;
          classStack.push(pendingClassFrame);
          pendingClassFrame = null;
        }
        break;

      case 'close': {
        while (classStack.length > 0) {
          const top = classStack[classStack.length - 1]!;
          if (top.entryDepth > depth) {
            classStack.pop();
          } else {
            break;
          }
        }
        depth = Math.max(0, depth - 1);
        break;
      }
    }
  }

  return symbols;
}

// ─── Detection helpers ────────────────────────────────────────────────────────

/**
 * Check pom.xml for Quarkus artifacts (quarkus- prefix or io.quarkus groupId).
 */
function detectPomXml(projectRoot: string): boolean {
  try {
    const pom = readFileSync(join(projectRoot, 'pom.xml'), 'utf8');
    return /quarkus-/i.test(pom) || pom.includes('io.quarkus');
  } catch {
    return false;
  }
}

/**
 * Check Gradle build files for Quarkus plugin or dependency.
 */
function detectGradle(projectRoot: string): boolean {
  for (const buildFile of ['build.gradle.kts', 'build.gradle']) {
    try {
      const content = readFileSync(join(projectRoot, buildFile), 'utf8');
      if (content.includes('io.quarkus')) return true;
    } catch {
      // file absent — try next
    }
  }
  return false;
}

// ─── Quarkus adapter ──────────────────────────────────────────────────────────

export const quarkusAdapter: FrameworkAdapter = {
  name: 'quarkus',

  /** No new file extensions — `.java` and `.kt` handled by language handlers. */
  extensions: () => [],

  // ── Detection ─────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    return detectPomXml(projectRoot) || detectGradle(projectRoot);
  },

  // ── File routing ───────────────────────────────────────────────────────────

  fileFilter: (filePath: string): boolean =>
    filePath.endsWith('.java') || filePath.endsWith('.kt'),

  // ── Framework symbol extraction ────────────────────────────────────────────

  extractFrameworkSymbols(
    _tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    return extractQuarkusSymbols(source.toString('utf8'), filePath);
  },

  // ── Metadata enrichment ────────────────────────────────────────────────────

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(quarkusAdapter);
logger.debug("Adapter 'quarkus' registered");
