/**
 * search-by-complexity.ts
 *
 * MCP tool: search_by_complexity
 *
 * Find all symbols whose complexity metrics match a set of min/max filters.
 * Covers six dimensions stored at index time:
 *   cyclomatic_complexity, cognitive_complexity, line_count,
 *   nesting_depth, param_count, return_count
 *
 * All filters are optional and combined with AND. Omitting a filter means
 * "no constraint on that dimension". The tool returns only symbols that have
 * metrics (logic-carrying kinds: function, method, class, component, etc.).
 *
 * Designed for targeted queries like:
 *   "show me every function with ≥8 cyclomatic complexity"
 *   "find all methods with exactly 0–2 parameters"
 *   "list functions that are between 20 and 50 lines"
 *
 * Use get_quality_metrics when you want a ranked worst-offenders list with a
 * composite score. Use search_by_complexity when you have a specific threshold
 * or range in mind for one or more individual dimensions.
 */

import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SymbolKind } from '../../core/types.js';

export const name = 'search_by_complexity';

export const description =
  'Find symbols matching specific complexity criteria. ' +
  'Filter by any combination of cyclomatic complexity, cognitive complexity, ' +
  'line count, nesting depth, parameter count, and return count — each with ' +
  'optional min and/or max bounds. Only symbols with computed metrics are returned ' +
  '(functions, methods, classes, components, etc.).' +
  '\n\nExample use cases:' +
  '\n  minCyclomaticComplexity: 8              — dangerously complex functions' +
  '\n  minParamCount: 5                        — functions with too many arguments' +
  '\n  minLineCount: 100                       — long functions to split' +
  '\n  minNestingDepth: 4                      — deeply nested, hard-to-read code' +
  '\n  maxCyclomaticComplexity: 2, maxLineCount: 15  — simple utility functions' +
  '\n  minReturnCount: 4                       — functions with many exit points';

export const inputSchema = {
  repoId: z.string().describe('Repository ID returned by index_folder or list_repos'),
  // Cyclomatic complexity bounds
  minCyclomaticComplexity: z
    .number().int().min(1).optional()
    .describe('Only return symbols with cyclomatic complexity ≥ this value'),
  maxCyclomaticComplexity: z
    .number().int().min(1).optional()
    .describe('Only return symbols with cyclomatic complexity ≤ this value'),
  // Cognitive complexity bounds
  minCognitiveComplexity: z
    .number().int().min(1).optional()
    .describe('Only return symbols with cognitive complexity ≥ this value'),
  maxCognitiveComplexity: z
    .number().int().min(1).optional()
    .describe('Only return symbols with cognitive complexity ≤ this value'),
  // Line count bounds
  minLineCount: z
    .number().int().min(1).optional()
    .describe('Only return symbols with line count ≥ this value'),
  maxLineCount: z
    .number().int().min(1).optional()
    .describe('Only return symbols with line count ≤ this value'),
  // Nesting depth bounds
  minNestingDepth: z
    .number().int().min(1).optional()
    .describe('Only return symbols with max nesting depth ≥ this value'),
  maxNestingDepth: z
    .number().int().min(1).optional()
    .describe('Only return symbols with max nesting depth ≤ this value'),
  // Param count bounds
  minParamCount: z
    .number().int().min(0).optional()
    .describe('Only return symbols with parameter count ≥ this value'),
  maxParamCount: z
    .number().int().min(0).optional()
    .describe('Only return symbols with parameter count ≤ this value'),
  // Return count bounds
  minReturnCount: z
    .number().int().min(0).optional()
    .describe('Only return symbols with return statement count ≥ this value'),
  maxReturnCount: z
    .number().int().min(0).optional()
    .describe('Only return symbols with return statement count ≤ this value'),
  // Sort controls
  sortBy: z
    .enum(['complexity', 'cognitive', 'size', 'nesting', 'params', 'returns'])
    .optional()
    .describe(
      'Sort dimension: "complexity" (cyclomatic, default), "cognitive", ' +
      '"size" (line count), "nesting", "params", "returns"',
    ),
  sortOrder: z
    .enum(['asc', 'desc'])
    .optional()
    .describe('Sort direction: "desc" (default, worst first) or "asc" (best first)'),
  // Filters
  kind: z
    .enum([
      'function', 'class', 'method', 'const', 'type', 'interface', 'enum',
      'component', 'composable', 'hook', 'route', 'decorator', 'middleware',
    ])
    .optional()
    .describe('Filter results to a specific symbol kind'),
  filePath: z
    .string()
    .optional()
    .describe('Restrict search to a specific file path or directory prefix'),
  limit: z
    .number().int().positive().optional()
    .describe('Maximum number of results to return (default 50)'),
};

// ─── Row type ─────────────────────────────────────────────────────────────────

interface ComplexityRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  start_byte: number;
  signature: string;
  summary: string;
  line_count: number;
  cyclomatic_complexity: number;
  cognitive_complexity: number;
  param_count: number;
  return_count: number;
  nesting_depth: number;
}

// ─── Sort column map ──────────────────────────────────────────────────────────

const SORT_COL: Record<string, string> = {
  complexity: 'cyclomatic_complexity',
  cognitive:  'cognitive_complexity',
  size:       'line_count',
  nesting:    'nesting_depth',
  params:     'param_count',
  returns:    'return_count',
};

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  minCyclomaticComplexity?: number;
  maxCyclomaticComplexity?: number;
  minCognitiveComplexity?: number;
  maxCognitiveComplexity?: number;
  minLineCount?: number;
  maxLineCount?: number;
  minNestingDepth?: number;
  maxNestingDepth?: number;
  minParamCount?: number;
  maxParamCount?: number;
  minReturnCount?: number;
  maxReturnCount?: number;
  sortBy?: 'complexity' | 'cognitive' | 'size' | 'nesting' | 'params' | 'returns';
  sortOrder?: 'asc' | 'desc';
  kind?: string;
  filePath?: string;
  limit?: number;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    sortBy = 'complexity',
    sortOrder = 'desc',
    limit = 50,
  } = args;

  const db = openDatabase(repoId);
  try {
    // ── Build query ────────────────────────────────────────────────────────────
    const conditions: string[] = ['repo_id = @repoId', 'line_count IS NOT NULL'];
    const params: Record<string, unknown> = { repoId };

    if (args.minCyclomaticComplexity !== undefined) {
      conditions.push('COALESCE(cyclomatic_complexity, 1) >= @minCC');
      params['minCC'] = args.minCyclomaticComplexity;
    }
    if (args.maxCyclomaticComplexity !== undefined) {
      conditions.push('COALESCE(cyclomatic_complexity, 1) <= @maxCC');
      params['maxCC'] = args.maxCyclomaticComplexity;
    }
    if (args.minCognitiveComplexity !== undefined) {
      conditions.push('COALESCE(cognitive_complexity, 0) >= @minCog');
      params['minCog'] = args.minCognitiveComplexity;
    }
    if (args.maxCognitiveComplexity !== undefined) {
      conditions.push('COALESCE(cognitive_complexity, 0) <= @maxCog');
      params['maxCog'] = args.maxCognitiveComplexity;
    }
    if (args.minLineCount !== undefined) {
      conditions.push('COALESCE(line_count, 0) >= @minLC');
      params['minLC'] = args.minLineCount;
    }
    if (args.maxLineCount !== undefined) {
      conditions.push('COALESCE(line_count, 0) <= @maxLC');
      params['maxLC'] = args.maxLineCount;
    }
    if (args.minNestingDepth !== undefined) {
      conditions.push('COALESCE(nesting_depth, 0) >= @minND');
      params['minND'] = args.minNestingDepth;
    }
    if (args.maxNestingDepth !== undefined) {
      conditions.push('COALESCE(nesting_depth, 0) <= @maxND');
      params['maxND'] = args.maxNestingDepth;
    }
    if (args.minParamCount !== undefined) {
      conditions.push('COALESCE(param_count, 0) >= @minPC');
      params['minPC'] = args.minParamCount;
    }
    if (args.maxParamCount !== undefined) {
      conditions.push('COALESCE(param_count, 0) <= @maxPC');
      params['maxPC'] = args.maxParamCount;
    }
    if (args.minReturnCount !== undefined) {
      conditions.push('COALESCE(return_count, 0) >= @minRC');
      params['minRC'] = args.minReturnCount;
    }
    if (args.maxReturnCount !== undefined) {
      conditions.push('COALESCE(return_count, 0) <= @maxRC');
      params['maxRC'] = args.maxReturnCount;
    }
    if (args.kind) {
      conditions.push('kind = @kind');
      params['kind'] = args.kind;
    }
    if (args.filePath) {
      conditions.push('(file_path = @filePath OR file_path LIKE @filePathPrefix)');
      params['filePath'] = args.filePath;
      params['filePathPrefix'] = `${args.filePath}%`;
    }
    params['limit'] = limit;

    const orderCol = SORT_COL[sortBy] ?? 'cyclomatic_complexity';
    const order = sortOrder === 'asc' ? 'ASC' : 'DESC';

    const sql = `
      SELECT id, name, kind, file_path, start_byte, signature, summary,
             COALESCE(line_count, 0)            AS line_count,
             COALESCE(cyclomatic_complexity, 1)  AS cyclomatic_complexity,
             COALESCE(cognitive_complexity, 0)   AS cognitive_complexity,
             COALESCE(param_count, 0)            AS param_count,
             COALESCE(return_count, 0)           AS return_count,
             COALESCE(nesting_depth, 0)          AS nesting_depth
      FROM symbols
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderCol} ${order}, file_path ASC, start_byte ASC
      LIMIT @limit
    `;

    const rows = db.prepare<Record<string, unknown>, ComplexityRow>(sql).all(params);

    // ── Compute startLine from stored file content ─────────────────────────────
    const fileSymbols = new Map<string, ComplexityRow[]>();
    for (const row of rows) {
      const list = fileSymbols.get(row.file_path) ?? [];
      list.push(row);
      fileSymbols.set(row.file_path, list);
    }

    const lineMap = new Map<string, number>(); // symbolId → startLine
    for (const [filePath, syms] of fileSymbols) {
      const fileRow = db.prepare<[string, string], { raw_content: Buffer | null }>(
        'SELECT raw_content FROM files WHERE repo_id = ? AND path = ?',
      ).get(repoId, filePath);

      if (fileRow?.raw_content) {
        const content = fileRow.raw_content;
        for (const sym of syms) {
          const slice = content.slice(0, Math.min(sym.start_byte, content.length));
          let line = 1;
          for (let i = 0; i < slice.length; i++) {
            if (slice[i] === 0x0a) line++;
          }
          lineMap.set(sym.id, line);
        }
      } else {
        for (const sym of syms) {
          lineMap.set(sym.id, Math.max(1, Math.floor(sym.start_byte / 80) + 1));
        }
      }
    }

    // ── Shape output ───────────────────────────────────────────────────────────
    const symbols = rows.map((row) => ({
      symbolId: row.id,
      name: row.name,
      kind: row.kind as SymbolKind,
      filePath: row.file_path,
      startLine: lineMap.get(row.id) ?? 1,
      signature: row.signature,
      summary: row.summary,
      metrics: {
        cyclomaticComplexity: row.cyclomatic_complexity,
        cognitiveComplexity:  row.cognitive_complexity,
        lineCount:            row.line_count,
        nestingDepth:         row.nesting_depth,
        paramCount:           row.param_count,
        returnCount:          row.return_count,
      },
    }));

    const responseBytes = symbols.reduce(
      (sum, s) => sum + s.signature.length + s.summary.length + s.filePath.length + 100,
      0,
    );
    const tokenEstimate = Math.ceil(responseBytes / 4);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(
          {
            symbols,
            totalFound: symbols.length,
            sortedBy: sortBy,
            sortOrder,
            _tokenEstimate: tokenEstimate,
            _meta: buildMeta({ timingMs: Date.now() - t0 }),
          },
          null,
          2,
        ),
      }],
    };
  } finally {
    db.close();
  }
}
