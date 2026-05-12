/**
 * get-complexity-hotspots.ts
 *
 * MCP tool: get_complexity_hotspots
 *
 * Aggregates per-symbol complexity metrics to the file level and returns a
 * ranked list of the files with the highest complexity concentration. Use this
 * to answer "where should I focus refactoring effort?" — it surfaces files that
 * contain many complex symbols, deeply nested logic, or high average cyclomatic
 * complexity.
 *
 * Differs from related tools:
 *   get_quality_metrics    — per-symbol composite score, not file-level aggregation
 *   search_by_complexity   — threshold/range filter for individual symbols
 *   get_complexity_hotspots — file-level aggregation + hotspot ranking
 *
 * Designed for:
 *   - Identifying which files to tackle first in a refactoring sprint
 *   - Generating a "complexity heat map" for an architecture review
 *   - Spotting files that are growing too complex before they become unmaintainable
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SymbolKind } from '../../core/types.js';

export const name = 'get_complexity_hotspots';

export const description =
  'Aggregate per-symbol complexity metrics to the file level and return a ranked list ' +
  'of the files with the highest complexity concentration. Use this to answer ' +
  '"where should I focus refactoring effort?" — it surfaces files with many complex ' +
  'symbols, deeply nested logic, or high average cyclomatic complexity. ' +
  'Returns a hotspot score (0–100) per file, plus the top offending symbols within ' +
  'each hotspot file.' +
  '\n\nDiffers from related tools:' +
  '\n  get_quality_metrics    — per-symbol composite score ranked by worst symbols' +
  '\n  search_by_complexity   — threshold/range filtering of individual symbols' +
  '\n  get_debt_report        — broader tech-debt summary including comment density' +
  '\n  health_radar           — multi-dimensional health scores per file';

export const inputSchema = {
  repoId: z.string().describe('Repository ID returned by index_folder or list_repos'),
  scope: z
    .string()
    .optional()
    .describe(
      'Restrict to a directory prefix (e.g. "src/core/"). ' +
      'Omit to analyse the entire repo.',
    ),
  topN: z
    .number().int().min(1).max(100)
    .optional()
    .describe('Number of hotspot files to return (default 10)'),
  minComplexity: z
    .number().int().min(1)
    .optional()
    .describe(
      'Minimum cyclomatic complexity for a symbol to count as "complex" ' +
      'when computing the complex-symbol density for each file (default 5).',
    ),
  metric: z
    .enum(['complexity', 'cognitive', 'size', 'nesting', 'composite'])
    .optional()
    .describe(
      'Primary metric used to rank hotspot files. ' +
      '"complexity" = avg cyclomatic (default), ' +
      '"cognitive" = avg cognitive complexity, ' +
      '"size" = total line count, ' +
      '"nesting" = max nesting depth, ' +
      '"composite" = weighted hotspot score.',
    ),
  includeSymbols: z
    .boolean()
    .optional()
    .describe(
      'Include the top offending symbols within each hotspot file (default true). ' +
      'Set false for a compact file-level-only response.',
    ),
  symbolLimit: z
    .number().int().min(1).max(20)
    .optional()
    .describe('Max number of symbols to include per hotspot file (default 5). ' +
      'Symbols are ranked by cyclomatic complexity descending.'),
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
  line_count: number;
  cyclomatic_complexity: number;
  cognitive_complexity: number;
  nesting_depth: number;
  param_count: number;
  return_count: number;
}

interface FileStats {
  filePath: string;
  symbolCount: number;
  complexSymbolCount: number;
  avgCyclomaticComplexity: number;
  maxCyclomaticComplexity: number;
  avgCognitiveComplexity: number;
  maxCognitiveComplexity: number;
  avgNestingDepth: number;
  maxNestingDepth: number;
  avgLineCount: number;
  totalLineCount: number;
  hotspotScore: number;
}

interface HotspotSymbol {
  symbolId: string;
  name: string;
  kind: SymbolKind;
  startLine: number;
  signature: string;
  summary: string;
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  lineCount: number;
  nestingDepth: number;
}

interface HotspotFile extends FileStats {
  topSymbols?: HotspotSymbol[];
}

// ─── Hotspot score ────────────────────────────────────────────────────────────

/**
 * Composite hotspot score 0–100.
 *
 * Weights (must sum to 1.0):
 *   avg cyclomatic  (35%) — ceiling at 30 (avg CC ≥ 30 → max contribution)
 *   max cyclomatic  (30%) — ceiling at 50
 *   complex density (20%) — complexSymbols / symbolCount, ceiling 1.0
 *   max nesting     (15%) — ceiling at 10 levels
 */
function computeHotspotScore(stats: Omit<FileStats, 'hotspotScore'>): number {
  const avgCC = Math.min(stats.avgCyclomaticComplexity / 30, 1) * 100;
  const maxCC = Math.min(stats.maxCyclomaticComplexity / 50, 1) * 100;
  const density = stats.symbolCount > 0
    ? Math.min(stats.complexSymbolCount / stats.symbolCount, 1) * 100
    : 0;
  const nesting = Math.min(stats.maxNestingDepth / 10, 1) * 100;

  return Math.round(avgCC * 0.35 + maxCC * 0.30 + density * 0.20 + nesting * 0.15);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  scope?: string;
  topN?: number;
  minComplexity?: number;
  metric?: 'complexity' | 'cognitive' | 'size' | 'nesting' | 'composite';
  includeSymbols?: boolean;
  symbolLimit?: number;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    topN = 10,
    minComplexity = 5,
    metric = 'complexity',
    includeSymbols = true,
    symbolLimit = 5,
  } = args;

  const db = openDatabase(repoId);
  try {
    // ── Validate repo exists ───────────────────────────────────────────────────
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

    // ── Fetch all measurable symbols ───────────────────────────────────────────
    const conditions: string[] = [
      'repo_id = @repoId',
      'line_count IS NOT NULL',
    ];
    const params: Record<string, unknown> = { repoId };

    if (args.scope) {
      conditions.push('(file_path = @scope OR file_path LIKE @scopePrefix)');
      params['scope'] = args.scope;
      params['scopePrefix'] = args.scope.endsWith('/')
        ? `${args.scope}%`
        : `${args.scope}/%`;
    }

    const sql = `
      SELECT id, name, kind, file_path, start_byte, signature, summary,
             COALESCE(line_count, 0)            AS line_count,
             COALESCE(cyclomatic_complexity, 1)  AS cyclomatic_complexity,
             COALESCE(cognitive_complexity, 0)   AS cognitive_complexity,
             COALESCE(nesting_depth, 0)          AS nesting_depth,
             COALESCE(param_count, 0)            AS param_count,
             COALESCE(return_count, 0)           AS return_count
      FROM symbols
      WHERE ${conditions.join(' AND ')}
      ORDER BY file_path ASC, cyclomatic_complexity DESC
    `;

    const rows = db.prepare<Record<string, unknown>, SymbolRow>(sql).all(params);

    if (rows.length === 0) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            repoId,
            totalFilesAnalyzed: 0,
            hotspots: [],
            summary: {
              hotspotFileCount: 0,
              avgHotspotScore: 0,
              totalComplexSymbols: 0,
              totalSymbolsAnalyzed: 0,
            },
            _tokenEstimate: 10,
            _meta: buildMeta({ timingMs: Date.now() - t0 }),
          }),
        }],
      };
    }

    // ── Group symbols by file ──────────────────────────────────────────────────
    const fileMap = new Map<string, SymbolRow[]>();
    for (const row of rows) {
      const list = fileMap.get(row.file_path) ?? [];
      list.push(row);
      fileMap.set(row.file_path, list);
    }

    // ── Compute per-file stats ─────────────────────────────────────────────────
    const fileStatsList: FileStats[] = [];
    for (const [filePath, syms] of fileMap) {
      const symbolCount = syms.length;
      const complexSymbolCount = syms.filter(
        (s) => s.cyclomatic_complexity >= minComplexity,
      ).length;

      const avgCC = syms.reduce((s, r) => s + r.cyclomatic_complexity, 0) / symbolCount;
      const maxCC = Math.max(...syms.map((r) => r.cyclomatic_complexity));
      const avgCog = syms.reduce((s, r) => s + r.cognitive_complexity, 0) / symbolCount;
      const maxCog = Math.max(...syms.map((r) => r.cognitive_complexity));
      const avgND = syms.reduce((s, r) => s + r.nesting_depth, 0) / symbolCount;
      const maxND = Math.max(...syms.map((r) => r.nesting_depth));
      const avgLC = syms.reduce((s, r) => s + r.line_count, 0) / symbolCount;
      const totalLC = syms.reduce((s, r) => s + r.line_count, 0);

      const statsWithoutScore = {
        filePath,
        symbolCount,
        complexSymbolCount,
        avgCyclomaticComplexity: Math.round(avgCC * 10) / 10,
        maxCyclomaticComplexity: maxCC,
        avgCognitiveComplexity: Math.round(avgCog * 10) / 10,
        maxCognitiveComplexity: maxCog,
        avgNestingDepth: Math.round(avgND * 10) / 10,
        maxNestingDepth: maxND,
        avgLineCount: Math.round(avgLC * 10) / 10,
        totalLineCount: totalLC,
      };

      fileStatsList.push({
        ...statsWithoutScore,
        hotspotScore: computeHotspotScore(statsWithoutScore),
      });
    }

    // ── Sort by chosen metric ──────────────────────────────────────────────────
    fileStatsList.sort((a, b) => {
      switch (metric) {
        case 'cognitive': return b.avgCognitiveComplexity - a.avgCognitiveComplexity;
        case 'size':      return b.totalLineCount - a.totalLineCount;
        case 'nesting':   return b.maxNestingDepth - a.maxNestingDepth;
        case 'composite': return b.hotspotScore - a.hotspotScore;
        case 'complexity':
        default:          return b.avgCyclomaticComplexity - a.avgCyclomaticComplexity;
      }
    });

    const topFiles = fileStatsList.slice(0, topN);
    const totalFilesAnalyzed = fileStatsList.length;

    // ── Resolve start lines and attach top symbols ────────────────────────────
    const hotspots: HotspotFile[] = [];

    for (const stats of topFiles) {
      const hotspot: HotspotFile = { ...stats };

      if (includeSymbols) {
        const syms = fileMap.get(stats.filePath) ?? [];

        // Resolve start lines from file content (best-effort)
        const fileRow = db.prepare<[string, string], { raw_content: Buffer | null }>(
          'SELECT raw_content FROM files WHERE repo_id = ? AND path = ?',
        ).get(repoId, stats.filePath);

        const lineOf = (startByte: number): number => {
          if (fileRow?.raw_content) {
            const slice = fileRow.raw_content.slice(0, Math.min(startByte, fileRow.raw_content.length));
            let line = 1;
            for (let i = 0; i < slice.length; i++) {
              if (slice[i] === 0x0a) line++;
            }
            return line;
          }
          return Math.max(1, Math.floor(startByte / 80) + 1);
        };

        // Top symbols ranked by cyclomatic complexity
        const topSyms = [...syms]
          .sort((a, b) => b.cyclomatic_complexity - a.cyclomatic_complexity)
          .slice(0, symbolLimit);

        hotspot.topSymbols = topSyms.map((s) => ({
          symbolId: s.id,
          name: s.name,
          kind: s.kind as SymbolKind,
          startLine: lineOf(s.start_byte),
          signature: s.signature,
          summary: s.summary,
          cyclomaticComplexity: s.cyclomatic_complexity,
          cognitiveComplexity: s.cognitive_complexity,
          lineCount: s.line_count,
          nestingDepth: s.nesting_depth,
        }));
      }

      hotspots.push(hotspot);
    }

    // ── Summary stats ─────────────────────────────────────────────────────────
    const avgHotspotScore =
      topFiles.length > 0
        ? Math.round(topFiles.reduce((s, f) => s + f.hotspotScore, 0) / topFiles.length)
        : 0;
    const totalComplexSymbols = fileStatsList.reduce((s, f) => s + f.complexSymbolCount, 0);
    const totalSymbolsAnalyzed = rows.length;

    // ── Token estimate ─────────────────────────────────────────────────────────
    const responseBytes = hotspots.reduce((sum, h) => {
      const symBytes = (h.topSymbols ?? []).reduce(
        (s, sym) => s + sym.signature.length + sym.summary.length + 80,
        0,
      );
      return sum + h.filePath.length + 150 + symBytes;
    }, 0);
    const tokenEstimate = Math.ceil(responseBytes / 4);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(
          {
            repoId,
            totalFilesAnalyzed,
            rankedBy: metric,
            minComplexity,
            hotspots,
            summary: {
              hotspotFileCount: topFiles.length,
              avgHotspotScore,
              totalComplexSymbols,
              totalSymbolsAnalyzed,
            },
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
