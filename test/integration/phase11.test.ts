/**
 * Phase 11 Integration Tests — Task 95
 *
 * Validates the complete semantic search pipeline end-to-end using mock embedding
 * providers (no real API calls required). Each test exercises a different layer
 * of the pipeline to verify components compose correctly.
 *
 *  1.  Embedding provider: embed 10 symbols, verify vector dimensions
 *  2.  HNSW index: add 1000 vectors, search, verify nearest-neighbor recall
 *  3.  Semantic indexer: threshold gate — skip below threshold, index above
 *  4.  Semantic indexer: batch processing with concurrency
 *  5.  Hybrid search: keyword + semantic results merged via RRF
 *  6.  RRF scoring: combined score equals sum of keyword + semantic components
 *  7.  Incremental update: add symbols after initial index, verify HNSW updated
 *  8.  Remove symbols: removed vectors no longer appear in search results
 *  9.  Persistence: save HNSW index, reload into fresh store, search succeeds
 * 10.  Graceful fallback: empty vector store → keyword-only results returned
 * 11.  Full pipeline: SemanticIndexer → VectorStore → HybridSearcher integration
 * 12.  Regression: basic-ts-project indexes cleanly after Phase 11 changes
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type Database from 'better-sqlite3';

import type { EmbeddingProvider } from '../../src/semantic/embedding-provider.js';
import type { SymbolRecord } from '../../src/core/types.js';
import { HNSWIndex } from '../../src/semantic/hnsw-index.js';
import { VectorStore } from '../../src/semantic/vector-store.js';
import { SemanticIndexer } from '../../src/semantic/semantic-indexer.js';
import { HybridSearcher } from '../../src/semantic/hybrid-search.js';
import { prepareSymbolText } from '../../src/semantic/text-preparation.js';
import { DEFAULT_CONFIG } from '../../src/config/config-schema.js';
import type { PureContextConfig } from '../../src/config/config-schema.js';
import { openInMemoryDatabase } from '../../src/core/db/schema.js';
import { insertSymbols, bulkUpsertFtsSymbols } from '../../src/core/db/symbol-store.js';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TS_FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

const DIM = 64;

// ─── Mock provider ────────────────────────────────────────────────────────────

/**
 * Deterministic mock embedding provider.
 * Returns unit vectors derived from text content — texts with similar characters
 * produce vectors that are closer in cosine space.
 */
class MockProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly dimension: number;
  readonly maxTokens = 512;
  embedCallCount = 0;

  constructor(dim = DIM) {
    this.dimension = dim;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCallCount++;
    return texts.map((t) => seedVec(this.dimension, textSeed(t)));
  }
}

/** Convert text to a numeric seed for deterministic vectors. */
function textSeed(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** Generate a deterministic unit vector from a seed. */
function seedVec(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim);
  let s = seed;
  for (let i = 0; i < dim; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    v[i] = ((s >>> 0) / 0xffffffff) * 2 - 1;
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

function insertRepo(db: Database.Database, repoId: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO repos
      (id, root_path, symbol_count, file_count, languages, indexed_at, schema_version)
    VALUES (?, ?, 0, 0, '[]', 0, 2)
  `).run(repoId, `/test/${repoId}`);
}

function insertSymbolRows(db: Database.Database, repoId: string, symbols: SymbolRecord[]): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO symbols
      (id, repo_id, name, kind, file_path, start_byte, end_byte, signature, summary, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);
  for (const s of symbols) {
    stmt.run(s.id, repoId, s.name, s.kind, s.filePath, s.startByte, s.endByte, s.signature, s.summary ?? '');
  }
}

// ─── Symbol factories ─────────────────────────────────────────────────────────

function makeSymbol(
  id: string,
  name: string,
  summary = '',
  kind: SymbolRecord['kind'] = 'function',
  filePath = 'src/test.ts',
): SymbolRecord {
  return {
    id,
    name,
    kind,
    filePath,
    startByte: 0,
    endByte: 100,
    signature: `function ${name}(): void`,
    summary: summary || `Does ${name}`,
  };
}

/** Create `count` numbered symbols. */
function makeSymbols(count: number, prefix = 'sym'): SymbolRecord[] {
  return Array.from({ length: count }, (_, i) => makeSymbol(
    `${prefix}${i}`,
    `${prefix}${i}`,
    `Symbol number ${i}`,
  ));
}

// ─── Config helpers ───────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PureContextConfig['semantic']> = {}): PureContextConfig {
  return {
    ...DEFAULT_CONFIG,
    semantic: {
      ...DEFAULT_CONFIG.semantic,
      enabled: true,
      provider: 'openai',
      threshold: 100,
      batchSize: 50,
      concurrency: 2,
      ...overrides,
    },
    ai: { ...DEFAULT_CONFIG.ai, openaiApiKey: 'test-key' },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Phase 11 Integration — Semantic Search Pipeline', () => {
  let db: Database.Database;
  let tmpDir: string;
  let provider: MockProvider;

  beforeEach(() => {
    db = openInMemoryDatabase();
    tmpDir = mkdtempSync(join(tmpdir(), 'p11-int-'));
    provider = new MockProvider();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Test 1: Embedding provider ───────────────────────────────────────────────

  it('1. embedding provider: embed 10 symbols, verify vector dimensions', async () => {
    const symbols = makeSymbols(10, 'auth');
    const texts = symbols.map((s) => prepareSymbolText(s, provider.maxTokens));

    const vectors = await provider.embed(texts);

    expect(vectors).toHaveLength(10);
    for (const vec of vectors) {
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(DIM);
      // Verify unit-normalized (cosine distance from itself ≈ 0)
      let norm = 0;
      for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
      expect(Math.sqrt(norm)).toBeCloseTo(1.0, 3);
    }
    expect(provider.embedCallCount).toBe(1);
  });

  // ── Test 2: HNSW index ───────────────────────────────────────────────────────

  it('2. HNSW index: add 1000 vectors, search, verify nearest-neighbor recall', () => {
    const N = 1000;
    const idx = new HNSWIndex(DIM, N + 100);

    const ids: string[] = [];
    const vecs: Float32Array[] = [];
    for (let i = 0; i < N; i++) {
      ids.push(`sym_${i}`);
      vecs.push(seedVec(DIM, i * 17 + 3));
    }

    idx.add(ids, vecs);
    expect(idx.size()).toBe(N);

    // Query using an indexed vector — it must be the exact nearest neighbor
    const queryIdx = 123;
    const results = idx.search(vecs[queryIdx], 5);

    expect(results).toHaveLength(5);
    expect(results[0].id).toBe(`sym_${queryIdx}`);
    expect(results[0].distance).toBeCloseTo(0, 4);

    // Results sorted nearest-first
    for (let i = 0; i + 1 < results.length; i++) {
      expect(results[i].distance).toBeLessThanOrEqual(results[i + 1].distance);
    }

    // Timing: 1000-vector search should complete well under 500ms
    const start = Date.now();
    idx.search(seedVec(DIM, 99999), 10);
    expect(Date.now() - start).toBeLessThan(500);
  });

  // ── Test 3: Semantic indexer threshold gate ───────────────────────────────────

  it('3. semantic indexer: threshold gate — skips below, indexes above', () => {
    const indexer = new SemanticIndexer(
      makeConfig({ threshold: 1000 }),
      { storeOptions: { indexDir: tmpDir }, providerFactory: () => provider },
    );

    expect(indexer.shouldIndex('repo1', 999)).toBe(false);
    expect(indexer.shouldIndex('repo1', 1000)).toBe(true);
    expect(indexer.shouldIndex('repo1', 50_000)).toBe(true);
  });

  // ── Test 4: Semantic indexer batch processing ─────────────────────────────────

  it('4. semantic indexer: batch processing with concurrency', async () => {
    insertRepo(db, 'repo_batch');
    const symbols = makeSymbols(120, 'fn');
    insertSymbolRows(db, 'repo_batch', symbols);

    const indexer = new SemanticIndexer(
      makeConfig({ threshold: 10, batchSize: 30, concurrency: 2 }),
      { storeOptions: { indexDir: tmpDir }, providerFactory: () => provider },
    );

    const result = await indexer.index('repo_batch', symbols, db);

    expect(result.symbolsIndexed).toBe(120);
    // 120 / 30 = 4 batches → 4 embed() calls (concurrency=2 processes in parallel)
    expect(provider.embedCallCount).toBe(4);
    expect(result.embeddingTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.indexSizeBytes).toBe(120 * DIM * 4);
  });

  // ── Test 5: Hybrid search ──────────────────────────────────────────────────────

  it('5. hybrid search: keyword + semantic results merged via RRF', async () => {
    const REPO = 'repo_hybrid';
    insertRepo(db, REPO);

    const symbols: SymbolRecord[] = [
      makeSymbol('h1', 'authenticateUser', 'Validates user credentials and issues a session token'),
      makeSymbol('h2', 'hashPassword', 'Hashes a plaintext password using bcrypt'),
      makeSymbol('h3', 'getUserById', 'Fetches a user record from the database by ID'),
      makeSymbol('h4', 'renderLoginForm', 'Renders the HTML login form component'),
      makeSymbol('h5', 'validateEmail', 'Checks that an email address has correct format'),
      makeSymbol('h6', 'createOrder', 'Creates a new order in the order management system'),
      makeSymbol('h7', 'authorizeRequest', 'Checks that the requesting user has required permission'),
    ];

    insertSymbols(db, REPO, symbols);
    bulkUpsertFtsSymbols(db, REPO, symbols);

    const store = new VectorStore(REPO, provider, db, { indexDir: tmpDir });
    insertSymbolRows(db, REPO, symbols);
    await store.indexSymbols(symbols);

    const searcher = new HybridSearcher(REPO, store, db);

    const results = await searcher.search('authenticate', {
      keywordWeight: 0.5,
      semanticWeight: 0.5,
      maxResults: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    // At least some results should come from both keyword and semantic
    const hasBothScores = results.some((r) => r.keywordScore > 0 && r.semanticScore > 0);
    expect(hasBothScores).toBe(true);
    // Results are sorted descending by combined score
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].combinedScore).toBeGreaterThanOrEqual(results[i].combinedScore);
    }
  });

  // ── Test 6: RRF scoring ────────────────────────────────────────────────────────

  it('6. RRF scoring: combined score equals sum of keyword + semantic components', async () => {
    const REPO = 'repo_rrf';
    insertRepo(db, REPO);

    const symbols = makeSymbols(15, 'rrf');
    insertSymbols(db, REPO, symbols);
    bulkUpsertFtsSymbols(db, REPO, symbols);
    insertSymbolRows(db, REPO, symbols);

    const store = new VectorStore(REPO, provider, db, { indexDir: tmpDir });
    await store.indexSymbols(symbols);

    const searcher = new HybridSearcher(REPO, store, db);

    const results = await searcher.search('rrf0', {
      keywordWeight: 0.4,
      semanticWeight: 0.6,
      maxResults: 10,
    });

    expect(results.length).toBeGreaterThan(0);

    // For every result: combinedScore === keywordScore + semanticScore
    for (const r of results) {
      expect(r.combinedScore).toBeCloseTo(r.keywordScore + r.semanticScore, 10);
    }
    // All scores non-negative
    for (const r of results) {
      expect(r.keywordScore).toBeGreaterThanOrEqual(0);
      expect(r.semanticScore).toBeGreaterThanOrEqual(0);
      expect(r.combinedScore).toBeGreaterThan(0);
    }
  });

  // ── Test 7: Incremental update ────────────────────────────────────────────────

  it('7. incremental update: add symbols after initial index, verify HNSW updated', async () => {
    insertRepo(db, 'repo_incr');

    const initial = makeSymbols(20, 'init');
    insertSymbolRows(db, 'repo_incr', initial);

    const indexer = new SemanticIndexer(
      makeConfig({ threshold: 5, batchSize: 10, concurrency: 1 }),
      { storeOptions: { indexDir: tmpDir }, providerFactory: () => provider },
    );

    const result1 = await indexer.index('repo_incr', initial, db);
    expect(result1.symbolsIndexed).toBe(20);

    // Now add 10 more symbols
    const added = makeSymbols(10, 'new');
    insertSymbolRows(db, 'repo_incr', added);

    await indexer.updateIncremental('repo_incr', added, [], db);

    // Reload the index and verify total count
    const store = new VectorStore('repo_incr', provider, db, { indexDir: tmpDir });
    const loaded = store.loadIndex();
    expect(loaded).toBe(true);
    // Index should contain original + added symbols
    expect(store.size).toBe(30);
  });

  // ── Test 8: Remove symbols ────────────────────────────────────────────────────

  it('8. remove symbols: removed vectors no longer appear in search results', async () => {
    const REPO = 'repo_remove';
    insertRepo(db, REPO);

    const symbols: SymbolRecord[] = [
      makeSymbol('rm1', 'targetFunction', 'The function that will be removed'),
      makeSymbol('rm2', 'keepFunction', 'This function stays in the index'),
      makeSymbol('rm3', 'anotherKeeper', 'Another function that stays'),
    ];
    insertSymbolRows(db, REPO, symbols);

    const store = new VectorStore(REPO, provider, db, { indexDir: tmpDir });
    await store.indexSymbols(symbols);

    expect(store.size).toBe(3);

    // Remove the target
    store.removeSymbols(['rm1']);
    expect(store.size).toBe(2);

    // Search should not return the removed symbol
    const searchResults = await store.searchSimilar('target function removed', 5);
    const returnedIds = searchResults.map((r) => r.id);
    expect(returnedIds).not.toContain('rm1');

    // Verify removed from SQLite embeddings table too
    const row = db.prepare('SELECT 1 FROM embeddings WHERE symbol_id = ?').get('rm1');
    expect(row).toBeUndefined();
  });

  // ── Test 9: Persistence ──────────────────────────────────────────────────────

  it('9. persistence: save HNSW index, reload into fresh store, search succeeds', async () => {
    const REPO = 'repo_persist';
    insertRepo(db, REPO);

    const symbols = makeSymbols(30, 'persist');
    insertSymbolRows(db, REPO, symbols);

    // Build and save
    const store1 = new VectorStore(REPO, provider, db, { indexDir: tmpDir });
    await store1.indexSymbols(symbols);
    store1.saveIndex();

    const idxFile = join(tmpDir, 'hnsw.idx');
    expect(existsSync(idxFile)).toBe(true);

    // Load into a fresh store (no embeddings in HNSW in-memory)
    const store2 = new VectorStore(REPO, provider, db, { indexDir: tmpDir });
    expect(store2.size).toBe(0); // starts empty

    const loaded = store2.loadIndex();
    expect(loaded).toBe(true);
    expect(store2.size).toBe(30);

    // Search still works after reload
    const results = await store2.searchSimilar('persist0 symbol', 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('id');
    expect(results[0]).toHaveProperty('distance');
  });

  // ── Test 10: Graceful fallback ────────────────────────────────────────────────

  it('10. graceful fallback: empty vector store → keyword-only results returned', async () => {
    const REPO = 'repo_fallback';
    insertRepo(db, REPO);

    const symbols: SymbolRecord[] = [
      makeSymbol('fb1', 'authenticateUser', 'Validates user credentials'),
      makeSymbol('fb2', 'hashPassword', 'Hashes a password'),
      makeSymbol('fb3', 'createSession', 'Creates a new session'),
    ];
    insertSymbols(db, REPO, symbols);
    bulkUpsertFtsSymbols(db, REPO, symbols);
    insertSymbolRows(db, REPO, symbols);

    // Store with NO indexed vectors
    const emptyStore = new VectorStore(REPO, provider, db, { indexDir: tmpDir });
    expect(emptyStore.size).toBe(0);

    const searcher = new HybridSearcher(REPO, emptyStore, db);

    // With hybrid weights but empty semantic index — should fall back to keyword only
    const results = await searcher.search('authenticate', {
      keywordWeight: 0.5,
      semanticWeight: 0.5,
      maxResults: 5,
    });

    // Keyword results should still work
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.symbol.name === 'authenticateUser')).toBe(true);

    // All semantic scores must be 0 (no index)
    for (const r of results) {
      expect(r.semanticScore).toBe(0);
    }
  });

  // ── Test 11: Full pipeline integration ────────────────────────────────────────

  it('11. full pipeline: SemanticIndexer → VectorStore → HybridSearcher', async () => {
    const REPO = 'repo_pipeline';
    insertRepo(db, REPO);

    // Create realistic auth-domain symbols
    const symbols: SymbolRecord[] = [
      makeSymbol('p01', 'verifyJwtToken', 'Verifies a JWT token signature and expiry', 'function', 'src/auth/jwt.ts'),
      makeSymbol('p02', 'generateAccessToken', 'Generates a signed JWT access token', 'function', 'src/auth/jwt.ts'),
      makeSymbol('p03', 'refreshSessionToken', 'Refreshes an expired session token', 'function', 'src/auth/session.ts'),
      makeSymbol('p04', 'hashUserPassword', 'Hashes a user password with bcrypt', 'function', 'src/auth/password.ts'),
      makeSymbol('p05', 'comparePasswordHash', 'Compares a plaintext password with stored hash', 'function', 'src/auth/password.ts'),
      makeSymbol('p06', 'getUserPermissions', 'Fetches the permission set for a user', 'function', 'src/users/permissions.ts'),
      makeSymbol('p07', 'checkUserRole', 'Checks whether a user has a specific role', 'function', 'src/users/roles.ts'),
      makeSymbol('p08', 'sendPasswordReset', 'Sends a password reset email to the user', 'function', 'src/email/reset.ts'),
      makeSymbol('p09', 'AuthService', 'Core authentication service class', 'class', 'src/auth/service.ts'),
      makeSymbol('p10', 'SessionStore', 'In-memory session storage with TTL eviction', 'class', 'src/auth/session.ts'),
      makeSymbol('p11', 'createUserAccount', 'Creates a new user account and sends welcome email', 'function', 'src/users/account.ts'),
      makeSymbol('p12', 'deactivateAccount', 'Deactivates a user account and revokes all sessions', 'function', 'src/users/account.ts'),
    ];

    insertSymbols(db, REPO, symbols);
    bulkUpsertFtsSymbols(db, REPO, symbols);
    insertSymbolRows(db, REPO, symbols);

    // Step 1: Run SemanticIndexer
    const indexer = new SemanticIndexer(
      makeConfig({ threshold: 5, batchSize: 6, concurrency: 2 }),
      { storeOptions: { indexDir: tmpDir }, providerFactory: () => provider },
    );
    const indexResult = await indexer.index(REPO, symbols, db);
    expect(indexResult.symbolsIndexed).toBe(12);

    // Step 2: Verify embeddings in SQLite
    const embCount = db.prepare(
      'SELECT COUNT(*) AS c FROM embeddings WHERE repo_id = ?',
    ).get(REPO) as { c: number };
    expect(embCount.c).toBe(12);

    // Step 3: Build VectorStore from persisted index
    const store = new VectorStore(REPO, provider, db, { indexDir: tmpDir });
    const loaded = store.loadIndex();
    expect(loaded).toBe(true);
    expect(store.size).toBe(12);

    // Step 4: Hybrid search for authentication-related symbols
    const searcher = new HybridSearcher(REPO, store, db);
    const authResults = await searcher.search('jwt token authentication', {
      keywordWeight: 0.4,
      semanticWeight: 0.6,
      maxResults: 5,
    });

    expect(authResults.length).toBeGreaterThan(0);
    // Combined scores should be positive
    for (const r of authResults) {
      expect(r.combinedScore).toBeGreaterThan(0);
    }

    // Step 5: Kind filter — only classes
    const classResults = await searcher.search('service store', {
      kind: 'class',
      maxResults: 10,
    });
    for (const r of classResults) {
      expect(r.symbol.kind).toBe('class');
    }

    // Step 6: File pattern filter
    const authFileResults = await searcher.search('auth', {
      filePattern: 'src/auth/',
      maxResults: 10,
    });
    for (const r of authFileResults) {
      expect(r.symbol.filePath).toContain('src/auth/');
    }
  });

  // ── Test 12: Regression ───────────────────────────────────────────────────────

  it('12. regression: basic-ts-project indexes cleanly after Phase 11 changes', async () => {
    _resetForTesting();
    registerHandler(typescriptHandler);
    await initParser();

    const { repoId } = await indexFolder(TS_FIXTURE);

    let db12: Database.Database | null = null;
    try {
      db12 = openDatabase(repoId);

      // Verify basic symbol extraction still works
      const functions = searchSymbols(db12, repoId, '', { kind: 'function' });
      const classes = searchSymbols(db12, repoId, '', { kind: 'class' });

      expect(functions.length).toBeGreaterThan(0);
      expect(classes.length).toBeGreaterThan(0);
    } finally {
      db12?.close();
      deleteIndex(repoId);
    }
  });
});
