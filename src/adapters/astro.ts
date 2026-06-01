/**
 * Astro framework adapter.
 *
 * Responsibilities:
 *  1. Detect Astro projects (package.json declares `astro`/`@astrojs/*`,
 *     an astro.config.* file, or `.astro` files present — incl. monorepo sub-apps).
 *  2. Pre-process .astro components: extract the leading `---` frontmatter as a
 *     TypeScript block via astro-preprocessor.
 *  3. Emit one `component` symbol per .astro file (name derived from filename).
 */

import { createHash } from 'crypto';
import { basename } from 'path';
import { existsSync, readFileSync } from 'fs';
import type { FrameworkAdapter, SymbolRecord, Tree } from '../core/types.js';
import { splitAstroSFC } from './astro-preprocessor.js';
import { registerAdapter } from './adapter-registry.js';
import { scanForFramework, pkgDepMatches, toPascalCase } from './detect-utils.js';
import { logger } from '../core/logger.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: string): string {
  return createHash('sha256').update(`${filePath}:${name}:${kind}`).digest('hex').slice(0, 16);
}

function componentNameFromPath(filePath: string): string {
  return toPascalCase(basename(filePath, '.astro'));
}

/** Returns true if a package.json declares an astro / @astrojs/* dependency. */
function pkgDeclaresAstro(raw: string): boolean {
  return pkgDepMatches(raw, (k) => k === 'astro' || k.startsWith('@astrojs/'));
}

const ASTRO_CONFIG_NAMES = ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'astro.config.cjs'];

// ─── Astro adapter ──────────────────────────────────────────────────────────────

export const astroAdapter: FrameworkAdapter = {
  name: 'astro',

  extensions: () => ['.astro'],

  // ── Detection ───────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    try {
      if (pkgDeclaresAstro(readFileSync(`${projectRoot}/package.json`, 'utf8'))) return true;
    } catch {
      // no package.json — fall through
    }

    if (ASTRO_CONFIG_NAMES.some((n) => existsSync(`${projectRoot}/${n}`))) return true;

    return scanForFramework(projectRoot, {
      matchesFile: (name) => name.endsWith('.astro'),
      pkgDeclares: pkgDeclaresAstro,
    });
  },

  // ── File routing ─────────────────────────────────────────────────────────────

  fileFilter: (filePath: string) => filePath.endsWith('.astro'),

  // ── Pre-processing ───────────────────────────────────────────────────────────

  preProcess: splitAstroSFC,

  // ── Framework symbol extraction ──────────────────────────────────────────────

  /** Emit one `component` symbol per .astro file. */
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
        summary: `Astro component ${name}`,
        frameworkMeta: { astro_component: true },
      },
    ];
  },

  // ── Metadata enrichment ──────────────────────────────────────────────────────

  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    if (symbol.kind === 'component') {
      return { ...symbol, frameworkMeta: { ...symbol.frameworkMeta, astro_component: true } };
    }
    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(astroAdapter);
logger.debug("Adapter 'astro' registered");
