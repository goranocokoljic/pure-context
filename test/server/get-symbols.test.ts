/**
 * Tests for the get_symbols batch retrieval tool (Task 133).
 *
 * Strategy: index the basic-ts-project fixture once in beforeAll,
 * discover real symbol IDs via searchSymbols, then exercise the tool.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as getSymbolsHandler } from '../../src/server/tools/get-symbols.js';
import { TooManySymbolsError } from '../../src/core/errors.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

// ─── Setup ────────────────────────────────────────────────────────────────────

let repoId: string;
let knownIds: string[];

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  const result = await indexFolder(FIXTURE, { fileLimit: 50 });
  repoId = result.repoId;
  expect(result.symbolsFound).toBeGreaterThan(0);

  // Collect a few real symbol IDs to use across tests.
  const db = openDatabase(repoId);
  const symbols = searchSymbols(db, repoId, '', { limit: 10 });
  db.close();
  knownIds = symbols.map((s) => s.id);
  expect(knownIds.length).toBeGreaterThanOrEqual(3);
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface SymbolResult {
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  source: string;
  signature: string;
  summary: string;
  hashDrift?: boolean;
}

interface GetSymbolsOutput {
  found: SymbolResult[];
  notFound: string[];
  _meta: { timing_ms: number; tokens_saved?: number; powered_by: string };
}

function parseResult(result: { content: { text: string }[] }): GetSymbolsOutput {
  return JSON.parse(result.content[0].text) as GetSymbolsOutput;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('get_symbols', () => {
  it('batch-fetches multiple known symbols in one call', () => {
    const ids = knownIds.slice(0, 3);
    const result = getSymbolsHandler({ repoId, symbolIds: ids });
    const data = parseResult(result);

    expect(data.found).toHaveLength(ids.length);
    expect(data.notFound).toHaveLength(0);

    for (const sym of data.found) {
      expect(ids).toContain(sym.symbolId);
      expect(typeof sym.name).toBe('string');
      expect(sym.name.length).toBeGreaterThan(0);
      expect(typeof sym.source).toBe('string');
      expect(sym.source.length).toBeGreaterThan(0);
    }
  });

  it('reports not-found IDs separately without failing', () => {
    const real = knownIds[0];
    const fake = 'deadbeefdeadbeef';
    const result = getSymbolsHandler({ repoId, symbolIds: [real, fake] });
    const data = parseResult(result);

    expect(data.found).toHaveLength(1);
    expect(data.found[0].symbolId).toBe(real);
    expect(data.notFound).toEqual([fake]);
  });

  it('returns _meta with timing and token savings', () => {
    const result = getSymbolsHandler({ repoId, symbolIds: [knownIds[0]] });
    const data = parseResult(result);

    expect(typeof data._meta.timing_ms).toBe('number');
    expect(data._meta.timing_ms).toBeGreaterThanOrEqual(0);
    expect(typeof data._meta.tokens_saved).toBe('number');
    expect(data._meta.powered_by).toBe('PureContext MCP');
  });

  it('contextLines expands source beyond the symbol boundary', () => {
    const id = knownIds[0];

    const without = getSymbolsHandler({ repoId, symbolIds: [id] });
    const withCtx = getSymbolsHandler({ repoId, symbolIds: [id], contextLines: 3 });

    const base = parseResult(without).found[0].source;
    const expanded = parseResult(withCtx).found[0].source;

    // With context, the source must be at least as long (equal if symbol is at top of file).
    expect(expanded.length).toBeGreaterThanOrEqual(base.length);
  });

  it('verify: true sets hashDrift on each result', () => {
    const id = knownIds[0];
    const result = getSymbolsHandler({ repoId, symbolIds: [id], verify: true });
    const data = parseResult(result);

    expect(data.found).toHaveLength(1);
    // hashDrift must be a boolean (false, since the file has not been touched after indexing).
    expect(typeof data.found[0].hashDrift).toBe('boolean');
    expect(data.found[0].hashDrift).toBe(false);
  });

  it('throws TooManySymbolsError when more than 50 IDs are requested', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `id${i}`);
    expect(() => getSymbolsHandler({ repoId, symbolIds: ids })).toThrow(TooManySymbolsError);
  });

  it('preserves insertion order of symbolIds in found results', () => {
    const ids = knownIds.slice(0, 3);
    const result = getSymbolsHandler({ repoId, symbolIds: ids });
    const data = parseResult(result);

    const returnedIds = data.found.map((s) => s.symbolId);
    // All returned IDs must be in the same relative order as requested.
    const filtered = ids.filter((id) => returnedIds.includes(id));
    expect(returnedIds).toEqual(filtered);
  });
});
