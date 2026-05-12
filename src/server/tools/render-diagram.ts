/**
 * render-diagram.ts
 *
 * MCP tool: render_diagram
 *
 * Generate a Mermaid or DOT diagram from the dependency graph for a file,
 * directory, or the whole repo. The primary general-purpose visualization tool —
 * specialized variants (render_call_graph, render_class_hierarchy, etc.) build
 * on this foundation.
 *
 * Diagram types:
 *   'module'  — file-level import graph, nodes = files, clustered by directory
 *   'call'    — call graph rooted at rootSymbolId (requires Task 174 data)
 *   'class'   — class inheritance rooted at rootSymbolId (requires Task 175 data)
 *   'import'  — alias for 'module' at the symbol level (same DB, different label)
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getAllDepEdges } from '../../core/db/dep-store.js';
import { buildCallHierarchy, buildClassHierarchy } from '../../graph/graph-traversal.js';
import {
  sanitizeId,
  shortLabel,
  parentDir,
  pruneGraph,
  renderMermaidModule,
  renderMermaidCallGraph,
  renderMermaidClassDiagram,
  renderDot,
  type GraphNode,
  type GraphEdge,
} from '../../graph/diagram-renderer.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CallNode, HierarchyNode } from '../../graph/graph-traversal.js';

export const name = 'render_diagram';

export const description =
  'Generate a Mermaid or DOT diagram from the indexed dependency graph. ' +
  'Use type "module" for a file-level import graph of the whole repo or a directory. ' +
  'Use type "call" with rootSymbolId for a call hierarchy flowchart. ' +
  'Use type "class" with rootSymbolId for a class inheritance classDiagram. ' +
  'Use type "import" for the same as "module" (alias). ' +
  'Mermaid output renders natively in GitHub, VS Code, and Claude. ' +
  'maxNodes (default 30) and maxDepth (default 3) prevent oversized diagrams.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  type: z
    .enum(['module', 'call', 'class', 'import'])
    .describe(
      '"module"/"import" — file-level import graph; ' +
      '"call" — call graph (requires rootSymbolId); ' +
      '"class" — class hierarchy (requires rootSymbolId)',
    ),
  rootSymbolId: z
    .string()
    .optional()
    .describe('Anchor symbol ID for call/class diagrams. Required for type "call" and "class".'),
  filePath: z
    .string()
    .optional()
    .describe(
      'Scope the diagram to a directory or file prefix (relative to repo root). ' +
      'E.g. "src/core/" restricts the module diagram to that directory.',
    ),
  maxNodes: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Maximum number of nodes to include. Least-connected nodes are dropped first. Default 30.'),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Maximum traversal depth for call/class diagrams. Default 3.'),
  format: z
    .enum(['mermaid', 'dot'])
    .optional()
    .describe('Output format. Default "mermaid".'),
};

// ─── Output type ──────────────────────────────────────────────────────────────

interface RenderDiagramOutput {
  diagram: string;
  format: 'mermaid' | 'dot';
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
  _tokenEstimate: number;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  type: 'module' | 'call' | 'class' | 'import';
  rootSymbolId?: string;
  filePath?: string;
  maxNodes?: number;
  maxDepth?: number;
  format?: 'mermaid' | 'dot';
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    type,
    rootSymbolId,
    filePath,
    maxNodes = 30,
    maxDepth = 3,
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

    let nodes: GraphNode[];
    let edges: GraphEdge[];

    if (type === 'module' || type === 'import') {
      ({ nodes, edges } = buildModuleGraph(repoId, db, filePath));
    } else if (type === 'call') {
      if (!rootSymbolId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'rootSymbolId is required for type "call".' }) }],
          isError: true,
        };
      }
      const result = buildCallHierarchy(rootSymbolId, repoId, db, 'both', maxDepth, maxNodes * 2);
      if (!result) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Symbol "${rootSymbolId}" not found.` }) }],
          isError: true,
        };
      }
      ({ nodes, edges } = flattenCallTree(result.root, result.root.symbolId));
    } else {
      // type === 'class'
      if (!rootSymbolId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'rootSymbolId is required for type "class".' }) }],
          isError: true,
        };
      }
      const result = buildClassHierarchy(rootSymbolId, repoId, db, 'both', maxDepth, true);
      if (!result) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Symbol "${rootSymbolId}" not found.` }) }],
          isError: true,
        };
      }
      ({ nodes, edges } = flattenClassTree(result.root));
    }

    // Apply maxNodes pruning
    const { nodes: prunedNodes, edges: prunedEdges, truncated } = pruneGraph(nodes, edges, maxNodes);

    // Render
    let diagram: string;
    if (format === 'dot') {
      diagram = renderDot(prunedNodes, prunedEdges);
    } else if (type === 'call') {
      const rootNode = prunedNodes.find((n) => n.styleClass === 'root');
      const rootId = rootNode?.id ?? (prunedNodes[0]?.id ?? '');
      diagram = renderMermaidCallGraph(prunedNodes, prunedEdges, rootId);
    } else if (type === 'class') {
      diagram = renderMermaidClassDiagram(prunedNodes, prunedEdges);
    } else {
      diagram = renderMermaidModule(prunedNodes, prunedEdges);
    }

    const output: RenderDiagramOutput = {
      diagram,
      format,
      nodeCount: prunedNodes.length,
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

// ─── Module graph builder ─────────────────────────────────────────────────────

function buildModuleGraph(
  repoId: string,
  db: import('better-sqlite3').Database,
  filePathScope?: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const allEdges = getAllDepEdges(db, repoId);

  // Filter by scope prefix if provided
  const scopePrefix = filePathScope
    ? filePathScope.endsWith('/') ? filePathScope : filePathScope + '/'
    : null;

  const scopedEdges = scopePrefix
    ? allEdges.filter(
        (e) => e.sourceFile.startsWith(scopePrefix) && e.targetFile.startsWith(scopePrefix),
      )
    : allEdges;

  // Collect unique file paths
  const fileSet = new Set<string>();
  for (const e of scopedEdges) {
    fileSet.add(e.sourceFile);
    fileSet.add(e.targetFile);
  }

  const nodes: GraphNode[] = Array.from(fileSet).map((fp) => ({
    id: sanitizeId(fp),
    label: shortLabel(fp),
    fullPath: fp,
    group: parentDir(fp),
  }));

  // Deduplicate edges (same source→target pair may appear multiple times)
  const seenEdges = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const e of scopedEdges) {
    const key = `${e.sourceFile}→${e.targetFile}`;
    if (!seenEdges.has(key)) {
      seenEdges.add(key);
      edges.push({
        source: sanitizeId(e.sourceFile),
        target: sanitizeId(e.targetFile),
      });
    }
  }

  return { nodes, edges };
}

// ─── Call tree flattener ──────────────────────────────────────────────────────

function flattenCallTree(
  root: CallNode,
  rootSymbolId: string,
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

    if (parentId !== null && !visited.has(`${parentId}→${nodeId}`)) {
      visited.add(`${parentId}→${nodeId}`);
      edges.push({
        source: parentId,
        target: nodeId,
        dashed: node.cyclic,
      });
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

// ─── Class hierarchy flattener ────────────────────────────────────────────────

function flattenClassTree(
  root: HierarchyNode,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodeMap = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const visited = new Set<string>();

  function nodeKey(node: HierarchyNode): string {
    return node.symbolId ?? `ext_${sanitizeId(node.name)}`;
  }

  function walk(node: HierarchyNode, parentNode: HierarchyNode | null): void {
    const key = sanitizeId(nodeKey(node));

    if (!nodeMap.has(key)) {
      nodeMap.set(key, {
        id: key,
        label: node.name,
        fullPath: node.filePath ?? '',
        group: node.filePath ? parentDir(node.filePath) : 'external',
        styleClass: node.filePath === null ? 'external' : undefined,
      });
    }

    if (parentNode !== null) {
      const parentKey = sanitizeId(nodeKey(parentNode));
      const edgeKey = `${key}→${parentKey}`;
      if (!visited.has(edgeKey)) {
        visited.add(edgeKey);
        // parent is an ancestor (depth < 0) or interface → dashed for implements
        const isInterface = parentNode.isInterface;
        edges.push({
          source: key,
          target: parentKey,
          dashed: isInterface,
          label: isInterface ? 'implements' : 'extends',
        });
      }
    }

    for (const child of node.children) {
      walk(child, node);
    }
  }

  walk(root, null);
  return { nodes: Array.from(nodeMap.values()), edges };
}
