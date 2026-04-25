/**
 * Unit tests for the dependency graph layout algorithms and graph data utilities.
 * Runs in Node — no DOM or React Flow needed.
 */

import { describe, it, expect } from 'vitest';

// ─── Inline layout algorithm (mirrors GraphViewer.tsx logic) ──────────────────

type ApiNode = { id: string; data: { label: string; path: string; symbolCount: number } };
type ApiEdge = { id: string; source: string; target: string; data: { edgeType: string; specifier: string } };

function applyHierarchicalLayout(
  nodes: ApiNode[],
  edges: ApiEdge[],
): Map<string, { x: number; y: number }> {
  const inDegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    adj.get(e.source)?.push(e.target);
  }

  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      level.set(id, 0);
      queue.push(id);
    }
  }
  if (queue.length === 0 && nodes.length > 0) {
    level.set(nodes[0]!.id, 0);
    queue.push(nodes[0]!.id);
  }

  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!;
    const l = level.get(node) ?? 0;
    for (const child of adj.get(node) ?? []) {
      if (!level.has(child)) {
        level.set(child, l + 1);
        queue.push(child);
      }
    }
  }

  const levelNodes = new Map<number, string[]>();
  for (const [id, l] of level) {
    if (!levelNodes.has(l)) levelNodes.set(l, []);
    levelNodes.get(l)!.push(id);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [l, ids] of levelNodes) {
    const totalWidth = ids.length * 180;
    ids.forEach((id, i) => {
      positions.set(id, {
        x: i * 180 - totalWidth / 2,
        y: l * 140,
      });
    });
  }

  let fallbackX = 0;
  for (const n of nodes) {
    if (!positions.has(n.id)) {
      positions.set(n.id, { x: fallbackX, y: 0 });
      fallbackX += 180;
    }
  }

  return positions;
}

function applyRadialLayout(
  nodes: ApiNode[],
  edges: ApiEdge[],
): Map<string, { x: number; y: number }> {
  if (nodes.length === 0) return new Map();

  const degree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const sorted = [...nodes].sort(
    (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0),
  );

  const positions = new Map<string, { x: number; y: number }>();
  const center = sorted[0]!;
  positions.set(center.id, { x: 0, y: 0 });

  const rest = sorted.slice(1);
  const rings = [rest.slice(0, 8), rest.slice(8, 24), rest.slice(24)];
  const radii = [200, 380, 560];

  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]!;
    if (ring.length === 0) continue;
    const radius = radii[r]!;
    ring.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / ring.length;
      positions.set(node.id, {
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle),
      });
    });
  }

  return positions;
}

// ─── Graph server-tool helpers ────────────────────────────────────────────────

/** Mirrors the BFS in get-graph.ts */
function buildAdjacency(edges: ApiEdge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, new Set());
    if (!adj.has(e.target)) adj.set(e.target, new Set());
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
  }
  return adj;
}

function bfsNodes(start: string, adj: Map<string, Set<string>>, depth: number): Set<string> {
  const visited = new Set<string>([start]);
  let frontier = [start];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbor of adj.get(node) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return visited;
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeNode(id: string, symbolCount = 0): ApiNode {
  const label = id.split('/').pop() ?? id;
  return { id, data: { label, path: id, symbolCount } };
}

function makeEdge(source: string, target: string): ApiEdge {
  return {
    id: `${source}→${target}`,
    source,
    target,
    data: { edgeType: 'import', specifier: target },
  };
}

// ─── Tests: hierarchical layout ───────────────────────────────────────────────

describe('applyHierarchicalLayout', () => {
  it('assigns root nodes to level 0', () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
    const edges = [makeEdge('a', 'b'), makeEdge('a', 'c')];
    const positions = applyHierarchicalLayout(nodes, edges);

    expect(positions.get('a')!.y).toBe(0);
    expect(positions.get('b')!.y).toBe(140);
    expect(positions.get('c')!.y).toBe(140);
  });

  it('places every node', () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c'), makeNode('d')];
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'c'), makeEdge('b', 'd')];
    const positions = applyHierarchicalLayout(nodes, edges);
    expect(positions.size).toBe(4);
  });

  it('handles disconnected graph (no edges)', () => {
    const nodes = [makeNode('x'), makeNode('y'), makeNode('z')];
    const positions = applyHierarchicalLayout(nodes, []);
    expect(positions.size).toBe(3);
    // All are roots (in-degree 0), so all at level 0
    for (const pos of positions.values()) {
      expect(pos.y).toBe(0);
    }
  });

  it('handles single node', () => {
    const nodes = [makeNode('sole')];
    const positions = applyHierarchicalLayout(nodes, []);
    expect(positions.get('sole')).toBeDefined();
    expect(positions.get('sole')!.y).toBe(0);
  });

  it('handles cyclic graph without hanging', () => {
    const nodes = [makeNode('a'), makeNode('b')];
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'a')];
    const positions = applyHierarchicalLayout(nodes, edges);
    // Both have in-degree 1, so no natural root — algorithm uses first node as root
    expect(positions.size).toBe(2);
  });
});

// ─── Tests: radial layout ─────────────────────────────────────────────────────

describe('applyRadialLayout', () => {
  it('returns empty map for empty node list', () => {
    expect(applyRadialLayout([], []).size).toBe(0);
  });

  it('places most-connected node at center (0, 0)', () => {
    const nodes = [makeNode('hub'), makeNode('a'), makeNode('b'), makeNode('c')];
    const edges = [
      makeEdge('hub', 'a'),
      makeEdge('hub', 'b'),
      makeEdge('hub', 'c'),
    ];
    const positions = applyRadialLayout(nodes, edges);
    expect(positions.get('hub')).toEqual({ x: 0, y: 0 });
  });

  it('places all nodes', () => {
    const nodes = Array.from({ length: 10 }, (_, i) => makeNode(`node${i}`));
    const edges = nodes.slice(1).map((n) => makeEdge('node0', n.id));
    const positions = applyRadialLayout(nodes, edges);
    expect(positions.size).toBe(10);
  });

  it('places ring-1 nodes within 200-radius band', () => {
    const nodes = [makeNode('center'), makeNode('a'), makeNode('b')];
    const edges = [makeEdge('center', 'a'), makeEdge('center', 'b')];
    const positions = applyRadialLayout(nodes, edges);

    for (const id of ['a', 'b']) {
      const pos = positions.get(id)!;
      const dist = Math.sqrt(pos.x ** 2 + pos.y ** 2);
      expect(dist).toBeCloseTo(200, 0);
    }
  });
});

// ─── Tests: BFS depth filtering ──────────────────────────────────────────────

describe('bfsNodes (depth filter)', () => {
  it('returns only the start node when depth=0', () => {
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'c')];
    const adj = buildAdjacency(edges);
    // depth 0 means the loop runs 0 times, so only start node
    const result = bfsNodes('a', adj, 0);
    expect(result.size).toBe(1);
    expect(result.has('a')).toBe(true);
  });

  it('captures 1-hop neighbors at depth=1', () => {
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'c')];
    const adj = buildAdjacency(edges);
    const result = bfsNodes('a', adj, 1);
    expect(result.has('a')).toBe(true);
    expect(result.has('b')).toBe(true);
    expect(result.has('c')).toBe(false);
  });

  it('captures 2-hop neighbors at depth=2', () => {
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'c'), makeEdge('c', 'd')];
    const adj = buildAdjacency(edges);
    const result = bfsNodes('a', adj, 2);
    expect(result.has('c')).toBe(true);
    expect(result.has('d')).toBe(false);
  });

  it('handles node not in adjacency list', () => {
    const adj = new Map<string, Set<string>>();
    const result = bfsNodes('isolated', adj, 3);
    expect(result.size).toBe(1);
    expect(result.has('isolated')).toBe(true);
  });

  it('handles cyclic graph without infinite loop', () => {
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'c'), makeEdge('c', 'a')];
    const adj = buildAdjacency(edges);
    const result = bfsNodes('a', adj, 10);
    expect(result.size).toBe(3);
  });
});

// ─── Tests: adjacency map ─────────────────────────────────────────────────────

describe('buildAdjacency', () => {
  it('builds bidirectional adjacency from edges', () => {
    const edges = [makeEdge('src/a.ts', 'src/b.ts')];
    const adj = buildAdjacency(edges);
    expect(adj.get('src/a.ts')?.has('src/b.ts')).toBe(true);
    expect(adj.get('src/b.ts')?.has('src/a.ts')).toBe(true);
  });

  it('returns empty map for empty edge list', () => {
    expect(buildAdjacency([]).size).toBe(0);
  });

  it('handles multiple edges from same source', () => {
    const edges = [makeEdge('a', 'b'), makeEdge('a', 'c'), makeEdge('a', 'd')];
    const adj = buildAdjacency(edges);
    expect(adj.get('a')?.size).toBe(3);
  });
});
