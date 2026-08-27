/**
 * React framework adapter.
 *
 * Works entirely through enrichMetadata — no preProcess needed because the
 * TypeScript handler (tsxHandler) and JavaScript handler already parse .tsx
 * and .jsx files. extractFrameworkSymbols returns [] and the TS/JS handler
 * symbols are reclassified by enrichMetadata.
 *
 * Reclassification rules (Phase 92 — path-gated, deterministic regardless of
 * adapter order):
 *   hook (useXxx, kinds function|const|composable):
 *     - fires in .tsx/.jsx files, OR
 *     - fires in plain .ts/.js/.mts/.mjs/.cts/.cjs files whose path contains a
 *       `hooks/` segment (React convention — this is the re-claim: when a
 *       Vue/Svelte adapter ran first and made it a `composable`, React takes
 *       it back and drops the vue_composable/svelte_composable meta key).
 *   component (true PascalCase, kinds function|const):
 *     - fires ONLY in .tsx/.jsx files
 *     - true PascalCase = starts uppercase AND contains a lowercase letter AND
 *       no underscore (Button/UIButton pass; API_URL/HTTP/SOME_FLAG fail).
 *   everything else → unchanged. Symbols in other languages' files are never
 *   touched.
 *
 * Known residual ambiguity (accepted): a useX symbol in a plain .ts file
 * outside any hooks/ directory, in a repo where both Vue and React detect,
 * still lands as `composable`. The Phase-88 FTS kind-alias tokens keep it
 * retrievable either way.
 *
 * When kind changes the id is recomputed to keep it deterministic.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import type { FrameworkAdapter, SymbolRecord, Tree } from '../core/types.js';
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

const IS_HOOK = /^use[A-Z]/;   // useAuth, useState, useMyHook

/** True PascalCase: starts uppercase, has a lowercase letter, no underscore.
 *  Rejects SCREAMING_CASE consts (API_URL, HTTP, SOME_FLAG). */
function isTruePascalCase(name: string): boolean {
  return /^[A-Z]/.test(name) && /[a-z]/.test(name) && !name.includes('_');
}

/** React's own files — the only place the component upgrade fires. */
const JSX_FILES = /\.(tsx|jsx)$/;

/** Plain JS/TS files where the hook re-claim may fire (under a hooks/ segment). */
const PLAIN_JS_TS_FILES = /\.(ts|js|mts|mjs|cts|cjs)$/;

/** Path contains a `hooks/` segment (forward-slash-normalized, case-insensitive). */
function hasHooksSegment(filePath: string): boolean {
  return filePath
    .replace(/\\/g, '/')
    .toLowerCase()
    .split('/')
    .slice(0, -1)   // segments only — a file literally named hooks.ts does not count
    .includes('hooks');
}

const HOOK_INPUT_KINDS = new Set(['function', 'const', 'composable']);
const COMPONENT_INPUT_KINDS = new Set(['function', 'const']);

/** Returns true if a package.json declares a react dependency. */
function pkgDeclaresReact(raw: string): boolean {
  return pkgDepMatches(raw, (k) => k === 'react');
}

// ─── React adapter ────────────────────────────────────────────────────────────

export const reactAdapter: FrameworkAdapter = {
  name: 'react',

  /** No new extensions — .tsx/.jsx are already registered by the TS/JS handlers. */
  extensions: () => [],

  // ── Detection ───────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    // Fast path: root package.json declares react.
    try {
      if (pkgDeclaresReact(readFileSync(`${projectRoot}/package.json`, 'utf8'))) return true;
    } catch {
      // no root package.json — fall through to the monorepo scan
    }

    // Monorepo / sub-app fallback (Phase 92, Task 571): bounded recursive scan
    // for a .tsx/.jsx file or a nested package.json declaring react.
    return scanForFramework(projectRoot, {
      matchesFile: (name) => name.endsWith('.tsx') || name.endsWith('.jsx'),
      pkgDeclares: pkgDeclaresReact,
    });
  },

  // ── File routing ─────────────────────────────────────────────────────────────

  fileFilter: (filePath: string) =>
    filePath.endsWith('.tsx') || filePath.endsWith('.jsx'),

  // No preProcess — tsxHandler/.jsHandler parse these files in the else-branch
  // of processWithAdapter.

  // ── Framework symbol extraction ──────────────────────────────────────────────

  /**
   * The TS/JS handler already extracts all top-level symbols. enrichMetadata
   * handles reclassification, so there is nothing to add here.
   */
  extractFrameworkSymbols(_tree: Tree | null, _source: Buffer, _filePath: string): SymbolRecord[] {
    return [];
  },

  // ── Metadata enrichment ──────────────────────────────────────────────────────

  /**
   * Reclassify symbols per the path-gated rules in the file header.
   * Hooks are checked before components (a useXxx name is always a hook).
   */
  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    const isJsx = JSX_FILES.test(symbol.filePath);

    // Hooks: useXxx in React's own files, or the hooks/ re-claim in plain JS/TS.
    if (
      HOOK_INPUT_KINDS.has(symbol.kind) &&
      IS_HOOK.test(symbol.name) &&
      (isJsx || (PLAIN_JS_TS_FILES.test(symbol.filePath) && hasHooksSegment(symbol.filePath)))
    ) {
      // Drop composable markers when re-claiming from Vue/Svelte.
      const { vue_composable: _v, svelte_composable: _s, ...restMeta } =
        symbol.frameworkMeta ?? {};
      return {
        ...symbol,
        kind: 'hook',
        id: makeId(symbol.filePath, symbol.name, 'hook'),
        frameworkMeta: { ...restMeta, react_hook: true },
      };
    }

    // Components: true PascalCase function/const in .tsx/.jsx only.
    if (
      isJsx &&
      COMPONENT_INPUT_KINDS.has(symbol.kind) &&
      isTruePascalCase(symbol.name)
    ) {
      return {
        ...symbol,
        kind: 'component',
        id: makeId(symbol.filePath, symbol.name, 'component'),
        frameworkMeta: { ...symbol.frameworkMeta, react_component: true },
      };
    }

    return symbol;
  },
};

// ─── Self-registration ────────────────────────────────────────────────────────

registerAdapter(reactAdapter);
logger.debug("Adapter 'react' registered");
