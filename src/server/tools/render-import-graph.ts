/**
 * render-import-graph.ts
 *
 * MCP tool: render_import_graph
 *
 * Render a file-level import graph for a directory as a Mermaid or DOT diagram.
 *
 * Node categories:
 *   - In-scope nodes   — files whose path starts with `filePath` (no special style)
 *   - Boundary nodes   — files OUTSIDE `filePath` that are imported by in-scope files
 *                        (shown with a grey fill so the import boundary is visible)
 *   - External nodes   — npm package specifiers (only when includeExternal: true;
 *                        these are not stored in dep_edges so they are a no-op at
 *                        the moment — the parameter is accepted for API stability)
 *
 * All dep_edges are internal file-to-file edges (external npm imports are dropped
 * at graph-build time in graph-builder.ts). Boundary nodes are detected by
 * comparing `targetFile` against the `filePath` scope prefix.
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getAllDepEdges } from '../../core/db/dep-store.js';
import {
  sanitizeId,
  shortLabel,
  parentDir,
  pruneGraph,
  renderMermaidImportGraph,
  renderDot,
  type GraphNode,
  type GraphEdge,
} from '../../graph/diagram-renderer.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'render_import_graph';

export const description =
  'Render a file-level import graph for a directory as a Mermaid or DOT diagram. ' +
  'Nodes = files, edges = import relationships. Files inside the directory are ' +
  'clustered by subdirectory using Mermaid subgraph blocks. Files outside the ' +
  'directory that are imported by in-scope files appear as grey boundary nodes. ' +
  'Use maxNodes (default 30) to keep large graphs readable. ' +
  'Mermaid output renders natively in GitHub, VS Code, and Claude.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  filePath: z
    .string()
    .describe(
      'Directory path to scope the graph to (relative to repo root). ' +
      'E.g. "src/core/" — only files under this directory are rendered as primary nodes. ' +
      'Files outside this directory that are imported by in-scope files appear as boundary nodes.',
    ),
  includeExternal: z
    .boolean()
    .optional()
    .describe(
      'When true, external npm imports appear as grey terminal nodes. ' +
      'Default false. Note: external imports are not stored in the dep graph, ' +
      'so this option currently has no effect (reserved for future use).',
    ),
  maxNodes: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Maximum number of nodes to include. Least-connected nodes are dropped first. Default 30.'),
  format: z
    .enum(['mermaid', 'dot'])
    .optional()
    .describe('Output format. Default "mermaid".'),
};

// ─── Output type ──────────────────────────────────────────────────────────────

interface RenderImportGraphOutput {
  diagram: string;
  fileCount: number;
  edgeCount: number;
  truncated: boolean;
  _tokenEstimate: number;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  filePath: string;
  includeExternal?: boolean;
  maxNodes?: number;
  format?: 'mermaid' | 'dot';
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    filePath,
    includeExternal = false,
    maxNodes = 30,
    format = 'mermaid',
  } = args;

  const db = openDatabase(repoId);

  try {
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: `Repo "${repoId}" not found. Run index_folder first.` }) },
        ],
        isError: true,
      };
    }

    // Normalise scope prefix — always ends with '/'
    const scopePrefix = filePath.endsWith('/') ? filePath : filePath + '/';

    // Fetch all dep_edges for the repo and filter to edges whose source is in scope.
    const allEdges = getAllDepEdges(db, repoId);
    const sourceEdges = allEdges.filter((e) => e.sourceFile.startsWith(scopePrefix));

    // Classify edges into internal (both endpoints in scope) and boundary
    // (target is an internal file but outside the scope prefix).
    const internalEdges = sourceEdges.filter((e) => e.targetFile.startsWith(scopePrefix));
    const boundaryEdges = sourceEdges.filter((e) => !e.targetFile.startsWith(scopePrefix));

    // Build node set: collect in-scope files from all source edges, then add
    // boundary files from boundary edges.
    const inScopeFiles = new Set<string>();
    for (const e of sourceEdges) {
      inScopeFiles.add(e.sourceFile);
    }
    for (const e of internalEdges) {
      inScopeFiles.add(e.targetFile);
    }

    const boundaryFiles = new Set<string>();
    for (const e of boundaryEdges) {
      boundaryFiles.add(e.targetFile);
    }

    // Build GraphNode array: in-scope nodes clustered by subdirectory, boundary
    // nodes placed in a synthetic 'external' group.
    const nodes: GraphNode[] = [];

    for (const fp of inScopeFiles) {
      nodes.push({
        id: sanitizeId(fp),
        label: shortLabel(fp),
        fullPath: fp,
        group: parentDir(fp),
      });
    }

    for (const fp of boundaryFiles) {
      nodes.push({
        id: sanitizeId(fp),
        label: shortLabel(fp),
        fullPath: fp,
        group: parentDir(fp),
        styleClass: 'boundary',
      });
    }

    // includeExternal: external npm imports are not stored in dep_edges, so
    // this branch intentionally has no effect until a future phase persists them.
    void includeExternal;

    // Deduplicate edges (same source→target pair may appear multiple times).
    const seenEdges = new Set<string>();
    const edges: GraphEdge[] = [];

    for (const e of [...internalEdges, ...boundaryEdges]) {
      const key = `${e.sourceFile}→${e.targetFile}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push({
          source: sanitizeId(e.sourceFile),
          target: sanitizeId(e.targetFile),
        });
      }
    }

    // Apply maxNodes pruning — drops least-connected nodes first.
    const { nodes: prunedNodes, edges: prunedEdges, truncated } = pruneGraph(nodes, edges, maxNodes);

    // Count in-scope files (boundary nodes don't count as "files in graph").
    const fileCount = prunedNodes.filter((n) => !n.styleClass).length;

    // Render.
    let diagram: string;
    if (format === 'dot') {
      diagram = renderDot(prunedNodes, prunedEdges);
    } else {
      diagram = renderMermaidImportGraph(prunedNodes, prunedEdges);
    }

    const output: RenderImportGraphOutput = {
      diagram,
      fileCount,
      edgeCount: prunedEdges.length,
      truncated,
      _tokenEstimate: Math.ceil(diagram.length / 4),
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    };
  } finally {
    db.close();
  }
}
