/**
 * render-dep-matrix.ts
 *
 * MCP tool: render_dep_matrix
 *
 * Render a dependency matrix (coupling heatmap) for the top-N most coupled
 * files in the repo. Matrix cell [row][col] is 1 when row imports col, 0
 * otherwise; the diagonal is always "—".
 *
 * Two formats:
 *   'ascii'   — text table (default). Token-efficient, renders in any markdown.
 *   'mermaid' — `graph TD` showing direct import edges between the top-N files.
 *               More useful than xychart-beta which cannot represent a matrix.
 *
 * File selection: the N files with the highest total coupling
 * (efferentCoupling + afferentCoupling) are chosen. Use `filePath` to scope
 * selection to a directory.
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getCouplingMap } from '../../core/db/dep-store.js';
import {
  sanitizeId,
  shortLabel,
  parentDir,
  renderMermaidModule,
  type GraphNode,
  type GraphEdge,
} from '../../graph/diagram-renderer.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'render_dep_matrix';

export const description =
  'Render a dependency matrix for the top-N most coupled files. ' +
  'Each cell shows 1 if the row file imports the column file, 0 otherwise; ' +
  'the diagonal shows "—". ' +
  'ASCII format (default) is token-efficient and renders in any markdown context. ' +
  'Mermaid format produces a graph TD showing import edges between the top-N files. ' +
  'Use topN (default 10) to control how many files appear. ' +
  'Use filePath to scope selection to a directory.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  topN: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Number of most-coupled files to include (default 10)'),
  filePath: z
    .string()
    .optional()
    .describe(
      'Scope file selection to files under this directory path (relative to repo root). ' +
      'When omitted, selects from the whole repo.',
    ),
  format: z
    .enum(['ascii', 'mermaid'])
    .optional()
    .describe(
      '"ascii" (default) — text table readable in any markdown. ' +
      '"mermaid" — graph TD diagram of import edges between the selected files.',
    ),
};

// ─── Output type ──────────────────────────────────────────────────────────────

interface RenderDepMatrixOutput {
  matrix: string;
  files: string[];
  format: 'ascii' | 'mermaid';
  _tokenEstimate: number;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Rendering helpers ────────────────────────────────────────────────────────

/**
 * Return the last `segments` path components of a file path.
 * e.g. `src/core/index-manager.ts` → `core/index-manager.ts` (segments=2)
 */
function truncatePath(filePath: string, segments = 2): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts.slice(-segments).join('/');
}

/**
 * Render a text dependency matrix.
 *
 * Rows = files (labelled with last-2-segment names).
 * Columns = same files (headers use last-2-segment names, potentially padded).
 * Cell: '1' if row imports col, '0' otherwise, '—' on diagonal.
 */
function renderAsciiMatrix(
  filePaths: string[],
  importMap: Map<string, Set<string>>,
): string {
  if (filePaths.length === 0) return '(no files)';

  const rowLabels = filePaths.map((fp) => truncatePath(fp));
  const colHeaders = filePaths.map((fp) => truncatePath(fp));

  // Measure column widths (at least 1 char for the cell value)
  const colWidths = colHeaders.map((h) => h.length);
  const rowLabelWidth = Math.max(...rowLabels.map((l) => l.length));

  const lines: string[] = [];
  const GAP = 2; // spaces between columns

  // Build header line
  const headerParts: string[] = [' '.repeat(rowLabelWidth)];
  for (let c = 0; c < colHeaders.length; c++) {
    headerParts.push(colHeaders[c].padStart(colWidths[c] + GAP));
  }
  lines.push(headerParts.join(''));

  // Build data rows
  for (let r = 0; r < filePaths.length; r++) {
    const rowImports = importMap.get(filePaths[r]) ?? new Set<string>();
    const parts: string[] = [rowLabels[r].padEnd(rowLabelWidth)];
    for (let c = 0; c < filePaths.length; c++) {
      let cell: string;
      if (r === c) {
        cell = '—';
      } else {
        cell = rowImports.has(filePaths[c]) ? '1' : '0';
      }
      parts.push(cell.padStart(colWidths[c] + GAP));
    }
    lines.push(parts.join(''));
  }

  return lines.join('\n');
}

/**
 * Render a `graph TD` Mermaid diagram showing import edges between the
 * top-N files. Only edges where both endpoints are in the selected set are
 * drawn (same semantics as matrix cells with value 1).
 */
function renderMermaidMatrix(
  filePaths: string[],
  importMap: Map<string, Set<string>>,
): string {
  const fileSet = new Set(filePaths);

  const nodes: GraphNode[] = filePaths.map((fp) => ({
    id: sanitizeId(fp),
    label: shortLabel(fp),
    fullPath: fp,
    group: parentDir(fp),
  }));

  const seenEdges = new Set<string>();
  const edges: GraphEdge[] = [];

  for (const fp of filePaths) {
    for (const dep of importMap.get(fp) ?? new Set<string>()) {
      if (!fileSet.has(dep)) continue;
      const key = `${fp}→${dep}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push({ source: sanitizeId(fp), target: sanitizeId(dep) });
      }
    }
  }

  return renderMermaidModule(nodes, edges);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  topN?: number;
  filePath?: string;
  format?: 'ascii' | 'mermaid';
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, topN = 10, filePath, format = 'ascii' } = args;

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

    // Fetch coupling rows for the whole repo (or scoped path).
    let rows = getCouplingMap(db, repoId, filePath);

    // When scoping to a directory, filter to files under that path.
    if (filePath) {
      const prefix = filePath.endsWith('/') ? filePath : filePath + '/';
      rows = rows.filter((r) => r.filePath.startsWith(prefix) || r.filePath === filePath);
    }

    // Sort by total coupling descending, stable by filePath.
    rows.sort(
      (a, b) =>
        b.efferentCoupling + b.afferentCoupling - (a.efferentCoupling + a.afferentCoupling) ||
        a.filePath.localeCompare(b.filePath),
    );

    // Take top-N.
    rows = rows.slice(0, topN);

    const filePaths = rows.map((r) => r.filePath);

    // Build a set-of-targets per file for O(1) lookup during matrix construction.
    const importMap = new Map<string, Set<string>>();
    for (const r of rows) {
      importMap.set(r.filePath, new Set(r.efferentDeps));
    }

    // Render the matrix in the requested format.
    let matrix: string;
    if (format === 'mermaid') {
      matrix = renderMermaidMatrix(filePaths, importMap);
    } else {
      matrix = renderAsciiMatrix(filePaths, importMap);
    }

    const output: RenderDepMatrixOutput = {
      matrix,
      files: filePaths,
      format,
      _tokenEstimate: Math.ceil(matrix.length / 4),
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    };
  } finally {
    db.close();
  }
}
