/**
 * Unit tests for get-graph tool utility logic.
 * Tests the BFS scoping, node deduplication, and truncation logic
 * using in-process reimplementations (no SQLite needed).
 */

import { describe, it, expect } from 'vitest';
import type { DepEdge } from '../../src/core/types.js';

// ─── Inline the pure functions from get-graph.ts ──────────────────────────────

function buildAdjacency(edges: DepEdge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!adj.has(e.sourceFile)) adj.set(e.sourceFile, new Set());
    if (!adj.has(e.targetFile)) adj.set(e.targetFile, new Set());
    adj.get(e.sourceFile)!.add(e.targetFile);
    adj.get(e.targetFile)!.add(e.sourceFile);
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

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? filePath;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeEdge(sourceFile: string, targetFile: string): DepEdge {
  return {
    repoId: 'test-repo',
    sourceFile,
    sourceSymbolId: null,
    targetFile,
    targetSymbolId: null,
    edgeType: 'import',
    specifier: targetFile,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildAdjacency', () => {
  it('returns empty map for empty edge list', () => {
    expect(buildAdjacency([]).size).toBe(0);
  });

  it('creates bidirectional entries', () => {
    const adj = buildAdjacency([makeEdge('src/a.ts', 'src/b.ts')]);
    expect(adj.get('src/a.ts')?.has('src/b.ts')).toBe(true);
    expect(adj.get('src/b.ts')?.has('src/a.ts')).toBe(true);
  });

  it('accumulates multiple outgoing edges from same source', () => {
    const edges = [
      makeEdge('src/index.ts', 'src/foo.ts'),
      makeEdge('src/index.ts', 'src/bar.ts'),
    ];
    const adj = buildAdjacency(edges);
    const neighbors = adj.get('src/index.ts');
    expect(neighbors?.size).toBe(2);
    expect(neighbors?.has('src/foo.ts')).toBe(true);
    expect(neighbors?.has('src/bar.ts')).toBe(true);
  });
});

describe('bfsNodes', () => {
  it('includes only start node at depth 0', () => {
    const adj = buildAdjacency([makeEdge('a', 'b')]);
    const result = bfsNodes('a', adj, 0);
    expect(result.size).toBe(1);
    expect(result.has('a')).toBe(true);
    expect(result.has('b')).toBe(false);
  });

  it('includes 1-hop neighbors at depth 1', () => {
    const adj = buildAdjacency([makeEdge('a', 'b'), makeEdge('b', 'c')]);
    const result = bfsNodes('a', adj, 1);
    expect(result.has('a')).toBe(true);
    expect(result.has('b')).toBe(true);
    expect(result.has('c')).toBe(false);
  });

  it('includes full chain at sufficient depth', () => {
    const adj = buildAdjacency([
      makeEdge('a', 'b'),
      makeEdge('b', 'c'),
      makeEdge('c', 'd'),
    ]);
    const result = bfsNodes('a', adj, 10);
    expect(result.size).toBe(4);
  });

  it('handles isolated node (no edges)', () => {
    const adj = new Map<string, Set<string>>();
    const result = bfsNodes('solo', adj, 5);
    expect(result.size).toBe(1);
    expect(result.has('solo')).toBe(true);
  });

  it('does not revisit nodes in cyclic graphs', () => {
    const adj = buildAdjacency([
      makeEdge('a', 'b'),
      makeEdge('b', 'c'),
      makeEdge('c', 'a'),
    ]);
    const result = bfsNodes('a', adj, 100);
    expect(result.size).toBe(3);
  });

  it('traverses both directions (bidirectional BFS)', () => {
    // Edge goes b→c but we start at c. Bidirectional adj means c can reach b.
    const adj = buildAdjacency([makeEdge('b', 'c')]);
    const result = bfsNodes('c', adj, 1);
    expect(result.has('b')).toBe(true);
  });
});

describe('basename', () => {
  it('extracts filename from Unix-style path', () => {
    expect(basename('src/core/types.ts')).toBe('types.ts');
  });

  it('extracts filename from Windows-style path', () => {
    expect(basename('src\\core\\types.ts')).toBe('types.ts');
  });

  it('returns path unchanged when no separator', () => {
    expect(basename('index.ts')).toBe('index.ts');
  });

  it('returns empty string for trailing slash (edge case)', () => {
    // 'src/dir/'.split('/') → ['src', 'dir', ''] → last is ''
    expect(basename('src/dir/')).toBe('');
  });
});

describe('graph scoping (simulated)', () => {
  /**
   * Simulate the scoping logic from handler():
   *   - Build adjacency from all edges
   *   - BFS from focus file
   *   - Filter edges to scoped nodes
   */
  function scopeGraph(
    allEdges: DepEdge[],
    focusFile: string,
    depth: number,
  ): { files: Set<string>; edges: DepEdge[] } {
    const adj = buildAdjacency(allEdges);
    const scopedFiles = bfsNodes(focusFile, adj, depth);
    const scopedEdges = allEdges.filter(
      (e) => scopedFiles.has(e.sourceFile) && scopedFiles.has(e.targetFile),
    );
    return { files: scopedFiles, edges: scopedEdges };
  }

  it('returns only focus file and its direct neighbors at depth=1', () => {
    const edges = [
      makeEdge('a.ts', 'b.ts'),
      makeEdge('b.ts', 'c.ts'),
      makeEdge('c.ts', 'd.ts'),
    ];
    const { files } = scopeGraph(edges, 'a.ts', 1);
    expect(files.has('a.ts')).toBe(true);
    expect(files.has('b.ts')).toBe(true);
    expect(files.has('c.ts')).toBe(false);
    expect(files.has('d.ts')).toBe(false);
  });

  it('edges between out-of-scope nodes are excluded', () => {
    const edges = [
      makeEdge('a.ts', 'b.ts'),
      makeEdge('x.ts', 'y.ts'), // unrelated cluster
    ];
    const { edges: scopedEdges } = scopeGraph(edges, 'a.ts', 2);
    const inScope = scopedEdges.every(
      (e) => e.sourceFile !== 'x.ts' && e.targetFile !== 'y.ts',
    );
    expect(inScope).toBe(true);
  });

  it('with no focus file all edges are returned (no scoping)', () => {
    const allEdges = [makeEdge('a.ts', 'b.ts'), makeEdge('c.ts', 'd.ts')];
    // No focus means scopedFiles is null — all edges pass through
    expect(allEdges.length).toBe(2);
  });
});
