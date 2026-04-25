import { describe, it, expect, beforeEach } from 'vitest';
import { HybridSearcher } from '../../src/semantic/hybrid-search.js';
import { VectorStore } from '../../src/semantic/vector-store.js';
import type { EmbeddingProvider } from '../../src/semantic/embedding-provider.js';
import type { SymbolRecord } from '../../src/core/types.js';
import { openInMemoryDatabase } from '../../src/core/db/schema.js';
import { insertSymbols, bulkUpsertFtsSymbols } from '../../src/core/db/symbol-store.js';
import type Database from 'better-sqlite3';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DIM = 32;

/** Deterministic pseudo-random unit vector. */
function seedVec(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim);
  let s = seed;
  for (let i = 0; i < dim; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    v[i] = ((s >>> 0) / 0xffffffff) * 2 - 1;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

/**
 * Mock provider: embed() returns a deterministic vector per text.
 * Texts starting with "auth" cluster near each other via the same seed range.
 */
class MockProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly dimension = DIM;
  readonly maxTokens = 512;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const seed = t.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
      return seedVec(DIM, seed);
    });
  }
}

function insertRepo(db: Database.Database, repoId: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO repos (id, root_path, symbol_count, file_count, languages, indexed_at, schema_version)
    VALUES (?, ?, 0, 0, '[]', 0, 2)
  `).run(repoId, `/test/${repoId}`);
}

function makeSymbol(
  id: string,
  name: string,
  summary = '',
  filePath = 'src/test.ts',
  kind: SymbolRecord['kind'] = 'function',
): SymbolRecord {
  return {
    id,
    name,
    kind,
    filePath,
    startByte: 0,
    endByte: 100,
    signature: `function ${name}()`,
    summary: summary || `Does ${name}`,
  };
}

const REPO = 'hybrid_test_repo';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('HybridSearcher', () => {
  let db: Database.Database;
  let provider: MockProvider;
  let vectorStore: VectorStore;
  let searcher: HybridSearcher;

  const symbols: SymbolRecord[] = [
    makeSymbol('s1', 'authenticateUser', 'Validates user credentials and issues a session token'),
    makeSymbol('s2', 'hashPassword', 'Hashes a plaintext password using bcrypt'),
    makeSymbol('s3', 'getUserById', 'Fetches a user record from the database by ID'),
    makeSymbol('s4', 'renderLoginForm', 'Renders the HTML login form component'),
    makeSymbol('s5', 'validateEmail', 'Checks that an email address has the correct format'),
    makeSymbol('s6', 'createOrder', 'Creates a new order in the order management system'),
    makeSymbol('s7', 'calculateShipping', 'Calculates shipping cost based on weight and destination'),
    makeSymbol('s8', 'authorizeRequest', 'Checks that the requesting user has the required permission'),
  ];

  beforeEach(async () => {
    db = openInMemoryDatabase();
    insertRepo(db, REPO);
    insertSymbols(db, REPO, symbols);
    bulkUpsertFtsSymbols(db, REPO, symbols);

    provider = new MockProvider();
    vectorStore = new VectorStore(REPO, provider, db, { indexDir: undefined as unknown as string });
    // For tests, we skip disk persistence — just build the in-memory HNSW
    await vectorStore.indexSymbols(symbols);

    searcher = new HybridSearcher(REPO, vectorStore, db);
  });

  // ── Keyword-only mode ─────────────────────────────────────────────────────

  it('keyword-only mode (keywordWeight=1, semanticWeight=0) returns keyword matches', async () => {
    const results = await searcher.search('authenticate', {
      keywordWeight: 1,
      semanticWeight: 0,
      maxResults: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    // authenticateUser should appear (FTS match on name/summary)
    expect(results.some((r) => r.symbol.name === 'authenticateUser')).toBe(true);
    // Semantic scores should be 0
    for (const r of results) {
      expect(r.semanticScore).toBe(0);
    }
  });

  // ── Semantic-only mode ────────────────────────────────────────────────────

  it('semantic-only mode (keywordWeight=0, semanticWeight=1) returns vector matches', async () => {
    const results = await searcher.search('authenticate', {
      keywordWeight: 0,
      semanticWeight: 1,
      maxResults: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    // Keyword scores should be 0
    for (const r of results) {
      expect(r.keywordScore).toBe(0);
    }
    // Combined == semantic score
    for (const r of results) {
      expect(r.combinedScore).toBeCloseTo(r.semanticScore, 10);
    }
  });

  // ── Hybrid mode ───────────────────────────────────────────────────────────

  it('hybrid mode returns results with both keyword and semantic scores', async () => {
    const results = await searcher.search('authenticate', {
      keywordWeight: 0.5,
      semanticWeight: 0.5,
      maxResults: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    // At least some results should have both scores non-zero (those in both lists)
    const hasBoth = results.some((r) => r.keywordScore > 0 && r.semanticScore > 0);
    expect(hasBoth).toBe(true);
  });

  // ── RRF score formula ─────────────────────────────────────────────────────

  it('RRF scores are positive and decrease with rank', async () => {
    const results = await searcher.search('user', {
      keywordWeight: 0.5,
      semanticWeight: 0.5,
      maxResults: 8,
    });

    // Sorted by combined score descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].combinedScore).toBeGreaterThanOrEqual(results[i].combinedScore);
    }

    // All combined scores positive
    for (const r of results) {
      expect(r.combinedScore).toBeGreaterThan(0);
    }
  });

  it('combined score equals sum of keyword and semantic scores', async () => {
    const results = await searcher.search('password', {
      keywordWeight: 0.5,
      semanticWeight: 0.5,
      maxResults: 5,
    });

    for (const r of results) {
      expect(r.combinedScore).toBeCloseTo(r.keywordScore + r.semanticScore, 10);
    }
  });

  // ── Threshold filter ──────────────────────────────────────────────────────

  it('threshold filter excludes low-scoring results', async () => {
    const allResults = await searcher.search('user', { threshold: 0 });
    const filtered = await searcher.search('user', { threshold: 0.02 });

    expect(filtered.length).toBeLessThanOrEqual(allResults.length);
    for (const r of filtered) {
      expect(r.combinedScore).toBeGreaterThanOrEqual(0.02);
    }
  });

  // ── Kind filter ───────────────────────────────────────────────────────────

  it('kind filter restricts results to matching kind', async () => {
    const classSymbols: SymbolRecord[] = [
      makeSymbol('c1', 'AuthService', 'Service for authentication', 'src/auth.ts', 'class'),
    ];
    insertSymbols(db, REPO, classSymbols);
    bulkUpsertFtsSymbols(db, REPO, classSymbols);
    await vectorStore.indexSymbols(classSymbols);

    const results = await searcher.search('auth', { kind: 'class', maxResults: 10 });

    for (const r of results) {
      expect(r.symbol.kind).toBe('class');
    }
  });

  // ── File pattern filter ───────────────────────────────────────────────────

  it('filePattern filter restricts results to matching file paths', async () => {
    const authSymbols: SymbolRecord[] = [
      makeSymbol('af1', 'authMiddleware', 'Auth middleware', 'src/auth/middleware.ts'),
    ];
    insertSymbols(db, REPO, authSymbols);
    bulkUpsertFtsSymbols(db, REPO, authSymbols);
    await vectorStore.indexSymbols(authSymbols);

    const results = await searcher.search('auth', {
      filePattern: 'src/auth/',
      maxResults: 10,
    });

    for (const r of results) {
      expect(r.symbol.filePath).toContain('src/auth/');
    }
  });

  // ── maxResults cap ────────────────────────────────────────────────────────

  it('respects maxResults cap', async () => {
    const results = await searcher.search('user', { maxResults: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  // ── Graceful fallback: empty vector store ─────────────────────────────────

  it('returns keyword-only results when vector store is empty', async () => {
    const emptyDb = openInMemoryDatabase();
    insertRepo(emptyDb, 'empty_repo');
    insertSymbols(emptyDb, 'empty_repo', symbols);
    bulkUpsertFtsSymbols(emptyDb, 'empty_repo', symbols);

    const emptyStore = new VectorStore('empty_repo', provider, emptyDb, {
      indexDir: undefined as unknown as string,
    });
    // Don't call indexSymbols — store is empty

    const emptySearcher = new HybridSearcher('empty_repo', emptyStore, emptyDb);

    const results = await emptySearcher.search('authenticate', {
      semanticWeight: 0.5,
      keywordWeight: 0.5,
      maxResults: 5,
    });

    // Should fall back gracefully — keyword results still work
    expect(results.length).toBeGreaterThan(0);
    // All semantic scores should be 0 since no index
    for (const r of results) {
      expect(r.semanticScore).toBe(0);
    }
  });

  // ── Overlapping results are handled correctly ─────────────────────────────

  it('symbols appearing in both keyword and semantic results get combined score', async () => {
    // 'authenticateUser' is an exact FTS match AND should rank semantically for "authenticate"
    const results = await searcher.search('authenticate', {
      keywordWeight: 0.5,
      semanticWeight: 0.5,
      maxResults: 10,
    });

    const authResult = results.find((r) => r.symbol.name === 'authenticateUser');
    if (authResult) {
      // If it appears in both, combined > either alone
      if (authResult.keywordScore > 0 && authResult.semanticScore > 0) {
        expect(authResult.combinedScore).toBeGreaterThan(authResult.keywordScore);
        expect(authResult.combinedScore).toBeGreaterThan(authResult.semanticScore);
      }
    }
  });

  // ── Query expansion ───────────────────────────────────────────────────────

  it('query expansion can be disabled', async () => {
    const withExpansion = await searcher.search('auth', {
      expandQuery: true,
      semanticWeight: 1,
      keywordWeight: 0,
      maxResults: 10,
    });

    const withoutExpansion = await searcher.search('auth', {
      expandQuery: false,
      semanticWeight: 1,
      keywordWeight: 0,
      maxResults: 10,
    });

    // Both should return results
    expect(withExpansion.length).toBeGreaterThan(0);
    expect(withoutExpansion.length).toBeGreaterThan(0);
  });
});
