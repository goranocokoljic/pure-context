/**
 * Phase 102: the shared cycle search (`findCyclesInAdjacency`) is confined to
 * strongly connected components and bounded by a work budget. Found on
 * jenkins as five linked roots: the unpruned simple-path DFS ran for hours
 * on paths that could never close; `core` alone never finished either.
 */
import { describe, it, expect } from 'vitest';
import {
  findCyclesInAdjacency,
  stronglyConnectedComponents,
} from '../../src/graph/graph-traversal.js';

function graph(edges: Array<[string, string]>): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
  }
  for (const v of adj.values()) v.sort();
  return adj;
}

describe('stronglyConnectedComponents', () => {
  it('groups the cycle members and leaves the tail alone', () => {
    const adj = graph([['a', 'b'], ['b', 'c'], ['c', 'a'], ['c', 'd'], ['d', 'e']]);
    const comp = stronglyConnectedComponents(adj);
    expect(comp.get('a')).toBe(comp.get('b'));
    expect(comp.get('b')).toBe(comp.get('c'));
    expect(comp.get('d')).not.toBe(comp.get('a'));
    expect(comp.get('d')).not.toBe(comp.get('e'));
  });
});

describe('findCyclesInAdjacency', () => {
  it('finds each cycle once, rooted at its smallest node, unchanged by the pruning', () => {
    const adj = graph([['a', 'b'], ['b', 'a'], ['b', 'c'], ['c', 'a'], ['c', 'x'], ['x', 'y']]);
    const r = findCyclesInAdjacency(adj);
    expect(r.cycles.map((c) => c.files)).toEqual([['a', 'b'], ['a', 'b', 'c']]);
    expect(r.totalFound).toBe(2);
    expect(r.budgetExhausted).toBeUndefined();
  });

  it('a dense acyclic tail costs nothing: the DFS never leaves the start component', () => {
    // One 2-cycle plus a wide DAG hanging off it. Unpruned, the walk explores
    // every path through the DAG (exponential); pruned, it needs a handful of steps.
    const edges: Array<[string, string]> = [['a', 'b'], ['b', 'a']];
    const layers = 12;
    const width = 6;
    let prev = ['a'];
    for (let l = 0; l < layers; l++) {
      const cur = Array.from({ length: width }, (_, i) => `t${l}_${i}`);
      for (const p of prev) for (const c of cur) edges.push([p, c]);
      prev = cur;
    }
    const r = findCyclesInAdjacency(graph(edges), undefined, 20, 2, 1_000);
    expect(r.cycles.map((c) => c.files)).toEqual([['a', 'b']]);
    expect(r.budgetExhausted).toBeUndefined();
  });

  it('when the budget runs out every cyclic component still reports one cycle and the result says so', () => {
    // Two components: a complete digraph on 9 nodes (exponentially many
    // simple cycles) and a separate 2-cycle the exhausted walk never reaches.
    const edges: Array<[string, string]> = [];
    const k = Array.from({ length: 9 }, (_, i) => `k${i}`);
    for (const a of k) for (const b of k) if (a !== b) edges.push([a, b]);
    edges.push(['z1', 'z2'], ['z2', 'z1']);
    const r = findCyclesInAdjacency(graph(edges), undefined, 500, 2, 2_000);
    expect(r.budgetExhausted).toBe(true);
    const inK = r.cycles.filter((c) => c.files[0]!.startsWith('k'));
    const inZ = r.cycles.filter((c) => c.files[0]!.startsWith('z'));
    expect(inK.length).toBeGreaterThan(0);
    expect(inZ.map((c) => c.files)).toEqual([['z1', 'z2']]);
    // Same graph with a real budget enumerates far more and does not flag.
    const full = findCyclesInAdjacency(graph(edges), undefined, 500, 2);
    expect(full.budgetExhausted).toBeUndefined();
    expect(full.truncated).toBe(true);
    expect(full.totalFound).toBe(501);
  });

  it('filePath scoping still works under the budget', () => {
    const adj = graph([['a', 'b'], ['b', 'a'], ['c', 'd'], ['d', 'c']]);
    expect(findCyclesInAdjacency(adj, 'd').cycles.map((c) => c.files)).toEqual([['c', 'd']]);
  });
});
