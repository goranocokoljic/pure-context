/**
 * Micronaut adapter (Java/Kotlin/Groovy).
 *
 * Extracts route, bean, client, scheduled, and event listener symbols from
 * Micronaut applications. Micronaut uses compile-time DI with annotations
 * similar in style to Spring Boot but with different annotation names.
 *
 * Patterns recognised:
 *   @Controller("/prefix") class Foo { … }    → class (micronaut_controller)
 *   @Get / @Post / … on methods               → route (micronaut_route)
 *   @Singleton / @Prototype class Foo { … }   → class (micronaut_bean)
 *   @Bean on method in @Factory class         → function (micronaut_bean)
 *   @Client("/base") interface Foo { … }      → interface (micronaut_client)
 *   @Scheduled on methods                     → function (micronaut_scheduled)
 *   @EventListener on methods                 → function (micronaut_listener)
 *
 * Micronaut path variables use `{param}` syntax: `/users/{id}`.
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
 * Extract the first string-literal path argument from a Micronaut annotation.
 * Handles: @Get("/path"), @Get(value = "/path"), @Controller("/prefix")
 * Returns '' when no path argument is present.
 */
function extractAnnotationPath(annotationText: string): string {
  const m = annotationText.match(
    /\(\s*(?:value\s*=\s*)?["']([^"']+)["']/,
  );
  return m ? m[1]! : '';
}

// ─── Frame types ──────────────────────────────────────────────────────────────

type MicronautFrameType = 'controller' | 'bean' | 'factory' | 'client' | 'other';

interface ClassFrame {
  type: MicronautFrameType;
  name: string;
  prefix: string;     // from @Controller("/prefix")
  entryDepth: number; // brace depth when this class body opened
  isInterface: boolean;
}

// ─── Symbol extraction state machine ──────────────────────────────────────────

function extractMicronautSymbols(source: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];

  // ── Event types ──────────────────────────────────────────────────────────────

  interface Event {
    pos: number;
    type:
      | 'controller-anno'
      | 'http-anno'
      | 'bean-scope-anno'   // @Singleton, @Prototype → class level
      | 'bean-method-anno'  // @Bean → method level
      | 'factory-anno'      // @Factory → class level
      | 'client-anno'
      | 'scheduled-anno'
      | 'listener-anno'
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
    'controller-anno': 0,
    'http-anno': 0,
    'bean-scope-anno': 0,
    'bean-method-anno': 0,
    'factory-anno': 0,
    'client-anno': 0,
    'scheduled-anno': 0,
    'listener-anno': 0,
    'class-decl': 0,
    'interface-decl': 0,
    'method-decl': 0,
    'open': 1,
    'close': 2,
  };

  const events: Event[] = [];
  let m: RegExpExecArray | null;

  // ── Annotation scanning ───────────────────────────────────────────────────────

  // @Controller("/prefix")
  const controllerAnnoRe = /@Controller\s*(?:\([^)]*\))?/g;
  while ((m = controllerAnnoRe.exec(source)) !== null) {
    const path = extractAnnotationPath(m[0]);
    events.push({ pos: m.index, type: 'controller-anno', path, raw: m[0] });
  }

  // HTTP method annotations: @Get, @Post, @Put, @Delete, @Patch
  const httpAnnoRe = /@(Get|Post|Put|Delete|Patch)\s*(?:\([^)]*\))?/g;
  const ANNO_TO_METHOD: Record<string, string> = {
    Get: 'GET',
    Post: 'POST',
    Put: 'PUT',
    Delete: 'DELETE',
    Patch: 'PATCH',
  };
  while ((m = httpAnnoRe.exec(source)) !== null) {
    const httpMethod = ANNO_TO_METHOD[m[1]!]!;
    const path = extractAnnotationPath(m[0]);
    events.push({ pos: m.index, type: 'http-anno', httpMethod, path, raw: m[0] });
  }

  // @Singleton, @Prototype → class-level bean scopes
  const beanScopeRe = /@(Singleton|Prototype)\b(?:\s*\([^)]*\))?/g;
  while ((m = beanScopeRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'bean-scope-anno', raw: m[0] });
  }

  // @Bean → method-level (inside @Factory class)
  const beanMethodRe = /@Bean\b(?:\s*\([^)]*\))?/g;
  while ((m = beanMethodRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'bean-method-anno', raw: m[0] });
  }

  // @Factory → class-level
  const factoryAnnoRe = /@Factory\b(?:\s*\([^)]*\))?/g;
  while ((m = factoryAnnoRe.exec(source)) !== null) {
    events.push({ pos: m.index, type: 'factory-anno', raw: m[0] });
  }

  // @Client("/base")
  const clientAnnoRe = /@Client\s*(?:\([^)]*\))?/g;
  while ((m = clientAnnoRe.exec(source)) !== null) {
    const path = extractAnnotationPath(m[0]);
    events.push({ pos: m.index, type: 'client-anno', path, raw: m[0] });
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

  let pendingControllerAnno: { path: string; raw: string } | null = null;
  let pendingHttpAnno: { httpMethod: string; path: string; raw: string } | null = null;
  let pendingBeanScopeAnno: { raw: string } | null = null;
  let pendingBeanMethodAnno: { raw: string } | null = null;
  let pendingFactoryAnno: { raw: string } | null = null;
  let pendingClientAnno: { path: string; raw: string } | null = null;
  let pendingScheduledAnno: { raw: string } | null = null;
  let pendingListenerAnno: { raw: string } | null = null;

  const classStack: ClassFrame[] = [];
  let depth = 0;
  let pendingClassFrame: ClassFrame | null = null;

  const seen = new Set<string>();

  function clearClassLevelPending(): void {
    pendingControllerAnno = null;
    pendingBeanScopeAnno = null;
    pendingFactoryAnno = null;
    pendingClientAnno = null;
    pendingHttpAnno = null;
    pendingBeanMethodAnno = null;
    pendingScheduledAnno = null;
    pendingListenerAnno = null;
  }

  function clearMethodLevelPending(): void {
    pendingHttpAnno = null;
    pendingBeanMethodAnno = null;
    pendingScheduledAnno = null;
    pendingListenerAnno = null;
  }

  for (const ev of events) {
    switch (ev.type) {
      case 'controller-anno':
        pendingControllerAnno = { path: ev.path ?? '', raw: ev.raw! };
        break;

      case 'http-anno':
        pendingHttpAnno = { httpMethod: ev.httpMethod!, path: ev.path ?? '', raw: ev.raw! };
        break;

      case 'bean-scope-anno':
        pendingBeanScopeAnno = { raw: ev.raw! };
        break;

      case 'bean-method-anno':
        pendingBeanMethodAnno = { raw: ev.raw! };
        break;

      case 'factory-anno':
        pendingFactoryAnno = { raw: ev.raw! };
        break;

      case 'client-anno':
        pendingClientAnno = { path: ev.path ?? '', raw: ev.raw! };
        break;

      case 'scheduled-anno':
        pendingScheduledAnno = { raw: ev.raw! };
        break;

      case 'listener-anno':
        pendingListenerAnno = { raw: ev.raw! };
        break;

      case 'class-decl': {
        const className = ev.name!;

        if (pendingControllerAnno) {
          const { path: prefix, raw: annoRaw } = pendingControllerAnno;
          symbols.push({
            id: makeId(filePath, className, 'class'),
            name: className,
            kind: 'class',
            filePath,
            startByte: ev.pos,
            endByte: ev.pos,
            signature: `${annoRaw} class ${className}`,
            summary: `Micronaut controller: ${className}`,
            frameworkMeta: {
              micronaut_controller: true,
              ...(prefix ? { route_prefix: prefix } : {}),
            },
          });
          pendingClassFrame = { type: 'controller', name: className, prefix, entryDepth: 0, isInterface: false };
        } else if (pendingBeanScopeAnno) {
          symbols.push({
            id: makeId(filePath, className, 'class'),
            name: className,
            kind: 'class',
            filePath,
            startByte: ev.pos,
            endByte: ev.pos,
            signature: `${pendingBeanScopeAnno.raw} class ${className}`,
            summary: `Micronaut bean: ${className}`,
            frameworkMeta: { micronaut_bean: true },
          });
          pendingClassFrame = { type: 'bean', name: className, prefix: '', entryDepth: 0, isInterface: false };
        } else if (pendingFactoryAnno) {
          pendingClassFrame = { type: 'factory', name: className, prefix: '', entryDepth: 0, isInterface: false };
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
              summary: `Micronaut HTTP client: ${ifaceName}`,
              frameworkMeta: {
                micronaut_client: true,
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

        // Route: inside a controller at class body depth
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
              summary: `Micronaut route: ${routeName}`,
              frameworkMeta: {
                http_method: httpMethod,
                route_path: fullPath,
                micronaut_route: true,
              },
            });
          }
        }

        // @Bean method inside @Factory class
        if (pendingBeanMethodAnno && top && top.type === 'factory') {
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
              summary: `Micronaut bean: ${methodName}`,
              frameworkMeta: { micronaut_bean: true },
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
              summary: `Micronaut scheduled task: ${methodName}`,
              frameworkMeta: { micronaut_scheduled: true },
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
              summary: `Micronaut event listener: ${methodName}`,
              frameworkMeta: { micronaut_listener: true },
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
 * Check pom.xml for Micronaut artifact (micronaut-* groupId or artifactId).
 */
function detectPomXml(projectRoot: string): boolean {
  try {
    const pom = readFileSync(join(projectRoot, 'pom.xml'), 'utf8');
    return /micronaut-/i.test(pom) || pom.includes('io.micronaut');
  } catch {
    return false;
  }
}

/**
 * Check Gradle build files for Micronaut dependency or plugin.
 */
function detectGradle(projectRoot: string): boolean {
  for (const buildFile of ['build.gradle.kts', 'build.gradle']) {
    try {
      const content = readFileSync(join(projectRoot, buildFile), 'utf8');
      if (content.includes('io.micronaut')) return true;
    } catch {
      // file absent — try next
    }
  }
  return false;
}

// ─── Micronaut adapter ────────────────────────────────────────────────────────

export const micronautAdapter: FrameworkAdapter = {
  name: 'micronaut',

  /** No new file extensions — `.java`, `.kt`, `.groovy` handled by language handlers. */
  extensions: () => [],

  // ── Detection ─────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    return detectPomXml(projectRoot) || detectGradle(projectRoot);
  },

  // ── File routing ───────────────────────────────────────────────────────────

  fileFilter: (filePath: string): boolean =>
    filePath.endsWith('.java') ||
    filePath.endsWith('.kt') ||
    filePath.endsWith('.groovy'),

  // ── Framework symbol extraction ────────────────────────────────────────────

  extractFrameworkSymbols(
    _tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    return extractMicronautSymbols(source.toString('utf8'), filePath);
  },

  // ── Metadata enrichment ────────────────────────────────────────────────────

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(micronautAdapter);
logger.debug("Adapter 'micronaut' registered");
