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
import { readFileSync } from 'fs';
import { scanForFramework, pkgDepMatches } from './detect-utils.js';
import type { FrameworkAdapter, SymbolRecord, Tree } from '../core/types.js';
// Naming is shared with the TS/JS handlers' Options-API extraction (Phase 93,
// vue-options-extractor.ts) so `ComponentName.methodName` symbols and the
// component symbol always agree. Mode-suffix stripping + index.vue parent-dir
// naming (V-9) live there. (Adapter → handler import: allowed direction.)
import { componentNameFromVuePath } from '../handlers/vue-options-extractor.js';
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

function componentNameFromPath(filePath: string): string {
  return componentNameFromVuePath(filePath);
}

// ─── Detection helpers ──────────────────────────────────────────────────────

/**
 * Fixture/test directories excluded from Vue detection (Phase 93, V-7): a repo
 * whose ONLY `.vue` files are test fixtures (PureContext itself) must not
 * activate the adapter — it was self-indexing its Zustand stores as
 * `composable`.
 */
const FIXTURE_IGNORE_DIRS = new Set(['test', 'tests', 'fixtures', '__fixtures__', 'examples', 'e2e']);

/** Returns true if a parsed package.json declares a vue / @vue/* dependency. */
function pkgDeclaresVue(raw: string): boolean {
  return pkgDepMatches(raw, (k) => k === 'vue' || k.startsWith('@vue/'));
}

/**
 * Try to find an explicit component name from `defineOptions({ name: '...' })`,
 * `defineComponent({ name: '...' })`, or an Options-API
 * `export default { name: '...' }` (Phase 93, V-12 — the docs claimed the
 * latter two for years; now true). Falls back to the filename-derived
 * PascalCase name.
 */
function resolveComponentName(source: Buffer, filePath: string): string {
  const str = source.toString('utf8');
  const m =
    str.match(/defineOptions\s*\(\s*\{[^}]*\bname\s*:\s*['"]([^'"]+)['"]/) ??
    str.match(/defineComponent\s*\(\s*\{[^}]*\bname\s*:\s*['"]([^'"]+)['"]/) ??
    str.match(/export\s+default\s*\{[^}]*\bname\s*:\s*['"]([^'"]+)['"]/);
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

    // Monorepo / sub-app fallback (shared scanner, Phase 93 consolidation):
    // bounded recursive scan for a `.vue` file or a nested package.json
    // declaring vue. Fixture/test dirs are ignored (V-7).
    return scanForFramework(projectRoot, {
      matchesFile: (name) => name.endsWith('.vue'),
      pkgDeclares: pkgDeclaresVue,
      extraIgnoreDirs: FIXTURE_IGNORE_DIRS,
    });
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
