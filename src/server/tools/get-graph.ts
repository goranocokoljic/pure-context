import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { getAllDepEdges, getCrossDepEdges } from '../../core/db/dep-store.js';
import { getRepoLinks } from '../../core/db/link-store.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DepEdge } from '../../core/types.js';

export const name = 'get_graph';

export const description =
  'Return the dependency graph for a repository as nodes and edges. ' +
  'Nodes represent files; edges represent import relationships. ' +
  'Optionally focus on a specific file and limit traversal depth. ' +
  'Edges into LINKED indexes (since 1.32.0) appear with target nodes named `<linkedRepoId>:<path>` ' +
  'and `data.repoId` set; `links` lists those indexes.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  filePath: z
    .string()
    .optional()
    .describe('Focus file (relative to repo root). When set, only nodes within `depth` hops are returned.'),
  depth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .default(3)
    .describe('Max hops from focus file (1–10). Only used when filePath is set.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .default(200)
    .describe('Maximum number of nodes to return (1–500).'),
};

// ─── Graph types ──────────────────────────────────────────────────────────────

export interface GraphNodeData {
  label: string;
  path: string;
  symbolCount: number;
  /** Phase 99: set on nodes that live in a LINKED index. */
  repoId?: string;
}

export interface GraphNode {
  id: string;
  data: GraphNodeData;
}

export interface GraphEdgeData {
  edgeType: string;
  specifier: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  data: GraphEdgeData;
}

export interface GraphResponse {
  repoId: string;
  nodeCount: number;
  edgeCount: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── BFS helpers ──────────────────────────────────────────────────────────────

function buildAdjacency(edges: DepEdge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!adj.has(e.sourceFile)) adj.set(e.sourceFile, new Set());
    if (!adj.has(e.targetFile)) adj.set(e.targetFile, new Set());
    adj.get(e.sourceFile)!.add(e.targetFile);
    adj.get(e.targetFile)!.add(e.sourceFile); // bidirectional for reachability
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

// ─── Handler ──────────────────────────────────────────────────────────────────

export function handler(args: {
  repoId: string;
  filePath?: string;
  depth?: number;
  limit?: number;
}): CallToolResult {
  const t0 = Date.now();
  const depth = args.depth ?? 3;
  const limit = args.limit ?? 200;

  const db = openDatabase(args.repoId);
  // Phase 99: cross edges join the graph with the target renamed to
  // `<repoId>:<path>` so it never collides with a local path.
  const links = getRepoLinks(db, args.repoId).map((l) => ({ repoId: l.linkedRepoId, rootPath: l.linkedRootPath }));
  const crossNodes = new Map<string, string>(); // node id → owning repo id
  const allEdges: DepEdge[] = [
    ...getAllDepEdges(db, args.repoId),
    ...getCrossDepEdges(db, args.repoId).map((e) => {
      const id = `${e.targetRepoId}:${e.targetFile}`;
      crossNodes.set(id, e.targetRepoId!);
      return { ...e, targetFile: id };
    }),
  ];

  // Build per-file symbol counts from dep edges (approximation using distinct files)
  const symbolCountMap = new Map<string, number>();
  try {
    const rows = db
      .prepare<[string], { file_path: string; cnt: number }>(
        'SELECT file_path, COUNT(*) as cnt FROM symbols WHERE repo_id = ? GROUP BY file_path',
      )
      .all(args.repoId);
    for (const row of rows) {
      symbolCountMap.set(row.file_path, row.cnt);
    }
  } catch {
    // symbols table may be empty — continue without counts
  }

  db.close();

  // Determine which files are in scope
  let scopedFiles: Set<string> | null = null;
  if (args.filePath) {
    const adj = buildAdjacency(allEdges);
    scopedFiles = bfsNodes(args.filePath, adj, depth);
  }

  // Filter edges to scope
  const scopedEdges = scopedFiles
    ? allEdges.filter(
        (e) => scopedFiles!.has(e.sourceFile) && scopedFiles!.has(e.targetFile),
      )
    : allEdges;

  // Collect unique file nodes from edges
  const fileSet = new Set<string>();
  for (const e of scopedEdges) {
    fileSet.add(e.sourceFile);
    fileSet.add(e.targetFile);
  }
  // Also include the focus file itself (might be isolated)
  if (args.filePath) fileSet.add(args.filePath);

  // Apply node limit (prefer files with more edges — keep most connected)
  const fileDegrees = new Map<string, number>();
  for (const e of scopedEdges) {
    fileDegrees.set(e.sourceFile, (fileDegrees.get(e.sourceFile) ?? 0) + 1);
    fileDegrees.set(e.targetFile, (fileDegrees.get(e.targetFile) ?? 0) + 1);
  }

  let sortedFiles = [...fileSet].sort(
    (a, b) => (fileDegrees.get(b) ?? 0) - (fileDegrees.get(a) ?? 0),
  );
  const truncated = sortedFiles.length > limit;
  if (truncated) {
    // Always keep focus file
    if (args.filePath) {
      sortedFiles = [
        args.filePath,
        ...sortedFiles.filter((f) => f !== args.filePath).slice(0, limit - 1),
      ];
    } else {
      sortedFiles = sortedFiles.slice(0, limit);
    }
  }

  const keptFiles = new Set(sortedFiles);

  // Build nodes
  const nodes: GraphNode[] = sortedFiles.map((filePath) => {
    const linkedRepo = crossNodes.get(filePath);
    const path = linkedRepo ? filePath.slice(linkedRepo.length + 1) : filePath;
    return {
      id: filePath,
      data: {
        label: basename(path),
        path,
        symbolCount: symbolCountMap.get(filePath) ?? 0,
        ...(linkedRepo ? { repoId: linkedRepo } : {}),
      },
    };
  });

  // Build edges (only between kept nodes, deduplicate)
  const edgeIds = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const e of scopedEdges) {
    if (!keptFiles.has(e.sourceFile) || !keptFiles.has(e.targetFile)) continue;
    const edgeId = `${e.sourceFile}→${e.targetFile}`;
    if (edgeIds.has(edgeId)) continue;
    edgeIds.add(edgeId);
    edges.push({
      id: edgeId,
      source: e.sourceFile,
      target: e.targetFile,
      data: { edgeType: e.edgeType, specifier: e.specifier },
    });
  }

  const response: GraphResponse = {
    repoId: args.repoId,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
    truncated,
    _meta: buildMeta({ timingMs: Date.now() - t0 }),
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
  };
}
