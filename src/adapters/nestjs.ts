/**
 * NestJS framework adapter.
 *
 * Extracts HTTP route symbols from @Controller + HTTP-method decorators,
 * and marks services, modules, guards, and interceptors with NestJS metadata.
 *
 * Route path merging: controller prefix + method decorator path.
 * e.g. @Controller('users') + @Get(':id') → GET /users/:id
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

const HTTP_METHOD_DECORATORS = new Map<string, string>([
  ['@Get', 'GET'],
  ['@Post', 'POST'],
  ['@Put', 'PUT'],
  ['@Patch', 'PATCH'],
  ['@Delete', 'DELETE'],
  ['@Head', 'HEAD'],
  ['@Options', 'OPTIONS'],
  ['@All', '*'],
]);

const NESTJS_CLASS_DECORATORS = new Set([
  '@Injectable',
  '@Module',
  '@Guard',
  '@Interceptor',
  '@Middleware',
  '@Catch',
  '@WebSocketGateway',
]);

// ─── Decorator extraction ─────────────────────────────────────────────────────

/**
 * Extract the string path argument from a decorator like @Controller('users')
 * or @Get(':id'). Returns '' for no-arg decorators like @Controller().
 */
function extractDecoratorPath(decoratorText: string): string {
  const m = decoratorText.match(/@\w+\s*\(\s*['"`]([^'"`]*)['"`]/);
  return m ? m[1]! : '';
}

/**
 * Combine controller prefix and method path into a full route path.
 */
function buildRoutePath(prefix: string, methodPath: string): string {
  const p = prefix.startsWith('/') ? prefix : `/${prefix}`;
  if (!methodPath) return p;
  const m = methodPath.startsWith('/') ? methodPath : `/${methodPath}`;
  // Avoid double slashes
  if (p === '/') return m;
  return `${p}${m}`;
}

// ─── Source-text decorator detection ─────────────────────────────────────────

interface NestDecoratorMatch {
  type: 'controller' | 'injectable' | 'module' | 'guard' | 'interceptor' | 'middleware';
  prefix?: string;
}

function detectNestDecorator(
  classNode: SyntaxNode,
  sourceStr: string,
): NestDecoratorMatch | null {
  // Walk back through named siblings (and parent for export_statement)
  const candidates: SyntaxNode[] = [];

  let prev = classNode.previousNamedSibling;
  while (prev !== null && prev.type === 'decorator') {
    candidates.push(prev);
    prev = prev.previousNamedSibling;
  }

  // Also check decorators on parent export_statement
  if (classNode.parent?.type === 'export_statement') {
    let outerPrev = classNode.parent.previousNamedSibling;
    while (outerPrev !== null && outerPrev.type === 'decorator') {
      candidates.push(outerPrev);
      outerPrev = outerPrev.previousNamedSibling;
    }
  }

  // Check decorators as direct children of class node
  for (const child of classNode.children) {
    if (child.type === 'decorator') candidates.push(child);
  }

  // Check if class implements CanActivate — takes priority over @Injectable,
  // since `@Injectable() class X implements CanActivate` is the standard guard pattern.
  const classText = sourceStr.slice(classNode.startIndex, classNode.endIndex);
  if (/\bCanActivate\b/.test(classText)) {
    return { type: 'guard' };
  }

  for (const dec of candidates) {
    const text = sourceStr.slice(dec.startIndex, dec.endIndex);

    if (text.startsWith('@Controller')) {
      const prefix = extractDecoratorPath(text);
      return { type: 'controller', prefix };
    }
    if (text.startsWith('@Injectable') || text.startsWith('@Service')) {
      return { type: 'injectable' };
    }
    if (text.startsWith('@Module')) {
      return { type: 'module' };
    }
    if (text.startsWith('@UseGuards') || text.startsWith('@Guard')) {
      return { type: 'guard' };
    }
    if (text.startsWith('@UseInterceptors') || text.startsWith('@Interceptor')) {
      return { type: 'interceptor' };
    }
    if (text.startsWith('@Middleware') || text.startsWith('@NestMiddleware')) {
      return { type: 'middleware' };
    }
  }

  return null;
}

/**
 * Extract method symbols from a controller class body.
 * Looks for method_definition nodes preceded by HTTP-method decorators.
 */
function extractControllerRoutes(
  classNode: SyntaxNode,
  sourceStr: string,
  filePath: string,
  controllerPrefix: string,
): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];

  // Find the class body
  const body = classNode.children.find(
    (c) => c.type === 'class_body',
  );
  if (!body) return symbols;

  for (const member of body.children) {
    if (
      member.type !== 'method_definition' &&
      member.type !== 'public_field_definition'
    ) {
      continue;
    }

    // Check for HTTP method decorators on this member
    let prev = member.previousNamedSibling;
    while (prev !== null && prev.type === 'decorator') {
      const decoratorText = sourceStr.slice(prev.startIndex, prev.endIndex);
      for (const [decoratorName, httpMethod] of HTTP_METHOD_DECORATORS) {
        if (decoratorText.startsWith(decoratorName)) {
          const methodPath = extractDecoratorPath(decoratorText);
          const fullPath = buildRoutePath(controllerPrefix, methodPath);
          const routeName = `${httpMethod} ${fullPath}`;

          symbols.push({
            id: makeId(filePath, routeName, 'route'),
            name: routeName,
            kind: 'route',
            filePath,
            startByte: member.startIndex,
            endByte: member.endIndex,
            signature: `@${decoratorName.slice(1)}('${methodPath}') ${routeName}`,
            summary: `NestJS route: ${routeName}`,
            frameworkMeta: {
              http_method: httpMethod,
              route_path: fullPath,
              controller_prefix: controllerPrefix,
            },
          });
          break;
        }
      }
      prev = prev.previousNamedSibling;
    }

    // Also check decorators as direct children of the method
    for (const child of member.children) {
      if (child.type !== 'decorator') continue;
      const decoratorText = sourceStr.slice(child.startIndex, child.endIndex);
      for (const [decoratorName, httpMethod] of HTTP_METHOD_DECORATORS) {
        if (decoratorText.startsWith(decoratorName)) {
          const methodPath = extractDecoratorPath(decoratorText);
          const fullPath = buildRoutePath(controllerPrefix, methodPath);
          const routeName = `${httpMethod} ${fullPath}`;

          // Avoid duplicates
          if (!symbols.some((s) => s.name === routeName)) {
            symbols.push({
              id: makeId(filePath, routeName, 'route'),
              name: routeName,
              kind: 'route',
              filePath,
              startByte: member.startIndex,
              endByte: member.endIndex,
              signature: `@${decoratorName.slice(1)}('${methodPath}') ${routeName}`,
              summary: `NestJS route: ${routeName}`,
              frameworkMeta: {
                http_method: httpMethod,
                route_path: fullPath,
                controller_prefix: controllerPrefix,
              },
            });
          }
          break;
        }
      }
    }
  }

  return symbols;
}

// ─── Text-based fallback route extraction ─────────────────────────────────────

/**
 * Regex-based extraction of NestJS routes as a fallback when AST traversal
 * doesn't capture all decorators (e.g. stacked decorators, unusual formatting).
 */
function extractRoutesFromSource(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];

  // Find @Controller('prefix') ... @Get('/path') / @Post('/path') patterns
  const controllerRe = /@Controller\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g;
  const httpRe = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g;

  let controllerMatch;
  while ((controllerMatch = controllerRe.exec(sourceStr)) !== null) {
    const prefix = controllerMatch[1] ?? '';
    const controllerEnd = sourceStr.indexOf('{', controllerMatch.index);
    if (controllerEnd === -1) continue;

    // Find the class body end (simplified: find matching braces)
    let depth = 1;
    let bodyEnd = controllerEnd + 1;
    while (depth > 0 && bodyEnd < sourceStr.length) {
      if (sourceStr[bodyEnd] === '{') depth++;
      else if (sourceStr[bodyEnd] === '}') depth--;
      bodyEnd++;
    }

    const classBody = sourceStr.slice(controllerEnd, bodyEnd);
    httpRe.lastIndex = 0;
    let httpMatch;

    while ((httpMatch = httpRe.exec(classBody)) !== null) {
      const httpDecoratorName = httpMatch[1]!;
      const methodPath = httpMatch[2] ?? '';
      const httpMethod = HTTP_METHOD_DECORATORS.get(`@${httpDecoratorName}`) ?? httpDecoratorName.toUpperCase();
      const fullPath = buildRoutePath(prefix, methodPath);
      const routeName = `${httpMethod} ${fullPath}`;

      if (!symbols.some((s) => s.name === routeName)) {
        symbols.push({
          id: makeId(filePath, routeName, 'route'),
          name: routeName,
          kind: 'route',
          filePath,
          startByte: 0,
          endByte: 0,
          signature: `@${httpDecoratorName}('${methodPath}') → ${routeName}`,
          summary: `NestJS route: ${routeName}`,
          frameworkMeta: {
            http_method: httpMethod,
            route_path: fullPath,
            controller_prefix: prefix,
          },
        });
      }
    }
  }

  return symbols;
}

// ─── Class symbol extraction ──────────────────────────────────────────────────

function walkForNestClasses(
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
      const inner = node.children.find((c) => c.type === 'class_declaration');
      if (inner) classNode = inner;
    }

    if (classNode === null) continue;

    const nameNode = classNode.children.find(
      (c) => c.type === 'type_identifier' || c.type === 'identifier',
    );
    if (!nameNode) continue;

    const className = sourceStr.slice(nameNode.startIndex, nameNode.endIndex);
    if (!className) continue;

    const decInfo = detectNestDecorator(classNode, sourceStr);
    if (!decInfo) continue;

    if (decInfo.type === 'controller') {
      // Controller: emit route symbols for each HTTP-method decorated method
      const prefix = decInfo.prefix ?? '';
      const routes = extractControllerRoutes(classNode, sourceStr, filePath, prefix);
      symbols.push(...routes);
      continue;
    }

    if (decInfo.type === 'injectable') {
      symbols.push({
        id: makeId(filePath, className, 'class'),
        name: className,
        kind: 'class',
        filePath,
        startByte: classNode.startIndex,
        endByte: classNode.endIndex,
        signature: `@Injectable() class ${className}`,
        summary: `NestJS service: ${className}`,
        frameworkMeta: { nestjs_provider: true },
      });
      continue;
    }

    if (decInfo.type === 'module') {
      symbols.push({
        id: makeId(filePath, className, 'class'),
        name: className,
        kind: 'class',
        filePath,
        startByte: classNode.startIndex,
        endByte: classNode.endIndex,
        signature: `@Module() class ${className}`,
        summary: `NestJS module: ${className}`,
        frameworkMeta: { nestjs_module: true },
      });
      continue;
    }

    if (decInfo.type === 'guard') {
      symbols.push({
        id: makeId(filePath, className, 'middleware'),
        name: className,
        kind: 'middleware',
        filePath,
        startByte: classNode.startIndex,
        endByte: classNode.endIndex,
        signature: `class ${className} implements CanActivate`,
        summary: `NestJS guard: ${className}`,
        frameworkMeta: { nestjs_guard: true },
      });
      continue;
    }

    if (decInfo.type === 'interceptor') {
      symbols.push({
        id: makeId(filePath, className, 'middleware'),
        name: className,
        kind: 'middleware',
        filePath,
        startByte: classNode.startIndex,
        endByte: classNode.endIndex,
        signature: `@Interceptor() class ${className}`,
        summary: `NestJS interceptor: ${className}`,
        frameworkMeta: { nestjs_interceptor: true },
      });
      continue;
    }

    if (decInfo.type === 'middleware') {
      symbols.push({
        id: makeId(filePath, className, 'middleware'),
        name: className,
        kind: 'middleware',
        filePath,
        startByte: classNode.startIndex,
        endByte: classNode.endIndex,
        signature: `class ${className} implements NestMiddleware`,
        summary: `NestJS middleware: ${className}`,
        frameworkMeta: { nestjs_middleware: true },
      });
      continue;
    }
  }
}

// ─── NestJS adapter ───────────────────────────────────────────────────────────

export const nestjsAdapter: FrameworkAdapter = {
  name: 'nestjs',

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
      return '@nestjs/core' in deps || '@nestjs/common' in deps;
    } catch {
      return false;
    }
  },

  // ── File routing ─────────────────────────────────────────────────────────────

  fileFilter: (filePath: string): boolean =>
    filePath.endsWith('.controller.ts') ||
    filePath.endsWith('.service.ts') ||
    filePath.endsWith('.module.ts') ||
    filePath.endsWith('.guard.ts') ||
    filePath.endsWith('.middleware.ts') ||
    filePath.endsWith('.interceptor.ts') ||
    filePath.endsWith('.pipe.ts') ||
    filePath.endsWith('.decorator.ts'),

  // ── Framework symbol extraction ──────────────────────────────────────────────

  extractFrameworkSymbols(
    tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    const sourceStr = source.toString('utf8');
    const symbols: SymbolRecord[] = [];

    // AST-based extraction for class symbols and routes
    if (tree !== null) {
      walkForNestClasses(tree.rootNode.children, sourceStr, filePath, symbols);
    }

    // Text-based fallback for route extraction (catches cases AST misses)
    if (filePath.endsWith('.controller.ts')) {
      const textRoutes = extractRoutesFromSource(sourceStr, filePath);
      for (const route of textRoutes) {
        if (!symbols.some((s) => s.name === route.name)) {
          symbols.push(route);
        }
      }
    }

    return symbols;
  },

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(nestjsAdapter);
logger.debug("Adapter 'nestjs' registered");
