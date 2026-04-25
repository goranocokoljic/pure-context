/**
 * Angular framework adapter.
 *
 * Detects Angular projects via @angular/core in package.json.
 * Extracts decorated class symbols (@Component, @Injectable, @NgModule,
 * @Directive, @Pipe, CanActivate guards) and route paths from RouterModule.
 *
 * Uses source-text analysis for decorator metadata (selector, pipe name)
 * and AST walking for class declarations.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import type { FrameworkAdapter, SymbolRecord, Tree, SyntaxNode } from '../core/types.js';
import { registerAdapter } from './adapter-registry.js';
import { logger } from '../core/logger.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: string): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
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
 * Check if a class implements CanActivate (functional guard pattern).
 */
function implementsCanActivate(classNode: SyntaxNode, sourceStr: string): boolean {
  const classText = sourceStr.slice(classNode.startIndex, classNode.endIndex);
  return /\bCanActivate\b/.test(classText);
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
 * Extract Angular route paths from RouterModule.forRoot/forChild call expressions.
 * Looks for: `{ path: 'some/path', ... }` inside RouterModule.forRoot/forChild.
 */
function extractAngularRoutes(
  sourceStr: string,
  filePath: string,
): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];

  // Find RouterModule.forRoot/forChild blocks
  const routerModuleRe = /RouterModule\.for(?:Root|Child)\s*\(\s*\[([^\]]*)\]/gs;
  let routerMatch;

  while ((routerMatch = routerModuleRe.exec(sourceStr)) !== null) {
    const routesBlock = routerMatch[1]!;

    // Extract { path: 'some-path' } objects within the routes array
    const pathRe = /\bpath\s*:\s*['"`]([^'"`]*)['"`]/g;
    let pathMatch;

    while ((pathMatch = pathRe.exec(routesBlock)) !== null) {
      const routePath = pathMatch[1]!;
      const name = routePath === '' ? '/' : `/${routePath}`;

      symbols.push({
        id: makeId(filePath, name, 'route'),
        name,
        kind: 'route',
        filePath,
        startByte: 0,
        endByte: 0,
        signature: `route '${name}'`,
        summary: `Angular route: ${name}`,
        frameworkMeta: { router: 'angular' },
      });
    }

    // Also handle lazy-loaded routes: { path: 'admin', loadChildren: () => import(...) }
    const lazyPathRe = /\bpath\s*:\s*['"`]([^'"`]*)['"`][^}]*loadChildren/gs;
    let lazyMatch;
    while ((lazyMatch = lazyPathRe.exec(routesBlock)) !== null) {
      // Lazy routes are already captured by pathRe above
      void lazyMatch;
    }
  }

  // Also extract functional guard exports: `export const canActivate = () => ...`
  // These are handled separately as middleware

  return symbols;
}

// ─── Class symbol extraction ──────────────────────────────────────────────────

function walkForAngularClasses(
  nodes: SyntaxNode[],
  sourceStr: string,
  filePath: string,
  symbols: SymbolRecord[],
): void {
  for (const node of nodes) {
    let classNode: SyntaxNode | null = null;

    if (node.type === 'class_declaration') {
      classNode = node;
    } else if (node.type === 'export_statement') {
      // export class Foo { } or export default class { }
      const inner = node.children.find(
        (c) => c.type === 'class_declaration',
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

      // Also check if class implements CanActivate
      const isGuard =
        decoratorInfo?.decorator === '@Guard' ||
        implementsCanActivate(classNode, sourceStr);

      if (!decoratorInfo && !isGuard) continue;

      const dec = decoratorInfo?.decorator;
      const metaBlock = decoratorInfo?.metaBlock ?? '';

      if (dec === '@Component' || dec === '@Directive') {
        const selector = extractMetaProperty(metaBlock, 'selector');
        const isStandalone =
          /\bstandalone\s*:\s*true/.test(metaBlock);
        const isDirective = dec === '@Directive';

        symbols.push({
          id: makeId(filePath, className, 'component'),
          name: className,
          kind: 'component',
          filePath,
          startByte: classNode.startIndex,
          endByte: classNode.endIndex,
          signature: `${dec}({ selector: '${selector ?? ''}' }) class ${className}`,
          summary: `Angular ${isDirective ? 'directive' : 'component'}: ${selector ?? className}`,
          frameworkMeta: {
            selector: selector ?? null,
            angular_directive: isDirective || undefined,
            angular_standalone: isStandalone || undefined,
          },
        });
        continue;
      }

      if (dec === '@Pipe') {
        const pipeName = extractMetaProperty(metaBlock, 'name');
        symbols.push({
          id: makeId(filePath, className, 'component'),
          name: className,
          kind: 'component',
          filePath,
          startByte: classNode.startIndex,
          endByte: classNode.endIndex,
          signature: `@Pipe({ name: '${pipeName ?? ''}' }) class ${className}`,
          summary: `Angular pipe: ${pipeName ?? className}`,
          frameworkMeta: {
            angular_pipe: true,
            pipe_name: pipeName ?? null,
          },
        });
        continue;
      }

      // isGuard takes priority over @Injectable — `@Injectable() implements CanActivate`
      // is the canonical NestJS/Angular guard pattern.
      if (isGuard) {
        symbols.push({
          id: makeId(filePath, className, 'middleware'),
          name: className,
          kind: 'middleware',
          filePath,
          startByte: classNode.startIndex,
          endByte: classNode.endIndex,
          signature: `class ${className} implements CanActivate`,
          summary: `Angular guard: ${className}`,
          frameworkMeta: { angular_guard: true },
        });
        continue;
      }

      if (dec === '@Injectable') {
        symbols.push({
          id: makeId(filePath, className, 'class'),
          name: className,
          kind: 'class',
          filePath,
          startByte: classNode.startIndex,
          endByte: classNode.endIndex,
          signature: `@Injectable() class ${className}`,
          summary: `Angular service: ${className}`,
          frameworkMeta: {
            angular_service: true,
            angular_injectable: true,
          },
        });
        continue;
      }

      if (dec === '@NgModule') {
        symbols.push({
          id: makeId(filePath, className, 'class'),
          name: className,
          kind: 'class',
          filePath,
          startByte: classNode.startIndex,
          endByte: classNode.endIndex,
          signature: `@NgModule() class ${className}`,
          summary: `Angular module: ${className}`,
          frameworkMeta: { angular_module: true },
        });
        continue;
      }

    }

    // Detect Angular 15+ functional guards: `export const canActivate = () => ...`
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
            if (/^can[A-Z]/.test(fnName)) {
              symbols.push({
                id: makeId(filePath, fnName, 'middleware'),
                name: fnName,
                kind: 'middleware',
                filePath,
                startByte: node.startIndex,
                endByte: node.endIndex,
                signature: `export const ${fnName} = (...)`,
                summary: `Angular functional guard: ${fnName}`,
                frameworkMeta: { angular_guard: true },
              });
            }
          }
        }
      }
    }
  }
}

// ─── Angular adapter ──────────────────────────────────────────────────────────

export const angularAdapter: FrameworkAdapter = {
  name: 'angular',

  /** No new file extensions — .ts files are already handled by the TypeScript handler. */
  extensions: () => [],

  // ── Detection ───────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    try {
      const raw = readFileSync(`${projectRoot}/package.json`, 'utf8');
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      const deps = Object.assign(
        {},
        pkg['dependencies'] as Record<string, string> | undefined,
        pkg['devDependencies'] as Record<string, string> | undefined,
      );
      return '@angular/core' in deps;
    } catch {
      return false;
    }
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
      filePath.endsWith('-routing.module.ts')
    );
  },

  // ── Framework symbol extraction ──────────────────────────────────────────────

  extractFrameworkSymbols(
    tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    const symbols: SymbolRecord[] = [];
    const sourceStr = source.toString('utf8');

    // Extract Angular decorated class symbols from the AST
    if (tree !== null) {
      walkForAngularClasses(tree.rootNode.children, sourceStr, filePath, symbols);
    }

    // Extract route paths from RouterModule.forRoot/forChild
    const routeSymbols = extractAngularRoutes(sourceStr, filePath);
    symbols.push(...routeSymbols);

    return symbols;
  },

  // ── Metadata enrichment ──────────────────────────────────────────────────────

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
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
