/**
 * find_refactoring_opportunities tool — identify actionable refactoring opportunities
 * from indexed quality metrics and dependency data.
 *
 * Types detected:
 *   extract_function           — line_count > 50 AND cyclomatic_complexity > 10
 *   introduce_parameter_object — param_count > 5
 *   extract_class              — file with symbol_count > 15 of mixed kinds
 *   inline_function            — line_count <= 3 AND imported by exactly 1 file
 *   consolidate_duplicates     — HNSW similarity > 0.92 (skipped if no index)
 *   simplify_conditional       — nesting_depth > 4 AND return_count > 3
 */

import { z } from 'zod';
import type Database from 'better-sqlite3';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { countEmbeddings, loadEmbeddings } from '../../core/db/embedding-store.js';
import { cosineSimilarity } from './detect-antipatterns.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ─── Public constants (exported for tests) ────────────────────────────────────

export const EXTRACT_FUNCTION_LINE_THRESHOLD = 50;
export const EXTRACT_FUNCTION_CC_THRESHOLD = 10;
export const INTRODUCE_PARAM_OBJECT_THRESHOLD = 5;
export const EXTRACT_CLASS_SYMBOL_COUNT_THRESHOLD = 15;
export const INLINE_FUNCTION_MAX_LINES = 3;
export const CONSOLIDATE_SIMILARITY_THRESHOLD = 0.92;
export const SIMPLIFY_NESTING_THRESHOLD = 4;
export const SIMPLIFY_RETURN_THRESHOLD = 3;

// ─── Tool exports ─────────────────────────────────────────────────────────────

export const name = 'find_refactoring_opportunities';

export const description =
  'Identify actionable refactoring opportunities in an indexed repo using stored quality metrics ' +
  '(from get_quality_metrics) and dependency data. Detects: functions that are too long/complex ' +
  '(extract_function), excessive parameters (introduce_parameter_object), over-loaded files ' +
  '(extract_class), trivial single-callsite wrappers (inline_function), near-duplicate functions ' +
  '(consolidate_duplicates — requires semantic index), and deeply nested conditionals ' +
  '(simplify_conditional). Results are sorted by impact descending, effort ascending.';

const refactoringTypeEnum = z.enum([
  'extract_function',
  'introduce_parameter_object',
  'extract_class',
  'inline_function',
  'consolidate_duplicates',
  'simplify_conditional',
]);

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  scope: z
    .string()
    .optional()
    .describe('Directory prefix filter (e.g. "src/core/") — narrows to that subtree'),
  types: z
    .array(refactoringTypeEnum)
    .optional()
    .describe('Specific refactoring types to detect (default: all types)'),
  minImpact: z
    .enum(['low', 'medium', 'high'])
    .optional()
    .describe('Minimum impact level to include (default: low — all results)'),
};

// ─── Internal types ───────────────────────────────────────────────────────────

type RefactoringType = z.infer<typeof refactoringTypeEnum>;
type Impact = 'low' | 'medium' | 'high';
type Effort = 'trivial' | 'small' | 'medium' | 'large';

interface RefactoringOpportunity {
  type: RefactoringType;
  impact: Impact;
  symbolId: string;
  symbolName: string;
  filePath: string;
  description: string;
  suggestion: string;
  effort: Effort;
}

interface FindRefactoringOpportunitiesOutput {
  repoId: string;
  totalOpportunities: number;
  opportunities: RefactoringOpportunity[];
  estimatedImpact: string;
  notes: string[];
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Row types ────────────────────────────────────────────────────────────────

interface MetricRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  line_count: number | null;
  cyclomatic_complexity: number | null;
  param_count: number | null;
  return_count: number | null;
  nesting_depth: number | null;
}

interface FileSymbolCountRow {
  file_path: string;
  symbol_count: number;
  kind_count: number;
}

interface ImporterCountRow {
  target_file: string;
  importer_count: number;
}

interface TinyFunctionRow {
  id: string;
  name: string;
  file_path: string;
  line_count: number;
}

interface EmbeddingSymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
}

// ─── Effort heuristic ────────────────────────────────────────────────────────

/**
 * Estimate effort based on line count of the symbol to refactor.
 * Larger symbols = more effort.
 */
export function estimateEffort(lineCount: number): Effort {
  if (lineCount <= 10) return 'trivial';
  if (lineCount <= 30) return 'small';
  if (lineCount <= 100) return 'medium';
  return 'large';
}

// ─── Impact ordering helper ──────────────────────────────────────────────────

const IMPACT_ORDER: Record<Impact, number> = { low: 0, medium: 1, high: 2 };
const EFFORT_ORDER: Record<Effort, number> = { trivial: 0, small: 1, medium: 2, large: 3 };

// ─── Detection functions ──────────────────────────────────────────────────────

export function detectExtractFunction(
  db: Database.Database,
  repoId: string,
  scope?: string,
): RefactoringOpportunity[] {
  const parts = ['repo_id = ?', 'line_count IS NOT NULL', 'line_count > ?', 'cyclomatic_complexity > ?',
    "kind IN ('function', 'method', 'hook', 'composable', 'middleware', 'route')"];
  const params: unknown[] = [repoId, EXTRACT_FUNCTION_LINE_THRESHOLD, EXTRACT_FUNCTION_CC_THRESHOLD];

  if (scope) { parts.push('file_path LIKE ?'); params.push(`${scope}%`); }

  const rows = db
    .prepare<unknown[], MetricRow>(
      `SELECT id, name, kind, file_path, line_count, cyclomatic_complexity, param_count, return_count, nesting_depth
       FROM symbols WHERE ${parts.join(' AND ')} ORDER BY cyclomatic_complexity DESC`,
    )
    .all(...params);

  return rows.map((row) => {
    const lc = row.line_count ?? 0;
    const cc = row.cyclomatic_complexity ?? 0;
    const impact: Impact = cc > 30 || lc > 150 ? 'high' : cc > 15 || lc > 80 ? 'medium' : 'low';
    return {
      type: 'extract_function',
      impact,
      symbolId: row.id,
      symbolName: row.name,
      filePath: row.file_path,
      description: `"${row.name}" has ${lc} lines and cyclomatic complexity ${cc}`,
      suggestion:
        `Break "${row.name}" into smaller helper functions — identify cohesive sub-tasks ` +
        `(e.g. validation, data transformation, I/O) and extract each into its own named function.`,
      effort: estimateEffort(lc),
    };
  });
}

export function detectIntroduceParameterObject(
  db: Database.Database,
  repoId: string,
  scope?: string,
): RefactoringOpportunity[] {
  const parts = ['repo_id = ?', 'param_count IS NOT NULL', 'param_count > ?',
    "kind IN ('function', 'method', 'hook', 'composable', 'middleware', 'route')"];
  const params: unknown[] = [repoId, INTRODUCE_PARAM_OBJECT_THRESHOLD];

  if (scope) { parts.push('file_path LIKE ?'); params.push(`${scope}%`); }

  const rows = db
    .prepare<unknown[], MetricRow>(
      `SELECT id, name, kind, file_path, line_count, param_count, cyclomatic_complexity, return_count, nesting_depth
       FROM symbols WHERE ${parts.join(' AND ')} ORDER BY param_count DESC`,
    )
    .all(...params);

  return rows.map((row) => {
    const pc = row.param_count ?? 0;
    const impact: Impact = pc > 10 ? 'high' : pc > 7 ? 'medium' : 'low';
    return {
      type: 'introduce_parameter_object',
      impact,
      symbolId: row.id,
      symbolName: row.name,
      filePath: row.file_path,
      description: `"${row.name}" has ${pc} parameters`,
      suggestion:
        `Group the parameters of "${row.name}" into a typed options object ` +
        `(e.g. \`options: ${row.name.charAt(0).toUpperCase() + row.name.slice(1)}Options\`). ` +
        `This improves call-site readability and makes optional arguments easier to add.`,
      effort: estimateEffort(row.line_count ?? 0),
    };
  });
}

export function detectExtractClass(
  db: Database.Database,
  repoId: string,
  scope?: string,
): RefactoringOpportunity[] {
  const parts = ['repo_id = ?'];
  const params: unknown[] = [repoId];

  if (scope) { parts.push('file_path LIKE ?'); params.push(`${scope}%`); }

  // Files with > 15 symbols AND multiple distinct kinds (mixed responsibilities)
  const rows = db
    .prepare<unknown[], FileSymbolCountRow>(
      `SELECT file_path,
              COUNT(*) AS symbol_count,
              COUNT(DISTINCT kind) AS kind_count
       FROM symbols
       WHERE ${parts.join(' AND ')}
       GROUP BY file_path
       HAVING COUNT(*) > ? AND COUNT(DISTINCT kind) >= 3
       ORDER BY symbol_count DESC`,
    )
    .all(...params, EXTRACT_CLASS_SYMBOL_COUNT_THRESHOLD);

  return rows.map((row) => {
    const impact: Impact = row.symbol_count > 30 ? 'high' : row.symbol_count > 20 ? 'medium' : 'low';
    return {
      type: 'extract_class',
      impact,
      symbolId: '',
      symbolName: row.file_path,
      filePath: row.file_path,
      description:
        `"${row.file_path}" contains ${row.symbol_count} symbols of ${row.kind_count} different kinds`,
      suggestion:
        `Identify cohesive groups of symbols in "${row.file_path}" and extract each group ` +
        `into its own focused module or class. Each module should have a single responsibility.`,
      effort: row.symbol_count > 30 ? 'large' : 'medium',
    };
  });
}

export function detectInlineFunction(
  db: Database.Database,
  repoId: string,
  scope?: string,
): RefactoringOpportunity[] {
  const parts = ['s.repo_id = ?', 's.line_count IS NOT NULL', `s.line_count <= ${INLINE_FUNCTION_MAX_LINES}`,
    "s.kind IN ('function', 'method', 'hook', 'composable')"];
  const params: unknown[] = [repoId];

  if (scope) { parts.push('s.file_path LIKE ?'); params.push(`${scope}%`); }

  // Find small functions
  const tiny = db
    .prepare<unknown[], TinyFunctionRow>(
      `SELECT id, name, file_path, line_count FROM symbols s
       WHERE ${parts.join(' AND ')}`,
    )
    .all(...params);

  if (tiny.length === 0) return [];

  // For each tiny function, check how many files import its file
  const importerCounts = db
    .prepare<[string, string], ImporterCountRow>(
      `SELECT target_file, COUNT(DISTINCT source_file) AS importer_count
       FROM dep_edges
       WHERE repo_id = ? AND target_file = ?`,
    );

  const results: RefactoringOpportunity[] = [];
  for (const row of tiny) {
    const countRow = importerCounts.get(repoId, row.file_path);
    if (countRow && countRow.importer_count === 1) {
      results.push({
        type: 'inline_function',
        impact: 'low',
        symbolId: row.id,
        symbolName: row.name,
        filePath: row.file_path,
        description: `"${row.name}" is only ${row.line_count} line(s) long and its file is imported by exactly 1 file`,
        suggestion:
          `Inline "${row.name}" at its single call site to reduce indirection. ` +
          `If the name adds clarity, consider a well-named local variable instead.`,
        effort: 'trivial',
      });
    }
  }
  return results;
}

export function detectSimplifyConditional(
  db: Database.Database,
  repoId: string,
  scope?: string,
): RefactoringOpportunity[] {
  const parts = ['repo_id = ?', 'nesting_depth IS NOT NULL', 'return_count IS NOT NULL',
    `nesting_depth > ${SIMPLIFY_NESTING_THRESHOLD}`, `return_count > ${SIMPLIFY_RETURN_THRESHOLD}`,
    "kind IN ('function', 'method', 'hook', 'composable', 'middleware', 'route')"];
  const params: unknown[] = [repoId];

  if (scope) { parts.push('file_path LIKE ?'); params.push(`${scope}%`); }

  const rows = db
    .prepare<unknown[], MetricRow>(
      `SELECT id, name, kind, file_path, line_count, nesting_depth, return_count, cyclomatic_complexity, param_count
       FROM symbols WHERE ${parts.join(' AND ')} ORDER BY nesting_depth DESC`,
    )
    .all(...params);

  return rows.map((row) => {
    const nd = row.nesting_depth ?? 0;
    const rc = row.return_count ?? 0;
    const impact: Impact = nd > 7 ? 'high' : nd > 5 ? 'medium' : 'low';
    return {
      type: 'simplify_conditional',
      impact,
      symbolId: row.id,
      symbolName: row.name,
      filePath: row.file_path,
      description: `"${row.name}" has nesting depth ${nd} and ${rc} return statements`,
      suggestion:
        `Refactor "${row.name}" using early returns (guard clauses) to invert conditionals and ` +
        `reduce nesting. Extract deeply nested blocks into helper functions with descriptive names.`,
      effort: estimateEffort(row.line_count ?? 0),
    };
  });
}

async function detectConsolidateDuplicates(
  db: Database.Database,
  repoId: string,
  scope: string | undefined,
  notes: string[],
): Promise<RefactoringOpportunity[]> {
  const embeddingCount = countEmbeddings(db, repoId);
  if (embeddingCount === 0) {
    notes.push(
      'consolidate_duplicates check skipped: no semantic index found. ' +
        'Run index_folder with semantic.enabled=true to enable this check.',
    );
    return [];
  }

  const embeddings = loadEmbeddings(db, repoId);
  let symbolIds = Array.from(embeddings.keys());

  if (symbolIds.length > 2000) {
    notes.push(
      `consolidate_duplicates: limited to first 2000 symbols (repo has ${symbolIds.length} embeddings) ` +
        'to avoid excessive computation.',
    );
    symbolIds = symbolIds.slice(0, 2000);
  }

  if (symbolIds.length < 2) return [];

  const placeholders = symbolIds.map(() => '?').join(',');
  const scopeClause = scope ? ` AND file_path LIKE '${scope.replace(/'/g, "''")}%'` : '';
  const rows = db
    .prepare<string[], EmbeddingSymbolRow>(
      `SELECT id, name, kind, file_path FROM symbols
       WHERE id IN (${placeholders}) AND kind IN ('function', 'method', 'hook', 'composable')${scopeClause}`,
    )
    .all(...symbolIds);

  // Group by kind for comparison
  const byKind = new Map<string, EmbeddingSymbolRow[]>();
  for (const row of rows) {
    if (!byKind.has(row.kind)) byKind.set(row.kind, []);
    byKind.get(row.kind)!.push(row);
  }

  const opportunities: RefactoringOpportunity[] = [];
  const reportedPairs = new Set<string>();

  for (const [, kindRows] of byKind) {
    for (let i = 0; i < kindRows.length; i++) {
      for (let j = i + 1; j < kindRows.length; j++) {
        const a = kindRows[i]!;
        const b = kindRows[j]!;
        if (a.file_path === b.file_path) continue;

        const vecA = embeddings.get(a.id);
        const vecB = embeddings.get(b.id);
        if (!vecA || !vecB) continue;

        const sim = cosineSimilarity(vecA, vecB);
        if (sim >= CONSOLIDATE_SIMILARITY_THRESHOLD) {
          const pairKey = [a.id, b.id].sort().join(':');
          if (!reportedPairs.has(pairKey)) {
            reportedPairs.add(pairKey);
            opportunities.push({
              type: 'consolidate_duplicates',
              impact: 'medium',
              symbolId: a.id,
              symbolName: a.name,
              filePath: a.file_path,
              description:
                `"${a.name}" and "${b.name}" are ${(sim * 100).toFixed(1)}% similar ` +
                `(threshold: ${(CONSOLIDATE_SIMILARITY_THRESHOLD * 100).toFixed(0)}%)`,
              suggestion:
                `Extract shared logic from "${a.name}" and "${b.name}" into a common utility function. ` +
                `Small differences can often be parameterized. Found in: ${b.file_path}`,
              effort: 'small',
            });
          }
        }
      }
    }
  }

  return opportunities;
}

// ─── Impact summary ───────────────────────────────────────────────────────────

function buildEstimatedImpact(opportunities: RefactoringOpportunity[]): string {
  if (opportunities.length === 0) return 'No refactoring opportunities detected.';

  const high = opportunities.filter((o) => o.impact === 'high').length;
  const medium = opportunities.filter((o) => o.impact === 'medium').length;
  const types = new Set(opportunities.map((o) => o.type));

  const parts: string[] = [];
  if (high > 0) parts.push(`${high} high-impact issue${high === 1 ? '' : 's'}`);
  if (medium > 0) parts.push(`${medium} medium-impact issue${medium === 1 ? '' : 's'}`);

  const trivialCount = opportunities.filter((o) => o.effort === 'trivial' || o.effort === 'small').length;
  if (trivialCount > 0) {
    parts.push(`${trivialCount} quick win${trivialCount === 1 ? '' : 's'} (trivial/small effort)`);
  }

  const typeList = Array.from(types).join(', ');
  return `${opportunities.length} opportunities across ${types.size} type${types.size === 1 ? '' : 's'} (${typeList}). ` +
    (parts.length > 0 ? parts.join(', ') + '.' : '');
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  scope?: string;
  types?: RefactoringType[];
  minImpact?: Impact;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, scope, minImpact = 'low' } = args;

  const ALL_TYPES: RefactoringType[] = [
    'extract_function',
    'introduce_parameter_object',
    'extract_class',
    'inline_function',
    'consolidate_duplicates',
    'simplify_conditional',
  ];
  const activeTypes = args.types ?? ALL_TYPES;

  const db = openDatabase(repoId);

  try {
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Repo "${repoId}" not found` }) }],
        isError: true,
      };
    }

    const notes: string[] = [];
    const all: RefactoringOpportunity[] = [];

    if (activeTypes.includes('extract_function')) {
      all.push(...detectExtractFunction(db, repoId, scope));
    }
    if (activeTypes.includes('introduce_parameter_object')) {
      all.push(...detectIntroduceParameterObject(db, repoId, scope));
    }
    if (activeTypes.includes('extract_class')) {
      all.push(...detectExtractClass(db, repoId, scope));
    }
    if (activeTypes.includes('inline_function')) {
      all.push(...detectInlineFunction(db, repoId, scope));
    }
    if (activeTypes.includes('simplify_conditional')) {
      all.push(...detectSimplifyConditional(db, repoId, scope));
    }
    if (activeTypes.includes('consolidate_duplicates')) {
      all.push(...(await detectConsolidateDuplicates(db, repoId, scope, notes)));
    }

    // Apply minImpact filter
    const impactThreshold = IMPACT_ORDER[minImpact];
    const filtered = all.filter((o) => IMPACT_ORDER[o.impact] >= impactThreshold);

    // Sort: impact DESC, effort ASC (highest value, lowest effort first)
    filtered.sort((a, b) => {
      const impactDiff = IMPACT_ORDER[b.impact] - IMPACT_ORDER[a.impact];
      if (impactDiff !== 0) return impactDiff;
      return EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort];
    });

    const output: FindRefactoringOpportunitiesOutput = {
      repoId,
      totalOpportunities: filtered.length,
      opportunities: filtered,
      estimatedImpact: buildEstimatedImpact(filtered),
      notes,
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    };
  } finally {
    db.close();
  }
}
