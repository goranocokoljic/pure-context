/**
 * get-type-graph.ts
 *
 * MCP tool: get_type_graph
 *
 * Returns the type dependency graph for a repository (or a scoped subtree),
 * showing how interfaces, classes, type aliases, and enums relate to each
 * other through inheritance (`extends`), implementation (`implements`), and
 * optional usage relationships.
 *
 * Use this tool to:
 *   - Understand a domain model's type hierarchy before refactoring
 *   - Find all types that depend on a given interface
 *   - Generate a Mermaid class diagram from live code
 *   - Answer "what does this type extend/implement, and who extends it?"
 *
 * Differs from related tools:
 *   get_class_hierarchy — single-root ancestor/descendant tree for one class
 *   find_implementations — all concrete implementations of one interface
 *   get_type_graph       — full multi-root graph of all type relationships
 *                          in a scope; supports rootSymbol for focused traversal
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SymbolKind } from '../../core/types.js';

export const name = 'get_type_graph';

export const description =
  'Return the type dependency graph for a repo, showing how interfaces, classes, ' +
  'type aliases, and enums relate to each other via extends and implements. ' +
  'Returns nodes (type symbols) and directed edges (relationship type + source/target). ' +
  'Optionally rooted at a single type for a focused subgraph up to a given depth. ' +
  'Supports mermaid output format for visual rendering.' +
  '\n\nUse this to:' +
  '\n  - Understand a domain model before refactoring' +
  '\n  - Find all types that inherit from a given interface' +
  '\n  - Generate a Mermaid class diagram from live code' +
  '\n\nDiffers from related tools:' +
  '\n  get_class_hierarchy  — single-root tree for one class/interface' +
  '\n  find_implementations — concrete implementors of one interface' +
  '\n  get_type_graph       — full multi-root graph across a scope';

export const inputSchema = {
  repoId: z.string().describe('Repository ID returned by index_folder or list_repos'),

  rootSymbol: z
    .string()
    .optional()
    .describe(
      'Name or ID of a type/interface/class to root the graph at. ' +
      'When provided, only connected symbols up to maxDepth are returned. ' +
      'Omit to return the full graph for the scope.',
    ),

  maxDepth: z
    .number().int().min(1).max(10)
    .optional()
    .describe(
      'Maximum traversal depth from rootSymbol (default 3). ' +
      'Ignored when rootSymbol is not provided.',
    ),

  scope: z
    .string()
    .optional()
    .describe(
      'Restrict to a directory prefix (e.g. "src/types/"). ' +
      'Omit to analyse the entire repo.',
    ),

  kinds: z
    .array(z.enum(['interface', 'class', 'type', 'enum']))
    .optional()
    .describe(
      'Symbol kinds to include. Defaults to all type-like kinds: ' +
      'interface, class, type, enum.',
    ),

  includeAbstract: z
    .boolean()
    .optional()
    .describe(
      'Include abstract classes as nodes (default true). ' +
      'Set false to show only concrete classes.',
    ),

  format: z
    .enum(['graph', 'mermaid'])
    .optional()
    .describe(
      '"graph" (default) — structured JSON nodes+edges. ' +
      '"mermaid" — Mermaid classDiagram source string. ' +
      'Both formats always include the JSON graph; mermaid adds a "mermaid" field.',
    ),

  limit: z
    .number().int().min(1).max(500)
    .optional()
    .describe('Maximum number of nodes to include (default 100). Applied after depth traversal.'),
};

// ─── Internal types ───────────────────────────────────────────────────────────

interface SymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  start_byte: number;
  signature: string;
  summary: string;
}

export interface TypeNode {
  id: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  signature: string;
  summary: string;
  isAbstract: boolean;
  isGeneric: boolean;
}

export interface TypeEdge {
  source: string;   // symbolId of the source node
  target: string;   // symbolId of the target node (resolved) or '' (unresolved)
  relation: 'extends' | 'implements';
  targetName: string;  // name as seen in the signature
  resolved: boolean;   // true if target symbolId was found in the index
}

// ─── Signature parsers ────────────────────────────────────────────────────────

/**
 * Extract parent names from `extends X, Y<T>` in a signature.
 * Strips generic parameters and returns bare names.
 */
function parseExtendsNames(signature: string): string[] {
  // interface/class declaration: capture after `extends` until `implements` or `{`
  const match = signature.match(/\bextends\s+([\w<>\s,[\]]+?)(?=\s+implements\b|\s*[{]|$)/);
  if (!match) return [];
  return splitTypeList(match[1]);
}

/**
 * Extract interface names from `implements X, Y<T>` in a signature.
 * Strips generic parameters and returns bare names.
 */
function parseImplementsNames(signature: string): string[] {
  const match = signature.match(/\bimplements\s+([\w<>\s,[\]]+?)(?=\s*[{]|$)/);
  if (!match) return [];
  return splitTypeList(match[1]);
}

/**
 * Split a comma-separated type list (which may contain generics) into
 * individual bare type names, stripping generic parameters.
 *
 * e.g. "Repository<User>, Serializable" → ["Repository", "Serializable"]
 */
function splitTypeList(raw: string): string[] {
  // Use a simple bracket-depth tracker to split on commas at depth 0
  const names: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of raw) {
    if (ch === '<' || ch === '[') { depth++; current += ch; }
    else if (ch === '>' || ch === ']') { depth--; current += ch; }
    else if (ch === ',' && depth === 0) {
      const name = extractBareName(current.trim());
      if (name) names.push(name);
      current = '';
    } else {
      current += ch;
    }
  }

  const last = extractBareName(current.trim());
  if (last) names.push(last);

  return names;
}

/** Strip generic parameters from a type reference: "Repository<User>" → "Repository" */
function extractBareName(typeRef: string): string {
  return typeRef.replace(/<.*/, '').replace(/\[.*/, '').trim();
}

// ─── Mermaid renderer ─────────────────────────────────────────────────────────

function renderMermaid(nodes: TypeNode[], edges: TypeEdge[]): string {
  const lines: string[] = ['classDiagram'];

  // Declare classes
  for (const node of nodes) {
    if (node.kind === 'interface') {
      lines.push(`  class ${node.name} {`);
      lines.push(`    <<interface>>`);
      lines.push(`  }`);
    } else if (node.kind === 'enum') {
      lines.push(`  class ${node.name} {`);
      lines.push(`    <<enumeration>>`);
      lines.push(`  }`);
    } else if (node.kind === 'type') {
      lines.push(`  class ${node.name} {`);
      lines.push(`    <<type>>`);
      lines.push(`  }`);
    } else {
      // class (possibly abstract)
      lines.push(`  class ${node.name} {`);
      if (node.isAbstract) lines.push(`    <<abstract>>`);
      lines.push(`  }`);
    }
  }

  // Node ID → name map for resolved edges
  const idToName = new Map(nodes.map((n) => [n.id, n.name]));

  // Render edges
  for (const edge of edges) {
    const sourceName = idToName.get(edge.source);
    if (!sourceName) continue;

    const targetName = edge.resolved ? (idToName.get(edge.target) ?? edge.targetName) : edge.targetName;

    if (edge.relation === 'extends') {
      lines.push(`  ${sourceName} --|> ${targetName} : extends`);
    } else {
      lines.push(`  ${sourceName} ..|> ${targetName} : implements`);
    }
  }

  return lines.join('\n');
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  rootSymbol?: string;
  maxDepth?: number;
  scope?: string;
  kinds?: Array<'interface' | 'class' | 'type' | 'enum'>;
  includeAbstract?: boolean;
  format?: 'graph' | 'mermaid';
  limit?: number;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    maxDepth = 3,
    kinds = ['interface', 'class', 'type', 'enum'],
    includeAbstract = true,
    format = 'graph',
    limit = 100,
  } = args;

  const db = openDatabase(repoId);
  try {
    // ── Validate repo ──────────────────────────────────────────────────────────
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: `Repo "${repoId}" not found. Run index_folder first.` }),
        }],
        isError: true,
      };
    }

    // ── Fetch type symbols ─────────────────────────────────────────────────────
    const kindPlaceholders = kinds.map(() => '?').join(', ');
    const conditions: string[] = [`repo_id = ?`, `kind IN (${kindPlaceholders})`];
    const params: unknown[] = [repoId, ...kinds];

    if (args.scope) {
      conditions.push('(file_path = ? OR file_path LIKE ?)');
      params.push(args.scope);
      params.push(
        args.scope.endsWith('/')
          ? `${args.scope}%`
          : `${args.scope}/%`,
      );
    }

    if (!includeAbstract) {
      conditions.push("signature NOT LIKE '%abstract %'");
    }

    const sql = `
      SELECT id, name, kind, file_path, start_byte, signature, summary
      FROM symbols
      WHERE ${conditions.join(' AND ')}
      ORDER BY file_path ASC, name ASC
    `;

    const rows = db.prepare<unknown[], SymbolRow>(sql).all(...params);

    if (rows.length === 0) {
      const emptyResult = {
        repoId,
        rootSymbolId: null,
        nodes: [],
        edges: [],
        summary: { nodeCount: 0, edgeCount: 0, resolvedEdgeCount: 0, unresolvedEdgeCount: 0, relationTypes: [] },
        _tokenEstimate: 10,
        _meta: buildMeta({ timingMs: Date.now() - t0 }),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(emptyResult, null, 2) }],
      };
    }

    // ── Build name → symbolId lookup (for resolving extends/implements targets) ─
    const nameToIds = new Map<string, string[]>();
    for (const row of rows) {
      const list = nameToIds.get(row.name) ?? [];
      list.push(row.id);
      nameToIds.set(row.name, list);
    }

    // ── Build all nodes ────────────────────────────────────────────────────────
    const allNodes = new Map<string, TypeNode>();
    for (const row of rows) {
      allNodes.set(row.id, {
        id: row.id,
        name: row.name,
        kind: row.kind as SymbolKind,
        filePath: row.file_path,
        signature: row.signature,
        summary: row.summary,
        isAbstract: row.signature.includes('abstract '),
        isGeneric: row.signature.includes('<'),
      });
    }

    // ── Build all edges ────────────────────────────────────────────────────────
    const allEdges: TypeEdge[] = [];

    for (const row of rows) {
      // extends
      for (const parentName of parseExtendsNames(row.signature)) {
        const targetIds = nameToIds.get(parentName);
        if (targetIds && targetIds.length > 0) {
          allEdges.push({
            source: row.id,
            target: targetIds[0],
            relation: 'extends',
            targetName: parentName,
            resolved: true,
          });
        } else {
          // Unresolved — target not in the indexed symbols (external/stdlib)
          allEdges.push({
            source: row.id,
            target: '',
            relation: 'extends',
            targetName: parentName,
            resolved: false,
          });
        }
      }

      // implements
      for (const ifaceName of parseImplementsNames(row.signature)) {
        const targetIds = nameToIds.get(ifaceName);
        if (targetIds && targetIds.length > 0) {
          allEdges.push({
            source: row.id,
            target: targetIds[0],
            relation: 'implements',
            targetName: ifaceName,
            resolved: true,
          });
        } else {
          allEdges.push({
            source: row.id,
            target: '',
            relation: 'implements',
            targetName: ifaceName,
            resolved: false,
          });
        }
      }
    }

    // ── rootSymbol traversal ───────────────────────────────────────────────────
    let rootSymbolId: string | null = null;
    let finalNodes: TypeNode[];
    let finalEdges: TypeEdge[];

    if (args.rootSymbol) {
      // Resolve rootSymbol: try as ID first, then by name
      let rootNode: TypeNode | undefined = allNodes.get(args.rootSymbol);
      if (!rootNode) {
        const ids = nameToIds.get(args.rootSymbol);
        if (ids && ids.length > 0) rootNode = allNodes.get(ids[0]);
      }

      if (!rootNode) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: `Symbol "${args.rootSymbol}" not found among type symbols in repo "${repoId}".`,
            }),
          }],
          isError: true,
        };
      }

      rootSymbolId = rootNode.id;

      // BFS: include nodes reachable from root within maxDepth hops (both directions)
      // Build adjacency: for each node, what nodes does it connect to (either direction)
      const adjacency = new Map<string, Set<string>>();
      for (const edge of allEdges) {
        if (!edge.resolved) continue;
        if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
        if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
        adjacency.get(edge.source)!.add(edge.target);
        adjacency.get(edge.target)!.add(edge.source);
      }

      const visited = new Set<string>([rootSymbolId]);
      let frontier = new Set<string>([rootSymbolId]);

      for (let depth = 0; depth < maxDepth && frontier.size > 0; depth++) {
        const next = new Set<string>();
        for (const nodeId of frontier) {
          for (const neighbor of (adjacency.get(nodeId) ?? [])) {
            if (!visited.has(neighbor)) {
              visited.add(neighbor);
              next.add(neighbor);
            }
          }
        }
        frontier = next;
      }

      const reachableNodes = new Map<string, TypeNode>();
      for (const id of visited) {
        const node = allNodes.get(id);
        if (node) reachableNodes.set(id, node);
      }

      finalNodes = Array.from(reachableNodes.values());
      finalEdges = allEdges.filter(
        (e) => visited.has(e.source) && (e.resolved ? visited.has(e.target) : true),
      );
    } else {
      finalNodes = Array.from(allNodes.values());
      finalEdges = allEdges;
    }

    // ── Apply limit ────────────────────────────────────────────────────────────
    if (finalNodes.length > limit) {
      // Keep nodes with the most edges first (most connected)
      const edgeCounts = new Map<string, number>();
      for (const edge of finalEdges) {
        edgeCounts.set(edge.source, (edgeCounts.get(edge.source) ?? 0) + 1);
        if (edge.target) edgeCounts.set(edge.target, (edgeCounts.get(edge.target) ?? 0) + 1);
      }
      finalNodes.sort((a, b) => (edgeCounts.get(b.id) ?? 0) - (edgeCounts.get(a.id) ?? 0));
      const keptIds = new Set(finalNodes.slice(0, limit).map((n) => n.id));
      finalNodes = finalNodes.slice(0, limit);
      finalEdges = finalEdges.filter((e) => keptIds.has(e.source));
    }

    // ── Compute relation types ─────────────────────────────────────────────────
    const relationTypes = [...new Set(finalEdges.map((e) => e.relation))].sort();
    const resolvedEdges = finalEdges.filter((e) => e.resolved);
    const unresolvedEdges = finalEdges.filter((e) => !e.resolved);

    // ── Build output ───────────────────────────────────────────────────────────
    const outputNodes = finalNodes.map((n) => ({
      id: n.id,
      name: n.name,
      kind: n.kind,
      filePath: n.filePath,
      signature: n.signature,
      summary: n.summary,
      isAbstract: n.isAbstract,
      isGeneric: n.isGeneric,
    }));

    const outputEdges = finalEdges.map((e) => ({
      source: e.source,
      target: e.target,
      relation: e.relation,
      targetName: e.targetName,
      resolved: e.resolved,
    }));

    // ── Token estimate ─────────────────────────────────────────────────────────
    const nodeBytes = finalNodes.reduce(
      (s, n) => s + n.name.length + n.filePath.length + n.signature.length + n.summary.length + 40,
      0,
    );
    const edgeBytes = finalEdges.length * 60;
    const tokenEstimate = Math.ceil((nodeBytes + edgeBytes) / 4);

    const result: Record<string, unknown> = {
      repoId,
      rootSymbolId,
      nodes: outputNodes,
      edges: outputEdges,
      summary: {
        nodeCount: finalNodes.length,
        edgeCount: finalEdges.length,
        resolvedEdgeCount: resolvedEdges.length,
        unresolvedEdgeCount: unresolvedEdges.length,
        relationTypes,
      },
      _tokenEstimate: tokenEstimate,
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };

    if (format === 'mermaid') {
      result['mermaid'] = renderMermaid(finalNodes, resolvedEdges);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } finally {
    db.close();
  }
}
