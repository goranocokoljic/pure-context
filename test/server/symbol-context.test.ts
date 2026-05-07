/**
 * Tests for Task 136: context_lines and verify parameters on
 * get_symbol_source and get_symbols.
 *
 * Strategy: index basic-ts-project, discover real symbol IDs, then exercise
 * contextLines expansion and hash-drift detection on both tools.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, readFileSync } from 'fs';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as getSymbolSourceHandler } from '../../src/server/tools/get-symbol-source.js';
import { handler as getSymbolsHandler } from '../../src/server/tools/get-symbols.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';
import { MAX_CONTEXT_LINES } from '../../src/core/symbol-source-helper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

// ─── Setup ────────────────────────────────────────────────────────────────────

let repoId: string;
let knownId: string;
let knownFilePath: string; // relative path of the symbol's source file

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  const result = await indexFolder(FIXTURE, { fileLimit: 50 });
  repoId = result.repoId;
  expect(result.symbolsFound).toBeGreaterThan(0);

  // Pick a real symbol to use across tests.
  const db = openDatabase(repoId);
  const symbols = searchSymbols(db, repoId, '', { limit: 5 });
  db.close();

  expect(symbols.length).toBeGreaterThan(0);
  knownId = symbols[0].id;
  knownFilePath = symbols[0].filePath;
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseSource(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text) as {
    symbol: {
      source: string;
      contextLines?: number;
      hashDrift?: boolean;
      diskHash?: string;
      cachedHash?: string;
    };
    _meta: Record<string, unknown>;
    _warnings?: string[];
  };
}

function parseSymbols(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text) as {
    found: Array<{
      symbolId: string;
      source: string;
      hashDrift?: boolean;
    }>;
    notFound: string[];
    _meta: Record<string, unknown>;
  };
}

// ─── get_symbol_source tests ──────────────────────────────────────────────────

describe('get_symbol_source — contextLines', () => {
  it('contextLines: 0 (default) returns bare symbol source', () => {
    const result = getSymbolSourceHandler({ repoId, symbolId: knownId });
    const data = parseSource(result);

    expect(typeof data.symbol.source).toBe('string');
    expect(data.symbol.source.length).toBeGreaterThan(0);
    expect(data.symbol.contextLines).toBeUndefined();
  });

  it('contextLines: 3 returns source at least as long as bare symbol', () => {
    const bare = parseSource(getSymbolSourceHandler({ repoId, symbolId: knownId }));
    const ctx = parseSource(
      getSymbolSourceHandler({ repoId, symbolId: knownId, contextLines: 3 }),
    );

    expect(ctx.symbol.source.length).toBeGreaterThanOrEqual(bare.symbol.source.length);
    expect(ctx.symbol.contextLines).toBe(3);
  });

  it('contextLines > MAX_CONTEXT_LINES is clamped and a warning is emitted', () => {
    const over = MAX_CONTEXT_LINES + 10;
    const data = parseSource(
      getSymbolSourceHandler({ repoId, symbolId: knownId, contextLines: over }),
    );

    // Clamped: echoed back at MAX, not the requested value.
    expect(data.symbol.contextLines).toBe(MAX_CONTEXT_LINES);
    expect(data._warnings).toBeDefined();
    expect(data._warnings!.some((w) => w.includes('clamped'))).toBe(true);
  });
});

describe('get_symbol_source — verify', () => {
  it('verify: false omits hashDrift field', () => {
    const data = parseSource(
      getSymbolSourceHandler({ repoId, symbolId: knownId, verify: false }),
    );
    expect(data.symbol.hashDrift).toBeUndefined();
  });

  it('verify: true with unmodified file → hashDrift: false, no hashes returned', () => {
    const data = parseSource(
      getSymbolSourceHandler({ repoId, symbolId: knownId, verify: true }),
    );

    expect(typeof data.symbol.hashDrift).toBe('boolean');
    expect(data.symbol.hashDrift).toBe(false);
    // hashes are only present when drift is true
    expect(data.symbol.diskHash).toBeUndefined();
    expect(data.symbol.cachedHash).toBeUndefined();
  });

  it('verify: true with modified file → hashDrift: true and both hashes returned', () => {
    // Temporarily append whitespace to the file to change its hash.
    const absPath = join(FIXTURE, knownFilePath);
    const original = readFileSync(absPath);
    writeFileSync(absPath, Buffer.concat([original, Buffer.from(' ')]));

    try {
      const data = parseSource(
        getSymbolSourceHandler({ repoId, symbolId: knownId, verify: true }),
      );

      expect(data.symbol.hashDrift).toBe(true);
      expect(typeof data.symbol.diskHash).toBe('string');
      expect(typeof data.symbol.cachedHash).toBe('string');
      expect(data.symbol.diskHash).not.toBe(data.symbol.cachedHash);
    } finally {
      // Restore original content so other tests see a clean file.
      writeFileSync(absPath, original);
    }
  });
});

// ─── get_symbols tests ────────────────────────────────────────────────────────

describe('get_symbols — contextLines', () => {
  it('contextLines: 0 returns bare symbol source', () => {
    const data = parseSymbols(getSymbolsHandler({ repoId, symbolIds: [knownId] }));
    expect(data.found).toHaveLength(1);
    expect(data.found[0].source.length).toBeGreaterThan(0);
  });

  it('contextLines: 3 returns expanded source', () => {
    const bare = parseSymbols(getSymbolsHandler({ repoId, symbolIds: [knownId] }));
    const ctx = parseSymbols(
      getSymbolsHandler({ repoId, symbolIds: [knownId], contextLines: 3 }),
    );

    expect(ctx.found[0].source.length).toBeGreaterThanOrEqual(
      bare.found[0].source.length,
    );
  });

  it('contextLines > MAX_CONTEXT_LINES is silently clamped', () => {
    // Should not throw; just return valid source.
    const data = parseSymbols(
      getSymbolsHandler({
        repoId,
        symbolIds: [knownId],
        contextLines: MAX_CONTEXT_LINES + 100,
      }),
    );
    expect(data.found).toHaveLength(1);
    expect(data.found[0].source.length).toBeGreaterThan(0);
  });
});

describe('get_symbols — verify', () => {
  it('verify: false → hashDrift field is absent', () => {
    const data = parseSymbols(
      getSymbolsHandler({ repoId, symbolIds: [knownId], verify: false }),
    );
    expect(data.found[0].hashDrift).toBeUndefined();
  });

  it('verify: true with unmodified file → hashDrift: false', () => {
    const data = parseSymbols(
      getSymbolsHandler({ repoId, symbolIds: [knownId], verify: true }),
    );
    expect(typeof data.found[0].hashDrift).toBe('boolean');
    expect(data.found[0].hashDrift).toBe(false);
  });

  it('verify: true with modified file → hashDrift: true', () => {
    const absPath = join(FIXTURE, knownFilePath);
    const original = readFileSync(absPath);
    writeFileSync(absPath, Buffer.concat([original, Buffer.from(' ')]));

    try {
      const data = parseSymbols(
        getSymbolsHandler({ repoId, symbolIds: [knownId], verify: true }),
      );
      expect(data.found[0].hashDrift).toBe(true);
    } finally {
      writeFileSync(absPath, original);
    }
  });
});
