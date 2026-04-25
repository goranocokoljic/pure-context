/**
 * Spring Boot adapter (Java).
 *
 * Extracts route, controller, service, bean, scheduled, and event listener
 * symbols from Spring Boot applications written in Java. Both `.java` and `.kt`
 * files are accepted (Kotlin Spring files share the same annotation syntax).
 *
 * Patterns recognised:
 *   @RestController / @Controller class Foo { … }   → class (spring_controller)
 *   @Service class FooService { … }                  → class (spring_bean)
 *   @Component class Foo { … }                       → class (spring_bean)
 *   @Repository class FooRepo { … }                  → class (spring_bean)
 *   @Configuration class Cfg { … }                   → class (spring_config)
 *   @RequestMapping("/prefix") at class level        → base path prefix
 *   @GetMapping / @PostMapping / … on method         → route (spring_route)
 *   @Bean on method                                  → function (spring_bean)
 *   @Scheduled on method                             → function (spring_scheduled)
 *   @EventListener on method                         → function (spring_listener)
 *
 * Spring path variables use `{param}` syntax: `/users/{id}`.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
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
 * Extract the first string-literal path argument from a Spring annotation call.
 * Handles: @GetMapping("/path"), @GetMapping(value = "/path"), @GetMapping("/p1")
 * Returns '' when no path argument is present (e.g. bare @GetMapping).
 */
function extractAnnotationPath(annotationText: string): string {
  const m = annotationText.match(
    /\(\s*(?:value\s*=\s*\[?\s*|path\s*=\s*\[?\s*)?["']([^"']+)["']/,
  );
  return m ? m[1]! : '';
}

// ─── Class type ───────────────────────────────────────────────────────────────

type SpringClassType =
  | 'controller'
  | 'service'
  | 'component'
  | 'repository'
  | 'configuration'
  | 'other';

interface ClassFrame {
  type: SpringClassType;
  name: string;
  prefix: string;     // from @RequestMapping at class level
  entryDepth: number; // brace depth when this class body opened
}

// ─── Symbol extraction state machine ──────────────────────────────────────────

function extractSpringBootSymbols(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];

  // ── Event types ──────────────────────────────────────────────────────────────

  interface Event {
    pos: number;
    type:
      | 'class-anno'
      | 'req-mapping'
      | 'http-anno'
      | 'bean-anno'
      | 'scheduled-anno'
      | 'listener-anno'
      | 'class-decl'
      | 'method-decl'
      | 'open'
      | 'close';
    name?: string;
    classRole?: SpringClassType;
    httpMethod?: string;
    path?: string;
    raw?: string;
  }

  const ORDER: Record<Event['type'], number> = {
    'class-anno': 0,
    'req-mapping': 0,
    'http-anno': 0,
    'bean-anno': 0,
    'scheduled-anno': 0,
    'listener-anno': 0,
    'class-decl': 0,
    'method-decl': 0,
    'open': 1,
    'close': 2,
  };

  const events: Event[] = [];
  let m: RegExpExecArray | null;

  // ── Annotation scanning ───────────────────────────────────────────────────────

  // @RestController, @Controller, @Service, @Component, @Repository, @Configuration
  const classAnnoRe =
    /@(RestController|Controller|Service|Component|Repository|Configuration)(?:\s*\([^)]*\))?/g;
  while ((m = classAnnoRe.exec(source)) !== null) {
    const anno = m[1]!;
    let classRole: SpringClassType;
    if (anno === 'RestController' || anno === 'Controller') classRole = 'controller';
    else if (anno === 'Service') classRole = 'service';
    else if (anno === 'Component') classRole = 'component';
    else if (anno === 'Repository') classRole = 'repository';
    else classRole = 'configuration'; // Configuration
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

  // @Bean
  const beanAnnoRe = /@Bean\b(?:\s*\([^)]*\))?/g;
  while ((m = beanAnnoRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'bean-anno', raw: m[0] });
  }

  // @Scheduled
  const scheduledAnnoRe = /@Scheduled\b(?:\s*\([^)]*\))?/g;
  while ((m = scheduledAnnoRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'scheduled-anno', raw: m[0] });
  }

  // @EventListener
  const listenerAnnoRe = /@EventListener\b(?:\s*\([^)]*\))?/g;
  while ((m = listenerAnnoRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'listener-anno', raw: m[0] });
  }

  // ── Declaration scanning ──────────────────────────────────────────────────────

  // class ClassName  (upper-case name to exclude inner anonymous classes)
  const classRe = /\bclass\s+([A-Z]\w*)/g;
  while ((m = classRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'class-decl', name: m[1] });
  }

  // Java method declarations: public/protected/private ... methodName(
  // Consume return type/modifiers up to the last whitespace before the method
  // name, then capture the lowercase-starting identifier before `(`.
  // The `\s` anchor before the capture group ensures we grab the full word,
  // not just its last character (which greedy backtracking would otherwise do).
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

  const pendingClassAnnos: Array<{ classRole: SpringClassType; raw: string }> = [];
  let pendingReqMapping: { path: string; raw: string } | null = null;
  let pendingHttpAnno: { httpMethod: string; path: string; raw: string } | null = null;
  let pendingBeanAnno: { raw: string } | null = null;
  let pendingScheduledAnno: { raw: string } | null = null;
  let pendingListenerAnno: { raw: string } | null = null;

  const classStack: ClassFrame[] = [];
  let depth = 0;
  let pendingClassFrame: ClassFrame | null = null;

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

      case 'bean-anno':
        pendingBeanAnno = { raw: ev.raw! };
        break;

      case 'scheduled-anno':
        pendingScheduledAnno = { raw: ev.raw! };
        break;

      case 'listener-anno':
        pendingListenerAnno = { raw: ev.raw! };
        break;

      case 'class-decl': {
        const className = ev.name!;
        const roleAnno = pendingClassAnnos.length > 0
          ? pendingClassAnnos[pendingClassAnnos.length - 1]!
          : null;

        const classType: SpringClassType = roleAnno?.classRole ?? 'other';
        const annoRaw = roleAnno?.raw ?? '';
        const prefix = pendingReqMapping?.path ?? '';

        // Clear class-level pending state
        pendingClassAnnos.length = 0;
        pendingReqMapping = null;
        pendingHttpAnno = null;
        pendingBeanAnno = null;
        pendingScheduledAnno = null;
        pendingListenerAnno = null;

        if (classType === 'other') {
          pendingClassFrame = { type: 'other', name: className, prefix: '', entryDepth: 0 };
          break;
        }

        const metaKey = springClassMetaKey(classType);
        const sig = `${annoRaw} class ${className}`;

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
            ...(prefix ? { route_prefix: prefix } : {}),
          },
        });

        pendingClassFrame = { type: classType, name: className, prefix, entryDepth: 0 };
        break;
      }

      case 'method-decl': {
        const methodName = ev.name ?? '<method>';

        // Route: only inside a controller class at top-level depth
        const top = classStack[classStack.length - 1];
        if (top && top.type === 'controller' && depth === top.entryDepth && pendingHttpAnno) {
          const { httpMethod, path, raw: httpRaw } = pendingHttpAnno;
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
              signature: `${httpRaw} public ... ${methodName}(...)`,
              summary: `Spring route: ${routeName}`,
              frameworkMeta: {
                http_method: httpMethod,
                route_path: fullPath,
                spring_route: true,
              },
            });
          }
        }

        // @Bean method
        if (pendingBeanAnno) {
          if (!seen.has(`bean:${methodName}`)) {
            seen.add(`bean:${methodName}`);
            symbols.push({
              id: makeId(filePath, methodName, 'function'),
              name: methodName,
              kind: 'function',
              filePath,
              startByte: ev.pos,
              endByte: ev.pos,
              signature: `@Bean public ... ${methodName}()`,
              summary: `Spring bean: ${methodName}`,
              frameworkMeta: { spring_bean: true },
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
              summary: `Spring scheduled task: ${methodName}`,
              frameworkMeta: { spring_scheduled: true },
            });
          }
        }

        // @EventListener method
        if (pendingListenerAnno) {
          if (!seen.has(`listener:${methodName}`)) {
            seen.add(`listener:${methodName}`);
            symbols.push({
              id: makeId(filePath, methodName, 'function'),
              name: methodName,
              kind: 'function',
              filePath,
              startByte: ev.pos,
              endByte: ev.pos,
              signature: `@EventListener public void ${methodName}(...)`,
              summary: `Spring event listener: ${methodName}`,
              frameworkMeta: { spring_listener: true },
            });
          }
        }

        // Clear all method-level pending annotations
        pendingHttpAnno = null;
        pendingBeanAnno = null;
        pendingScheduledAnno = null;
        pendingListenerAnno = null;
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

function springClassMetaKey(type: SpringClassType): string {
  switch (type) {
    case 'controller': return 'spring_controller';
    case 'service': return 'spring_bean';
    case 'component': return 'spring_bean';
    case 'repository': return 'spring_bean';
    case 'configuration': return 'spring_config';
    default: return 'spring_class';
  }
}

// ─── Detection helpers ────────────────────────────────────────────────────────

/**
 * Check pom.xml for Spring Boot starter dependency.
 */
function detectPomXml(projectRoot: string): boolean {
  try {
    const pom = readFileSync(join(projectRoot, 'pom.xml'), 'utf8');
    return pom.includes('spring-boot-starter');
  } catch {
    return false;
  }
}

/**
 * Check Gradle build files for Spring Boot plugin or dependency.
 */
function detectGradle(projectRoot: string): boolean {
  for (const buildFile of ['build.gradle.kts', 'build.gradle']) {
    try {
      const content = readFileSync(join(projectRoot, buildFile), 'utf8');
      if (content.includes('org.springframework.boot')) return true;
    } catch {
      // file absent — try next
    }
  }
  return false;
}

/**
 * Check for application.properties or application.yml presence (common Spring Boot artifact).
 */
function detectApplicationConfig(projectRoot: string): boolean {
  const paths = [
    join(projectRoot, 'src', 'main', 'resources', 'application.properties'),
    join(projectRoot, 'src', 'main', 'resources', 'application.yml'),
  ];
  return paths.some((p) => existsSync(p));
}

// ─── Spring Boot adapter ──────────────────────────────────────────────────────

export const springBootAdapter: FrameworkAdapter = {
  name: 'spring-boot',

  /** `.java` and `.kt` files — no new extensions beyond what handlers cover. */
  extensions: () => [],

  // ── Detection ─────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    return detectPomXml(projectRoot) || detectGradle(projectRoot) || detectApplicationConfig(projectRoot);
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
    return extractSpringBootSymbols(source.toString('utf8'), filePath);
  },

  // ── Metadata enrichment ────────────────────────────────────────────────────

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(springBootAdapter);
logger.debug("Adapter 'spring-boot' registered");
