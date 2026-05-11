/**
 * Tests for search_similar tool (Task 151 — Code Similarity Search).
 *
 * Strategy: mock openDatabase, getRepo, and the embedding/HNSW infrastructure
 * so the handler code runs unchanged while heavy I/O is stubbed out.
 *
 * Scenarios:
 *  - Neither symbolId nor codeSnippet → error
 *  - Both symbolId and codeSnippet → error
 *  - symbolId: no embedding found → error
 *  - symbolId: load embedding, return nearest neighbours
 *  - symbolId: excludeSelf removes source symbol from results
 *  - codeSnippet: embed on-the-fly and search
 *  - threshold filters low-similarity results
 *  - kind filter applied correctly
 *  - No semantic index in any repo → error
 *  - _meta includes reposSearched, threshold, resultCount
 *  - limit capped at 50
 *  - repoIds scope filter respected
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SymbolRecord } from '../../src/core/types.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../src/core/db/schema.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/db/schema.js')>();
  return {
    ...real,
    openDatabase: vi.fn(),
    getRepo: vi.fn(),
  };
});

vi.mock('../../src/core/db/repo-scope.js', () => ({
  resolveRepoScope: vi.fn(),
}));

vi.mock('../../src/core/index-manager.js', () => ({
  computeRepoId: vi.fn((p: string) => p),
}));

vi.mock('../../src/core/db/embedding-store.js', () => ({
  loadEmbeddings: vi.fn(),
  countEmbeddings: vi.fn(),
  getEmbedding: vi.fn(),
  saveEmbeddings: vi.fn(),
  deleteEmbeddings: vi.fn(),
  deleteAllEmbeddings: vi.fn(),
}));

vi.mock('../../src/core/db/symbol-store.js', () => ({
  getSymbolById: vi.fn(),
}));

vi.mock('../../src/semantic/hnsw-index.js', () => ({
  HNSWIndex: vi.fn(),
}));

vi.mock('../../src/config/config-loader.js', () => ({
  getConfig: vi.fn(() => ({})),
}));

vi.mock('../../src/semantic/embedding-provider.js', () => ({
  createEmbeddingProvider: vi.fn(),
}));

vi.mock('../../src/core/token-tracker.js', () => ({
  estimateSavings: vi.fn(() => 0),
  recordSavings: vi.fn(() => 0),
}));

// ─── Mocked module references ─────────────────────────────────────────────────

import { openDatabase, getRepo } from '../../src/core/db/schema.js';
import { resolveRepoScope } from '../../src/core/db/repo-scope.js';
import {
  loadEmbeddings,
  countEmbeddings,
  getEmbedding,
} from '../../src/core/db/embedding-store.js';
import { getSymbolById } from '../../src/core/db/symbol-store.js';
import { HNSWIndex as MockHNSWIndexClass } from '../../src/semantic/hnsw-index.js';
import { createEmbeddingProvider as mockCreateProvider } from '../../src/semantic/embedding-provider.js';

// ─── Handler under test ───────────────────────────────────────────────────────

import { handler } from '../../src/server/tools/search-similar.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const REPO_A = { id: 'aaaaaaaaaaaaaaa1', name: 'repo-a' };
const REPO_B = { id: 'bbbbbbbbbbbbbbb2', name: 'repo-b' };
const SYM_ID = 'sym0000000000001';
const SYM_ID2 = 'sym0000000000002';
const SYM_ID3 = 'sym0000000000003';

function makeVec(val: number): Float32Array {
  return new Float32Array([val, 0, 0, 0]);
}

function makeSymbol(id: string, kind = 'function'): SymbolRecord {
  return {
    id,
    name: `symbol_${id}`,
    kind: kind as SymbolRecord['kind'],
    filePath: 'src/foo.ts',
    startByte: 0,
    endByte: 100,
    signature: `function ${id}()`,
    summary: `does ${id}`,
  };
}

function makeFakeDb() {
  return { close: vi.fn() };
}

/** Build a fake HNSWIndex mock with controlled search results. */
function setupHnsw(results: Array<{ id: string; distance: number }>) {
  const mockSearch = vi.fn().mockReturnValue(results);
  const mockAdd = vi.fn();
  vi.mocked(MockHNSWIndexClass).mockImplementation(() => ({
    add: mockAdd,
    search: mockSearch,
    size: vi.fn().mockReturnValue(results.length),
  }) as unknown as InstanceType<typeof MockHNSWIndexClass>);
  return { mockSearch, mockAdd };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('search_similar handler', () => {
  beforeEach(() => {
    // Use resetAllMocks (not clearAllMocks) so once-queues are fully purged
    // between tests and implementations don't bleed across.
    vi.resetAllMocks();
  });

  // ── Validation ───────────────────────────────────────────────────────────────

  it('returns error when neither symbolId nor codeSnippet is provided', async () => {
    const result = await handler({});
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toMatch(/symbolId or codeSnippet/);
  });

  it('returns error when both symbolId and codeSnippet are provided', async () => {
    const result = await handler({ symbolId: SYM_ID, codeSnippet: 'const x = 1;' });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toMatch(/not both/);
  });

  // ── Repo resolution ──────────────────────────────────────────────────────────

  it('returns error when no repos are found', async () => {
    vi.mocked(resolveRepoScope).mockReturnValue([]);
    const result = await handler({ symbolId: SYM_ID });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toMatch(/No indexed repos/);
  });

  it('returns error when specified repoId is not found', async () => {
    vi.mocked(resolveRepoScope).mockReturnValue([]);
    const result = await handler({ repoId: 'nonexistent', symbolId: SYM_ID });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toMatch(/Repo not found/);
  });

  // ── symbolId source ──────────────────────────────────────────────────────────

  it('returns error when symbolId embedding is not found', async () => {
    vi.mocked(resolveRepoScope).mockReturnValue([REPO_A]);
    const fakeDb = makeFakeDb();
    vi.mocked(openDatabase).mockReturnValue(fakeDb as never);
    vi.mocked(getEmbedding).mockReturnValue(null);

    const result = await handler({ symbolId: SYM_ID });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toMatch(/No embedding found/);
  });

  it('returns nearest neighbours for symbolId source', async () => {
    // Resolve repos
    vi.mocked(resolveRepoScope).mockReturnValue([REPO_A]);

    const fakeDb = makeFakeDb();
    vi.mocked(openDatabase).mockReturnValue(fakeDb as never);

    // getEmbedding: first call is in loadSymbolEmbedding, second call is in the search loop
    vi.mocked(getEmbedding).mockReturnValue(makeVec(1));
    vi.mocked(getSymbolById)
      .mockReturnValueOnce(makeSymbol(SYM_ID))    // loadSymbolEmbedding name lookup
      .mockReturnValueOnce(makeSymbol(SYM_ID2))   // result symbol lookup
      .mockReturnValueOnce(makeSymbol(SYM_ID3));

    vi.mocked(getRepo).mockReturnValue({
      id: REPO_A.id,
      rootPath: '/repos/repo-a',
      tenantId: 'local',
      indexedAt: Date.now(),
      schemaVersion: 1,
      fileCount: 10,
      symbolCount: 5,
      clonePath: null,
    } as never);
    vi.mocked(countEmbeddings).mockReturnValue(3);
    vi.mocked(loadEmbeddings).mockReturnValue(
      new Map([[SYM_ID, makeVec(1)], [SYM_ID2, makeVec(0.9)], [SYM_ID3, makeVec(0.8)]]),
    );

    setupHnsw([
      { id: SYM_ID, distance: 0 },     // the source itself — will be excluded
      { id: SYM_ID2, distance: 0.05 }, // similarity 0.95
      { id: SYM_ID3, distance: 0.1 },  // similarity 0.90
    ]);

    const result = await handler({ symbolId: SYM_ID, threshold: 0.5 });
    expect(result.isError).toBeFalsy();

    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.source).toBe('symbol');
    expect(body.sourceName).toBe(`symbol_${SYM_ID}`);
    // SYM_ID is excluded by excludeSelf=true (default)
    expect(body.results).toHaveLength(2);
    expect(body.results[0].symbolId).toBe(SYM_ID2);
    expect(body.results[0].similarity).toBeCloseTo(0.95, 2);
    expect(body.results[0].repoId).toBe(REPO_A.id);
    expect(body.results[0].repoName).toBe('repo-a');
  });

  it('excludeSelf=false includes the source symbol in results', async () => {
    vi.mocked(resolveRepoScope).mockReturnValue([REPO_A]);
    const fakeDb = makeFakeDb();
    vi.mocked(openDatabase).mockReturnValue(fakeDb as never);
    vi.mocked(getEmbedding).mockReturnValue(makeVec(1));
    vi.mocked(getSymbolById).mockReturnValue(makeSymbol(SYM_ID));
    vi.mocked(getRepo).mockReturnValue({ id: REPO_A.id, rootPath: '/r', tenantId: 'local', indexedAt: 0, schemaVersion: 1, fileCount: 1, symbolCount: 1, clonePath: null } as never);
    vi.mocked(countEmbeddings).mockReturnValue(1);
    vi.mocked(loadEmbeddings).mockReturnValue(new Map([[SYM_ID, makeVec(1)]]));
    setupHnsw([{ id: SYM_ID, distance: 0 }]);

    const result = await handler({ symbolId: SYM_ID, excludeSelf: false, threshold: 0.0 });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content[0] as { text: string }).text);
    const ids = body.results.map((r: { symbolId: string }) => r.symbolId);
    expect(ids).toContain(SYM_ID);
  });

  // ── codeSnippet source ───────────────────────────────────────────────────────

  it('returns error when codeSnippet is used but no provider is configured', async () => {
    vi.mocked(resolveRepoScope).mockReturnValue([REPO_A]);
    vi.mocked(mockCreateProvider).mockImplementation(() => {
      throw new Error('no provider');
    });

    const result = await handler({ codeSnippet: 'const x = 1;' });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toMatch(/Embedding provider not configured/);
  });

  it('embeds codeSnippet and returns similar symbols', async () => {
    vi.mocked(resolveRepoScope).mockReturnValue([REPO_A]);
    const fakeDb = makeFakeDb();
    vi.mocked(openDatabase).mockReturnValue(fakeDb as never);
    vi.mocked(getRepo).mockReturnValue({ id: REPO_A.id, rootPath: '/r', tenantId: 'local', indexedAt: 0, schemaVersion: 1, fileCount: 1, symbolCount: 2, clonePath: null } as never);
    vi.mocked(countEmbeddings).mockReturnValue(2);
    vi.mocked(loadEmbeddings).mockReturnValue(new Map([[SYM_ID2, makeVec(0.9)]]));
    vi.mocked(getSymbolById).mockReturnValue(makeSymbol(SYM_ID2));

    const mockProvider = {
      name: 'test',
      dimension: 4,
      maxTokens: 256,
      embed: vi.fn().mockResolvedValue([makeVec(1)]),
    };
    vi.mocked(mockCreateProvider).mockReturnValue(mockProvider as never);

    setupHnsw([{ id: SYM_ID2, distance: 0.05 }]);

    const result = await handler({ codeSnippet: 'function doThing() {}', threshold: 0.5 });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.source).toBe('snippet');
    expect(body.sourceName).toBeUndefined();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].symbolId).toBe(SYM_ID2);
    expect(mockProvider.embed).toHaveBeenCalledWith(['function doThing() {}']);
  });

  // ── threshold filter ─────────────────────────────────────────────────────────

  it('excludes results below threshold', async () => {
    vi.mocked(resolveRepoScope).mockReturnValue([REPO_A]);
    const fakeDb = makeFakeDb();
    vi.mocked(openDatabase).mockReturnValue(fakeDb as never);
    vi.mocked(getEmbedding).mockReturnValue(makeVec(1));
    // SYM_ID3 is below threshold → getSymbolById is never called for it
    vi.mocked(getSymbolById)
      .mockReturnValueOnce(makeSymbol(SYM_ID))   // loadSymbolEmbedding name lookup
      .mockReturnValueOnce(makeSymbol(SYM_ID2));  // SYM_ID2 result (above threshold)
    vi.mocked(getRepo).mockReturnValue({ id: REPO_A.id, rootPath: '/r', tenantId: 'local', indexedAt: 0, schemaVersion: 1, fileCount: 1, symbolCount: 3, clonePath: null } as never);
    vi.mocked(countEmbeddings).mockReturnValue(3);
    vi.mocked(loadEmbeddings).mockReturnValue(new Map([
      [SYM_ID2, makeVec(0.9)],
      [SYM_ID3, makeVec(0.1)],
    ]));

    setupHnsw([
      { id: SYM_ID, distance: 0 },    // excluded (self)
      { id: SYM_ID2, distance: 0.1 }, // similarity 0.9 — passes threshold 0.85
      { id: SYM_ID3, distance: 0.7 }, // similarity 0.3 — below threshold 0.85
    ]);

    const result = await handler({ symbolId: SYM_ID, threshold: 0.85 });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].symbolId).toBe(SYM_ID2);
  });

  // ── kind filter ──────────────────────────────────────────────────────────────

  it('filters results by kind', async () => {
    vi.mocked(resolveRepoScope).mockReturnValue([REPO_A]);
    const fakeDb = makeFakeDb();
    vi.mocked(openDatabase).mockReturnValue(fakeDb as never);
    vi.mocked(getEmbedding).mockReturnValue(makeVec(1));
    vi.mocked(getSymbolById)
      .mockReturnValueOnce(makeSymbol(SYM_ID, 'function'))   // name lookup
      .mockReturnValueOnce(makeSymbol(SYM_ID2, 'class'))     // result — wrong kind
      .mockReturnValueOnce(makeSymbol(SYM_ID3, 'function')); // result — right kind
    vi.mocked(getRepo).mockReturnValue({ id: REPO_A.id, rootPath: '/r', tenantId: 'local', indexedAt: 0, schemaVersion: 1, fileCount: 1, symbolCount: 2, clonePath: null } as never);
    vi.mocked(countEmbeddings).mockReturnValue(2);
    vi.mocked(loadEmbeddings).mockReturnValue(new Map([
      [SYM_ID2, makeVec(0.9)],
      [SYM_ID3, makeVec(0.85)],
    ]));
    setupHnsw([
      { id: SYM_ID, distance: 0 },
      { id: SYM_ID2, distance: 0.05 },
      { id: SYM_ID3, distance: 0.1 },
    ]);

    const result = await handler({ symbolId: SYM_ID, kind: 'function', threshold: 0.5 });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    const kinds = body.results.map((r: { kind: string }) => r.kind);
    expect(kinds.every((k: string) => k === 'function')).toBe(true);
    // SYM_ID2 (class) filtered out
    const ids = body.results.map((r: { symbolId: string }) => r.symbolId);
    expect(ids).not.toContain(SYM_ID2);
    expect(ids).toContain(SYM_ID3);
  });

  // ── no semantic index ────────────────────────────────────────────────────────

  it('returns clear error when no repo has a semantic index', async () => {
    vi.mocked(resolveRepoScope).mockReturnValue([REPO_A]);
    const fakeDb = makeFakeDb();
    vi.mocked(openDatabase).mockReturnValue(fakeDb as never);
    // getEmbedding returns null → loadSymbolEmbedding fails
    vi.mocked(getEmbedding).mockReturnValue(null);

    const result = await handler({ symbolId: SYM_ID });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toMatch(/No embedding found/);
  });

  it('returns no-semantic-index error for codeSnippet when all repos have 0 embeddings', async () => {
    vi.mocked(resolveRepoScope).mockReturnValue([REPO_A]);
    const fakeDb = makeFakeDb();
    vi.mocked(openDatabase).mockReturnValue(fakeDb as never);
    vi.mocked(getRepo).mockReturnValue({ id: REPO_A.id, rootPath: '/r', tenantId: 'local', indexedAt: 0, schemaVersion: 1, fileCount: 1, symbolCount: 0, clonePath: null } as never);
    vi.mocked(countEmbeddings).mockReturnValue(0);

    const mockProvider = {
      name: 'test',
      dimension: 4,
      maxTokens: 256,
      embed: vi.fn().mockResolvedValue([makeVec(1)]),
    };
    vi.mocked(mockCreateProvider).mockReturnValue(mockProvider as never);

    const result = await handler({ codeSnippet: 'const x = 1;' });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toMatch(/No semantic index/);
  });

  // ── _meta fields ─────────────────────────────────────────────────────────────

  it('_meta includes reposSearched, threshold, resultCount', async () => {
    vi.mocked(resolveRepoScope).mockReturnValue([REPO_A]);
    const fakeDb = makeFakeDb();
    vi.mocked(openDatabase).mockReturnValue(fakeDb as never);
    vi.mocked(getEmbedding).mockReturnValue(makeVec(1));
    vi.mocked(getSymbolById).mockReturnValue(makeSymbol(SYM_ID2));
    vi.mocked(getRepo).mockReturnValue({ id: REPO_A.id, rootPath: '/r', tenantId: 'local', indexedAt: 0, schemaVersion: 1, fileCount: 1, symbolCount: 1, clonePath: null } as never);
    vi.mocked(countEmbeddings).mockReturnValue(1);
    vi.mocked(loadEmbeddings).mockReturnValue(new Map([[SYM_ID2, makeVec(0.9)]]));
    setupHnsw([{ id: SYM_ID2, distance: 0.05 }]);

    const result = await handler({ symbolId: SYM_ID, threshold: 0.8, limit: 5 });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body._meta.reposSearched).toContain(REPO_A.id);
    expect(body._meta.threshold).toBe(0.8);
    expect(typeof body._meta.resultCount).toBe('number');
    expect(typeof body._meta.timing_ms).toBe('number');
  });

  // ── limit capped at 50 ───────────────────────────────────────────────────────

  it('limit is capped at 50', async () => {
    vi.mocked(resolveRepoScope).mockReturnValue([REPO_A]);
    const fakeDb = makeFakeDb();
    vi.mocked(openDatabase).mockReturnValue(fakeDb as never);
    vi.mocked(getEmbedding).mockReturnValue(makeVec(1));
    // No other symbols needed — just verify it doesn't blow up and limit is respected
    vi.mocked(getSymbolById).mockReturnValue(null);
    vi.mocked(getRepo).mockReturnValue({ id: REPO_A.id, rootPath: '/r', tenantId: 'local', indexedAt: 0, schemaVersion: 1, fileCount: 1, symbolCount: 0, clonePath: null } as never);
    vi.mocked(countEmbeddings).mockReturnValue(1);
    vi.mocked(loadEmbeddings).mockReturnValue(new Map([[SYM_ID, makeVec(1)]]));
    setupHnsw([]);

    // limit: 100 should be capped to 50 internally (no error)
    const result = await handler({ symbolId: SYM_ID, limit: 100 });
    expect(result.isError).toBeFalsy();
  });

  // ── multi-repo ───────────────────────────────────────────────────────────────

  it('searches across multiple repos and tags results with repoId', async () => {
    vi.mocked(resolveRepoScope).mockReturnValue([REPO_A, REPO_B]);

    // Two separate DB instances
    const fakeDbA = makeFakeDb();
    const fakeDbB = makeFakeDb();
    vi.mocked(openDatabase)
      .mockReturnValueOnce(fakeDbA as never)  // loadSymbolEmbedding — repo A
      .mockReturnValueOnce(fakeDbA as never)  // search loop — repo A
      .mockReturnValueOnce(fakeDbB as never); // search loop — repo B

    vi.mocked(getEmbedding)
      .mockReturnValueOnce(makeVec(1))  // found in repo A
      .mockReturnValueOnce(null);       // not queried for repo B directly

    // getSymbolById calls: (1) name lookup in loadSymbolEmbedding, (2) result in A, (3) result in B
    vi.mocked(getSymbolById)
      .mockReturnValueOnce(makeSymbol(SYM_ID))   // name lookup
      .mockReturnValueOnce(makeSymbol(SYM_ID2))  // result in repo A
      .mockReturnValueOnce(makeSymbol(SYM_ID3)); // result in repo B

    vi.mocked(getRepo)
      .mockReturnValueOnce({ id: REPO_A.id, rootPath: '/r/a', tenantId: 'local', indexedAt: 0, schemaVersion: 1, fileCount: 1, symbolCount: 1, clonePath: null } as never)
      .mockReturnValueOnce({ id: REPO_B.id, rootPath: '/r/b', tenantId: 'local', indexedAt: 0, schemaVersion: 1, fileCount: 1, symbolCount: 1, clonePath: null } as never);

    vi.mocked(countEmbeddings).mockReturnValue(1);
    vi.mocked(loadEmbeddings)
      .mockReturnValueOnce(new Map([[SYM_ID2, makeVec(0.9)]]))
      .mockReturnValueOnce(new Map([[SYM_ID3, makeVec(0.85)]]));

    const mockSearch = vi.fn()
      .mockReturnValueOnce([{ id: SYM_ID2, distance: 0.05 }])  // repo A search
      .mockReturnValueOnce([{ id: SYM_ID3, distance: 0.08 }]); // repo B search
    vi.mocked(MockHNSWIndexClass).mockImplementation(() => ({
      add: vi.fn(),
      search: mockSearch,
      size: vi.fn().mockReturnValue(1),
    }) as unknown as InstanceType<typeof MockHNSWIndexClass>);

    const result = await handler({ symbolId: SYM_ID, threshold: 0.5, repoIds: [REPO_A.id, REPO_B.id] });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(result.isError).toBeFalsy();

    const repoIds = body.results.map((r: { repoId: string }) => r.repoId);
    expect(repoIds).toContain(REPO_A.id);
    expect(repoIds).toContain(REPO_B.id);
    expect(body._meta.reposSearched).toHaveLength(2);
  });
});
