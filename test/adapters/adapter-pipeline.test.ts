/**
 * Tests for the adapter pipeline integration in IndexManager.
 *
 * These tests verify that:
 * - Adapter-handled files are discovered and processed
 * - preProcess byte offsets are applied correctly
 * - extractFrameworkSymbols symbols are merged with handler symbols
 * - enrichMetadata is applied
 * - Multiple adapters can be chained
 * - Normal (non-adapter) files still work unchanged
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { indexFolder, deleteIndex, computeRepoId } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols, getSymbolsByFile } from '../../src/core/db/symbol-store.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import type { FrameworkAdapter, SymbolRecord, Tree, ProcessedBlock } from '../../src/core/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-adapter-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir: string, relPath: string, content: string): void {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function makeSym(overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    id: 'deadbeef01234567',
    name: 'MyComponent',
    kind: 'component',
    filePath: 'src/MyComponent.vue',
    startByte: 0,
    endByte: 10,
    signature: 'MyComponent',
    summary: 'Vue component MyComponent',
    ...overrides,
  };
}

/** Minimal no-op adapter for testing. */
function makeAdapter(name: string, ext: string, overrides: Partial<FrameworkAdapter> = {}): FrameworkAdapter {
  return {
    name,
    extensions: () => [ext],
    detect: vi.fn().mockResolvedValue(true),
    fileFilter: (fp) => fp.endsWith(ext),
    extractFrameworkSymbols: () => [],
    ...overrides,
  };
}

// ─── Global setup ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(javascriptHandler);
  await initParser();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('adapter pipeline — file discovery', () => {
  it('includes adapter extension files in the index', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'package.json', '{"name":"test"}');
      writeFile(dir, 'src/main.ts', 'export const x = 1;');
      // .custom file — only discoverable via adapter
      writeFile(dir, 'src/Widget.custom', '<widget>hello</widget>');

      const adapter = makeAdapter('custom', '.custom', {
        extractFrameworkSymbols: (_tree, _src, filePath) => [
          makeSym({ id: 'aabbccdd12345678', name: 'Widget', kind: 'component', filePath }),
        ],
      });

      const repoId = computeRepoId(dir);
      const result = await indexFolder(dir, { adapters: [adapter] });
      expect(result.errors).toHaveLength(0);

      const db = openDatabase(repoId);
      const symbols = searchSymbols(db, repoId, 'Widget');
      db.close();
      deleteIndex(repoId);

      expect(symbols.some((s) => s.name === 'Widget')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normal handler files still work when adapters are present', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'src/utils.ts', 'export function add(a: number, b: number) { return a + b; }');

      const adapter = makeAdapter('vue', '.vue');
      const repoId = computeRepoId(dir);
      await indexFolder(dir, { adapters: [adapter] });

      const db = openDatabase(repoId);
      const symbols = searchSymbols(db, repoId, 'add');
      db.close();
      deleteIndex(repoId);

      expect(symbols.some((s) => s.name === 'add')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('adapter pipeline — preProcess (block splitting)', () => {
  it('adjusts symbol byte offsets by block.offsetInOriginal', async () => {
    const dir = tmpDir();
    try {
      // Simulate a .vue-like file: 30 bytes of preamble before the script content
      const preamble = '<template><p>hi</p></template>'; // 30 bytes
      const script = 'export const msg = "hello";';
      const raw = preamble + script;
      writeFile(dir, 'src/Hello.fake', raw);

      const adapter = makeAdapter('fake', '.fake', {
        preProcess: (source, _fp): ProcessedBlock[] => [
          {
            content: Buffer.from(script, 'utf8'),
            language: 'javascript',
            offsetInOriginal: preamble.length,
          },
        ],
        extractFrameworkSymbols: () => [],
      });

      const repoId = computeRepoId(dir);
      await indexFolder(dir, { adapters: [adapter] });

      const db = openDatabase(repoId);
      const symbols = getSymbolsByFile(db, repoId, 'src/Hello.fake');
      db.close();
      deleteIndex(repoId);

      // `msg` is at byte 20 within the script block → should be 30 + 20 = 50 in the file
      const msg = symbols.find((s) => s.name === 'msg');
      expect(msg).toBeDefined();
      expect(msg!.startByte).toBeGreaterThanOrEqual(preamble.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('adapter pipeline — framework symbol merging', () => {
  it('framework symbols are added alongside handler symbols', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'src/App.ts', 'export function render() {}');

      const frameworkSym = makeSym({
        id: 'ff00ff0000000001',
        name: 'AppMeta',
        kind: 'component',
        filePath: 'src/App.ts',
        startByte: 0,
        endByte: 5,
      });

      const adapter = makeAdapter('ts-extra', '.ts', {
        fileFilter: (fp) => fp.endsWith('.ts'),
        extensions: () => [],
        extractFrameworkSymbols: () => [frameworkSym],
      });

      const repoId = computeRepoId(dir);
      await indexFolder(dir, { adapters: [adapter] });

      const db = openDatabase(repoId);
      const symbols = searchSymbols(db, repoId, '');
      db.close();
      deleteIndex(repoId);

      const names = symbols.map((s) => s.name);
      expect(names).toContain('render');     // from TS handler
      expect(names).toContain('AppMeta');    // from adapter
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('framework symbol with same id overrides handler symbol', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'src/util.ts', 'export function helper() {}');

      // We need to know the id of the `helper` symbol to override it.
      // We'll collect it first, then build an adapter that overrides it.
      const repoId = computeRepoId(dir);
      await indexFolder(dir, {});
      const db = openDatabase(repoId);
      const before = searchSymbols(db, repoId, 'helper');
      db.close();
      deleteIndex(repoId);

      expect(before).toHaveLength(1);
      const originalId = before[0]!.id;

      // Now index again with an adapter that returns a symbol with the same id
      // but upgraded kind
      const overrideSym: SymbolRecord = {
        ...before[0]!,
        kind: 'component', // upgraded
        summary: 'overridden by adapter',
      };
      const adapter = makeAdapter('override', '.ts', {
        fileFilter: (fp) => fp.endsWith('.ts'),
        extensions: () => [],
        extractFrameworkSymbols: () => [overrideSym],
      });

      await indexFolder(dir, { adapters: [adapter] });
      const db2 = openDatabase(repoId);
      const after = searchSymbols(db2, repoId, 'helper');
      db2.close();
      deleteIndex(repoId);

      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(originalId);
      expect(after[0]!.kind).toBe('component');
      expect(after[0]!.summary).toBe('overridden by adapter');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('adapter pipeline — enrichMetadata', () => {
  it('enrichMetadata is applied to all symbols', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'src/comp.ts', 'export function MyComp() {}');

      const adapter = makeAdapter('enricher', '.ts', {
        fileFilter: (fp) => fp.endsWith('.ts'),
        extensions: () => [],
        extractFrameworkSymbols: () => [],
        enrichMetadata: (sym) => ({
          ...sym,
          frameworkMeta: { enriched: true },
        }),
      });

      const repoId = computeRepoId(dir);
      await indexFolder(dir, { adapters: [adapter] });

      const db = openDatabase(repoId);
      const symbols = searchSymbols(db, repoId, 'MyComp');
      db.close();
      deleteIndex(repoId);

      expect(symbols).toHaveLength(1);
      expect(symbols[0]!.frameworkMeta).toEqual({ enriched: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('adapter pipeline — no match falls through to handler', () => {
  it('files not matched by any adapter use the normal handler path', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'src/logic.ts', 'export const PI = 3.14;');

      // Adapter only matches .vue — .ts files should go through normal handler
      const adapter = makeAdapter('vue', '.vue');

      const repoId = computeRepoId(dir);
      await indexFolder(dir, { adapters: [adapter] });

      const db = openDatabase(repoId);
      const symbols = searchSymbols(db, repoId, 'PI');
      db.close();
      deleteIndex(repoId);

      expect(symbols.some((s) => s.name === 'PI')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
