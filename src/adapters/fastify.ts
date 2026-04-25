/**
 * Fastify framework adapter.
 *
 * Extracts route symbols from Fastify procedural route definitions.
 * Only extracts routes with string literal paths.
 *
 * Patterns recognised:
 *   fastify.get('/path', handler)
 *   fastify.post('/path', handler)
 *   fastify.register(plugin, { prefix: '/api' }) → kind 'middleware'
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
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

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

// ─── Route extraction ─────────────────────────────────────────────────────────

/**
 * Heuristic: check if source uses Fastify.
 */
function hasFastifySetup(sourceStr: string): boolean {
  return (
    /\bfastify\s*\(\s*\)/.test(sourceStr) ||
    /require\s*\(\s*['"]fastify['"]\s*\)/.test(sourceStr) ||
    /from\s+['"]fastify['"]/.test(sourceStr) ||
    /\bFastify\s*\(\s*\)/.test(sourceStr)
  );
}

/**
 * Extract Fastify route symbols from source text.
 */
function extractFastifyRoutes(sourceStr: string, filePath: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];

  const methodPattern = HTTP_METHODS.join('|');

  // Match: identifier.method('/path', ...) where identifier looks like a Fastify instance
  const routeRe = new RegExp(
    `\\b(\\w+)\\.(${methodPattern})\\s*\\(\\s*(['"\`])([^'"\`]+)\\3`,
    'g',
  );

  let m;
  while ((m = routeRe.exec(sourceStr)) !== null) {
    const varName = m[1]!;
    const method = m[2]!;
    const path = m[4]!;

    // Only Fastify-like variable names
    if (
      !['fastify', 'server', 'app', 'instance'].includes(varName) &&
      !varName.toLowerCase().includes('fastify')
    ) {
      continue;
    }

    const httpMethod = method.toUpperCase();
    const routeName = `${httpMethod} ${path}`;

    if (!symbols.some((s) => s.name === routeName)) {
      symbols.push({
        id: makeId(filePath, routeName, 'route'),
        name: routeName,
        kind: 'route',
        filePath,
        startByte: 0,
        endByte: 0,
        signature: `${varName}.${method}('${path}', ...)`,
        summary: `Fastify route: ${routeName}`,
        frameworkMeta: { http_method: httpMethod, http_framework: 'fastify' },
      });
    }
  }

  // Match fastify.register(plugin, { prefix: '/api' })
  const registerRe = /\b(\w+)\.register\s*\([^,]+,\s*\{[^}]*prefix\s*:\s*(['"`])([^'"`]+)\2/g;
  let regMatch;
  while ((regMatch = registerRe.exec(sourceStr)) !== null) {
    const varName = regMatch[1]!;
    const prefix = regMatch[3]!;

    if (
      !['fastify', 'server', 'app', 'instance'].includes(varName) &&
      !varName.toLowerCase().includes('fastify')
    ) {
      continue;
    }

    const routeName = `PLUGIN ${prefix}`;
    if (!symbols.some((s) => s.name === routeName)) {
      symbols.push({
        id: makeId(filePath, routeName, 'middleware'),
        name: routeName,
        kind: 'middleware',
        filePath,
        startByte: 0,
        endByte: 0,
        signature: `${varName}.register(plugin, { prefix: '${prefix}' })`,
        summary: `Fastify plugin with prefix: ${prefix}`,
        frameworkMeta: { http_framework: 'fastify', route_prefix: prefix },
      });
    }
  }

  return symbols;
}

// ─── Fastify adapter ──────────────────────────────────────────────────────────

export const fastifyAdapter: FrameworkAdapter = {
  name: 'fastify',

  extensions: () => [],

  async detect(projectRoot: string): Promise<boolean> {
    try {
      const raw = readFileSync(`${projectRoot}/package.json`, 'utf8');
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      const deps = Object.assign(
        {},
        pkg['dependencies'] as Record<string, string> | undefined,
        pkg['devDependencies'] as Record<string, string> | undefined,
      );
      return 'fastify' in deps || '@fastify/core' in deps;
    } catch {
      return false;
    }
  },

  fileFilter: (filePath: string): boolean =>
    filePath.endsWith('.ts') || filePath.endsWith('.js'),

  extractFrameworkSymbols(
    _tree: Tree | null,
    source: Buffer,
    filePath: string,
  ): SymbolRecord[] {
    const sourceStr = source.toString('utf8');

    if (!hasFastifySetup(sourceStr)) return [];

    return extractFastifyRoutes(sourceStr, filePath);
  },

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(fastifyAdapter);
logger.debug("Adapter 'fastify' registered");
