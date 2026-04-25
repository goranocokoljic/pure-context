import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { HNSWIndex } from '../../src/semantic/hnsw-index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a random unit vector of given dimension. */
function randomVector(dim: number, seed?: number): Float32Array {
  // Simple deterministic-ish pseudo-random using index seed
  const v = new Float32Array(dim);
  let s = seed ?? Math.random() * 1000;
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

/** Cosine distance between two vectors (reference impl). */
function cosineDist(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return 1 - dot;
}

const DIM = 64;

describe('HNSWIndex', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hnsw-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Basic construction ───────────────────────────────────────────────────

  it('starts empty', () => {
    const idx = new HNSWIndex(DIM, 1000);
    expect(idx.size()).toBe(0);
  });

  it('size() reflects insertions', () => {
    const idx = new HNSWIndex(DIM, 1000);
    const vecs = [randomVector(DIM, 1), randomVector(DIM, 2), randomVector(DIM, 3)];
    idx.add(['a', 'b', 'c'], vecs);
    expect(idx.size()).toBe(3);
  });

  it('search returns empty on empty index', () => {
    const idx = new HNSWIndex(DIM, 1000);
    const results = idx.search(randomVector(DIM), 5);
    expect(results).toHaveLength(0);
  });

  it('search returns empty for k=0', () => {
    const idx = new HNSWIndex(DIM, 1000);
    idx.add(['a'], [randomVector(DIM, 1)]);
    const results = idx.search(randomVector(DIM, 99), 0);
    expect(results).toHaveLength(0);
  });

  // ─── Insertion ────────────────────────────────────────────────────────────

  it('ignores duplicate IDs', () => {
    const idx = new HNSWIndex(DIM, 1000);
    const v = randomVector(DIM, 5);
    idx.add(['x'], [v]);
    idx.add(['x'], [v]); // second call should be a no-op
    expect(idx.size()).toBe(1);
  });

  it('throws if ids and vectors have different lengths', () => {
    const idx = new HNSWIndex(DIM, 1000);
    expect(() => idx.add(['a', 'b'], [randomVector(DIM)])).toThrow();
  });

  // ─── Search correctness ───────────────────────────────────────────────────

  it('identical query vector returns itself as nearest neighbor', () => {
    const idx = new HNSWIndex(DIM, 1000);
    const v1 = randomVector(DIM, 10);
    const v2 = randomVector(DIM, 20);
    idx.add(['id1', 'id2'], [v1, v2]);

    const results = idx.search(v1, 1);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('id1');
    expect(results[0].distance).toBeCloseTo(0, 5);
  });

  it('returns k results when index has ≥ k elements', () => {
    const idx = new HNSWIndex(DIM, 1000);
    const ids: string[] = [];
    const vecs: Float32Array[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(`sym_${i}`);
      vecs.push(randomVector(DIM, i + 1));
    }
    idx.add(ids, vecs);

    const results = idx.search(vecs[0], 5);
    expect(results).toHaveLength(5);
  });

  it('returns fewer than k results when index has < k elements', () => {
    const idx = new HNSWIndex(DIM, 1000);
    idx.add(['a', 'b'], [randomVector(DIM, 1), randomVector(DIM, 2)]);

    const results = idx.search(randomVector(DIM, 99), 10);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('results are sorted nearest-first (ascending distance)', () => {
    const idx = new HNSWIndex(DIM, 1000);
    const ids: string[] = [];
    const vecs: Float32Array[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(`sym_${i}`);
      vecs.push(randomVector(DIM, i * 7 + 3));
    }
    idx.add(ids, vecs);

    const query = vecs[5];
    const results = idx.search(query, 10);

    for (let i = 0; i + 1 < results.length; i++) {
      expect(results[i].distance).toBeLessThanOrEqual(results[i + 1].distance);
    }
  });

  it('distances are approximately correct (within 1% of brute-force)', () => {
    const idx = new HNSWIndex(DIM, 1000);
    const vecs: Float32Array[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      ids.push(`sym_${i}`);
      vecs.push(randomVector(DIM, i * 13 + 7));
    }
    idx.add(ids, vecs);

    const query = vecs[0];
    const hnswResults = idx.search(query, 5);

    // Brute-force nearest neighbor
    const bruteForce = vecs
      .map((v, i) => ({ id: ids[i], dist: cosineDist(query, v) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 5);

    // HNSW nearest should be the same as brute force nearest (for small index)
    expect(hnswResults[0].id).toBe(bruteForce[0].id);
    // Distances should match closely
    expect(hnswResults[0].distance).toBeCloseTo(bruteForce[0].dist, 4);
  });

  // ─── Removal ─────────────────────────────────────────────────────────────

  it('remove() excludes deleted vectors from search', () => {
    const idx = new HNSWIndex(DIM, 1000);
    const v1 = randomVector(DIM, 10);
    const v2 = randomVector(DIM, 20);
    idx.add(['id1', 'id2'], [v1, v2]);

    idx.remove(['id1']);
    expect(idx.size()).toBe(1);

    const results = idx.search(v1, 5);
    const returnedIds = results.map((r) => r.id);
    expect(returnedIds).not.toContain('id1');
  });

  it('remove() is idempotent for unknown IDs', () => {
    const idx = new HNSWIndex(DIM, 1000);
    idx.add(['x'], [randomVector(DIM, 1)]);
    expect(() => idx.remove(['unknown'])).not.toThrow();
    expect(idx.size()).toBe(1);
  });

  it('size() decreases after remove()', () => {
    const idx = new HNSWIndex(DIM, 1000);
    idx.add(['a', 'b', 'c'], [randomVector(DIM, 1), randomVector(DIM, 2), randomVector(DIM, 3)]);
    idx.remove(['a', 'c']);
    expect(idx.size()).toBe(1);
  });

  // ─── Persistence ─────────────────────────────────────────────────────────

  it('save() creates a file', () => {
    const idx = new HNSWIndex(DIM, 1000);
    idx.add(['a'], [randomVector(DIM, 1)]);
    const path = join(tmpDir, 'test.idx');
    idx.save(path);
    expect(existsSync(path)).toBe(true);
  });

  it('load() restores state and produces same search results', () => {
    const vecs: Float32Array[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(`sym_${i}`);
      vecs.push(randomVector(DIM, i * 11 + 1));
    }

    const original = new HNSWIndex(DIM, 1000);
    original.add(ids, vecs);

    const path = join(tmpDir, 'hnsw.idx');
    original.save(path);

    // Load into a fresh instance
    const loaded = new HNSWIndex(DIM, 1000);
    loaded.load(path);

    expect(loaded.size()).toBe(original.size());

    const query = vecs[5];
    const resultsOriginal = original.search(query, 5);
    const resultsLoaded = loaded.search(query, 5);

    // Same top result
    expect(resultsLoaded[0].id).toBe(resultsOriginal[0].id);
  });

  it('load() throws on dimension mismatch', () => {
    const idx = new HNSWIndex(DIM, 1000);
    idx.add(['a'], [randomVector(DIM, 1)]);
    const path = join(tmpDir, 'test.idx');
    idx.save(path);

    const other = new HNSWIndex(DIM + 1, 1000);
    expect(() => other.load(path)).toThrow(/dimension mismatch/);
  });

  it('load() preserves deleted labels', () => {
    const idx = new HNSWIndex(DIM, 1000);
    idx.add(['a', 'b', 'c'], [randomVector(DIM, 1), randomVector(DIM, 2), randomVector(DIM, 3)]);
    idx.remove(['b']);

    const path = join(tmpDir, 'persist.idx');
    idx.save(path);

    const loaded = new HNSWIndex(DIM, 1000);
    loaded.load(path);

    expect(loaded.size()).toBe(2);
    const results = loaded.search(randomVector(DIM, 2), 5);
    expect(results.map((r) => r.id)).not.toContain('b');
  });

  // ─── Incremental updates ──────────────────────────────────────────────────

  it('supports incremental insertion after initial build', () => {
    const idx = new HNSWIndex(DIM, 1000);

    const ids1 = ['a', 'b', 'c'];
    const vecs1 = ids1.map((_, i) => randomVector(DIM, i + 1));
    idx.add(ids1, vecs1);
    expect(idx.size()).toBe(3);

    const ids2 = ['d', 'e'];
    const vecs2 = ids2.map((_, i) => randomVector(DIM, i + 10));
    idx.add(ids2, vecs2);
    expect(idx.size()).toBe(5);

    const results = idx.search(vecs2[0], 3);
    expect(results.length).toBeGreaterThan(0);
  });

  // ─── Large-index smoke test ───────────────────────────────────────────────

  it('handles 1000 vectors with correct nearest-neighbor recall', () => {
    const N = 1000;
    const idx = new HNSWIndex(DIM, N + 100);

    const ids: string[] = [];
    const vecs: Float32Array[] = [];
    for (let i = 0; i < N; i++) {
      ids.push(`sym_${i}`);
      vecs.push(randomVector(DIM, i * 17 + 3));
    }
    idx.add(ids, vecs);
    expect(idx.size()).toBe(N);

    // Query using one of the indexed vectors — it should be the nearest
    const qIdx = 42;
    const results = idx.search(vecs[qIdx], 5);
    expect(results[0].id).toBe(`sym_${qIdx}`);
    expect(results[0].distance).toBeCloseTo(0, 4);
  });

  it('search is faster than O(n) for large index (smoke test)', () => {
    // This is a sanity check — HNSW should complete 1k-vector search well under 50ms
    const N = 1000;
    const idx = new HNSWIndex(DIM, N + 100);
    const ids = Array.from({ length: N }, (_, i) => `s${i}`);
    const vecs = ids.map((_, i) => randomVector(DIM, i * 7 + 1));
    idx.add(ids, vecs);

    const query = randomVector(DIM, 99999);
    const start = Date.now();
    idx.search(query, 10);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500); // generous ceiling for CI
  });
});
