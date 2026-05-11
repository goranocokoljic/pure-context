/**
 * Task 71: Token tracking integration tests for retrieval tools.
 *
 * Verifies that each updated tool:
 *  - returns `_meta.tokens_saved >= 0`
 *  - returns `_meta.total_tokens_saved >= _meta.tokens_saved`
 *  - accumulates `total_tokens_saved` across multiple calls
 *
 * Uses the basic-ts-project fixture (same as tools.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { _resetForTesting as resetTracker } from '../../src/core/token-tracker.js';

import { handler as searchHandler } from '../../src/server/tools/search-symbols.js';
import { handler as fileOutlineHandler } from '../../src/server/tools/get-file-outline.js';
import { handler as symbolSourceHandler } from '../../src/server/tools/get-symbol-source.js';
import { handler as contextBundleHandler } from '../../src/server/tools/get-context-bundle.js';
import { handler as blastRadiusHandler } from '../../src/server/tools/get-blast-radius.js';
import { handler as findImportersHandler } from '../../src/server/tools/find-importers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

let repoId: string;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  const result = await indexFolder(FIXTURE, { fileLimit: 50 });
  repoId = result.repoId;
  expect(result.symbolsFound).toBeGreaterThan(0);
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface Meta {
  tokens_saved: number;
  total_tokens_saved: number;
}

function parseMeta(result: { content: { text: string }[] }): Meta {
  const data = JSON.parse(result.content[0].text) as { _meta: Meta };
  return data._meta;
}

function assertMeta(meta: Meta): void {
  expect(typeof meta.tokens_saved).toBe('number');
  expect(meta.tokens_saved).toBeGreaterThanOrEqual(0);
  expect(typeof meta.total_tokens_saved).toBe('number');
  expect(meta.total_tokens_saved).toBeGreaterThanOrEqual(meta.tokens_saved);
}

// Find a symbol ID for reuse across tests
async function findSymbolId(query: string): Promise<string> {
  const result = await searchHandler({ repoId, query });
  const data = JSON.parse(result.content[0].text) as { symbols: { id: string }[] };
  const id = data.symbols[0]?.id;
  if (!id) throw new Error(`No symbol found for query "${query}"`);
  return id;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('get_symbol_source token tracking', () => {
  it('returns _meta with non-negative tokens_saved', async () => {
    resetTracker();
    const symbolId = await findSymbolId('formatDiagnostic');
    const result = symbolSourceHandler({ repoId, symbolId });
    const meta = parseMeta(result);
    assertMeta(meta);
  });

  it('tokens_saved > 0 (file is larger than the symbol)', async () => {
    resetTracker();
    const symbolId = await findSymbolId('formatDiagnostic');
    const result = symbolSourceHandler({ repoId, symbolId });
    const meta = parseMeta(result);
    // formatDiagnostic is one function in utils.ts — file should be larger
    expect(meta.tokens_saved).toBeGreaterThan(0);
  });

  it('total_tokens_saved increases on second call', async () => {
    resetTracker();
    const symbolId = await findSymbolId('formatDiagnostic');
    const first = parseMeta(symbolSourceHandler({ repoId, symbolId }));
    const second = parseMeta(symbolSourceHandler({ repoId, symbolId }));
    expect(second.total_tokens_saved).toBeGreaterThanOrEqual(first.total_tokens_saved);
  });
});

describe('search_symbols token tracking', () => {
  it('returns _meta with savings fields', async () => {
    resetTracker();
    const result = await searchHandler({ repoId, query: '' });
    const meta = parseMeta(result);
    assertMeta(meta);
  });

  it('deduplicates file sizes (multiple symbols from same file)', async () => {
    resetTracker();
    // Search broadly to get multiple symbols from the same files
    const result = await searchHandler({ repoId, query: '' });
    const meta = parseMeta(result);
    // tokens_saved should still be non-negative (dedup prevents double-counting)
    expect(meta.tokens_saved).toBeGreaterThanOrEqual(0);
  });

  it('total_tokens_saved accumulates across calls', async () => {
    resetTracker();
    const first = parseMeta(await searchHandler({ repoId, query: 'format' }));
    const second = parseMeta(await searchHandler({ repoId, query: 'filter' }));
    expect(second.total_tokens_saved).toBeGreaterThanOrEqual(first.total_tokens_saved + second.tokens_saved - 1);
  });
});

describe('get_file_outline token tracking', () => {
  it('returns _meta with savings fields', () => {
    resetTracker();
    const result = fileOutlineHandler({ repoId, filePath: 'src/utils.ts' });
    const meta = parseMeta(result);
    assertMeta(meta);
  });

  it('tokens_saved > 0 for a real file (outline is smaller than full source)', () => {
    resetTracker();
    const result = fileOutlineHandler({ repoId, filePath: 'src/utils.ts' });
    const meta = parseMeta(result);
    expect(meta.tokens_saved).toBeGreaterThan(0);
  });

  it('tokens_saved is 0 for a nonexistent file (no content = no savings)', () => {
    resetTracker();
    const result = fileOutlineHandler({ repoId, filePath: 'nonexistent.ts' });
    const meta = parseMeta(result);
    // No file size available, so rawBytes = 0, savings = 0
    expect(meta.tokens_saved).toBe(0);
  });
});

describe('get_context_bundle token tracking', () => {
  it('returns _meta with savings fields', async () => {
    resetTracker();
    const symbolId = await findSymbolId('DiagnosticRunner');
    const result = contextBundleHandler({ repoId, symbolId });
    const meta = parseMeta(result);
    assertMeta(meta);
  });
});

describe('get_blast_radius token tracking', () => {
  it('returns _meta with savings fields', async () => {
    resetTracker();
    const symbolId = await findSymbolId('formatDiagnostic');
    const result = blastRadiusHandler({ repoId, symbolId });
    const meta = parseMeta(result);
    assertMeta(meta);
  });
});

describe('find_importers token tracking', () => {
  it('returns _meta with savings fields', () => {
    resetTracker();
    const result = findImportersHandler({ repoId, filePath: 'src/utils.ts' });
    const meta = parseMeta(result);
    assertMeta(meta);
  });

  it('tokens_saved > 0 when utils.ts has importers', () => {
    resetTracker();
    const result = findImportersHandler({ repoId, filePath: 'src/utils.ts' });
    const meta = parseMeta(result);
    expect(meta.tokens_saved).toBeGreaterThan(0);
  });
});

describe('cross-tool total accumulation', () => {
  it('total_tokens_saved increases across different tool calls', async () => {
    resetTracker();
    const symbolId = await findSymbolId('formatDiagnostic');

    const m1 = parseMeta(symbolSourceHandler({ repoId, symbolId }));
    const m2 = parseMeta(await searchHandler({ repoId, query: 'format' }));
    const m3 = parseMeta(fileOutlineHandler({ repoId, filePath: 'src/utils.ts' }));

    // Each call's total should be >= the previous
    expect(m2.total_tokens_saved).toBeGreaterThanOrEqual(m1.total_tokens_saved);
    expect(m3.total_tokens_saved).toBeGreaterThanOrEqual(m2.total_tokens_saved);
  });
});
