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
import { readFileSync, readdirSync, type Dirent } from 'fs';
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
 * Positive extension allowlist for the composable upgrade (Phase 92, Task 569a).
 * `.vue` plus the JS/TS extensions composables live in — NEVER `.tsx`/`.jsx`
 * (React's), NEVER other languages (a Kotlin `useCase` must not become a
 * composable).
 */
const COMPOSABLE_FILES = /\.(vue|ts|js|mts|mjs|cts|cjs)$/;

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

// ─── Detection helpers ──────────────────────────────────────────────────────

/**
 * Directory names that never contain first-party Vue source — skipped during
 * the recursive detection scan to keep it fast and avoid false positives from
 * bundled dependencies.
 */
const DETECT_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.nuxt',
  '.output',
  '.next',
  'coverage',
  'vendor',
  'target',
  '.cache',
  '.turbo',
  '.svelte-kit',
]);

/** Max directory depth and total directories visited by the detection scan. */
const DETECT_MAX_DEPTH = 6;
const DETECT_MAX_DIRS = 2000;

/** Returns true if a parsed package.json declares a vue / @vue/* dependency. */
function pkgDeclaresVue(raw: string): boolean {
  try {
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const deps = Object.assign(
      {},
      pkg['dependencies'] as Record<string, string> | undefined,
      pkg['devDependencies'] as Record<string, string> | undefined,
    );
    return Object.keys(deps).some((k) => k === 'vue' || k.startsWith('@vue/'));
  } catch {
    return false;
  }
}

/**
 * Bounded recursive scan: returns true on the first sign of a Vue project —
 * either a `.vue` file or a (possibly nested) package.json declaring vue.
 * Skips heavy/irrelevant directories and caps depth + total directories so the
 * scan stays cheap even on large monorepos. Symlinked directories are not
 * followed (Dirent.isDirectory() is false for symlinks), avoiding cycles.
 */
function scanForVue(dir: string, depth: number, budget: { dirs: number }): boolean {
  if (depth > DETECT_MAX_DEPTH || budget.dirs >= DETECT_MAX_DIRS) return false;
  budget.dirs++;

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false; // unreadable directory — skip
  }

  const subDirs: string[] = [];
  for (const e of entries) {
    if (e.isFile()) {
      if (e.name.endsWith('.vue')) return true;
      if (e.name === 'package.json') {
        try {
          if (pkgDeclaresVue(readFileSync(`${dir}/${e.name}`, 'utf8'))) return true;
        } catch {
          // unreadable package.json — ignore
        }
      }
    } else if (e.isDirectory() && !DETECT_IGNORE_DIRS.has(e.name)) {
      subDirs.push(e.name);
    }
  }

  for (const name of subDirs) {
    if (scanForVue(`${dir}/${name}`, depth + 1, budget)) return true;
  }

  return false;
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
    // Fast path: root package.json declares a vue dependency (common case).
    try {
      if (pkgDeclaresVue(readFileSync(`${projectRoot}/package.json`, 'utf8'))) {
        return true;
      }
    } catch {
      // No package.json or parse error — fall through to the recursive scan
    }

    // Monorepo / sub-app fallback: bounded recursive scan for a `.vue` file or
    // a nested package.json declaring vue. Handles projects where the Vue app
    // lives in a subdirectory (frontend/, web/, apps/web/, …) rather than the
    // indexed root. Skips heavy dirs and caps depth + total directories.
    return scanForVue(projectRoot, 0, { dirs: 0 });
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
   *
   * Gated to the extensions composables actually live in (Phase 92): `.vue`
   * plus plain JS/TS. NEVER `.tsx`/`.jsx` (React's files — a React hook must
   * not become a composable), NEVER other languages (a Kotlin/Swift/Java
   * `useCase` must not become a composable just because Vue detection fired).
   */
  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    if (
      (symbol.kind === 'function' || symbol.kind === 'const') &&
      /^use[A-Z]/.test(symbol.name) &&
      COMPOSABLE_FILES.test(symbol.filePath)
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
