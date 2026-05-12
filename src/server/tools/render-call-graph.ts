/**
 * render-call-graph.ts
 *
 * MCP tool: render_call_graph
 *
 * Render a call graph rooted at a symbol as a Mermaid flowchart or DOT diagram,
 * showing callers and/or callees N levels deep.
 *
 * Builds on `buildCallHierarchy` from Task 174 and the shared rendering functions
 * from diagram-renderer.ts. The root node is styled with a distinct orange fill.
 * Cyclic edges (recursive calls) are rendered as dashed arrows.
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { buildCallHierarchy } from '../../graph/graph-traversal.js';
import {
  sanitizeId,
  shortLabel,
  parentDir,
  pruneGraph,
  renderMermaidCallGraph,
  renderDot,
  type GraphNode,
  type GraphEdge,
} from '../../graph/diagram-renderer.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CallNode } from '../../graph/graph-traversal.js';

export const name = 'render_call_graph';

export const description =
  'Render a call graph rooted at a symbol as a Mermaid flowchart or DOT diagram. ' +
  'Shows callers and/or callees N levels deep. ' +
  'The root node is styled distinctly. Recursive/cyclic calls are shown as dashed arrows. ' +
  'Use direction="callees" to see what a function calls, "callers" to see what calls it, ' +
  'or "both" for a bidirectional view. ' +
  'Use search_symbols to find the symbolId first. ' +
  'Mermaid output renders natively in GitHub, VS Code, and Claude.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  symbolId: z
    .string()
    .describe('Symbol ID of the root function or method. Use search_symbols to find it.'),
  direction: z
    .enum(['callers', 'callees', 'both'])
    .optional()
    .describe(
      '"callees" — what this function calls (forward); ' +
      '"callers" — what calls this function (reverse); ' +
      '"both" — bidirectional (default)',
    ),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(6)
    .optional()
    .describe('Maximum depth to traverse. Default 3.'),
  maxNodes: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Maximum number of nodes to include. Least-connected nodes are dropped first. Default 25.'),
  format: z
    .enum(['mermaid', 'dot'])
    .optional()
    .describe('Output format. Default "mermaid".'),
};

// ─── Output type ──────────────────────────────────────────────────────────────

interface RenderCallGraphOutput {
  diagram: string;
  rootSymbol: string;
  nodeCount: number;
  truncated: boolean;
  _tokenEstimate: number;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  symbolId: string;
  direction?: 'callers' | 'callees' | 'both';
  maxDepth?: number;
  maxNodes?: number;
  format?: 'mermaid' | 'dot';
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    symbolId,
    direction = 'both',
    maxDepth = 3,
    maxNodes = 25,
    format = 'mermaid',
  } = args;

  const db = openDatabase(repoId);

  try {
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Repo "${repoId}" not found. Run index_folder first.`,
            }),
          },
        ],
        isError: true,
      };
    }

    // Request more nodes than needed from the traversal so client-side pruning
    // has sufficient candidates. Cap at 500 to avoid excessive work.
    const traversalLimit = Math.min(500, Math.max(50, maxNodes * 10));
    const result = buildCallHierarchy(symbolId, repoId, db, direction, maxDepth, traversalLimit);
    if (!result) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Symbol "${symbolId}" not found in repo "${repoId}".`,
            }),
          },
        ],
        isError: true,
      };
    }

    const { nodes: rawNodes, edges: rawEdges } = flattenCallTree(result.root, symbolId, direction);

    // Apply maxNodes pruning (keep the root always)
    const { nodes: prunedNodes, edges: prunedEdges, truncated } = pruneGraphKeepingRoot(
      rawNodes,
      rawEdges,
      maxNodes,
      sanitizeId(symbolId),
    );

    const rootNode = prunedNodes.find((n) => n.styleClass === 'root');
    const rootId = rootNode?.id ?? (prunedNodes[0]?.id ?? '');
    const rootSymbolName = rootNode?.label ?? symbolId;

    let diagram: string;
    if (format === 'dot') {
      diagram = renderDot(prunedNodes, prunedEdges);
    } else {
      diagram = renderMermaidCallGraph(prunedNodes, prunedEdges, rootId);
    }

    const output: RenderCallGraphOutput = {
      diagram,
      rootSymbol: rootSymbolName,
      nodeCount: prunedNodes.length,
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

// ─── Call tree flattener ──────────────────────────────────────────────────────

/**
 * Flatten the call hierarchy tree into nodes + edges for rendering.
 *
 * For 'callees': parent → child edges (root calls children)
 * For 'callers': child → parent edges (children call root)
 * For 'both':   mixed — the tree from buildCallHierarchy already encodes direction
 *               via the structure (callers appear as children of root with depth < 0
 *               conceptually, but the tree structure is consistent regardless)
 */
function flattenCallTree(
  root: CallNode,
  rootSymbolId: string,
  direction: 'callers' | 'callees' | 'both',
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodeMap = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const visited = new Set<string>();

  function walk(node: CallNode, parentId: string | null): void {
    const nodeId = sanitizeId(node.symbolId);
    const isRoot = node.symbolId === rootSymbolId;

    if (!nodeMap.has(nodeId)) {
      nodeMap.set(nodeId, {
        id: nodeId,
        label: `${node.name}\n${shortLabel(node.filePath)}`,
        fullPath: node.filePath,
        group: parentDir(node.filePath),
        styleClass: isRoot ? 'root' : undefined,
      });
    }

    if (parentId !== null) {
      const edgeKey = `${parentId}→${nodeId}`;
      if (!visited.has(edgeKey)) {
        visited.add(edgeKey);
        // Direction determines arrow direction:
        // For 'callers': parentId is the caller, nodeId is closer to root → reverse arrow
        // For 'callees': parentId is the callee's parent (root side), nodeId is callee
        // For 'both': use the tree structure as-is (parent → child)
        if (direction === 'callers') {
          // In callers direction: children are callers of their parent
          // So the edge is: child (caller) → parent (callee)
          edges.push({
            source: nodeId,
            target: parentId,
            dashed: node.cyclic,
          });
        } else {
          // callees or both: parent → child
          edges.push({
            source: parentId,
            target: nodeId,
            dashed: node.cyclic,
          });
        }
      }
    }

    if (!node.cyclic) {
      for (const child of node.children) {
        walk(child, nodeId);
      }
    }
  }

  walk(root, null);
  return { nodes: Array.from(nodeMap.values()), edges };
}

// ─── Pruning with root preservation ──────────────────────────────────────────

/**
 * Like pruneGraph but guarantees the root node is always retained.
 */
function pruneGraphKeepingRoot(
  nodes: GraphNode[],
  edges: GraphEdge[],
  maxNodes: number,
  rootId: string,
): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
  if (nodes.length <= maxNodes) {
    return { nodes, edges, truncated: false };
  }

  // Compute degree
  const degree = new Map<string, number>();
  for (const n of nodes) degree.set(n.id, 0);
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  // Always keep the root; sort rest by degree descending
  const nonRoot = nodes.filter((n) => n.id !== rootId);
  const rootNode = nodes.find((n) => n.id === rootId);

  const sorted = [...nonRoot].sort((a, b) => {
    const diff = (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });

  const slots = maxNodes - (rootNode ? 1 : 0);
  const kept = new Set(sorted.slice(0, slots).map((n) => n.id));
  if (rootNode) kept.add(rootId);

  const prunedNodes = nodes.filter((n) => kept.has(n.id));
  const prunedEdges = edges.filter((e) => kept.has(e.source) && kept.has(e.target));

  return { nodes: prunedNodes, edges: prunedEdges, truncated: true };
}
