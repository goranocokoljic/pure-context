/**
 * Angular framework adapter.
 *
 * Detects Angular projects via @angular/core in package.json.
 * Classifies decorated class symbols (@Component, @Injectable, @NgModule,
 * @Directive, @Pipe, CanActivate guards) and extracts route paths from
 * RouterModule.
 *
 * Extraction model (Phase 94, Task 583 — the android/react pattern):
 * extractFrameworkSymbols collects per-class decorator FACTS into a bounded
 * per-file cache and emits only route symbols; enrichMetadata upgrades the
 * TypeScript handler's own class/const rows in place (kind + frameworkMeta,
 * id recomputed for kind changes, real spans/signatures/docstrings preserved).
 * This guarantees ONE row per class — the pre-94 adapter re-emitted every
 * decorated class under a second id (kind is inside the id hash), producing
 * systematic duplicates.
 *
 * Statelessness rule (Phase 75 lesson): the facts cache is written in
 * extractFrameworkSymbols and read synchronously by enrichMetadata within the
 * same processFile call — no await between the two; each worker thread has its
 * own module instance.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import type { FrameworkAdapter, SymbolRecord, SymbolKind, Tree, SyntaxNode } from '../core/types.js';
import { registerAdapter } from './adapter-registry.js';
import { scanForFramework, pkgDepMatches } from './detect-utils.js';
import { logger } from '../core/logger.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: string): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

// ─── Per-file class facts ─────────────────────────────────────────────────────

export interface AngularClassFact {
  /** Kind to upgrade the handler symbol to; undefined keeps the handler kind. */
  kind?: 'component' | 'middleware';
  /** Handler kinds this fact may upgrade (class facts never touch consts, etc.). */
  inputKinds: readonly SymbolKind[];
  /** frameworkMeta merged onto the handler symbol. */
  meta: Record<string, unknown>;
  /** Fallback summary used only when the handler symbol has no docstring. */
  summary: string;
}

interface FileFacts {
  entries: Map<string, AngularClassFact>;
  /**
   * True when the file imports from '@nestjs/' — angular shadows nestjs on
   * shared suffixes (registration order), so it must never stamp Angular
   * metadata on NestJS code (Phase 94, Task 587 / A-12).
   */
  nestjs?: boolean;
}

// Bounded cache written by extractFrameworkSymbols, read by enrichMetadata for
// the same file within the same processFile call. Cleared wholesale when full.
const factsCache = new Map<string, FileFacts>();
const FACTS_CACHE_MAX = 256;

function putFacts(filePath: string, facts: FileFacts): void {
  if (factsCache.size >= FACTS_CACHE_MAX) factsCache.clear();
  factsCache.set(filePath, facts);
}

/** Test hook — inspect/clear the facts cache. */
export function _factsCacheForTesting(): Map<string, FileFacts> {
  return factsCache;
}

// ─── Decorator detection ──────────────────────────────────────────────────────

type AngularDecoratorKind =
  | '@Component'
  | '@Injectable'
  | '@NgModule'
  | '@Directive'
  | '@Pipe'
  | '@Guard';

const ANGULAR_DECORATORS = new Set<string>([
  '@Component',
  '@Injectable',
  '@NgModule',
  '@Directive',
  '@Pipe',
]);

/**
 * Detect the Angular decorator on a class declaration by scanning the source
 * text for the decorator that immediately precedes the class keyword.
 * Returns the decorator name (e.g. '@Component') or null.
 */
function detectAngularDecorator(
  classNode: SyntaxNode,
  sourceStr: string,
): { decorator: AngularDecoratorKind; metaBlock: string } | null {
  // Walk back through named siblings looking for a decorator node
  let prev = classNode.previousNamedSibling;
  while (prev !== null) {
    if (prev.type === 'decorator') {
      const decoratorText = sourceStr.slice(prev.startIndex, prev.endIndex);
      for (const dec of ANGULAR_DECORATORS) {
        if (decoratorText.startsWith(dec)) {
          return { decorator: dec as AngularDecoratorKind, metaBlock: decoratorText };
        }
      }
      // Non-Angular decorator — keep walking back for stacked decorators
    } else if (prev.type !== 'comment' && prev.type !== 'export') {
      break;
    }
    prev = prev.previousNamedSibling;
  }

  // Also check if this classNode is inside an export_statement and look at
  // siblings of the export_statement
  if (classNode.parent?.type === 'export_statement') {
    let outerPrev = classNode.parent.previousNamedSibling;
    while (outerPrev !== null) {
      if (outerPrev.type === 'decorator') {
        const decoratorText = sourceStr.slice(outerPrev.startIndex, outerPrev.endIndex);
        for (const dec of ANGULAR_DECORATORS) {
          if (decoratorText.startsWith(dec)) {
            return { decorator: dec as AngularDecoratorKind, metaBlock: decoratorText };
          }
        }
      } else if (outerPrev.type !== 'comment') {
        break;
      }
      outerPrev = outerPrev.previousNamedSibling;
    }
  }

  // Fallback: check if decorator is a direct child of the class node
  const decoratorChild = classNode.children.find((c) => c.type === 'decorator');
  if (decoratorChild) {
    const decoratorText = sourceStr.slice(decoratorChild.startIndex, decoratorChild.endIndex);
    for (const dec of ANGULAR_DECORATORS) {
      if (decoratorText.startsWith(dec)) {
        return { decorator: dec as AngularDecoratorKind, metaBlock: decoratorText };
      }
    }
  }

  return null;
}

/**
 * Check if a class declares a router-guard interface in its HERITAGE clause
 * (Phase 94, Task 586 / A-7). The pre-94 check regex-tested the WHOLE class
 * text including bodies and comments — a service merely mentioning
 * CanActivate became kind middleware. Only the class head (start → body
 * brace) is tested now, and all guard interfaces are recognized.
 */
function implementsGuardInterface(classNode: SyntaxNode, sourceStr: string): boolean {
  const body = classNode.children.find((c) => c.type === 'class_body');
  const headEnd = body ? body.startIndex : classNode.endIndex;
  const head = sourceStr.slice(classNode.startIndex, headEnd);
  return /\bimplements\b[^{]*\bCan(Activate|ActivateChild|Deactivate|Match|Load)\b/.test(head);
}

// ─── Metadata extraction ──────────────────────────────────────────────────────

/**
 * Extract a string property value from a decorator metadata object.
 * e.g. `@Component({ selector: 'app-root', ... })` → { selector: 'app-root' }
 */
function extractMetaProperty(metaBlock: string, property: string): string | null {
  const re = new RegExp(`\\b${property}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`);
  const m = metaBlock.match(re);
  return m ? m[1]! : null;
}

// ─── Route extraction ─────────────────────────────────────────────────────────

/**
 * Slice the content of a bracket-balanced `[...]` starting at `openIdx`
 * (which must point at the `[`). Returns null when unterminated.
 */
function bracketSlice(src: string, openIdx: number): string | null {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return null;
}

/**
 * Find the array-literal initializer of `const/let/var <name> [: Type] = [...]`
 * in the same file. Returns the char index of the `[` or null.
 * Cross-file route variables are a documented v1 limitation.
 */
function findRoutesVarArray(sourceStr: string, varName: string): number | null {
  const declRe = new RegExp(
    `(?:const|let|var)\\s+${varName}\\s*(?::\\s*[A-Za-z_$][\\w$<>,\\s.\\[\\]]*)?=\\s*\\[`,
  );
  const m = declRe.exec(sourceStr);
  if (m === null) return null;
  return m.index + m[0].length - 1;
}

/**
 * Extract Angular route paths (Phase 94, Task 586 rewrite / A-4).
 *
 * Sources of route arrays:
 *   - RouterModule.forRoot([...]) / forChild([...]) — inline arrays
 *   - RouterModule.forRoot(routesVar) — same-file variable resolution
 *   - provideRouter([...]) / provideRouter(routesVar) — standalone bootstrap
 *   - export const routes: Routes = [...] — *.routes.ts convention
 *
 * Arrays are bracket-matched (depth counter), so nested canActivate/children
 * arrays no longer truncate. Per route: `component`/`loadComponent`/
 * `loadChildren` target and `canActivate` guard names land in frameworkMeta.
 * Spans are CHAR offsets (converted to bytes by the file-processor).
 */
function extractAngularRoutes(
  sourceStr: string,
  filePath: string,
): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  // Dedupe route ARRAYS by their '[' offset (forRoot(routes) + the routes
  // declaration itself must not double-extract).
  const seenArrayStarts = new Set<number>();
  const seenRouteIds = new Set<string>();

  const collectArray = (openIdx: number): void => {
    if (seenArrayStarts.has(openIdx)) return;
    seenArrayStarts.add(openIdx);
    const block = bracketSlice(sourceStr, openIdx);
    if (block === null) return;
    const blockStart = openIdx + 1;

    const pathRe = /\bpath\s*:\s*['"`]([^'"`]*)['"`]/g;
    let pathMatch;
    const matches: Array<{ index: number; length: number; path: string }> = [];
    while ((pathMatch = pathRe.exec(block)) !== null) {
      matches.push({ index: pathMatch.index, length: pathMatch[0].length, path: pathMatch[1]! });
    }

    for (let i = 0; i < matches.length; i++) {
      const pm = matches[i]!;
      const name = pm.path === '' ? '/' : `/${pm.path}`;
      const id = makeId(filePath, name, 'route');
      if (seenRouteIds.has(id)) continue;
      seenRouteIds.add(id);

      // Route-local slice: from this path property to the next one (crude but
      // effective object scoping; a parent route's slice ends where its first
      // child's path begins, which keeps the parent's own component/guards).
      const sliceEnd = i + 1 < matches.length ? matches[i + 1]!.index : block.length;
      const routeSlice = block.slice(pm.index, sliceEnd);

      const meta: Record<string, unknown> = { router: 'angular' };
      const comp = /\bcomponent\s*:\s*([A-Za-z_$][\w$]*)/.exec(routeSlice);
      if (comp) meta['component'] = comp[1];
      if (/\bload(?:Component|Children)\s*:/.test(routeSlice)) meta['lazy'] = true;
      const guardList = /\bcanActivate(?:Child)?\s*:\s*\[([^\]]*)\]/.exec(routeSlice);
      if (guardList) {
        const guards = guardList[1]!
          .split(',')
          .map((g) => g.trim())
          .filter((g) => /^[A-Za-z_$][\w$]*$/.test(g));
        if (guards.length > 0) meta['guards'] = guards;
      }

      symbols.push({
        id,
        name,
        kind: 'route',
        filePath,
        startByte: blockStart + pm.index,
        endByte: blockStart + pm.index + pm.length,
        signature: `route '${name}'`,
        summary: `Angular route: ${name}`,
        frameworkMeta: meta,
      });
    }
  };

  // 1. RouterModule.forRoot/forChild + provideRouter — inline array or variable
  const callRe = /(?:RouterModule\.for(?:Root|Child)|provideRouter)\s*\(\s*(\[|[A-Za-z_$][\w$]*)/g;
  let callMatch;
  while ((callMatch = callRe.exec(sourceStr)) !== null) {
    const arg = callMatch[1]!;
    if (arg === '[') {
      collectArray(callMatch.index + callMatch[0].length - 1);
    } else {
      const openIdx = findRoutesVarArray(sourceStr, arg);
      if (openIdx !== null) collectArray(openIdx);
    }
  }

  // 2. Bare `<name>: Routes = [...]` declarations (the *.routes.ts convention)
  const routesDeclRe = /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:\s*Routes\s*=\s*\[/g;
  let declMatch;
  while ((declMatch = routesDeclRe.exec(sourceStr)) !== null) {
    collectArray(declMatch.index + declMatch[0].length - 1);
  }

  return symbols;
}

// ─── Class fact collection ────────────────────────────────────────────────────

const CLASS_INPUT_KINDS: readonly SymbolKind[] = ['class'];
const FN_GUARD_INPUT_KINDS: readonly SymbolKind[] = ['function', 'const'];

function collectAngularClassFacts(
  nodes: SyntaxNode[],
  sourceStr: string,
  entries: Map<string, AngularClassFact>,
): void {
  for (const node of nodes) {
    let classNode: SyntaxNode | null = null;

    if (node.type === 'class_declaration' || node.type === 'abstract_class_declaration') {
      classNode = node;
    } else if (node.type === 'export_statement') {
      // export class Foo { } / export abstract class Foo { }
      const inner = node.children.find(
        (c) => c.type === 'class_declaration' || c.type === 'abstract_class_declaration',
      );
      if (inner) classNode = inner;
    }

    if (classNode !== null) {
      const nameNode = classNode.children.find(
        (c) => c.type === 'type_identifier' || c.type === 'identifier',
      );
      if (!nameNode) continue;

      const className = sourceStr.slice(nameNode.startIndex, nameNode.endIndex);
      if (!className) continue;

      // Detect Angular decorator
      const decoratorInfo = detectAngularDecorator(classNode, sourceStr);

      // Guard = router-guard interface in the heritage clause (A-7)
      const isGuard =
        decoratorInfo?.decorator === '@Guard' ||
        implementsGuardInterface(classNode, sourceStr);

      if (!decoratorInfo && !isGuard) continue;

      const dec = decoratorInfo?.decorator;
      const metaBlock = decoratorInfo?.metaBlock ?? '';

      if (dec === '@Component' || dec === '@Directive') {
        const selector = extractMetaProperty(metaBlock, 'selector');
        // A-11: standalone is tri-state — for Angular ≥19 standalone is the
        // DEFAULT, so absence of the property means UNKNOWN, not false.
        const standalone = /\bstandalone\s*:\s*true\b/.test(metaBlock)
          ? true
          : /\bstandalone\s*:\s*false\b/.test(metaBlock)
            ? false
            : undefined;
        // Standalone imports: [...] component deps (names only)
        let imports: string[] | undefined;
        const importsIdx = metaBlock.search(/\bimports\s*:\s*\[/);
        if (importsIdx >= 0) {
          const openIdx = metaBlock.indexOf('[', importsIdx);
          const inner = bracketSlice(metaBlock, openIdx);
          if (inner) {
            const names = inner
              .split(',')
              .map((s) => s.trim())
              .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
            if (names.length > 0) imports = names;
          }
        }
        const isDirective = dec === '@Directive';

        entries.set(className, {
          kind: 'component',
          inputKinds: CLASS_INPUT_KINDS,
          meta: {
            selector: selector ?? null,
            angular_directive: isDirective || undefined,
            angular_standalone: standalone,
            angular_imports: imports,
          },
          summary: `Angular ${isDirective ? 'directive' : 'component'}: ${selector ?? className}`,
        });
        continue;
      }

      if (dec === '@Pipe') {
        const pipeName = extractMetaProperty(metaBlock, 'name');
        entries.set(className, {
          kind: 'component',
          inputKinds: CLASS_INPUT_KINDS,
          meta: {
            angular_pipe: true,
            pipe_name: pipeName ?? null,
          },
          summary: `Angular pipe: ${pipeName ?? className}`,
        });
        continue;
      }

      // isGuard takes priority over @Injectable — `@Injectable() implements CanActivate`
      // is the canonical Angular guard pattern. A guard IS injectable, so the
      // injectable flag is kept alongside (A-7 order fix).
      if (isGuard) {
        entries.set(className, {
          kind: 'middleware',
          inputKinds: CLASS_INPUT_KINDS,
          meta: {
            angular_guard: true,
            angular_injectable: dec === '@Injectable' || undefined,
          },
          summary: `Angular guard: ${className}`,
        });
        continue;
      }

      if (dec === '@Injectable') {
        entries.set(className, {
          inputKinds: CLASS_INPUT_KINDS,
          meta: {
            angular_service: true,
            angular_injectable: true,
          },
          summary: `Angular service: ${className}`,
        });
        continue;
      }

      if (dec === '@NgModule') {
        entries.set(className, {
          inputKinds: CLASS_INPUT_KINDS,
          meta: { angular_module: true },
          summary: `Angular module: ${className}`,
        });
        continue;
      }
    }

    // Functional router/http providers (Phase 94, Task 586 / A-7):
    // `export const authGuard: CanActivateFn = ...`,
    // `export const errorInterceptor: HttpInterceptorFn = ...`,
    // `export const bankAccountResolve: ResolveFn<T> = ...`.
    // The `/^can[A-Z]/` name rule stays as fallback for untyped guards.
    if (node.type === 'export_statement') {
      const lexDecl = node.children.find(
        (c) => c.type === 'lexical_declaration',
      );
      if (lexDecl) {
        const declarator = lexDecl.children.find((c) => c.type === 'variable_declarator');
        if (declarator) {
          const nameNode = declarator.children.find((c) => c.type === 'identifier');
          if (nameNode) {
            const fnName = sourceStr.slice(nameNode.startIndex, nameNode.endIndex);
            const typeNode = declarator.children.find((c) => c.type === 'type_annotation');
            const typeText = typeNode
              ? sourceStr.slice(typeNode.startIndex, typeNode.endIndex)
              : '';
            const fnType = /\b(CanActivateFn|CanActivateChildFn|CanDeactivateFn|CanMatchFn|ResolveFn|HttpInterceptorFn)\b/.exec(typeText)?.[1];

            if (fnType === 'HttpInterceptorFn') {
              entries.set(fnName, {
                kind: 'middleware',
                inputKinds: FN_GUARD_INPUT_KINDS,
                meta: { angular_interceptor: true },
                summary: `Angular functional interceptor: ${fnName}`,
              });
            } else if (fnType === 'ResolveFn') {
              entries.set(fnName, {
                kind: 'middleware',
                inputKinds: FN_GUARD_INPUT_KINDS,
                meta: { angular_resolver: true },
                summary: `Angular functional resolver: ${fnName}`,
              });
            } else if (fnType !== undefined || /^can[A-Z]/.test(fnName)) {
              entries.set(fnName, {
                kind: 'middleware',
                inputKinds: FN_GUARD_INPUT_KINDS,
                meta: { angular_guard: true },
                summary: `Angular functional guard: ${fnName}`,
              });
            }
          }
        }
      }
    }
  }
}

// ─── Angular adapter ──────────────────────────────────────────────────────────

/** Returns true if a package.json declares @angular/core. */
function pkgDeclaresAngular(raw: string): boolean {
  return pkgDepMatches(raw, (k) => k === '@angular/core');
}

export const angularAdapter: FrameworkAdapter = {
  name: 'angular',

  /** No new file extensions — .ts files are already handled by the TypeScript handler. */
  extensions: () => [],

  // ── Detection ───────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    // Fast path: root package.json declares @angular/core.
    try {
      if (pkgDeclaresAngular(readFileSync(`${projectRoot}/package.json`, 'utf8'))) return true;
    } catch {
      // no root package.json — fall through
    }

    // Workspace config at the root (Phase 94, Task 587 / A-8): angular.json is
    // the CLI's marker; workspace.json covers older Nx layouts.
    if (
      existsSync(`${projectRoot}/angular.json`) ||
      existsSync(`${projectRoot}/workspace.json`)
    ) {
      return true;
    }

    // Monorepo / sub-app fallback (svelte pattern): bounded recursive scan for
    // a nested angular.json or a nested package.json declaring @angular/core.
    return scanForFramework(projectRoot, {
      matchesFile: (name) => name === 'angular.json',
      pkgDeclares: pkgDeclaresAngular,
    });
  },

  // ── File routing ─────────────────────────────────────────────────────────────

  fileFilter: (filePath: string): boolean => {
    return (
      filePath.endsWith('.component.ts') ||
      filePath.endsWith('.service.ts') ||
      filePath.endsWith('.module.ts') ||
      filePath.endsWith('.directive.ts') ||
      filePath.endsWith('.pipe.ts') ||
      filePath.endsWith('.guard.ts') ||
      filePath.endsWith('.resolver.ts') ||
      filePath.endsWith('.interceptor.ts') ||
      filePath.endsWith('-routing.module.ts') ||
      // Phase 94 (Task 587 / A-8): standalone routing + bootstrap files
      filePath.endsWith('.routes.ts') ||
      filePath.endsWith('app.config.ts') ||
      filePath.endsWith('main.ts') ||
      // NgRx family
      filePath.endsWith('.effects.ts') ||
      filePath.endsWith('.reducer.ts') ||
      filePath.endsWith('.facade.ts') ||
      filePath.endsWith('.store.ts') ||
      filePath.endsWith('.state.ts')
    );
  },

  // ── Framework symbol extraction ──────────────────────────────────────────────

  /**
   * Collects class facts for enrichMetadata (no class symbols emitted here —
   * the TS handler already owns them; re-emitting duplicated every class) and
   * emits route symbols, which have no handler-side counterpart.
   */
  extractFrameworkSymbols(
    tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    const sourceStr = source.toString('utf8');

    // NestJS shadow guard (Task 587 / A-12): angular registers before nestjs
    // and wins shared suffixes — never stamp Angular metadata on NestJS code.
    // Import statements only (not free text), so comments can't misfire.
    if (/(?:from\s+['"]|require\(\s*['"])@nestjs\//.test(sourceStr)) {
      putFacts(filePath, { entries: new Map(), nestjs: true });
      return [];
    }

    // Collect Angular decorated-class facts from the AST
    const facts: FileFacts = { entries: new Map() };
    if (tree !== null) {
      collectAngularClassFacts(tree.rootNode.children, sourceStr, facts.entries);
    }
    putFacts(filePath, facts);

    // Extract route paths from RouterModule / provideRouter / Routes arrays
    return extractAngularRoutes(sourceStr, filePath);
  },

  // ── Metadata enrichment ──────────────────────────────────────────────────────

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    const fileFacts = factsCache.get(symbol.filePath);
    // NestJS-owned file (A-12b): no Angular enrichment of any kind.
    if (fileFacts?.nestjs) return symbol;

    // Upgrade handler symbols using the facts collected for this file.
    const fact = fileFacts?.entries.get(symbol.name);
    if (fact && fact.inputKinds.includes(symbol.kind)) {
      const kind = fact.kind ?? symbol.kind;
      return {
        ...symbol,
        kind,
        id: kind === symbol.kind ? symbol.id : makeId(symbol.filePath, symbol.name, kind),
        summary: symbol.summary || fact.summary,
        frameworkMeta: { ...symbol.frameworkMeta, ...fact.meta },
      };
    }

    // Field enrichment (Phase 94, Task 584): stamp signal/DI metadata on class
    // fields the TS handler now extracts. Gated to angular-routed files so the
    // Vue `inject()` API on mixed monorepos is never claimed.
    if (symbol.kind === 'property' && angularAdapter.fileFilter(symbol.filePath)) {
      const init = symbol.bodySnippet ?? '';
      const sig = /^(signal|computed|input|output|model)\s*(?:\.\s*required\s*)?(?:<[^(]*>)?\s*\(/.exec(init);
      if (sig) {
        return {
          ...symbol,
          frameworkMeta: { ...symbol.frameworkMeta, angular_signal: sig[1] },
        };
      }
      const inj = /^inject\s*\(\s*([A-Za-z_$][\w$.]*)/.exec(init);
      if (inj) {
        return {
          ...symbol,
          frameworkMeta: { ...symbol.frameworkMeta, angular_injection: inj[1] },
        };
      }
    }

    // Add angular_injectable flag to class symbols in Angular service files
    if (
      symbol.kind === 'class' &&
      symbol.filePath.endsWith('.service.ts') &&
      !symbol.frameworkMeta?.angular_service
    ) {
      return {
        ...symbol,
        frameworkMeta: {
          ...symbol.frameworkMeta,
          angular_injectable: true,
        },
      };
    }
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(angularAdapter);
logger.debug("Adapter 'angular' registered");
