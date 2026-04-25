import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { VectorStore } from '../../src/semantic/vector-store.js';
import type { EmbeddingProvider } from '../../src/semantic/embedding-provider.js';
import type { SymbolRecord } from '../../src/core/types.js';
import { openInMemoryDatabase } from '../../src/core/db/schema.js';
import type Database from 'better-sqlite3';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

const DIM = 32;

/**
 * Mock embedding provider.
 * Returns a deterministic vector derived from the text's charCode sum as seed.
 * Texts starting with the same prefix get similar vectors.
 */
class MockProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly dimension = DIM;
  readonly maxTokens = 512;
  embedCallCount = 0;

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCallCount++;
    return texts.map((t) => {
      const seed = t.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
      return seedVec(DIM, seed);
    });
  }
}

function makeDb(): Database.Database {
  return openInMemoryDatabase();
}

function insertRepo(db: Database.Database, repoId: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO repos (id, root_path, symbol_count, file_count, languages, indexed_at, schema_version)
    VALUES (?, ?, 0, 0, '[]', 0, 2)
  `).run(repoId, `/test/${repoId}`);
}

function insertSymbol(db: Database.Database, repoId: string, symbolId: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO symbols (id, repo_id, name, kind, file_path, start_byte, end_byte, signature, summary, indexed_at)
    VALUES (?, ?, 'fn', 'function', 'src/a.ts', 0, 50, 'function fn()', '', 0)
  `).run(symbolId, repoId);
}

function makeSymbol(id: string, name: string, signature = ''): SymbolRecord {
  return {
    id,
    name,
    kind: 'function',
    filePath: 'src/test.ts',
    startByte: 0,
    endByte: 100,
    signature: signature || `function ${name}()`,
    summary: `Does ${name}`,
  };
}

describe('VectorStore', () => {
  let db: Database.Database;
  let provider: MockProvider;
  let tmpDir: string;
  const REPO = 'repo_test';

  beforeEach(() => {
    db = makeDb();
    provider = new MockProvider();
    tmpDir = mkdtempSync(join(tmpdir(), 'vs-test-'));
    insertRepo(db, REPO);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeStore(repoId = REPO): VectorStore {
    return new VectorStore(repoId, provider, db, { indexDir: tmpDir });
  }

  // ─── indexSymbols ─────────────────────────────────────────────────────────

  it('indexSymbols: embeds and stores symbols', async () => {
    const store = makeStore();
    insertSymbol(db, REPO, 'sym1');
    insertSymbol(db, REPO, 'sym2');

    const symbols = [makeSymbol('sym1', 'foo'), makeSymbol('sym2', 'bar')];
    await store.indexSymbols(symbols);

    expect(store.size).toBe(2);
    expect(provider.embedCallCount).toBe(1);
  });

  it('indexSymbols: no-op for empty array', async () => {
    const store = makeStore();
    await store.indexSymbols([]);
    expect(store.size).toBe(0);
    expect(provider.embedCallCount).toBe(0);
  });

  it('indexSymbols: persists embeddings to SQLite', async () => {
    const store = makeStore();
    insertSymbol(db, REPO, 'sym1');

    await store.indexSymbols([makeSymbol('sym1', 'authenticate')]);

    // Verify directly in SQLite
    const row = db.prepare(
      'SELECT dimension, provider FROM embeddings WHERE symbol_id = ?',
    ).get('sym1') as { dimension: number; provider: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.dimension).toBe(DIM);
    expect(row!.provider).toBe('mock');
  });

  // ─── searchSimilar ────────────────────────────────────────────────────────

  it('searchSimilar: returns empty array on empty store', async () => {
    const store = makeStore();
    const results = await store.searchSimilar('find authentication', 5);
    expect(results).toHaveLength(0);
  });

  it('searchSimilar: returns k results', async () => {
    const store = makeStore();
    const ids = ['s1', 's2', 's3', 's4', 's5'];
    ids.forEach((id) => insertSymbol(db, REPO, id));
    await store.indexSymbols(ids.map((id, i) => makeSymbol(id, `func${i}`)));

    const results = await store.searchSimilar('some query', 3);
    expect(results.length).toBeLessThanOrEqual(3);
    expect(results.length).toBeGreaterThan(0);
  });

  it('searchSimilar: results sorted nearest-first', async () => {
    const store = makeStore();
    const ids = ['a', 'b', 'c', 'd'];
    ids.forEach((id) => insertSymbol(db, REPO, id));
    await store.indexSymbols(ids.map((id) => makeSymbol(id, id)));

    const results = await store.searchSimilar('query text', 4);
    for (let i = 0; i + 1 < results.length; i++) {
      expect(results[i].distance).toBeLessThanOrEqual(results[i + 1].distance);
    }
  });

  it('searchSimilar: returns id and distance fields', async () => {
    const store = makeStore();
    insertSymbol(db, REPO, 'sym1');
    await store.indexSymbols([makeSymbol('sym1', 'doWork')]);

    const results = await store.searchSimilar('work', 1);
    expect(results[0]).toHaveProperty('id');
    expect(results[0]).toHaveProperty('distance');
    expect(typeof results[0].id).toBe('string');
    expect(typeof results[0].distance).toBe('number');
  });

  // ─── removeSymbols ────────────────────────────────────────────────────────

  it('removeSymbols: excluded from search after removal', async () => {
    const store = makeStore();
    insertSymbol(db, REPO, 'sym1');
    insertSymbol(db, REPO, 'sym2');
    await store.indexSymbols([makeSymbol('sym1', 'alpha'), makeSymbol('sym2', 'beta')]);

    store.removeSymbols(['sym1']);
    expect(store.size).toBe(1);

    const results = await store.searchSimilar('anything', 5);
    expect(results.map((r) => r.id)).not.toContain('sym1');
  });

  it('removeSymbols: deletes from SQLite embeddings', async () => {
    const store = makeStore();
    insertSymbol(db, REPO, 'sym1');
    await store.indexSymbols([makeSymbol('sym1', 'doThing')]);

    store.removeSymbols(['sym1']);

    const row = db.prepare('SELECT 1 FROM embeddings WHERE symbol_id = ?').get('sym1');
    expect(row).toBeUndefined();
  });

  it('removeSymbols: no-op for unknown ids', async () => {
    const store = makeStore();
    insertSymbol(db, REPO, 'sym1');
    await store.indexSymbols([makeSymbol('sym1', 'doThing')]);

    expect(() => store.removeSymbols(['nonexistent'])).not.toThrow();
    expect(store.size).toBe(1);
  });

  // ─── rebuild ─────────────────────────────────────────────────────────────

  it('rebuild: reconstructs HNSW from SQLite embeddings', async () => {
    const store = makeStore();
    insertSymbol(db, REPO, 'sym1');
    insertSymbol(db, REPO, 'sym2');
    await store.indexSymbols([makeSymbol('sym1', 'funcA'), makeSymbol('sym2', 'funcB')]);

    // Create a fresh store with the same DB (simulating restart)
    const store2 = makeStore();
    expect(store2.size).toBe(0); // starts empty

    await store2.rebuild();
    expect(store2.size).toBe(2);

    // Should produce search results without calling provider again
    const prevCalls = provider.embedCallCount;
    const results = await store2.searchSimilar('query', 2);
    // provider.embed IS called for the query itself
    expect(results).toHaveLength(2);
    expect(provider.embedCallCount).toBe(prevCalls + 1); // only for query embedding
  });

  it('rebuild: no-op when SQLite is empty', async () => {
    const store = makeStore();
    await store.rebuild();
    expect(store.size).toBe(0);
  });

  // ─── save / load index ────────────────────────────────────────────────────

  it('saveIndex + loadIndex: persists and restores from disk', async () => {
    const store = makeStore();
    insertSymbol(db, REPO, 'sym1');
    await store.indexSymbols([makeSymbol('sym1', 'process')]);
    store.saveIndex();

    const idxFile = join(tmpDir, 'hnsw.idx');
    expect(existsSync(idxFile)).toBe(true);

    const store2 = makeStore();
    const loaded = store2.loadIndex();
    expect(loaded).toBe(true);
    expect(store2.size).toBe(1);
  });

  it('loadIndex: returns false when no file exists', () => {
    const store = makeStore();
    const loaded = store.loadIndex();
    expect(loaded).toBe(false);
    expect(store.size).toBe(0);
  });

  // ─── fullReindex ─────────────────────────────────────────────────────────

  it('fullReindex: clears old embeddings and rebuilds', async () => {
    const store = makeStore();
    insertSymbol(db, REPO, 'old1');
    insertSymbol(db, REPO, 'new1');
    await store.indexSymbols([makeSymbol('old1', 'oldFunc')]);
    expect(store.size).toBe(1);

    await store.fullReindex([makeSymbol('new1', 'newFunc')]);
    expect(store.size).toBe(1);

    // old1 embedding should be gone from SQLite
    const row = db.prepare('SELECT 1 FROM embeddings WHERE symbol_id = ?').get('old1');
    expect(row).toBeUndefined();
  });
});
