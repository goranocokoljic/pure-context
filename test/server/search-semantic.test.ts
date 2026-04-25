/**
 * Tests for search_semantic tool (Task 94).
 *
 * Tests the dedicated semantic search tool that uses HybridSearcher:
 *   - Returns error when repo not found
 *   - Returns error when no semantic index exists
 *   - Semantic-only mode (keyword_weight=0)
 *   - Hybrid mode (both weights)
 *   - kind and file_pattern filters
 *   - _meta fields: mode, semantic_index_size, search_ms
 *
 * Also retains unit tests for utility functions still present in
 * src/summarizer/embeddings.ts (cosine similarity, pack/unpack, FTS5 search).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import { saveEmbeddings } from '../../src/core/db/embedding-store.js';
import {
  cosineSimilarity,
  packEmbedding,
  unpackEmbedding,
  createEmbeddingProvider,
} from '../../src/summarizer/embeddings.js';
import type { SymbolRecord } from '../../src/core/types.js';
import type { PureContextConfig } from '../../src/config/config-schema.js';

// ─── Mocking strategy ─────────────────────────────────────────────────────────
//
// The handler opens a real DB (openDatabase) and calls createEmbeddingProvider,
// VectorStore, HybridSearcher.  We intercept at module boundaries so the handler
// code runs unchanged while the heavy I/O is stubbed out.

vi.mock('../../src/core/db/schema.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/db/schema.js')>();
  return {
    ...real,
    openDatabase: vi.fn(),
  };
});

vi.mock('../../src/config/config-loader.js', () => ({
  getConfig: vi.fn(() => ({})),
}));

vi.mock('../../src/core/index-manager.js', () => ({
  computeRepoId: vi.fn((path: string) => path),
}));

vi.mock('../../src/semantic/embedding-provider.js', () => ({
  createEmbeddingProvider: vi.fn(),
}));

vi.mock('../../src/semantic/vector-store.js', () => ({
  VectorStore: vi.fn(),
}));

vi.mock('../../src/semantic/hybrid-search.js', () => ({
  HybridSearcher: vi.fn(),
}));

vi.mock('../../src/core/db/embedding-store.js', () => ({
  countEmbeddings: vi.fn(),
  saveEmbeddings: vi.fn(),
  loadEmbeddings: vi.fn(() => new Map()),
  deleteEmbeddings: vi.fn(),
  deleteAllEmbeddings: vi.fn(),
}));

vi.mock('../../src/core/db/file-store.js', () => ({
  getFileSizesBatch: vi.fn(() => new Map()),
}));

// ─── Re-import mocked modules ─────────────────────────────────────────────────

import { openDatabase, getRepo } from '../../src/core/db/schema.js';
import { createEmbeddingProvider as mockCreateProvider } from '../../src/semantic/embedding-provider.js';
import { VectorStore as MockVectorStoreClass } from '../../src/semantic/vector-store.js';
import { HybridSearcher as MockHybridSearcherClass } from '../../src/semantic/hybrid-search.js';
import { countEmbeddings } from '../../src/core/db/embedding-store.js';

// Import handler under test AFTER mocks are registered
import { handler } from '../../src/server/tools/search-semantic.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSymbol(name: string, kind: SymbolRecord['kind'] = 'function', filePath = 'src/index.ts'): SymbolRecord {
  return {
    id: `id-${name}`,
    name,
    kind,
    filePath,
    startByte: 0,
    endByte: 100,
    signature: `function ${name}()`,
    summary: `Does ${name}`,
  };
}

function parseResult(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

const REPO_ID = 'abcdef0123456789'; // 16-char hex

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default: repo exists
  (openDatabase as ReturnType<typeof vi.fn>).mockReturnValue({
    close: vi.fn(),
    prepare: vi.fn(),
  });

  const mockDb = (openDatabase as ReturnType<typeof vi.fn>)();

  // getRepo is re-exported from schema — patch it inline via the mock
  // We inject a synthetic getRepo result via the db mock; handler calls getRepo(db, repoId)
  // Since getRepo is imported in handler's module scope and comes from the mocked schema module,
  // we need to provide it there.  The vi.mock above spreads real exports so getRepo is real.
  // Instead we provide the DB object such that getRepo finds the repo via SQL.
  // Simplest: mock openDatabase to return a db where getRepo returns a non-null repo.
  // We do this by patching the schema mock's getRepo.
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('search_semantic handler', () => {
  // ── Repo not found ────────────────────────────────────────────────────────

  it('returns isError when repo not found', async () => {
    // getRepo will return null because the in-memory mock DB has no rows
    // The simplest way: make the db.prepare chain return null for getRepo
    const fakeDb = {
      close: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(null),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      }),
    };
    (openDatabase as ReturnType<typeof vi.fn>).mockReturnValue(fakeDb);

    const result = await handler({ repo: REPO_ID, query: 'auth' });
    expect(result.isError).toBe(true);
    const data = parseResult(result as never);
    expect(data.error).toMatch(/not found/i);
  });

  // ── No semantic index ─────────────────────────────────────────────────────

  it('returns isError when no semantic index (embeddingCount=0)', async () => {
    const fakeDb = {
      close: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({
          id: REPO_ID,
          root_path: '/test',
          symbol_count: 100,
          file_count: 5,
          languages: '["typescript"]',
          indexed_at: Date.now(),
          schema_version: 2,
          clone_path: null,
        }),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      }),
    };
    (openDatabase as ReturnType<typeof vi.fn>).mockReturnValue(fakeDb);
    (countEmbeddings as ReturnType<typeof vi.fn>).mockReturnValue(0);

    const result = await handler({ repo: REPO_ID, query: 'auth' });
    expect(result.isError).toBe(true);
    const data = parseResult(result as never);
    expect(data.error).toMatch(/no semantic index/i);
  });

  // ── Provider not configured ───────────────────────────────────────────────

  it('returns isError when embedding provider not configured', async () => {
    const fakeDb = {
      close: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({
          id: REPO_ID, root_path: '/test', symbol_count: 1000, file_count: 5,
          languages: '["typescript"]', indexed_at: Date.now(), schema_version: 2, clone_path: null,
        }),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      }),
    };
    (openDatabase as ReturnType<typeof vi.fn>).mockReturnValue(fakeDb);
    (countEmbeddings as ReturnType<typeof vi.fn>).mockReturnValue(500);
    (mockCreateProvider as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('No embedding provider configured');
    });

    const result = await handler({ repo: REPO_ID, query: 'auth' });
    expect(result.isError).toBe(true);
    const data = parseResult(result as never);
    expect(data.error).toMatch(/embedding provider not configured/i);
  });

  // ── Successful hybrid search ──────────────────────────────────────────────

  it('returns results with scores in hybrid mode (default)', async () => {
    const sym1 = makeSymbol('validateUser', 'function', 'src/auth/validator.ts');
    const sym2 = makeSymbol('AuthService', 'class', 'src/auth/service.ts');

    const mockSearchFn = vi.fn().mockResolvedValue([
      { symbol: sym1, keywordScore: 0.008, semanticScore: 0.007, combinedScore: 0.015 },
      { symbol: sym2, keywordScore: 0.007, semanticScore: 0.008, combinedScore: 0.015 },
    ]);

    const mockVS = { rebuild: vi.fn().mockResolvedValue(undefined), size: 500 };
    (MockVectorStoreClass as ReturnType<typeof vi.fn>).mockImplementation(() => mockVS);
    (MockHybridSearcherClass as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      search: mockSearchFn,
    }));

    const fakeDb = {
      close: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({
          id: REPO_ID, root_path: '/test', symbol_count: 1000, file_count: 5,
          languages: '["typescript"]', indexed_at: Date.now(), schema_version: 2, clone_path: null,
        }),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      }),
    };
    (openDatabase as ReturnType<typeof vi.fn>).mockReturnValue(fakeDb);
    (countEmbeddings as ReturnType<typeof vi.fn>).mockReturnValue(1000);
    (mockCreateProvider as ReturnType<typeof vi.fn>).mockReturnValue({ name: 'mock', dimension: 32, maxTokens: 512 });

    const result = await handler({ repo: REPO_ID, query: 'authentication', mode: 'hybrid' });
    expect(result.isError).toBeFalsy();

    const data = parseResult(result as never) as {
      results: { name: string; scores: { keyword: number; semantic: number; combined: number } }[];
      _meta: { mode: string; semantic_index_size: number; search_ms: number };
    };

    expect(data.results).toHaveLength(2);
    expect(data.results[0].name).toBe('validateUser');
    expect(typeof data.results[0].scores.keyword).toBe('number');
    expect(typeof data.results[0].scores.semantic).toBe('number');
    expect(typeof data.results[0].scores.combined).toBe('number');

    expect(data._meta.mode).toBe('hybrid');
    expect(data._meta.semantic_index_size).toBe(1000);
    expect(typeof data._meta.search_ms).toBe('number');
  });

  // ── Semantic-only mode (keyword_weight=0) ─────────────────────────────────

  it('passes keywordWeight=0 and semanticWeight=1 in semantic mode', async () => {
    const sym1 = makeSymbol('validateCredentials', 'function');

    const mockSearchFn = vi.fn().mockResolvedValue([
      { symbol: sym1, keywordScore: 0, semanticScore: 0.015, combinedScore: 0.015 },
    ]);

    (MockVectorStoreClass as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      rebuild: vi.fn().mockResolvedValue(undefined),
      size: 200,
    }));
    (MockHybridSearcherClass as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      search: mockSearchFn,
    }));

    const fakeDb = {
      close: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({
          id: REPO_ID, root_path: '/test', symbol_count: 500, file_count: 3,
          languages: '["typescript"]', indexed_at: Date.now(), schema_version: 2, clone_path: null,
        }),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      }),
    };
    (openDatabase as ReturnType<typeof vi.fn>).mockReturnValue(fakeDb);
    (countEmbeddings as ReturnType<typeof vi.fn>).mockReturnValue(200);
    (mockCreateProvider as ReturnType<typeof vi.fn>).mockReturnValue({ name: 'mock', dimension: 32, maxTokens: 512 });

    await handler({ repo: REPO_ID, query: 'auth', mode: 'semantic' });

    expect(mockSearchFn).toHaveBeenCalledWith(
      'auth',
      expect.objectContaining({ keywordWeight: 0, semanticWeight: 1 }),
    );
  });

  // ── kind filter passed through ─────────────────────────────────────────────

  it('passes kind filter to HybridSearcher', async () => {
    const mockSearchFn = vi.fn().mockResolvedValue([]);

    (MockVectorStoreClass as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      rebuild: vi.fn().mockResolvedValue(undefined),
      size: 100,
    }));
    (MockHybridSearcherClass as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      search: mockSearchFn,
    }));

    const fakeDb = {
      close: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({
          id: REPO_ID, root_path: '/test', symbol_count: 500, file_count: 3,
          languages: '["typescript"]', indexed_at: Date.now(), schema_version: 2, clone_path: null,
        }),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      }),
    };
    (openDatabase as ReturnType<typeof vi.fn>).mockReturnValue(fakeDb);
    (countEmbeddings as ReturnType<typeof vi.fn>).mockReturnValue(100);
    (mockCreateProvider as ReturnType<typeof vi.fn>).mockReturnValue({ name: 'mock', dimension: 32, maxTokens: 512 });

    await handler({ repo: REPO_ID, query: 'service', kind: 'class' });

    expect(mockSearchFn).toHaveBeenCalledWith(
      'service',
      expect.objectContaining({ kind: 'class' }),
    );
  });

  // ── file_pattern filter passed through ────────────────────────────────────

  it('passes file_pattern filter to HybridSearcher', async () => {
    const mockSearchFn = vi.fn().mockResolvedValue([]);

    (MockVectorStoreClass as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      rebuild: vi.fn().mockResolvedValue(undefined),
      size: 100,
    }));
    (MockHybridSearcherClass as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      search: mockSearchFn,
    }));

    const fakeDb = {
      close: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({
          id: REPO_ID, root_path: '/test', symbol_count: 500, file_count: 3,
          languages: '["typescript"]', indexed_at: Date.now(), schema_version: 2, clone_path: null,
        }),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      }),
    };
    (openDatabase as ReturnType<typeof vi.fn>).mockReturnValue(fakeDb);
    (countEmbeddings as ReturnType<typeof vi.fn>).mockReturnValue(100);
    (mockCreateProvider as ReturnType<typeof vi.fn>).mockReturnValue({ name: 'mock', dimension: 32, maxTokens: 512 });

    await handler({ repo: REPO_ID, query: 'parse', file_pattern: 'src/auth' });

    expect(mockSearchFn).toHaveBeenCalledWith(
      'parse',
      expect.objectContaining({ filePattern: 'src/auth' }),
    );
  });

  // ── max_results respected ─────────────────────────────────────────────────

  it('passes max_results to HybridSearcher', async () => {
    const mockSearchFn = vi.fn().mockResolvedValue([]);

    (MockVectorStoreClass as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      rebuild: vi.fn().mockResolvedValue(undefined),
      size: 100,
    }));
    (MockHybridSearcherClass as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      search: mockSearchFn,
    }));

    const fakeDb = {
      close: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({
          id: REPO_ID, root_path: '/test', symbol_count: 500, file_count: 3,
          languages: '["typescript"]', indexed_at: Date.now(), schema_version: 2, clone_path: null,
        }),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      }),
    };
    (openDatabase as ReturnType<typeof vi.fn>).mockReturnValue(fakeDb);
    (countEmbeddings as ReturnType<typeof vi.fn>).mockReturnValue(100);
    (mockCreateProvider as ReturnType<typeof vi.fn>).mockReturnValue({ name: 'mock', dimension: 32, maxTokens: 512 });

    await handler({ repo: REPO_ID, query: 'auth', max_results: 5 });

    expect(mockSearchFn).toHaveBeenCalledWith(
      'auth',
      expect.objectContaining({ maxResults: 5 }),
    );
  });

  // ── _meta structure ───────────────────────────────────────────────────────

  it('includes mode and semantic_index_size in _meta', async () => {
    const sym = makeSymbol('doThing', 'function');
    const mockSearchFn = vi.fn().mockResolvedValue([
      { symbol: sym, keywordScore: 0.005, semanticScore: 0.009, combinedScore: 0.014 },
    ]);

    (MockVectorStoreClass as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      rebuild: vi.fn().mockResolvedValue(undefined),
      size: 300,
    }));
    (MockHybridSearcherClass as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      search: mockSearchFn,
    }));

    const fakeDb = {
      close: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({
          id: REPO_ID, root_path: '/test', symbol_count: 300, file_count: 10,
          languages: '["typescript"]', indexed_at: Date.now(), schema_version: 2, clone_path: null,
        }),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      }),
    };
    (openDatabase as ReturnType<typeof vi.fn>).mockReturnValue(fakeDb);
    (countEmbeddings as ReturnType<typeof vi.fn>).mockReturnValue(300);
    (mockCreateProvider as ReturnType<typeof vi.fn>).mockReturnValue({ name: 'mock', dimension: 32, maxTokens: 512 });

    const result = await handler({ repo: REPO_ID, query: 'thing', mode: 'semantic' });
    const data = parseResult(result as never) as {
      _meta: { mode: string; semantic_index_size: number; search_ms: number };
    };

    expect(data._meta.mode).toBe('semantic');
    expect(data._meta.semantic_index_size).toBe(300);
    expect(typeof data._meta.search_ms).toBe('number');
    expect(data._meta.search_ms).toBeGreaterThanOrEqual(0);
  });
});

// ─── Utility function tests (src/summarizer/embeddings.ts) ───────────────────
//
// These test standalone utility functions that remain in the pre-Phase-11
// embeddings module and are not exercised by the handler tests above.

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });

  it('returns 0 for zero-length vectors', () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });

  it('returns 0 for different-length vectors', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('computes correct value for known vectors', () => {
    expect(cosineSimilarity([1, 1], [1, 0])).toBeCloseTo(0.7071, 3);
  });
});

describe('embedding serialization', () => {
  it('round-trips a vector through pack/unpack', () => {
    const vec = [0.1, 0.2, 0.3, -0.5, 1.0];
    const buf = packEmbedding(vec);
    const restored = unpackEmbedding(buf);
    expect(restored).toHaveLength(vec.length);
    for (let i = 0; i < vec.length; i++) {
      expect(restored[i]).toBeCloseTo(vec[i]!, 5);
    }
  });

  it('produces a buffer of 4 bytes per dimension', () => {
    const vec = [1, 2, 3, 4, 5];
    expect(packEmbedding(vec).byteLength).toBe(vec.length * 4);
  });

  it('handles empty vector', () => {
    const buf = packEmbedding([]);
    expect(buf.byteLength).toBe(0);
    expect(unpackEmbedding(buf)).toHaveLength(0);
  });
});

describe('createEmbeddingProvider (legacy summarizer module)', () => {
  const baseConfig = {
    ai: {
      provider: 'none' as const,
      allowRemoteAI: true,
      apiKey: 'test-key',
      endpoint: null,
      model: 'claude-haiku-4-5-20251001',
      batchSize: 50,
      embeddingModel: null,
      embeddingProvider: null,
    },
  } as PureContextConfig;

  it('returns null when embeddingProvider is null', () => {
    expect(createEmbeddingProvider(baseConfig)).toBeNull();
  });

  it('returns null when allowRemoteAI is false', () => {
    const cfg = { ...baseConfig, ai: { ...baseConfig.ai, embeddingProvider: 'voyage' as const, allowRemoteAI: false } };
    expect(createEmbeddingProvider(cfg)).toBeNull();
  });

  it('returns null for voyage when no API key', () => {
    const cfg = { ...baseConfig, ai: { ...baseConfig.ai, embeddingProvider: 'voyage' as const, apiKey: '' } };
    expect(createEmbeddingProvider(cfg)).toBeNull();
  });

  it('returns a provider for voyage when API key is present', () => {
    const cfg = { ...baseConfig, ai: { ...baseConfig.ai, embeddingProvider: 'voyage' as const } };
    expect(createEmbeddingProvider(cfg)).not.toBeNull();
  });

  it('returns null for openai-compatible when no endpoint', () => {
    const cfg = { ...baseConfig, ai: { ...baseConfig.ai, embeddingProvider: 'openai-compatible' as const, endpoint: null } };
    expect(createEmbeddingProvider(cfg)).toBeNull();
  });

  it('returns a provider for openai-compatible when endpoint is set', () => {
    const cfg = {
      ...baseConfig,
      ai: { ...baseConfig.ai, embeddingProvider: 'openai-compatible' as const, endpoint: 'http://localhost:11434' },
    };
    expect(createEmbeddingProvider(cfg)).not.toBeNull();
  });
});
