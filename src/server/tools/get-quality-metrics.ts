/**
 * get-quality-metrics.ts
 *
 * MCP tool: get_quality_metrics
 *
 * Query per-symbol code quality metrics (complexity, size, coupling) that were
 * calculated during indexing and stored in the symbols table (Task 158).
 *
 * Returns the worst offenders — symbols above a threshold and/or sorted by a
 * chosen dimension — along with a summary of overall repo health.
 */

import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { queryQualityMetrics, countSymbolsWithMetrics } from '../../core/db/symbol-store.js';
import { buildMeta } from './_meta.js';
import type { SymbolKind } from '../../core/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_quality_metrics';

export const description =
  'Return per-symbol code quality metrics (cyclomatic complexity, cognitive complexity, ' +
  'line count, parameter count, nesting depth) for an indexed repo. ' +
  'Use threshold filters to surface only the problematic symbols, and sortBy to rank ' +
  'by the dimension you care about most. Metrics are calculated at index time — zero ' +
  'overhead at query time. Only functions, methods, classes, and similar logic-carrying ' +
  'symbol kinds have metrics; constants and type aliases are excluded.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  scope: z
    .string()
    .optional()
    .describe('Directory prefix filter (e.g. "src/core/") — narrows to that subtree'),
  kind: z
    .enum([
      'function', 'class', 'method', 'const', 'type', 'interface', 'enum',
      'component', 'composable', 'hook', 'route', 'decorator', 'middleware',
      'model', 'view', 'struct', 'macro', 'signal', 'namespace', 'widget',
    ])
    .optional()
    .describe('Filter to a specific symbol kind'),
  sortBy: z
    .enum(['complexity', 'size', 'nesting', 'params'])
    .optional()
    .describe(
      'Sort dimension: "complexity" (cyclomatic, default), "size" (line count), ' +
      '"nesting" (max nesting depth), "params" (parameter count)',
    ),
  threshold: z
    .object({
      cyclomaticComplexity: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Only return symbols with cyclomatic complexity ≥ this value'),
      lineCount: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Only return symbols with line count ≥ this value'),
      nestingDepth: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Only return symbols with nesting depth ≥ this value'),
    })
    .optional()
    .describe('Return only symbols that meet ALL specified threshold conditions'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Maximum number of results to return (default 20)'),
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface SymbolQualityRecord {
  symbolId: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  lineCount: number;
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  paramCount: number;
  returnCount: number;
  nestingDepth: number;
  qualityScore: number;
  riskLevel: 'good' | 'moderate' | 'high' | 'critical';
}

interface GetQualityMetricsOutput {
  repoId: string;
  symbolsAnalyzed: number;
  worstOffenders: SymbolQualityRecord[];
  summary: {
    avgComplexity: number;
    avgLineCount: number;
    criticalCount: number;
    goodCount: number;
  };
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Quality score helpers ────────────────────────────────────────────────────

/**
 * Composite quality score 0–100 (higher = worse).
 *
 * Normalized weights:
 *   cyclomatic (40%) — ceiling at 50 (CC ≥ 50 → max score for this dimension)
 *   line count  (30%) — ceiling at 200 lines
 *   nesting     (20%) — ceiling at 10 levels
 *   param count (10%) — ceiling at 10 params
 */
function computeQualityScore(r: SymbolQualityRecord): number {
  const cc = Math.min(r.cyclomaticComplexity / 50, 1) * 100;
  const lc = Math.min(r.lineCount / 200, 1) * 100;
  const nd = Math.min(r.nestingDepth / 10, 1) * 100;
  const pc = Math.min(r.paramCount / 10, 1) * 100;
  return Math.round(cc * 0.4 + lc * 0.3 + nd * 0.2 + pc * 0.1);
}

function riskLevel(score: number): SymbolQualityRecord['riskLevel'] {
  if (score < 25) return 'good';
  if (score < 50) return 'moderate';
  if (score < 75) return 'high';
  return 'critical';
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  scope?: string;
  kind?: SymbolKind;
  sortBy?: 'complexity' | 'size' | 'nesting' | 'params';
  threshold?: {
    cyclomaticComplexity?: number;
    lineCount?: number;
    nestingDepth?: number;
  };
  limit?: number;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, scope, kind, sortBy, threshold, limit = 20 } = args;

  const db = openDatabase(repoId);

  try {
    const rows = queryQualityMetrics(db, repoId, { scope, kind, sortBy, threshold, limit });
    const symbolsAnalyzed = countSymbolsWithMetrics(db, repoId);

    const worstOffenders: SymbolQualityRecord[] = rows.map((r) => {
      const base: SymbolQualityRecord = {
        symbolId: r.id,
        name: r.name,
        kind: r.kind as SymbolKind,
        filePath: r.file_path,
        lineCount: r.line_count,
        cyclomaticComplexity: r.cyclomatic_complexity,
        cognitiveComplexity: r.cognitive_complexity,
        paramCount: r.param_count,
        returnCount: r.return_count,
        nestingDepth: r.nesting_depth,
        qualityScore: 0,
        riskLevel: 'good',
      };
      base.qualityScore = computeQualityScore(base);
      base.riskLevel = riskLevel(base.qualityScore);
      return base;
    });

    // Summary stats across all worst-offenders returned
    const avgComplexity =
      worstOffenders.length > 0
        ? Math.round(
            worstOffenders.reduce((s, r) => s + r.cyclomaticComplexity, 0) /
              worstOffenders.length,
          )
        : 0;
    const avgLineCount =
      worstOffenders.length > 0
        ? Math.round(
            worstOffenders.reduce((s, r) => s + r.lineCount, 0) / worstOffenders.length,
          )
        : 0;
    const criticalCount = worstOffenders.filter((r) => r.riskLevel === 'critical').length;
    const goodCount = worstOffenders.filter((r) => r.riskLevel === 'good').length;

    const output: GetQualityMetricsOutput = {
      repoId,
      symbolsAnalyzed,
      worstOffenders,
      summary: { avgComplexity, avgLineCount, criticalCount, goodCount },
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    };
  } finally {
    db.close();
  }
}
