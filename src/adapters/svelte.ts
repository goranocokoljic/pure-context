/**
 * Svelte framework adapter.
 *
 * Responsibilities:
 *  1. Detect Svelte projects (package.json declares `svelte`/`@sveltejs/*`,
 *     a svelte.config.* file, or `.svelte` files present — incl. monorepo sub-apps).
 *  2. Pre-process .svelte components into typed script blocks via svelte-preprocessor.
 *  3. Emit one `component` symbol per .svelte file (name derived from filename).
 *  4. Upgrade exported `useXxx` functions to kind `'composable'` via enrichMetadata.
 */

import { createHash } from 'crypto';
import { basename } from 'path';
import { existsSync, readFileSync } from 'fs';
import type { FrameworkAdapter, SymbolRecord, Tree } from '../core/types.js';
import { splitSvelteSFC } from './svelte-preprocessor.js';
import { registerAdapter } from './adapter-registry.js';
import { scanForFramework, pkgDepMatches, toPascalCase } from './detect-utils.js';
import { logger } from '../core/logger.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: string): string {
  return createHash('sha256').update(`${filePath}:${name}:${kind}`).digest('hex').slice(0, 16);
}

function componentNameFromPath(filePath: string): string {
  return toPascalCase(basename(filePath, '.svelte'));
}

/**
 * Positive extension allowlist for the composable upgrade (Phase 92, Task 569a).
 * `.svelte` plus plain JS/TS — never `.tsx`/`.jsx` (React's), never other languages.
 */
const COMPOSABLE_FILES = /\.(svelte|ts|js|mts|mjs|cts|cjs)$/;

/** Returns true if a package.json declares a svelte / @sveltejs/* dependency. */
function pkgDeclaresSvelte(raw: string): boolean {
  return pkgDepMatches(raw, (k) => k === 'svelte' || k.startsWith('@sveltejs/'));
}

const SVELTE_CONFIG_NAMES = ['svelte.config.js', 'svelte.config.ts', 'svelte.config.mjs', 'svelte.config.cjs'];

// ─── Svelte adapter ─────────────────────────────────────────────────────────────

export const svelteAdapter: FrameworkAdapter = {
  name: 'svelte',

  extensions: () => ['.svelte'],

  // ── Detection ───────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    // Fast path: root package.json declares svelte.
    try {
      if (pkgDeclaresSvelte(readFileSync(`${projectRoot}/package.json`, 'utf8'))) return true;
    } catch {
      // no package.json — fall through
    }

    // svelte.config.* at root.
    if (SVELTE_CONFIG_NAMES.some((n) => existsSync(`${projectRoot}/${n}`))) return true;

    // Monorepo / sub-app fallback: bounded recursive scan for a `.svelte` file or
    // a nested package.json declaring svelte.
    return scanForFramework(projectRoot, {
      matchesFile: (name) => name.endsWith('.svelte'),
      pkgDeclares: pkgDeclaresSvelte,
    });
  },

  // ── File routing ─────────────────────────────────────────────────────────────

  fileFilter: (filePath: string) => filePath.endsWith('.svelte'),

  // ── Pre-processing ───────────────────────────────────────────────────────────

  preProcess: splitSvelteSFC,

  // ── Framework symbol extraction ──────────────────────────────────────────────

  /** Emit one `component` symbol per .svelte file. */
  extractFrameworkSymbols(tree: Tree | null, source: Buffer, filePath: string): SymbolRecord[] {
    const name = componentNameFromPath(filePath);
    return [
      {
        id: makeId(filePath, name, 'component'),
        name,
        kind: 'component',
        filePath,
        startByte: 0,
        endByte: source.length,
        signature: `<${name}>`,
        summary: `Svelte component ${name}`,
        frameworkMeta: { svelte_component: true },
      },
    ];
  },

  // ── Metadata enrichment ──────────────────────────────────────────────────────

  /**
   * Upgrade exported `useXxx` functions/consts to kind `'composable'`.
   * Gated to `.svelte` plus plain JS/TS files (Phase 92) — never `.tsx`/`.jsx`
   * (React's), never other languages.
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
        frameworkMeta: { ...symbol.frameworkMeta, svelte_composable: true },
      };
    }

    if (symbol.kind === 'component') {
      return { ...symbol, frameworkMeta: { ...symbol.frameworkMeta, svelte_component: true } };
    }

    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(svelteAdapter);
logger.debug("Adapter 'svelte' registered");
