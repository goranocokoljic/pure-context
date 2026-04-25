/**
 * Symfony framework adapter.
 *
 * Extracts route and controller symbols from Symfony PHP applications.
 *
 * Patterns recognised:
 *   #[Route('/users', methods: ['GET', 'POST'])]   → route per method (PHP 8+ attribute)
 *   @Route("/users", methods={"GET"})              → route (older docblock annotation)
 *   class UserController extends AbstractController → class (symfony_controller)
 *   #[AsController] class AdminController          → class (symfony_controller)
 *
 * Out of scope (Phase 5): YAML/XML route config, ORM entity extraction.
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

// ─── Route extraction ─────────────────────────────────────────────────────────

/**
 * Extract HTTP methods from the content inside a Route attribute or annotation.
 *
 * Handles:
 *   methods: ['GET', 'POST']       (PHP attribute named arg)
 *   methods={"GET", "POST"}        (Doctrine annotation style)
 */
function extractHttpMethods(inner: string): string[] {
  // PHP attribute style: methods: ['GET', 'POST']
  const attrMatch = inner.match(/methods\s*:\s*\[([^\]]*)\]/);
  // Doctrine annotation style: methods={"GET"}
  const annMatch = inner.match(/methods\s*=\s*\{([^}]*)\}/);
  const raw = attrMatch?.[1] ?? annMatch?.[1] ?? '';
  if (!raw.trim()) return [];
  const found = raw.match(/['"]([A-Z]+)['"]/gi) ?? [];
  return found.map((s) => s.replace(/['"]/g, '').toUpperCase());
}

/**
 * Emit one SymbolRecord per HTTP method (or a single method-agnostic route if
 * no methods are specified).
 */
function emitRouteSymbols(
  filePath: string,
  routePath: string,
  methods: string[],
  signature: string,
): SymbolRecord[] {
  if (methods.length === 0) {
    const name = routePath;
    return [
      {
        id: makeId(filePath, name, 'route'),
        name,
        kind: 'route',
        filePath,
        startByte: 0,
        endByte: 0,
        signature,
        summary: `Symfony route: ${name}`,
        frameworkMeta: {
          symfony_route: true,
          route_path: routePath,
        },
      },
    ];
  }

  return methods.map((httpMethod) => {
    const name = `${httpMethod} ${routePath}`;
    return {
      id: makeId(filePath, name, 'route'),
      name,
      kind: 'route',
      filePath,
      startByte: 0,
      endByte: 0,
      signature,
      summary: `Symfony route: ${name}`,
      frameworkMeta: {
        symfony_route: true,
        route_path: routePath,
        http_method: httpMethod,
      },
    };
  });
}

/**
 * `#[Route('/path', name: 'foo', methods: ['GET'])]`
 *
 * The inner content after the path argument may span multiple lines so we use
 * a multiline-aware scan with brace/bracket depth tracking.
 */
function extractAttributeRoutes(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];

  // Match opening of a Route PHP attribute: #[Route(
  const OPEN_RE = /#\[Route\s*\(/gi;
  let m: RegExpExecArray | null;
  OPEN_RE.lastIndex = 0;

  while ((m = OPEN_RE.exec(sourceStr)) !== null) {
    const contentStart = m.index + m[0].length;
    // Find the matching closing ')' using depth tracking
    let depth = 1;
    let i = contentStart;
    while (i < sourceStr.length && depth > 0) {
      const ch = sourceStr[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      i++;
    }
    if (depth !== 0) continue;

    const inner = sourceStr.slice(contentStart, i - 1);

    // Extract the path — first quoted string argument
    const pathMatch = inner.match(/^\s*['"]([^'"]*)['"]/);
    if (!pathMatch) continue;
    const routePath = pathMatch[1]!;
    const methods = extractHttpMethods(inner);
    const sig = `#[Route('${routePath}'${methods.length ? `, methods: [${methods.map((x) => `'${x}'`).join(', ')}]` : ''})]`;

    symbols.push(...emitRouteSymbols(filePath, routePath, methods, sig));
  }

  return symbols;
}

/**
 * `@Route("/path", methods={"GET"})` inside `/** ... *\/` docblocks.
 */
function extractAnnotationRoutes(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];

  // Find /** ... */ comment blocks
  const DOCBLOCK_RE = /\/\*\*([\s\S]*?)\*\//g;
  let dm: RegExpExecArray | null;
  DOCBLOCK_RE.lastIndex = 0;

  while ((dm = DOCBLOCK_RE.exec(sourceStr)) !== null) {
    const docContent = dm[1]!;

    // Find @Route annotations inside the docblock
    const ANNOT_RE = /@Route\s*\(\s*["']([^"']+)["']([\s\S]*?)\)/g;
    let am: RegExpExecArray | null;
    ANNOT_RE.lastIndex = 0;

    while ((am = ANNOT_RE.exec(docContent)) !== null) {
      const routePath = am[1]!;
      const inner = am[2] ?? '';
      const methods = extractHttpMethods(inner);
      const sig = `@Route("${routePath}"${methods.length ? `, methods={"${methods.join('", "')}"}` : ''})`;
      symbols.push(...emitRouteSymbols(filePath, routePath, methods, sig));
    }
  }

  return symbols;
}

// ─── Controller detection ─────────────────────────────────────────────────────

/** Detect `#[AsController]` attribute immediately preceding a class declaration. */
const AS_CONTROLLER_ATTR_RE = /#\[AsController\b[^\]]*\][\s\n]*class\s+(\w+)/g;

/** Class header regex to find classes with extends. */
const CLASS_HEADER_RE =
  /class\s+(\w+)(?:\s+extends\s+([\w\\]+))?(?:\s+implements\s+[^{]*)?\s*\{/g;

function extractControllers(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  // #[AsController] classes
  AS_CONTROLLER_ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AS_CONTROLLER_ATTR_RE.exec(sourceStr)) !== null) {
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    symbols.push({
      id: makeId(filePath, name, 'class'),
      name,
      kind: 'class',
      filePath,
      startByte: m.index,
      endByte: m.index + m[0].length,
      signature: `#[AsController] class ${name}`,
      summary: `Symfony controller: ${name}`,
      frameworkMeta: { symfony_controller: true },
    });
  }

  // Classes extending AbstractController (or Symfony\Bundle\...\AbstractController)
  CLASS_HEADER_RE.lastIndex = 0;
  while ((m = CLASS_HEADER_RE.exec(sourceStr)) !== null) {
    const name = m[1]!;
    const extendsName = (m[2] ?? '').split('\\').pop() ?? '';
    if (extendsName !== 'AbstractController') continue;
    if (seen.has(name)) continue;
    seen.add(name);
    symbols.push({
      id: makeId(filePath, name, 'class'),
      name,
      kind: 'class',
      filePath,
      startByte: m.index,
      endByte: m.index + m[0].length,
      signature: m[0].slice(0, -1).trim(), // strip trailing '{'
      summary: `Symfony controller: ${name}`,
      frameworkMeta: { symfony_controller: true },
    });
  }

  return symbols;
}

// ─── Symfony adapter ──────────────────────────────────────────────────────────

export const symfonyAdapter: FrameworkAdapter = {
  name: 'symfony',

  extensions: () => [],

  async detect(projectRoot: string): Promise<boolean> {
    const composerPath = join(projectRoot, 'composer.json');
    if (!existsSync(composerPath)) return false;
    try {
      const json = JSON.parse(readFileSync(composerPath, 'utf8')) as Record<string, unknown>;
      const require = json['require'] as Record<string, unknown> | undefined;
      return !!(
        require &&
        ('symfony/framework-bundle' in require || 'symfony/symfony' in require)
      );
    } catch {
      return false;
    }
  },

  fileFilter(filePath: string): boolean {
    if (!filePath.endsWith('.php')) return false;
    return /^src[\\/]/.test(filePath) || filePath.includes('/src/');
  },

  extractFrameworkSymbols(
    _tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    const sourceStr = source.toString('utf8');
    return [
      ...extractAttributeRoutes(sourceStr, filePath),
      ...extractAnnotationRoutes(sourceStr, filePath),
      ...extractControllers(sourceStr, filePath),
    ];
  },

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(symfonyAdapter);
logger.debug("Adapter 'symfony' registered");
