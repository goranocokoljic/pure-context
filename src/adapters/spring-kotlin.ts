/**
 * Spring Kotlin adapter.
 *
 * Extracts route, controller, service, component, and repository symbols from
 * Spring Boot applications written in Kotlin.
 *
 * Patterns recognised:
 *   @RestController / @Controller class Foo { ... }   → class (spring_controller)
 *   @Service class FooService { ... }                 → class (spring_service)
 *   @Component class Foo { ... }                      → class (spring_component)
 *   @Repository class FooRepo { ... }                 → class (spring_repository)
 *   @GetMapping("/path") fun handler() { ... }        → route (inside controller)
 *   @RequestMapping("/prefix") at class level         → base path prefix
 *
 * Only annotation-style routing is handled (functional DSL is out of scope).
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

// ─── Annotation parsing ───────────────────────────────────────────────────────

/**
 * Extract the first string-literal path argument from a Spring annotation call.
 * Handles: @GetMapping("/path"), @GetMapping(value = "/path"), @GetMapping("/p1", "/p2")
 * Returns '' when no path argument is present (e.g. bare @GetMapping).
 */
function extractAnnotationPath(annotationText: string): string {
  // value = "path" or just "path"
  const m = annotationText.match(/\(\s*(?:value\s*=\s*\[?\s*|path\s*=\s*\[?\s*)?["']([^"']+)["']/);
  return m ? m[1]! : '';
}

// ─── Route extraction ─────────────────────────────────────────────────────────

type SpringClassType = 'controller' | 'service' | 'component' | 'repository' | 'other';

interface PendingAnnotation {
  kind: 'class-role' | 'request-mapping' | 'http-method';
  classRole?: SpringClassType;    // for class-role
  path?: string;                  // for request-mapping / http-method
  httpMethod?: string;            // for http-method
  raw: string;                    // original annotation text (for signatures)
}

interface ClassFrame {
  type: SpringClassType;
  name: string;
  prefix: string;     // from @RequestMapping at class level
  entryDepth: number; // brace depth after the opening {
}

function extractSpringSymbols(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];

  // ── Event collection ─────────────────────────────────────────────────────────

  interface Event {
    pos: number;
    type:
      | 'class-anno'   // @RestController, @Controller, @Service, @Component, @Repository
      | 'req-mapping'  // @RequestMapping (class-level prefix or method-level route)
      | 'http-anno'    // @GetMapping, @PostMapping, etc.
      | 'class-decl'   // class Foo
      | 'fun-decl'     // fun foo
      | 'open'         // {
      | 'close';       // }
    name?: string;           // for class-decl / fun-decl
    classRole?: SpringClassType;
    httpMethod?: string;
    path?: string;
    raw?: string;
  }

  const events: Event[] = [];

  const ORDER: Record<Event['type'], number> = {
    'class-anno': 0,
    'req-mapping': 0,
    'http-anno': 0,
    'class-decl': 0,
    'fun-decl': 0,
    'open': 1,
    'close': 2,
  };

  let m: RegExpExecArray | null;

  // Class-role annotations
  const classAnnoRe =
    /@(RestController|Controller|Service|Component|Repository)(?:\s*\([^)]*\))?/g;
  while ((m = classAnnoRe.exec(source)) !== null) {
    const anno = m[1]!;
    let classRole: SpringClassType;
    if (anno === 'RestController' || anno === 'Controller') classRole = 'controller';
    else if (anno === 'Service') classRole = 'service';
    else if (anno === 'Component') classRole = 'component';
    else classRole = 'repository';
    events.push({ pos: m.index, type: 'class-anno', classRole, raw: m[0] });
  }

  // @RequestMapping
  const reqMappingRe = /@RequestMapping\s*(?:\([^)]*\))?/g;
  while ((m = reqMappingRe.exec(source)) !== null) {
    const path = extractAnnotationPath(m[0]);
    events.push({ pos: m.index, type: 'req-mapping', path, raw: m[0] });
  }

  // HTTP method annotations
  const httpAnnoRe =
    /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*(?:\([^)]*\))?/g;
  const ANNO_TO_METHOD: Record<string, string> = {
    GetMapping: 'GET',
    PostMapping: 'POST',
    PutMapping: 'PUT',
    DeleteMapping: 'DELETE',
    PatchMapping: 'PATCH',
  };
  while ((m = httpAnnoRe.exec(source)) !== null) {
    const httpMethod = ANNO_TO_METHOD[m[1]!]!;
    const path = extractAnnotationPath(m[0]);
    events.push({ pos: m.index, type: 'http-anno', httpMethod, path, raw: m[0] });
  }

  // class Name  (only named classes)
  const classRe = /\bclass\s+([A-Z]\w*)/g;
  while ((m = classRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'class-decl', name: m[1] });
  }

  // fun name
  const funRe = /\bfun\s+([a-zA-Z_]\w*)/g;
  while ((m = funRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'fun-decl', name: m[1] });
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

  // Sort by position, tiebreak by event order
  events.sort((a, b) => a.pos - b.pos || ORDER[a.type] - ORDER[b.type]);

  // ── State machine ─────────────────────────────────────────────────────────────

  // Pending annotations — cleared when consumed by a class or fun declaration
  const pendingClassAnnos: Array<{ classRole: SpringClassType; raw: string }> = [];
  let pendingReqMapping: { path: string; raw: string } | null = null;
  let pendingHttpAnno: { httpMethod: string; path: string; raw: string } | null = null;

  // Class stack: tracks nested class bodies
  const classStack: ClassFrame[] = [];
  let depth = 0;
  // Whether the next { opens the most recently seen class body
  let pendingClassFrame: ClassFrame | null = null;

  // Clear annotation state when we pass a {, }, class, or fun that doesn't belong
  // to them (i.e. they go stale). We keep annotations until either consumed or
  // a class/fun declaration sweeps them up.
  // For simplicity: we keep the last class-role annotation and last req-mapping
  // seen before a class declaration; and last http-anno seen before a fun.

  const seen = new Set<string>();

  for (const ev of events) {
    switch (ev.type) {
      case 'class-anno':
        pendingClassAnnos.push({ classRole: ev.classRole!, raw: ev.raw! });
        break;

      case 'req-mapping':
        pendingReqMapping = { path: ev.path ?? '', raw: ev.raw! };
        break;

      case 'http-anno':
        pendingHttpAnno = { httpMethod: ev.httpMethod!, path: ev.path ?? '', raw: ev.raw! };
        break;

      case 'class-decl': {
        const className = ev.name!;

        // Consume pending class annotations
        const roleAnno = pendingClassAnnos.length > 0
          ? pendingClassAnnos[pendingClassAnnos.length - 1]!
          : null;

        let classType: SpringClassType = 'other';
        let annoRaw = '';
        if (roleAnno) {
          classType = roleAnno.classRole;
          annoRaw = roleAnno.raw;
        }

        // Extract class-level @RequestMapping prefix
        const prefix = pendingReqMapping?.path ?? '';

        // Reset pending
        pendingClassAnnos.length = 0;
        pendingReqMapping = null;
        pendingHttpAnno = null;

        if (classType === 'other') {
          pendingClassFrame = { type: 'other', name: className, prefix: '', entryDepth: 0 };
          break;
        }

        // Emit class symbol
        const metaKey = springMetaKey(classType);
        const sig = `${annoRaw} class ${className}`;
        const routePath = prefix || undefined;

        symbols.push({
          id: makeId(filePath, className, 'class'),
          name: className,
          kind: 'class',
          filePath,
          startByte: ev.pos,
          endByte: ev.pos,
          signature: sig,
          summary: `Spring ${classType}: ${className}`,
          frameworkMeta: {
            [metaKey]: true,
            ...(routePath ? { route_prefix: routePath } : {}),
          },
        });

        pendingClassFrame = { type: classType, name: className, prefix, entryDepth: 0 };
        break;
      }

      case 'fun-decl': {
        // Only emit routes when directly inside a controller class body
        // "directly" = current stack top is a controller AND depth == top.entryDepth
        const top = classStack[classStack.length - 1];
        if (!top || top.type !== 'controller' || depth !== top.entryDepth) {
          pendingHttpAnno = null;
          break;
        }

        if (!pendingHttpAnno) break;

        const { httpMethod, path, raw: httpRaw } = pendingHttpAnno;
        pendingHttpAnno = null;

        const fullPath = joinPaths(top.prefix, path);
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
            signature: `${httpRaw} fun ${ev.name}(...)`,
            summary: `Spring route: ${routeName}`,
            frameworkMeta: {
              http_method: httpMethod,
              route_path: fullPath,
              spring_route: true,
            },
          });
        }
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
        // Pop frames whose entryDepth > depth after decrement
        // Frame was entered at depth N; exits when we decrement from N to N-1
        const newDepth = depth - 1;
        while (classStack.length > 0) {
          const top = classStack[classStack.length - 1]!;
          if (top.entryDepth > depth) {
            classStack.pop();
          } else {
            break;
          }
        }
        depth = newDepth;
        break;
      }
    }
  }

  return symbols;
}

function springMetaKey(type: SpringClassType): string {
  switch (type) {
    case 'controller': return 'spring_controller';
    case 'service': return 'spring_service';
    case 'component': return 'spring_component';
    case 'repository': return 'spring_repository';
    default: return 'spring_class';
  }
}

// ─── Spring Kotlin adapter ────────────────────────────────────────────────────

export const springKotlinAdapter: FrameworkAdapter = {
  name: 'spring-kotlin',

  extensions: () => [],

  async detect(projectRoot: string): Promise<boolean> {
    // Check build.gradle.kts or build.gradle for org.springframework.boot
    for (const buildFile of ['build.gradle.kts', 'build.gradle']) {
      try {
        const content = readFileSync(join(projectRoot, buildFile), 'utf8');
        if (content.includes('org.springframework.boot')) return true;
      } catch {
        // file absent — try next
      }
    }
    // Check pom.xml
    try {
      const pom = readFileSync(join(projectRoot, 'pom.xml'), 'utf8');
      if (pom.includes('<artifactId>spring-boot-starter</artifactId>')) return true;
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
    return extractSpringSymbols(source.toString('utf8'), filePath);
  },

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(springKotlinAdapter);
logger.debug("Adapter 'spring-kotlin' registered");
