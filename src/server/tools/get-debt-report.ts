/**
 * get-debt-report.ts
 *
 * MCP tool: get_debt_report
 *
 * Generate a comprehensive technical debt report for an indexed repo.
 * Aggregates signals from four debt dimensions:
 *
 *   complexity    — cyclomatic complexity, nesting depth, function length
 *   structural    — circular dependencies, high coupling, layer violations
 *   maintainability — dead code, god classes, long parameter lists
 *   volatility    — churn hotspots (requires git metadata)
 *
 * Produces:
 *   • An overall debt score (0–100, higher = more debt) with letter grade
 *   • Per-category scores with top issues
 *   • Top N debt files ranked by combined score across all dimensions
 *   • Prioritized action items sorted by estimated ROI
 *
 * All queries are read-only against the symbol and dep_edges tables — no
 * sub-tool calls. This keeps latency low and error handling simple.
 */

import { z } from 'zod';
import type Database from 'better-sqlite3';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getAllDepEdges, findDeadExports } from '../../core/db/dep-store.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DepEdge } from '../../core/types.js';

// ─── Tool exports ─────────────────────────────────────────────────────────────

export const name = 'get_debt_report';

export const description =
  'Generate a comprehensive technical debt report for an indexed repo. ' +
  'Aggregates complexity, structural, maintainability, and volatility signals ' +
  'into a single scored report with letter grade, per-category breakdown, ' +
  'top debt files, and prioritized action items. ' +
  'Use this for periodic debt reviews, CI gates, and architecture planning.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  scope: z
    .string()
    .optional()
    .describe('Directory prefix filter (e.g. "src/core/") — narrows analysis to that subtree'),
  topN: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Number of top debt files to return (default 10)'),
  includeChurn: z
    .boolean()
    .optional()
    .describe(
      'Include churn-based volatility debt (requires git metadata captured during indexing; default true)',
    ),
  format: z
    .enum(['summary', 'detailed'])
    .optional()
    .describe(
      '"summary" returns only scores and grade; ' +
      '"detailed" (default) includes top files and recommendations',
    ),
};

// ─── Internal types ───────────────────────────────────────────────────────────

interface DebtCategory {
  score: number;       // 0–100, higher = more debt
  itemCount: number;
  topIssues: string[];
}

interface DebtFile {
  filePath: string;
  debtScore: number;        // Combined 0–100
  complexityScore: number;
  structuralScore: number;
  maintainabilityScore: number;
  churnScore: number;
  issues: string[];
}

interface Recommendation {
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: 'complexity' | 'structural' | 'maintainability' | 'volatility';
  action: string;
  filePath?: string;
  estimatedImpact: string;
}

interface GetDebtReportOutput {
  repoId: string;
  generatedAt: string;
  overallDebtScore: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  categories: {
    complexity: DebtCategory;
    structural: DebtCategory;
    maintainability: DebtCategory;
    volatility: DebtCategory;
  };
  topDebtFiles: DebtFile[];
  recommendations: Recommendation[];
  summary: {
    totalFiles: number;
    totalSymbols: number;
    complexSymbols: number;
    circularDeps: number;
    deadExports: number;
    gitDataAvailable: boolean;
  };
  _tokenEstimate: number;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── DB row interfaces ────────────────────────────────────────────────────────

interface FileRow {
  path: string;
}

interface MetricRow {
  file_path: string;
  name: string;
  cyclomatic_complexity: number | null;
  nesting_depth: number | null;
  param_count: number | null;
  line_count: number | null;
}

interface CouplingRow {
  target_file: string;
  importer_count: number;
}

interface ClassRow {
  file_path: string;
  name: string;
  line_count: number | null;
}

interface ChurnRow {
  file_path: string;
  commit_count: number;
  unique_authors: number;
  last_commit_date: number;
}

// ─── Debt scoring constants ───────────────────────────────────────────────────

const CC_HIGH = 10;           // Cyclomatic complexity considered "high"
const CC_CRITICAL = 20;       // Cyclomatic complexity considered "critical"
const NESTING_HIGH = 4;
const PARAM_HIGH = 7;
const LINE_HIGH = 100;
const COUPLING_HIGH = 10;
const COUPLING_CRITICAL = 20;
const GOD_CLASS_LINES = 500;
const GOD_CLASS_METHODS = 20;
const CHURN_HIGH = 10;        // Commits in window to be "high churn"
const CHURN_CRITICAL = 25;    // Commits in window to be "critical churn"
const CHURN_WINDOW_DAYS = 90;
const CHURN_SINCE_MS = Date.now() - CHURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// ─── Graph helpers ────────────────────────────────────────────────────────────

function buildAdjacencyList(edges: DepEdge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adj.has(edge.sourceFile)) adj.set(edge.sourceFile, []);
    adj.get(edge.sourceFile)!.push(edge.targetFile);
    if (!adj.has(edge.targetFile)) adj.set(edge.targetFile, []);
  }
  return adj;
}

function detectCycles(adj: Map<string, string[]>): Set<string> {
  // Returns the set of files that are part of at least one cycle
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const cycleFiles = new Set<string>();

  for (const node of adj.keys()) color.set(node, WHITE);

  function dfs(startNode: string): void {
    const stack: Array<{ node: string; neighborIdx: number }> = [{ node: startNode, neighborIdx: 0 }];
    const path: string[] = [];
    const pathSet = new Set<string>();

    color.set(startNode, GRAY);
    path.push(startNode);
    pathSet.add(startNode);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const neighbors = adj.get(frame.node) ?? [];

      if (frame.neighborIdx >= neighbors.length) {
        color.set(frame.node, BLACK);
        path.pop();
        pathSet.delete(frame.node);
        stack.pop();
        continue;
      }

      const neighbor = neighbors[frame.neighborIdx]!;
      frame.neighborIdx++;

      const neighborColor = color.get(neighbor) ?? WHITE;

      if (neighborColor === WHITE) {
        color.set(neighbor, GRAY);
        path.push(neighbor);
        pathSet.add(neighbor);
        stack.push({ node: neighbor, neighborIdx: 0 });
      } else if (neighborColor === GRAY) {
        const cycleStart = path.indexOf(neighbor);
        for (const f of path.slice(cycleStart)) {
          cycleFiles.add(f);
        }
      }
    }
  }

  for (const node of adj.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) dfs(node);
  }

  return cycleFiles;
}

// ─── Category computers ───────────────────────────────────────────────────────

interface ComplexityResult {
  category: DebtCategory;
  fileScores: Map<string, number>;  // filePath → complexity debt score 0–100
  complexSymbols: number;
}

function computeComplexityDebt(
  db: Database.Database,
  repoId: string,
  scope: string | undefined,
): ComplexityResult {
  const scopeClause = scope ? `AND file_path LIKE ? || '%'` : '';
  const params: (string | number)[] = [repoId];
  if (scope) params.push(scope);

  const rows = db
    .prepare<(string | number)[], MetricRow>(
      `SELECT file_path, name, cyclomatic_complexity, nesting_depth, param_count, line_count
       FROM symbols
       WHERE repo_id = ?
         ${scopeClause}
         AND kind IN ('function','method','hook','composable','middleware','route')
         AND (cyclomatic_complexity IS NOT NULL OR nesting_depth IS NOT NULL OR param_count IS NOT NULL)`,
    )
    .all(...params);

  const fileScores = new Map<string, number>();
  const issues: string[] = [];
  let complexSymbols = 0;
  let criticalCount = 0;

  for (const row of rows) {
    const cc = row.cyclomatic_complexity ?? 0;
    const nd = row.nesting_depth ?? 0;
    const pc = row.param_count ?? 0;
    const lc = row.line_count ?? 0;

    // Per-symbol score: weighted sum of normalized dimensions
    const ccScore = Math.min(cc / CC_CRITICAL, 1) * 100;
    const ndScore = Math.min(nd / NESTING_HIGH, 1) * 100;
    const pcScore = Math.min(pc / PARAM_HIGH, 1) * 100;
    const lcScore = Math.min(lc / LINE_HIGH, 1) * 100;
    const symbolScore = ccScore * 0.5 + ndScore * 0.25 + pcScore * 0.15 + lcScore * 0.1;

    const prev = fileScores.get(row.file_path) ?? 0;
    fileScores.set(row.file_path, Math.max(prev, symbolScore));

    if (cc >= CC_HIGH) {
      complexSymbols++;
      const label = cc >= CC_CRITICAL ? 'critical' : 'high';
      if (issues.length < 5) {
        issues.push(`${label} complexity in "${row.name}" (CC=${cc}) at ${row.file_path}`);
      }
    }
    if (cc >= CC_CRITICAL) criticalCount++;
  }

  const fileScopeCount = fileScores.size || 1;
  const avgFileScore =
    Array.from(fileScores.values()).reduce((s, v) => s + v, 0) / fileScopeCount;

  // Category score: weighted blend of avg and max debt
  const maxScore = Math.max(0, ...fileScores.values());
  const categoryScore = Math.round(avgFileScore * 0.6 + maxScore * 0.4);

  return {
    category: {
      score: Math.min(100, categoryScore),
      itemCount: complexSymbols,
      topIssues: issues,
    },
    fileScores,
    complexSymbols,
  };
}

interface StructuralResult {
  category: DebtCategory;
  fileScores: Map<string, number>;
  cycleFiles: Set<string>;
  couplingRows: CouplingRow[];
  circularDeps: number;
}

function computeStructuralDebt(
  db: Database.Database,
  repoId: string,
  scope: string | undefined,
): StructuralResult {
  const edges = getAllDepEdges(db, repoId);
  const scopedEdges = scope
    ? edges.filter(
        (e) => e.sourceFile.startsWith(scope) || e.targetFile.startsWith(scope),
      )
    : edges;

  const adj = buildAdjacencyList(scopedEdges);
  const cycleFiles = detectCycles(adj);

  // High-coupling: count unique importers per target file
  const importersByTarget = new Map<string, Set<string>>();
  for (const edge of scopedEdges) {
    if (!importersByTarget.has(edge.targetFile)) {
      importersByTarget.set(edge.targetFile, new Set());
    }
    importersByTarget.get(edge.targetFile)!.add(edge.sourceFile);
  }

  const couplingRows: CouplingRow[] = Array.from(importersByTarget.entries())
    .map(([target_file, importers]) => ({ target_file, importer_count: importers.size }))
    .filter((r) => r.importer_count > COUPLING_HIGH)
    .sort((a, b) => b.importer_count - a.importer_count);

  const fileScores = new Map<string, number>();

  // Cycle files get 80–100 structural score
  for (const f of cycleFiles) {
    if (!scope || f.startsWith(scope)) {
      fileScores.set(f, 80);
    }
  }

  // Coupling files
  for (const row of couplingRows) {
    const score =
      row.importer_count >= COUPLING_CRITICAL
        ? 90
        : Math.min(79, Math.round((row.importer_count / COUPLING_CRITICAL) * 79));
    const prev = fileScores.get(row.target_file) ?? 0;
    fileScores.set(row.target_file, Math.max(prev, score));
  }

  const issues: string[] = [];
  if (cycleFiles.size > 0) {
    issues.push(`${cycleFiles.size} file(s) involved in circular dependencies`);
  }
  for (const row of couplingRows.slice(0, 3)) {
    issues.push(
      `"${row.target_file}" has ${row.importer_count} importers (high coupling)`,
    );
  }

  const avgScore =
    fileScores.size > 0
      ? Array.from(fileScores.values()).reduce((s, v) => s + v, 0) / fileScores.size
      : 0;
  const maxScore = fileScores.size > 0 ? Math.max(...fileScores.values()) : 0;
  const categoryScore = Math.round(avgScore * 0.5 + maxScore * 0.5);

  return {
    category: {
      score: Math.min(100, categoryScore),
      itemCount: cycleFiles.size + couplingRows.length,
      topIssues: issues,
    },
    fileScores,
    cycleFiles,
    couplingRows,
    circularDeps: cycleFiles.size > 0 ? 1 : 0, // at least one cycle group
  };
}

interface MaintainabilityResult {
  category: DebtCategory;
  fileScores: Map<string, number>;
  deadExports: number;
}

function computeMaintainabilityDebt(
  db: Database.Database,
  repoId: string,
  scope: string | undefined,
): MaintainabilityResult {
  const fileScores = new Map<string, number>();
  const issues: string[] = [];
  let itemCount = 0;

  // Dead exports
  const deadSymbols = findDeadExports(db, repoId);
  const deadByFile = new Map<string, number>();
  for (const sym of deadSymbols) {
    if (scope && !sym.filePath.startsWith(scope)) continue;
    deadByFile.set(sym.filePath, (deadByFile.get(sym.filePath) ?? 0) + 1);
  }
  for (const [fp, count] of deadByFile) {
    const score = Math.min(50, count * 10);
    const prev = fileScores.get(fp) ?? 0;
    fileScores.set(fp, Math.max(prev, score));
    itemCount++;
  }
  if (deadByFile.size > 0) {
    issues.push(
      `${deadByFile.size} file(s) with unreferenced exports (dead code)`,
    );
  }

  // God classes — by line count
  const scopeClause = scope ? `AND file_path LIKE ? || '%'` : '';
  const params: (string | number)[] = [repoId, GOD_CLASS_LINES];
  if (scope) params.push(scope);

  const godClasses = db
    .prepare<(string | number)[], ClassRow>(
      `SELECT file_path, name, line_count
       FROM symbols
       WHERE repo_id = ? AND kind = 'class' AND line_count > ?
         ${scopeClause}
       ORDER BY line_count DESC`,
    )
    .all(...params);

  for (const row of godClasses) {
    const score = Math.min(100, Math.round(((row.line_count ?? 0) / GOD_CLASS_LINES) * 70));
    const prev = fileScores.get(row.file_path) ?? 0;
    fileScores.set(row.file_path, Math.max(prev, score));
    itemCount++;
  }
  if (godClasses.length > 0) {
    issues.push(
      ...godClasses
        .slice(0, 3)
        .map((r) => `God class "${r.name}" (${r.line_count} lines) in ${r.file_path}`),
    );
  }

  // Files with too many methods (god class by method count)
  const methodParams: (string | number)[] = [repoId, GOD_CLASS_METHODS];
  if (scope) methodParams.push(scope);
  const methodScopeClause = scope ? `AND file_path LIKE ? || '%'` : '';

  interface MethodCountRow { file_path: string; method_count: number }
  const highMethodFiles = db
    .prepare<(string | number)[], MethodCountRow>(
      `SELECT file_path, COUNT(*) AS method_count
       FROM symbols
       WHERE repo_id = ? AND kind = 'method' ${methodScopeClause}
       GROUP BY file_path
       HAVING COUNT(*) > ?`,
    )
    .all(...methodParams);

  for (const row of highMethodFiles) {
    const score = Math.min(90, Math.round((row.method_count / GOD_CLASS_METHODS) * 70));
    const prev = fileScores.get(row.file_path) ?? 0;
    fileScores.set(row.file_path, Math.max(prev, score));
    itemCount++;
    if (issues.length < 5) {
      issues.push(
        `"${row.file_path}" has ${row.method_count} methods (god class by method count)`,
      );
    }
  }

  const avgScore =
    fileScores.size > 0
      ? Array.from(fileScores.values()).reduce((s, v) => s + v, 0) / fileScores.size
      : 0;
  const maxScore = fileScores.size > 0 ? Math.max(...fileScores.values()) : 0;
  const categoryScore = Math.round(avgScore * 0.6 + maxScore * 0.4);

  return {
    category: {
      score: Math.min(100, categoryScore),
      itemCount,
      topIssues: issues.slice(0, 5),
    },
    fileScores,
    deadExports: deadByFile.size,
  };
}

interface VolatilityResult {
  category: DebtCategory;
  fileScores: Map<string, number>;
  available: boolean;
}

function computeVolatilityDebt(
  db: Database.Database,
  repoId: string,
  scope: string | undefined,
): VolatilityResult {
  const fileScores = new Map<string, number>();

  // Check if git_metadata has any data for this repo
  const hasGit = db
    .prepare<[string], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM git_metadata WHERE repo_id = ? LIMIT 1`,
    )
    .get(repoId);

  if (!hasGit || hasGit.cnt === 0) {
    return {
      category: { score: 0, itemCount: 0, topIssues: ['No git metadata available'] },
      fileScores,
      available: false,
    };
  }

  const scopeClause = scope ? `AND file_path LIKE ? || '%'` : '';
  const params: (string | number)[] = [repoId, Math.floor(CHURN_SINCE_MS / 1000)];
  if (scope) params.push(scope);

  const churnRows = db
    .prepare<(string | number)[], ChurnRow>(
      `SELECT
         file_path,
         COUNT(DISTINCT commit_sha) AS commit_count,
         COUNT(DISTINCT author_email) AS unique_authors,
         MAX(commit_date) AS last_commit_date
       FROM git_metadata
       WHERE repo_id = ? AND commit_date >= ?
         ${scopeClause}
       GROUP BY file_path
       HAVING COUNT(DISTINCT commit_sha) > 0
       ORDER BY commit_count DESC`,
    )
    .all(...params);

  const issues: string[] = [];
  let hotspots = 0;

  for (const row of churnRows) {
    const cc = row.commit_count;
    const score =
      cc >= CHURN_CRITICAL
        ? 100
        : Math.round((cc / CHURN_CRITICAL) * 100);
    fileScores.set(row.file_path, score);

    if (cc >= CHURN_HIGH) {
      hotspots++;
      if (issues.length < 5) {
        issues.push(
          `"${row.file_path}" changed ${cc} times in ${CHURN_WINDOW_DAYS} days by ${row.unique_authors} author(s)`,
        );
      }
    }
  }

  const avgScore =
    fileScores.size > 0
      ? Array.from(fileScores.values()).reduce((s, v) => s + v, 0) / fileScores.size
      : 0;
  const maxScore = fileScores.size > 0 ? Math.max(...fileScores.values()) : 0;
  const categoryScore = Math.round(avgScore * 0.4 + maxScore * 0.6);

  return {
    category: {
      score: Math.min(100, categoryScore),
      itemCount: hotspots,
      topIssues: issues,
    },
    fileScores,
    available: true,
  };
}

// ─── Grade and recommendation helpers ────────────────────────────────────────

function debtGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score < 20) return 'A';
  if (score < 40) return 'B';
  if (score < 60) return 'C';
  if (score < 80) return 'D';
  return 'F';
}

function buildRecommendations(
  complexityResult: ComplexityResult,
  structuralResult: StructuralResult,
  maintainabilityResult: MaintainabilityResult,
  volatilityResult: VolatilityResult,
  topDebtFiles: DebtFile[],
): Recommendation[] {
  const recs: Recommendation[] = [];

  // Structural — circular dependencies (always critical)
  if (structuralResult.cycleFiles.size > 0) {
    recs.push({
      priority: 'critical',
      category: 'structural',
      action:
        `Break ${structuralResult.circularDeps} circular dependency cycle(s). ` +
        'Extract shared types into a separate module that both sides can import.',
      estimatedImpact: 'Eliminates build risk and enables tree-shaking',
    });
  }

  // Structural — high coupling
  const worstCoupling = structuralResult.couplingRows[0];
  if (worstCoupling) {
    recs.push({
      priority: worstCoupling.importer_count >= COUPLING_CRITICAL ? 'critical' : 'high',
      category: 'structural',
      filePath: worstCoupling.target_file,
      action:
        `Split "${worstCoupling.target_file}" — it is imported by ${worstCoupling.importer_count} files. ` +
        'Create focused sub-modules with explicit barrel exports.',
      estimatedImpact: 'Reduces coupling and improves incremental build speed',
    });
  }

  // Complexity — worst file
  const worstComplexFile = topDebtFiles.find((f) => f.complexityScore > 50);
  if (worstComplexFile) {
    recs.push({
      priority: worstComplexFile.complexityScore >= 75 ? 'critical' : 'high',
      category: 'complexity',
      filePath: worstComplexFile.filePath,
      action:
        `Refactor high-complexity code in "${worstComplexFile.filePath}". ` +
        'Apply guard clauses, extract helpers, and aim for cyclomatic complexity ≤ 10.',
      estimatedImpact: 'Reduces bug density and makes the code easier to test',
    });
  }

  // Maintainability — dead code
  if (maintainabilityResult.deadExports > 0) {
    recs.push({
      priority: maintainabilityResult.deadExports > 5 ? 'high' : 'medium',
      category: 'maintainability',
      action:
        `Remove dead code: ${maintainabilityResult.deadExports} file(s) have unreferenced exports. ` +
        'Use find_dead_code for the full list.',
      estimatedImpact: 'Reduces bundle size and cognitive overhead for future maintainers',
    });
  }

  // Volatility — churn hotspot intersecting high complexity
  if (volatilityResult.available) {
    const churnAndComplex = topDebtFiles.find(
      (f) => f.churnScore > 50 && f.complexityScore > 30,
    );
    if (churnAndComplex) {
      recs.push({
        priority: 'high',
        category: 'volatility',
        filePath: churnAndComplex.filePath,
        action:
          `"${churnAndComplex.filePath}" is both high-churn and high-complexity — a prime regression risk. ` +
          'Add tests before making further changes.',
        estimatedImpact: 'Prevents regressions in a frequently-changing file with complex logic',
      });
    }

    const onlyHighChurn = topDebtFiles.find(
      (f) => f.churnScore > 70 && f.complexityScore <= 30,
    );
    if (onlyHighChurn && !churnAndComplex) {
      recs.push({
        priority: 'medium',
        category: 'volatility',
        filePath: onlyHighChurn.filePath,
        action:
          `"${onlyHighChurn.filePath}" is a churn hotspot. ` +
          'Consider whether the frequent changes indicate unclear requirements or missing abstractions.',
        estimatedImpact: 'Stabilizes volatile code paths and reduces merge conflicts',
      });
    }
  }

  // General low-priority suggestions
  if (complexityResult.complexSymbols > 10) {
    recs.push({
      priority: 'medium',
      category: 'complexity',
      action:
        `${complexityResult.complexSymbols} symbols have high cyclomatic complexity. ` +
        'Use get_quality_metrics with sortBy:"complexity" for the full ranked list.',
      estimatedImpact: 'Improves testability and reduces future bug introduction rate',
    });
  }

  // Sort: critical → high → medium → low
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  recs.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return recs;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  scope?: string;
  topN?: number;
  includeChurn?: boolean;
  format?: 'summary' | 'detailed';
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, scope, topN = 10, includeChurn = true, format = 'detailed' } = args;

  const db = openDatabase(repoId);

  try {
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Repo "${repoId}" not found` }) }],
        isError: true,
      };
    }

    // ── File / symbol counts ────────────────────────────────────────────────
    const scopeClause = scope ? `AND path LIKE ? || '%'` : '';
    const fileParams: string[] = [repoId];
    if (scope) fileParams.push(scope);

    const totalFiles: number = (
      db
        .prepare<string[], { cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM files WHERE repo_id = ? ${scopeClause}`,
        )
        .get(...fileParams) ?? { cnt: 0 }
    ).cnt;

    const symScopeClause = scope ? `AND file_path LIKE ? || '%'` : '';
    const symParams: string[] = [repoId];
    if (scope) symParams.push(scope);

    const totalSymbols: number = (
      db
        .prepare<string[], { cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM symbols WHERE repo_id = ? ${symScopeClause}`,
        )
        .get(...symParams) ?? { cnt: 0 }
    ).cnt;

    // ── Compute debt categories ─────────────────────────────────────────────
    const complexityResult = computeComplexityDebt(db, repoId, scope);
    const structuralResult = computeStructuralDebt(db, repoId, scope);
    const maintainabilityResult = computeMaintainabilityDebt(db, repoId, scope);
    const volatilityResult = includeChurn
      ? computeVolatilityDebt(db, repoId, scope)
      : {
          category: { score: 0, itemCount: 0, topIssues: ['Churn analysis disabled'] },
          fileScores: new Map<string, number>(),
          available: false,
        };

    // ── Build per-file combined score ───────────────────────────────────────
    const allFiles = new Set<string>([
      ...complexityResult.fileScores.keys(),
      ...structuralResult.fileScores.keys(),
      ...maintainabilityResult.fileScores.keys(),
      ...volatilityResult.fileScores.keys(),
    ]);

    const debtFiles: DebtFile[] = [];

    for (const fp of allFiles) {
      const cs = complexityResult.fileScores.get(fp) ?? 0;
      const ss = structuralResult.fileScores.get(fp) ?? 0;
      const ms = maintainabilityResult.fileScores.get(fp) ?? 0;
      const vs = volatilityResult.fileScores.get(fp) ?? 0;

      // Weighted combined score (volatility lower weight when no git data)
      const vsWeight = volatilityResult.available ? 0.2 : 0;
      const baseWeight = 1 - vsWeight;
      const combined = Math.round(
        (cs * 0.4 + ss * 0.35 + ms * 0.25) * baseWeight + vs * vsWeight,
      );

      // Build issue list for this file
      const issues: string[] = [];
      if (cs >= 50) issues.push(`Complexity score: ${cs.toFixed(0)}`);
      if (ss >= 50) {
        if (structuralResult.cycleFiles.has(fp)) issues.push('Involved in circular dependency');
        const coupling = structuralResult.couplingRows.find((r) => r.target_file === fp);
        if (coupling) issues.push(`Imported by ${coupling.importer_count} files`);
      }
      if (ms >= 50) issues.push(`Maintainability score: ${ms.toFixed(0)}`);
      if (vs >= 50) issues.push(`Churn score: ${vs.toFixed(0)}`);

      debtFiles.push({
        filePath: fp,
        debtScore: combined,
        complexityScore: Math.round(cs),
        structuralScore: Math.round(ss),
        maintainabilityScore: Math.round(ms),
        churnScore: Math.round(vs),
        issues,
      });
    }

    debtFiles.sort((a, b) => b.debtScore - a.debtScore);
    const topDebtFiles = debtFiles.slice(0, topN);

    // ── Overall debt score ──────────────────────────────────────────────────
    const cs = complexityResult.category.score;
    const ss = structuralResult.category.score;
    const ms = maintainabilityResult.category.score;
    const vs = volatilityResult.category.score;
    const vsWeight = volatilityResult.available ? 0.15 : 0;
    const baseWeightTotal = 1 - vsWeight;
    const overallDebtScore = Math.round(
      (cs * 0.4 + ss * 0.35 + ms * 0.25) * baseWeightTotal + vs * vsWeight,
    );

    const output: GetDebtReportOutput = {
      repoId,
      generatedAt: new Date().toISOString(),
      overallDebtScore,
      grade: debtGrade(overallDebtScore),
      categories: {
        complexity: complexityResult.category,
        structural: structuralResult.category,
        maintainability: maintainabilityResult.category,
        volatility: volatilityResult.category,
      },
      topDebtFiles: format === 'summary' ? [] : topDebtFiles,
      recommendations: format === 'summary' ? [] : buildRecommendations(
        complexityResult,
        structuralResult,
        maintainabilityResult,
        volatilityResult,
        topDebtFiles,
      ),
      summary: {
        totalFiles,
        totalSymbols,
        complexSymbols: complexityResult.complexSymbols,
        circularDeps: structuralResult.circularDeps,
        deadExports: maintainabilityResult.deadExports,
        gitDataAvailable: volatilityResult.available,
      },
      _tokenEstimate: 0,
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };

    const text = JSON.stringify(output, null, 2);
    output._tokenEstimate = Math.ceil(text.length / 4);

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    };
  } finally {
    db.close();
  }
}
