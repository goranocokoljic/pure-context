/**
 * Vue 3 framework adapter.
 *
 * Responsibilities:
 *  1. Detect Vue projects (package.json has `vue` dep, or .vue files present).
 *  2. Pre-process .vue SFCs into typed script blocks via vue-preprocessor.
 *  3. Emit one `component` symbol per .vue file (name derived from filename or
 *     from an explicit `defineOptions({ name: '...' })` call).
 *  4. Upgrade exported `useXxx` functions to kind `'composable'` via enrichMetadata.
 */

import { createHash } from 'crypto';
import { basename } from 'path';
import { readFileSync, readdirSync } from 'fs';
import type { FrameworkAdapter, SymbolRecord, Tree } from '../core/types.js';
import { splitVueSFC } from './vue-preprocessor.js';
import { registerAdapter } from './adapter-registry.js';
import { logger } from '../core/logger.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: string): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Convert kebab-case or camelCase filename stems to PascalCase.
 * 'my-component' → 'MyComponent'
 * 'userCard'     → 'UserCard'
 */
function toPascalCase(str: string): string {
  return str
    .replace(/[-_](.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (_, c: string) => c.toUpperCase());
}

function componentNameFromPath(filePath: string): string {
  return toPascalCase(basename(filePath, '.vue'));
}

/**
 * Try to find an explicit component name from `defineOptions({ name: '...' })`.
 * Falls back to the filename-derived PascalCase name.
 */
function resolveComponentName(source: Buffer, filePath: string): string {
  const str = source.toString('utf8');
  const m = str.match(/defineOptions\s*\(\s*\{[^}]*\bname\s*:\s*['"]([^'"]+)['"]/);
  if (m) return m[1]!;
  return componentNameFromPath(filePath);
}

// ─── Vue adapter ──────────────────────────────────────────────────────────────

export const vueAdapter: FrameworkAdapter = {
  name: 'vue',

  extensions: () => ['.vue'],

  // ── Detection ───────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    // Primary signal: package.json declares a vue dependency
    try {
      const raw = readFileSync(`${projectRoot}/package.json`, 'utf8');
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      const deps = Object.assign(
        {},
        pkg['dependencies'] as Record<string, string> | undefined,
        pkg['devDependencies'] as Record<string, string> | undefined,
      );
      if (Object.keys(deps).some((k) => k === 'vue' || k.startsWith('@vue/'))) {
        return true;
      }
    } catch {
      // No package.json or parse error — fall through to file scan
    }

    // Fallback: presence of .vue files in common source directories
    const scanDirs = [projectRoot, `${projectRoot}/src`, `${projectRoot}/components`];
    for (const dir of scanDirs) {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        if (entries.some((e) => e.isFile() && e.name.endsWith('.vue'))) {
          return true;
        }
      } catch {
        // Directory doesn't exist — skip
      }
    }

    return false;
  },

  // ── File routing ─────────────────────────────────────────────────────────────

  fileFilter: (filePath: string) => filePath.endsWith('.vue'),

  // ── Pre-processing ───────────────────────────────────────────────────────────

  preProcess: splitVueSFC,

  // ── Framework symbol extraction ──────────────────────────────────────────────

  /**
   * Emit one `component` symbol per .vue file.
   * `tree` is the parsed AST of the <script> block (or null for template-only SFCs).
   * `source` is the full original .vue file buffer.
   */
  extractFrameworkSymbols(tree: Tree | null, source: Buffer, filePath: string): SymbolRecord[] {
    const name = resolveComponentName(source, filePath);

    return [
      {
        id: makeId(filePath, name, 'component'),
        name,
        kind: 'component',
        filePath,
        startByte: 0,
        endByte: source.length,
        signature: `<${name}>`,
        summary: `Vue component ${name}`,
        frameworkMeta: { vue_component: true },
      },
    ];
  },

  // ── Metadata enrichment ──────────────────────────────────────────────────────

  /**
   * Upgrade exported `useXxx` functions/consts to kind `'composable'`.
   * The id is recomputed to reflect the new kind so it remains deterministic.
   */
  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    if (
      (symbol.kind === 'function' || symbol.kind === 'const') &&
      /^use[A-Z]/.test(symbol.name)
    ) {
      return {
        ...symbol,
        kind: 'composable',
        id: makeId(symbol.filePath, symbol.name, 'composable'),
        frameworkMeta: { ...symbol.frameworkMeta, vue_composable: true },
      };
    }

    if (symbol.kind === 'component') {
      return {
        ...symbol,
        frameworkMeta: { ...symbol.frameworkMeta, vue_component: true },
      };
    }

    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(vueAdapter);
logger.debug("Adapter 'vue' registered");
