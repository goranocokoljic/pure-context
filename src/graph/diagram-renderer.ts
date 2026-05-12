/**
 * diagram-renderer.ts
 *
 * Shared rendering functions for converting graph nodes+edges into
 * Mermaid or DOT diagram source strings.
 *
 * Used by render_diagram (Task 178) and the specialized render tools
 * (Tasks 179–181).
 */

import { posix } from 'path';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GraphNode {
  /** Sanitized Mermaid-safe identifier. */
  id: string;
  /** Short display label (usually just the filename). */
  label: string;
  /** Full relative path — used in comments and DOT labels. */
  fullPath: string;
  /** Parent directory — used as the subgraph / cluster name. */
  group: string;
  /** Optional node style class (e.g. 'root', 'external', 'boundary'). */
  styleClass?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** Render as a dashed arrow (used for cyclic edges or implements arrows). */
  dashed?: boolean;
  /** Optional edge label (e.g. 'implements', 'extends'). */
  label?: string;
}

// ─── ID helpers ───────────────────────────────────────────────────────────────

/**
 * Convert a file path or symbol name to a Mermaid-safe node ID.
 * Replaces slashes, dots, hyphens, and spaces with underscores.
 * e.g. `src/core/index-manager.ts` → `src_core_index_manager_ts`
 */
export function sanitizeId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Return just the filename portion of a path.
 * e.g. `src/core/index-manager.ts` → `index-manager.ts`
 */
export function shortLabel(filePath: string): string {
  return posix.basename(filePath);
}

/**
 * Return the parent directory of a path (using posix separators).
 * e.g. `src/core/index-manager.ts` → `src/core`
 */
export function parentDir(filePath: string): string {
  return posix.dirname(filePath) === '.' ? '' : posix.dirname(filePath);
}

// ─── Truncation ───────────────────────────────────────────────────────────────

/**
 * Prune the graph to at most `maxNodes` nodes by dropping the least-connected
 * nodes first (lowest degree). Edges where either endpoint was dropped are
 * removed.
 */
export function pruneGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  maxNodes: number,
): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
  if (nodes.length <= maxNodes) {
    return { nodes, edges, truncated: false };
  }

  // Compute degree for each node ID
  const degree = new Map<string, number>();
  for (const n of nodes) degree.set(n.id, 0);
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  // Sort by degree descending (highest connectivity first), stable by id
  const sorted = [...nodes].sort((a, b) => {
    const diff = (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });

  const kept = new Set(sorted.slice(0, maxNodes).map((n) => n.id));
  const prunedNodes = nodes.filter((n) => kept.has(n.id));
  const prunedEdges = edges.filter((e) => kept.has(e.source) && kept.has(e.target));

  return { nodes: prunedNodes, edges: prunedEdges, truncated: true };
}

// ─── Mermaid renderers ────────────────────────────────────────────────────────

/**
 * Render a `graph TD` Mermaid diagram (import graph view).
 *
 * Like `renderMermaidModule` but adds `classDef` declarations so that
 * boundary nodes (files outside the scoped directory that are imported by
 * files inside) and external npm nodes render with distinct colours.
 */
export function renderMermaidImportGraph(nodes: GraphNode[], edges: GraphEdge[]): string {
  if (nodes.length === 0) {
    return 'graph TD\n  %% empty graph\n';
  }

  const lines: string[] = ['graph TD'];

  // Emit classDefs for special node styles so Mermaid actually colours them.
  const hasBoundary = nodes.some((n) => n.styleClass === 'boundary');
  const hasExternal = nodes.some((n) => n.styleClass === 'external');
  if (hasBoundary) {
    lines.push('  classDef boundary fill:#ddd,stroke:#888,color:#555');
  }
  if (hasExternal) {
    lines.push('  classDef external fill:#fee,stroke:#f99,color:#900');
  }

  // Group nodes by parent directory for subgraph clustering.
  const groups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const g = node.group || '(root)';
    const list = groups.get(g) ?? [];
    list.push(node);
    groups.set(g, list);
  }

  for (const [groupName, groupNodes] of groups) {
    if (groupName === '(root)') {
      for (const n of groupNodes) {
        lines.push(`  ${n.id}["${escapeLabel(n.label)}"]`);
      }
    } else {
      const sgId = sanitizeId(groupName);
      lines.push(`  subgraph ${sgId}["${groupName}"]`);
      for (const n of groupNodes) {
        lines.push(`    ${n.id}["${escapeLabel(n.label)}"]`);
      }
      lines.push('  end');
    }
  }

  // Apply styleClass references to special nodes.
  for (const n of nodes.filter((x) => x.styleClass)) {
    lines.push(`  class ${n.id} ${n.styleClass};`);
  }

  for (const e of edges) {
    const arrow = e.dashed ? '-.->' : '-->';
    if (e.label) {
      lines.push(`  ${e.source} ${arrow}|"${escapeLabel(e.label)}"| ${e.target}`);
    } else {
      lines.push(`  ${e.source} ${arrow} ${e.target}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Render a `graph TD` Mermaid diagram (module/import view).
 * Files are grouped by directory using Mermaid `subgraph` blocks.
 */
export function renderMermaidModule(nodes: GraphNode[], edges: GraphEdge[]): string {
  if (nodes.length === 0) {
    return 'graph TD\n  %% empty graph\n';
  }

  const lines: string[] = ['graph TD'];

  // Group nodes by their `group` field (parent directory)
  const groups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const g = node.group || '(root)';
    const list = groups.get(g) ?? [];
    list.push(node);
    groups.set(g, list);
  }

  // Emit subgraph blocks
  for (const [groupName, groupNodes] of groups) {
    if (groupName === '(root)') {
      // No subgraph wrapper for root-level files
      for (const n of groupNodes) {
        lines.push(`  ${n.id}["${escapeLabel(n.label)}"]`);
      }
    } else {
      // Sanitize subgraph name for Mermaid (must not start with a digit)
      const sgId = sanitizeId(groupName);
      lines.push(`  subgraph ${sgId}["${groupName}"]`);
      for (const n of groupNodes) {
        lines.push(`    ${n.id}["${escapeLabel(n.label)}"]`);
      }
      lines.push('  end');
    }
  }

  // Apply styleClass to special nodes
  const styledNodes = nodes.filter((n) => n.styleClass);
  for (const n of styledNodes) {
    lines.push(`  class ${n.id} ${n.styleClass};`);
  }

  // Emit edges
  for (const e of edges) {
    const arrow = e.dashed ? '-.->' : '-->';
    if (e.label) {
      lines.push(`  ${e.source} ${arrow}|"${escapeLabel(e.label)}"| ${e.target}`);
    } else {
      lines.push(`  ${e.source} ${arrow} ${e.target}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Render a `flowchart TD` Mermaid diagram (call graph view).
 * rootId receives a distinct fill style.
 */
export function renderMermaidCallGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  rootId: string,
): string {
  if (nodes.length === 0) {
    return 'flowchart TD\n  %% empty graph\n';
  }

  const lines: string[] = ['flowchart TD'];

  for (const n of nodes) {
    lines.push(`  ${n.id}["${escapeLabel(n.label)}"]`);
  }

  // Style the root node distinctly
  if (nodes.some((n) => n.id === rootId)) {
    lines.push(`  style ${rootId} fill:#f96,stroke:#333`);
  }

  for (const e of edges) {
    const arrow = e.dashed ? '-.->' : '-->';
    if (e.label) {
      lines.push(`  ${e.source} ${arrow}|"${escapeLabel(e.label)}"| ${e.target}`);
    } else {
      lines.push(`  ${e.source} ${arrow} ${e.target}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Render a Mermaid `classDiagram` diagram (class hierarchy view).
 * Edges use `<|--` for extends and `<|..` for implements.
 */
export function renderMermaidClassDiagram(
  nodes: GraphNode[],
  edges: GraphEdge[],
  memberMap?: Map<string, string[]>,
): string {
  if (nodes.length === 0) {
    return 'classDiagram\n  %% empty diagram\n';
  }

  const lines: string[] = ['classDiagram'];

  // Emit class boxes
  for (const n of nodes) {
    const members = memberMap?.get(n.id) ?? [];
    if (members.length > 0) {
      lines.push(`  class ${n.id} {`);
      for (const m of members) {
        lines.push(`    ${m}`);
      }
      lines.push('  }');
      // Add a label annotation if the sanitized id differs from the class name
      if (n.id !== n.label) {
        lines.push(`  ${n.id}["${escapeLabel(n.label)}"]`);
      }
    } else {
      lines.push(`  class ${n.id}`);
      if (n.id !== n.label) {
        lines.push(`  ${n.id}["${escapeLabel(n.label)}"]`);
      }
    }
  }

  // Emit relationships
  for (const e of edges) {
    if (e.dashed) {
      // implements: parent <|.. child
      const rel = e.label ? `${e.target} <|.. ${e.source} : ${e.label}` : `${e.target} <|.. ${e.source}`;
      lines.push(`  ${rel}`);
    } else {
      // extends: parent <|-- child
      const rel = e.label ? `${e.target} <|-- ${e.source} : ${e.label}` : `${e.target} <|-- ${e.source}`;
      lines.push(`  ${rel}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Render a DOT (Graphviz) diagram.
 */
export function renderDot(nodes: GraphNode[], edges: GraphEdge[]): string {
  if (nodes.length === 0) {
    return 'digraph G {\n}\n';
  }

  const lines: string[] = ['digraph G {', '  rankdir=TD;', '  node [shape=box];'];

  // Group nodes into clusters by directory
  const groups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const g = node.group || '';
    const list = groups.get(g) ?? [];
    list.push(node);
    groups.set(g, list);
  }

  let clusterIdx = 0;
  for (const [groupName, groupNodes] of groups) {
    if (!groupName) {
      for (const n of groupNodes) {
        lines.push(`  "${n.id}" [label="${dotEscape(n.label)}"];`);
      }
    } else {
      lines.push(`  subgraph cluster_${clusterIdx++} {`);
      lines.push(`    label="${dotEscape(groupName)}";`);
      for (const n of groupNodes) {
        lines.push(`    "${n.id}" [label="${dotEscape(n.label)}"];`);
      }
      lines.push('  }');
    }
  }

  for (const e of edges) {
    const attrs = e.dashed ? ' [style=dashed]' : '';
    lines.push(`  "${e.source}" -> "${e.target}"${attrs};`);
  }

  lines.push('}');
  return lines.join('\n') + '\n';
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Escape double-quotes and backslashes in Mermaid labels. */
function escapeLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Escape special chars in DOT string literals. */
function dotEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
