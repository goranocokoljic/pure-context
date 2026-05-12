/**
 * render-class-hierarchy.ts
 *
 * MCP tool: render_class_hierarchy
 *
 * Render a UML-style class hierarchy diagram using Mermaid's `classDiagram`
 * syntax. Builds on `buildClassHierarchy` from Task 175 and the shared
 * rendering functions from diagram-renderer.ts.
 *
 * Edges:
 *   `<|--`  extends (solid)
 *   `<|..`  implements (dashed)
 *
 * Member extraction (includeMembers: true):
 *   Queries the symbol store for methods in each class's file and renders
 *   them inside the class box with access-modifier prefixes (+/-/#).
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getSymbolById, getSymbolsByFile } from '../../core/db/symbol-store.js';
import { buildClassHierarchy } from '../../graph/graph-traversal.js';
import {
  sanitizeId,
  renderMermaidClassDiagram,
  type GraphNode,
  type GraphEdge,
} from '../../graph/diagram-renderer.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { HierarchyNode } from '../../graph/graph-traversal.js';
import type Database from 'better-sqlite3';

export const name = 'render_class_hierarchy';

export const description =
  'Render a UML-style class hierarchy diagram using Mermaid classDiagram syntax. ' +
  'Shows ancestors (extends chain upward) and/or descendants (all subclasses downward). ' +
  'Extends relationships are drawn with solid arrows (<|--); implements relationships with dashed arrows (<|..). ' +
  'When includeMembers is true, methods and properties are shown inside each class box with access-modifier prefixes. ' +
  'External base classes (e.g. Error, EventEmitter) that are not indexed appear as empty leaf nodes. ' +
  'Use search_symbols to find the symbolId for a class or interface first. ' +
  'Mermaid output renders natively in GitHub, VS Code, and Claude.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  symbolId: z
    .string()
    .describe('Symbol ID of the class or interface to root the diagram at. Use search_symbols to find it.'),
  direction: z
    .enum(['ancestors', 'descendants', 'both'])
    .optional()
    .describe(
      '"ancestors" — draw the extends chain upward; ' +
      '"descendants" — draw all subclasses downward; ' +
      '"both" — full hierarchy (default)',
    ),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Maximum traversal depth in each direction (default 5)'),
  includeInterfaces: z
    .boolean()
    .optional()
    .describe(
      'Include implemented interfaces in the ancestor chain and interface ' +
      'subclasses in descendants (default true)',
    ),
  includeMembers: z
    .boolean()
    .optional()
    .describe(
      'Show methods and properties inside each class box with access-modifier prefixes ' +
      '(+ public, - private, # protected). Default true.',
    ),
};

// ─── Output type ──────────────────────────────────────────────────────────────

interface RenderClassHierarchyOutput {
  diagram: string;
  nodeCount: number;
  _tokenEstimate: number;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  symbolId: string;
  direction?: 'ancestors' | 'descendants' | 'both';
  maxDepth?: number;
  includeInterfaces?: boolean;
  includeMembers?: boolean;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    symbolId,
    direction = 'both',
    maxDepth = 5,
    includeInterfaces = true,
    includeMembers = true,
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

    const target = getSymbolById(db, repoId, symbolId);
    if (!target) {
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

    if (target.kind !== 'class' && target.kind !== 'interface') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                `Symbol "${target.name}" has kind "${target.kind}". ` +
                'render_class_hierarchy only works with class or interface symbols.',
            }),
          },
        ],
        isError: true,
      };
    }

    const result = buildClassHierarchy(
      symbolId,
      repoId,
      db,
      direction,
      maxDepth,
      includeInterfaces,
    );

    if (!result) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Symbol "${symbolId}" not found during hierarchy traversal.`,
            }),
          },
        ],
        isError: true,
      };
    }

    // Flatten the HierarchyNode tree into GraphNode[] + GraphEdge[]
    const { nodes, edges } = flattenHierarchyTree(result.root);

    // Optionally build a memberMap (class node ID → formatted member strings)
    let memberMap: Map<string, string[]> | undefined;
    if (includeMembers) {
      memberMap = buildMemberMap(nodes, db, repoId);
    }

    const diagram = renderMermaidClassDiagram(nodes, edges, memberMap);

    const output: RenderClassHierarchyOutput = {
      diagram,
      nodeCount: nodes.length,
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

// ─── Tree flattening ──────────────────────────────────────────────────────────

/**
 * Walk the HierarchyNode tree produced by buildClassHierarchy and collect
 * unique GraphNode/GraphEdge pairs for rendering.
 *
 * Depth semantics:
 *   depth  0  = root (the queried class)
 *   depth < 0 = ancestor (parent class or implemented interface)
 *   depth > 0 = descendant (subclass)
 *
 * Edge direction:
 *   - Ancestor child (child.depth < parent.depth):
 *       source = parent (subclass), target = child (base class/interface)
 *       dashed = child.isInterface  (implements → dashed)
 *   - Descendant child (child.depth > parent.depth):
 *       source = child (subclass), target = parent (base class/interface)
 *       dashed = parent.isInterface (implements → dashed)
 */
function flattenHierarchyTree(root: HierarchyNode): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodeMap = new Map<string, GraphNode & { filePath: string }>();
  const edges: GraphEdge[] = [];
  const edgeSet = new Set<string>();

  function walk(node: HierarchyNode, parentNode: HierarchyNode | null): void {
    const nodeId = sanitizeId(node.name);

    if (!nodeMap.has(nodeId)) {
      nodeMap.set(nodeId, {
        id: nodeId,
        label: node.name,
        fullPath: node.filePath ?? '',
        group: '',
        styleClass: node.isInterface ? 'interface' : undefined,
        // Store filePath for member lookup (reusing fullPath field)
        filePath: node.filePath ?? '',
      });
    }

    if (parentNode !== null) {
      const parentId = sanitizeId(parentNode.name);

      let source: string;
      let target: string;
      let dashed: boolean;
      let label: string;

      if (node.depth < parentNode.depth) {
        // node is an ancestor of parentNode → parentNode extends/implements node
        source = parentId;
        target = nodeId;
        dashed = node.isInterface;
        label = node.isInterface ? 'implements' : 'extends';
      } else {
        // node is a descendant of parentNode → node extends/implements parentNode
        source = nodeId;
        target = parentId;
        dashed = parentNode.isInterface;
        label = parentNode.isInterface ? 'implements' : 'extends';
      }

      const edgeKey = `${source}→${target}`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        edges.push({ source, target, dashed, label });
      }
    }

    for (const child of node.children) {
      walk(child, node);
    }
  }

  walk(root, null);
  return { nodes: Array.from(nodeMap.values()), edges };
}

// ─── Member extraction ────────────────────────────────────────────────────────

/**
 * For each node that has a file path, query the symbol store for methods and
 * format them as Mermaid classDiagram member lines.
 *
 * The memberMap key is the sanitized node ID; values are formatted member
 * strings like `+speak() string` or `-validate() boolean`.
 */
function buildMemberMap(
  nodes: Array<GraphNode & { filePath?: string }>,
  db: Database.Database,
  repoId: string,
): Map<string, string[]> {
  const memberMap = new Map<string, string[]>();

  for (const node of nodes) {
    const filePath = (node as GraphNode & { filePath?: string }).filePath ?? node.fullPath;
    if (!filePath) continue; // external node — no file to query

    const fileSymbols = getSymbolsByFile(db, repoId, filePath);
    const members: string[] = [];

    for (const sym of fileSymbols) {
      if (sym.kind !== 'method' && sym.kind !== 'function') continue;
      members.push(formatMember(sym.signature));
    }

    if (members.length > 0) {
      memberMap.set(node.id, members);
    }
  }

  return memberMap;
}

/**
 * Convert a TypeScript method signature to a Mermaid classDiagram member line.
 *
 * Input examples:
 *   `abstract speak(): string`      → `+speak() string`
 *   `private validate(): boolean`   → `-validate() boolean`
 *   `protected helper(): void`      → `#helper() void`
 *   `static create(): User`         → `+create() User`
 *
 * Mermaid classDiagram member format:
 *   `{modifier}{name}({params}) ReturnType`
 */
function formatMember(signature: string): string {
  // Detect access modifier from TypeScript keywords
  let accessMod = '+';
  if (/\bprivate\b/.test(signature)) accessMod = '-';
  else if (/\bprotected\b/.test(signature)) accessMod = '#';

  // Strip TypeScript modifier keywords so Mermaid sees a clean declaration
  const cleaned = signature
    .replace(/\b(public|private|protected|static|abstract|async|override|readonly|declare)\b\s*/g, '')
    .trim();

  return `${accessMod}${cleaned}`;
}
