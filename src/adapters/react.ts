/**
 * React framework adapter.
 *
 * Works entirely through enrichMetadata — no preProcess needed because the
 * TypeScript handler (tsxHandler) and JavaScript handler already parse .tsx
 * and .jsx files. extractFrameworkSymbols returns [] and the TS/JS handler
 * symbols are reclassified by enrichMetadata.
 *
 * Reclassification rules (applied only to .tsx/.jsx file symbols):
 *   useXxx  function | const  → hook       (checked first)
 *   PascalCase function | const → component
 *   everything else            → unchanged
 *
 * When kind changes the id is recomputed to keep it deterministic.
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

const IS_HOOK      = /^use[A-Z]/;   // useAuth, useState, useMyHook
const IS_PASCAL    = /^[A-Z]/;      // Button, UserCard, MyComponent
const UPGRADEABLE  = new Set(['function', 'const'] as const);

// ─── React adapter ────────────────────────────────────────────────────────────

export const reactAdapter: FrameworkAdapter = {
  name: 'react',

  /** No new extensions — .tsx/.jsx are already registered by the TS/JS handlers. */
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
      return 'react' in deps;
    } catch {
      return false;
    }
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
   * Reclassify function/const symbols in .tsx/.jsx files.
   *
   * Priority: hooks are checked before components so that a hypothetical
   * `UseMyHook` (pathological name) would still become a hook if it matched
   * the hook pattern — though in practice hook names start with lowercase `use`.
   */
  enrichMetadata(symbol: SymbolRecord): SymbolRecord {
    const kind = symbol.kind;
    if (!UPGRADEABLE.has(kind as 'function' | 'const')) return symbol;

    // Hooks: useXxx (case-sensitive — 'use' + uppercase letter)
    if (IS_HOOK.test(symbol.name)) {
      return {
        ...symbol,
        kind: 'hook',
        id: makeId(symbol.filePath, symbol.name, 'hook'),
        frameworkMeta: { ...symbol.frameworkMeta, react_hook: true },
      };
    }

    // Components: PascalCase (first letter uppercase)
    if (IS_PASCAL.test(symbol.name)) {
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
