/**
 * Pure TypeScript HNSW (Hierarchical Navigable Small World) index.
 *
 * Implements approximate nearest-neighbor search with O(log n) average-case
 * complexity via a layered proximity graph.
 *
 * Reference: Malkov & Yashunin, 2018
 * "Efficient and robust approximate nearest neighbor search using
 *  Hierarchical Navigable Small World graphs"
 *
 * Design notes:
 * - No native addon or WASM dependency — works everywhere Node.js runs.
 * - Cosine distance metric (L2-normalized input vectors recommended).
 * - String IDs mapped to integer labels internally for graph adjacency lists.
 * - Serializes to JSON for persistence (readable, portable).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { PureContextError } from '../core/errors.js';
import { logger } from '../core/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SearchResult {
  id: string;
  distance: number;
}

interface HNSWNode {
  id: string;
  vector: Float32Array;
  /** neighbors[layer] = list of node labels connected at that layer */
  neighbors: number[][];
}

// ─── Priority queue helpers ───────────────────────────────────────────────────

/** Min-heap entry: smallest distance at top. */
interface HeapEntry {
  label: number;
  dist: number;
}

function heapPush(heap: HeapEntry[], entry: HeapEntry): void {
  heap.push(entry);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent].dist <= heap[i].dist) break;
    [heap[parent], heap[i]] = [heap[i], heap[parent]];
    i = parent;
  }
}

function heapPop(heap: HeapEntry[]): HeapEntry {
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < heap.length && heap[l].dist < heap[smallest].dist) smallest = l;
      if (r < heap.length && heap[r].dist < heap[smallest].dist) smallest = r;
      if (smallest === i) break;
      [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
      i = smallest;
    }
  }
  return top;
}

/** Max-heap: largest distance at top — used for the W (working set). */
function maxHeapPush(heap: HeapEntry[], entry: HeapEntry): void {
  heap.push(entry);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent].dist >= heap[i].dist) break;
    [heap[parent], heap[i]] = [heap[i], heap[parent]];
    i = parent;
  }
}

function maxHeapPop(heap: HeapEntry[]): HeapEntry {
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let largest = i;
      if (l < heap.length && heap[l].dist > heap[largest].dist) largest = l;
      if (r < heap.length && heap[r].dist > heap[largest].dist) largest = r;
      if (largest === i) break;
      [heap[i], heap[largest]] = [heap[largest], heap[i]];
      i = largest;
    }
  }
  return top;
}

// ─── Serialization types ──────────────────────────────────────────────────────

interface SerializedIndex {
  version: number;
  dimension: number;
  M: number;
  Mmax0: number;
  efConstruction: number;
  efSearch: number;
  entryPoint: number | null;
  maxLayer: number;
  deletedLabels: number[];
  nodes: Array<{
    id: string;
    vector: number[];
    neighbors: number[][];
  }>;
}

// ─── HNSWIndex ────────────────────────────────────────────────────────────────

/**
 * HNSW approximate nearest-neighbor index.
 *
 * Usage:
 * ```typescript
 * const index = new HNSWIndex(1024, 100_000);
 * index.add(['id1', 'id2'], [vec1, vec2]);
 * const results = index.search(queryVec, 10);
 * index.save('/path/to/hnsw.idx');
 * ```
 */
export class HNSWIndex {
  private readonly M: number;
  /** Max connections at layer 0: 2×M per the paper. */
  private readonly Mmax0: number;
  private readonly efConstruction: number;
  private efSearch: number;

  private nodes: HNSWNode[] = [];
  private readonly idToLabel = new Map<string, number>();
  private readonly deletedLabels = new Set<number>();
  private entryPoint: number | null = null;
  private maxLayer = -1;

  /** Reciprocal of ln(M) — used for random level generation. */
  private readonly mL: number;

  constructor(
    private readonly dimension: number,
    private readonly _maxElements: number,
    M = 16,
    efConstruction = 200,
    efSearch = 100,
  ) {
    this.M = M;
    this.Mmax0 = 2 * M;
    this.efConstruction = efConstruction;
    this.efSearch = efSearch;
    this.mL = 1 / Math.log(M);
  }

  // ─── Distance ──────────────────────────────────────────────────────────────

  /**
   * Cosine distance = 1 - cosine_similarity.
   * For L2-normalized vectors, this equals the inner product distance.
   * Range: [0, 2]. Identical vectors → 0. Opposite vectors → 2.
   */
  private dist(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    const len = a.length;
    // Unrolled by 4 for minor speed gain
    let i = 0;
    for (; i + 3 < len; i += 4) {
      dot += a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2] + a[i + 3] * b[i + 3];
    }
    for (; i < len; i++) dot += a[i] * b[i];
    return 1 - dot;
  }

  // ─── Level generation ──────────────────────────────────────────────────────

  /** Geometric distribution — same formula as the original HNSW paper. */
  private randomLevel(): number {
    return Math.floor(-Math.log(Math.random() + Number.EPSILON) * this.mL);
  }

  // ─── Core search at a single layer ────────────────────────────────────────

  /**
   * Search layer `level` starting from `entryLabel`.
   * Returns up to `ef` nearest labels, sorted nearest-first.
   */
  private searchLayer(
    query: Float32Array,
    entryLabel: number,
    ef: number,
    level: number,
  ): number[] {
    const visited = new Set<number>([entryLabel]);
    const entryDist = this.dist(query, this.nodes[entryLabel].vector);

    // C: candidate min-heap (closest at top)
    const C: HeapEntry[] = [];
    heapPush(C, { label: entryLabel, dist: entryDist });

    // W: result max-heap — keeps ef nearest found so far (farthest at top for easy pruning)
    const W: HeapEntry[] = [];
    maxHeapPush(W, { label: entryLabel, dist: entryDist });

    while (C.length > 0) {
      const c = heapPop(C);

      // If closest candidate is farther than the farthest in W, we're done
      if (W.length >= ef && c.dist > W[0].dist) break;

      const neighbors = this.nodes[c.label].neighbors[level] ?? [];
      for (const n of neighbors) {
        if (visited.has(n)) continue;
        visited.add(n);

        const nDist = this.dist(query, this.nodes[n].vector);
        const farthestInW = W[0]?.dist ?? Infinity;

        if (W.length < ef || nDist < farthestInW) {
          heapPush(C, { label: n, dist: nDist });
          maxHeapPush(W, { label: n, dist: nDist });
          if (W.length > ef) {
            maxHeapPop(W);
          }
        }
      }
    }

    // Sort W nearest-first and return labels
    return W
      .sort((a, b) => a.dist - b.dist)
      .map((e) => e.label);
  }

  // ─── Neighbor selection ────────────────────────────────────────────────────

  /**
   * Select M neighbors from sorted candidates (nearest-first).
   * Simple heuristic: take the M closest.
   */
  private selectNeighbors(candidates: number[], M: number): number[] {
    return candidates.slice(0, M);
  }

  // ─── Insertion ─────────────────────────────────────────────────────────────

  private insertOne(id: string, vector: Float32Array): void {
    if (this.idToLabel.has(id)) {
      logger.debug('HNSWIndex: skipping already-indexed id', { id });
      return;
    }

    const label = this.nodes.length;
    const level = this.randomLevel();

    const node: HNSWNode = {
      id,
      vector,
      neighbors: Array.from({ length: level + 1 }, () => []),
    };
    this.nodes.push(node);
    this.idToLabel.set(id, label);

    if (this.entryPoint === null) {
      this.entryPoint = label;
      this.maxLayer = level;
      return;
    }

    let ep = this.entryPoint;

    // Phase 1: greedy traversal from top layer to level+1 (ef=1)
    for (let lc = this.maxLayer; lc > level; lc--) {
      const results = this.searchLayer(vector, ep, 1, lc);
      ep = results[0] ?? ep;
    }

    // Phase 2: search and connect from min(level, maxLayer) down to 0
    for (let lc = Math.min(level, this.maxLayer); lc >= 0; lc--) {
      const candidates = this.searchLayer(vector, ep, this.efConstruction, lc);
      const Mmax = lc === 0 ? this.Mmax0 : this.M;
      const newNeighbors = this.selectNeighbors(candidates, Mmax).filter((n) => n !== label);

      node.neighbors[lc] = newNeighbors;

      // Bidirectional connection + prune if needed
      for (const n of newNeighbors) {
        if (!this.nodes[n].neighbors[lc]) this.nodes[n].neighbors[lc] = [];
        this.nodes[n].neighbors[lc].push(label);

        if (this.nodes[n].neighbors[lc].length > Mmax) {
          // Prune: keep Mmax closest to n
          const nVec = this.nodes[n].vector;
          this.nodes[n].neighbors[lc] = this.nodes[n].neighbors[lc]
            .map((nb) => ({ nb, d: this.dist(nVec, this.nodes[nb].vector) }))
            .sort((a, b) => a.d - b.d)
            .slice(0, Mmax)
            .map((x) => x.nb);
        }
      }

      ep = candidates[0] ?? ep;
    }

    if (level > this.maxLayer) {
      this.maxLayer = level;
      this.entryPoint = label;
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Insert vectors into the index.
   * `ids` and `vectors` must be the same length.
   */
  add(ids: string[], vectors: Float32Array[]): void {
    if (ids.length !== vectors.length) {
      throw new PureContextError(`HNSWIndex.add: ids.length (${ids.length}) !== vectors.length (${vectors.length})`);
    }
    for (let i = 0; i < ids.length; i++) {
      this.insertOne(ids[i], vectors[i]);
    }
    logger.debug('HNSWIndex: added vectors', { count: ids.length, total: this.size() });
  }

  /**
   * Search for the `k` nearest neighbors of `query`.
   * Returns results sorted by ascending distance (nearest first).
   * Deleted vectors are excluded from results.
   */
  search(query: Float32Array, k: number): SearchResult[] {
    if (this.entryPoint === null || this.nodes.length === 0) return [];
    if (k <= 0) return [];

    let ep = this.entryPoint;

    // Greedy descent to layer 1
    for (let lc = this.maxLayer; lc > 0; lc--) {
      const results = this.searchLayer(query, ep, 1, lc);
      ep = results[0] ?? ep;
    }

    // Search at layer 0
    const ef = Math.max(k, this.efSearch);
    const candidates = this.searchLayer(query, ep, ef, 0);

    const out: SearchResult[] = [];
    for (const label of candidates) {
      if (this.deletedLabels.has(label)) continue;
      out.push({ id: this.nodes[label].id, distance: this.dist(query, this.nodes[label].vector) });
      if (out.length >= k) break;
    }
    return out;
  }

  /**
   * Mark vectors as deleted. Deleted vectors are excluded from search results.
   * Actual storage is reclaimed on `rebuild()`.
   */
  remove(ids: string[]): void {
    for (const id of ids) {
      const label = this.idToLabel.get(id);
      if (label !== undefined) {
        this.deletedLabels.add(label);
        logger.debug('HNSWIndex: marked deleted', { id, label });
      }
    }
  }

  /** Number of live (non-deleted) vectors in the index. */
  size(): number {
    return this.nodes.length - this.deletedLabels.size;
  }

  /**
   * Persist the index to disk as JSON.
   * Path: typically `~/.purecontext/indexes/{repoId}/hnsw.idx`
   */
  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const data: SerializedIndex = {
      version: 1,
      dimension: this.dimension,
      M: this.M,
      Mmax0: this.Mmax0,
      efConstruction: this.efConstruction,
      efSearch: this.efSearch,
      entryPoint: this.entryPoint,
      maxLayer: this.maxLayer,
      deletedLabels: [...this.deletedLabels],
      nodes: this.nodes.map((n) => ({
        id: n.id,
        vector: Array.from(n.vector),
        neighbors: n.neighbors,
      })),
    };
    writeFileSync(path, JSON.stringify(data), 'utf8');
    logger.debug('HNSWIndex: saved to disk', { path, nodes: this.nodes.length });
  }

  /**
   * Load a previously saved index from disk.
   * Replaces all current state.
   */
  load(path: string): void {
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw) as SerializedIndex;

    if (data.version !== 1) {
      throw new PureContextError(`HNSWIndex: unsupported index version ${data.version}`);
    }
    if (data.dimension !== this.dimension) {
      throw new PureContextError(
        `HNSWIndex: dimension mismatch — index has ${data.dimension}, this instance expects ${this.dimension}`,
      );
    }

    this.entryPoint = data.entryPoint;
    this.maxLayer = data.maxLayer;
    this.deletedLabels.clear();
    for (const l of data.deletedLabels) this.deletedLabels.add(l);

    this.nodes = data.nodes.map((n) => ({
      id: n.id,
      vector: new Float32Array(n.vector),
      neighbors: n.neighbors,
    }));

    this.idToLabel.clear();
    for (let label = 0; label < this.nodes.length; label++) {
      this.idToLabel.set(this.nodes[label].id, label);
    }

    logger.debug('HNSWIndex: loaded from disk', { path, nodes: this.nodes.length });
  }
}
