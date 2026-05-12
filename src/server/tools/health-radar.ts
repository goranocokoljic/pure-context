/**
 * health-radar.ts
 *
 * MCP tool: health_radar
 *
 * Compute a multi-axis health radar for an indexed repo. Each axis is scored
 * 0–100 where 100 = perfectly healthy, 0 = critical problems.
 *
 * Five axes:
 *   complexity      — inverse of average/peak cyclomatic complexity
 *   coupling        — inverse of high-coupling file density
 *   maintainability — inverse of dead-code and god-class density
 *   documentation   — percentage of symbols with a non-trivial summary
 *   stability       — inverse of churn-hotspot density (requires git metadata)
 *
 * Produces:
 *   • Per-axis AxisScore (score 0–100, label, rationale, available flag)
 *   • overallHealth (0–100, weighted average of available axes)
 *   • Letter grade (A–F)
 *   • Summary counts
 *
 * Distinguishes from get_debt_report:
 *   • Scores are *health* (100 = good), not *debt* (100 = bad)
 *   • Adds a Documentation axis absent from the debt report
 *   • Compact output suited for dashboard charting and CI health gates
 *   • No per-file breakdown or recommendations (use get_debt_report for those)
 */

import { z } from 'zod';
import type Database from 'better-sqlite3';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getAllDepEdges } from '../../core/db/dep-store.js';
import { findDeadExports } from '../../core/db/dep-store.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DepEdge } from '../../core/types.js';

// ─── Tool exports ─────────────────────────────────────────────────────────────

export const name = 'health_radar';

export const description =
  'Compute a multi-axis health radar for an indexed repo. ' +
  'Scores five dimensions (complexity, coupling, maintainability, documentation, stability) ' +
  'on a 0–100 scale where 100 = perfectly healthy. ' +
  'Designed for dashboard charts, CI health gates, and quick repo orientation. ' +
  'Use get_debt_report for a detailed breakdown with per-file rankings and recommendations.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  scope: z
    .string()
    .optional()
    .describe('Directory prefix filter (e.g. "src/core/") — narrows analysis to that subtree'),
  includeStability: z
    .boolean()
    .optional()
    .describe(
      'Include churn-based stability axis (requires git metadata; default true). ' +
      'Set false to skip git queries when git data is absent.',
    ),
};

// ─── Internal types ───────────────────────────────────────────────────────────

type HealthLabel = 'excellent' | 'good' | 'fair' | 'poor' | 'critical';

export interface AxisScore {
  score: number;       // 0–100, 100 = healthy
  label: HealthLabel;
  rationale: string;   // One-line human-readable explanation
  available: boolean;  // false when no data to compute this axis
}

interface HealthRadarOutput {
  repoId: string;
  generatedAt: string;
  scope: string | undefined;
  axes: {
    complexity: AxisScore;
    coupling: AxisScore;
    maintainability: AxisScore;
    documentation: AxisScore;
    stability: AxisScore;
  };
  overallHealth: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  summary: {
    totalFiles: number;
    totalSymbols: number;
    documentedSymbols: number;
    axesWithData: number;
    gitDataAvailable: boolean;
  };
  _tokenEstimate: number;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Scoring constants ────────────────────────────────────────────────────────

const CC_HIGH = 10;
const CC_CRITICAL = 20;
const NESTING_HIGH = 4;
const PARAM_HIGH = 7;
const LINE_HIGH = 100;
const COUPLING_CRITICAL = 20;
const COUPLING_HIGH = 10;
const GOD_CLASS_LINES = 500;
const GOD_CLASS_METHODS = 20;
const CHURN_HIGH = 10;
const CHURN_CRITICAL = 25;
const CHURN_WINDOW_DAYS = 90;
const DOC_MIN_LENGTH = 5;    // Minimum summary length to count as documented

// ─── Label helper ─────────────────────────────────────────────────────────────

function toLabel(score: number): HealthLabel {
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'fair';
  if (score >= 20) return 'poor';
  return 'critical';
}

// ─── Grade helper ─────────────────────────────────────────────────────────────

function healthGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 80) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  if (score >= 20) return 'D';
  return 'F';
}

// ─── Graph helpers ────────────────────────────────────────────────────────────

function buildImporterCounts(edges: DepEdge[]): Map<string, number> {
  const importersByTarget = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!importersByTarget.has(edge.targetFile)) {
      importersByTarget.set(edge.targetFile, new Set());
    }
    importersByTarget.get(edge.targetFile)!.add(edge.sourceFile);
  }
  const result = new Map<string, number>();
  for (const [target, importers] of importersByTarget) {
    result.set(target, importers.size);
  }
  return result;
}

// ─── Axis computers ───────────────────────────────────────────────────────────

interface MetricRow {
  cyclomatic_complexity: number | null;
  nesting_depth: number | null;
  param_count: number | null;
  line_count: number | null;
}

function computeComplexityAxis(
  db: Database.Database,
  repoId: string,
  scope: string | undefined,
): AxisScore {
  const scopeClause = scope ? `AND file_path LIKE ? || '%'` : '';
  const params: (string | number)[] = [repoId];
  if (scope) params.push(scope);

  const rows = db
    .prepare<(string | number)[], MetricRow>(
      `SELECT cyclomatic_complexity, nesting_depth, param_count, line_count
       FROM symbols
       WHERE repo_id = ?
         ${scopeClause}
         AND kind IN ('function','method','hook','composable','middleware','route')
         AND (cyclomatic_complexity IS NOT NULL OR nesting_depth IS NOT NULL OR param_count IS NOT NULL)`,
    )
    .all(...params);

  if (rows.length === 0) {
    return {
      score: 100,
      label: 'excellent',
      rationale: 'No callable symbols with complexity metrics found',
      available: false,
    };
  }

  let totalDebt = 0;
  let complexCount = 0;
  let criticalCount = 0;

  for (const row of rows) {
    const cc = row.cyclomatic_complexity ?? 0;
    const nd = row.nesting_depth ?? 0;
    const pc = row.param_count ?? 0;
    const lc = row.line_count ?? 0;

    const ccScore = Math.min(cc / CC_CRITICAL, 1) * 100;
    const ndScore = Math.min(nd / NESTING_HIGH, 1) * 100;
    const pcScore = Math.min(pc / PARAM_HIGH, 1) * 100;
    const lcScore = Math.min(lc / LINE_HIGH, 1) * 100;
    const symbolDebt = ccScore * 0.5 + ndScore * 0.25 + pcScore * 0.15 + lcScore * 0.1;

    totalDebt += symbolDebt;
    if (cc >= CC_HIGH) complexCount++;
    if (cc >= CC_CRITICAL) criticalCount++;
  }

  const avgDebt = totalDebt / rows.length;
  // Health = inverse of avg debt, penalised more for critical symbols
  const criticalPenalty = Math.min(criticalCount * 10, 30);
  const rawHealth = Math.max(0, 100 - avgDebt - criticalPenalty);
  const score = Math.round(rawHealth);

  const pct = Math.round((complexCount / rows.length) * 100);
  const rationale =
    complexCount === 0
      ? `All ${rows.length} callable symbols are within complexity budget`
      : `${complexCount}/${rows.length} callable symbols exceed CC≥${CC_HIGH} (${pct}%)`;

  return { score, label: toLabel(score), rationale, available: true };
}

function computeCouplingAxis(
  db: Database.Database,
  repoId: string,
  scope: string | undefined,
): AxisScore {
  const edges = getAllDepEdges(db, repoId);
  const scopedEdges = scope
    ? edges.filter(
        (e) => e.sourceFile.startsWith(scope) || e.targetFile.startsWith(scope),
      )
    : edges;

  if (scopedEdges.length === 0) {
    return {
      score: 100,
      label: 'excellent',
      rationale: 'No dependency edges — repo has no imports',
      available: false,
    };
  }

  const importerCounts = buildImporterCounts(scopedEdges);
  const highCouplingFiles = Array.from(importerCounts.values()).filter(
    (n) => n > COUPLING_HIGH,
  );
  const criticalCouplingFiles = highCouplingFiles.filter(
    (n) => n >= COUPLING_CRITICAL,
  );

  const totalFiles = importerCounts.size || 1;
  const highRatio = highCouplingFiles.length / totalFiles;
  const critPenalty = criticalCouplingFiles.length * 15;
  const rawHealth = Math.max(0, 100 - highRatio * 60 - critPenalty);
  const score = Math.round(rawHealth);

  const maxImporters = Math.max(0, ...importerCounts.values());
  const rationale =
    highCouplingFiles.length === 0
      ? `No files exceed the coupling threshold (max ${maxImporters} importers)`
      : `${highCouplingFiles.length} file(s) have >${COUPLING_HIGH} importers (max: ${maxImporters})`;

  return { score, label: toLabel(score), rationale, available: true };
}

function computeMaintainabilityAxis(
  db: Database.Database,
  repoId: string,
  scope: string | undefined,
): AxisScore {
  // Dead exports
  const deadSymbols = findDeadExports(db, repoId);
  const deadCount = scope
    ? deadSymbols.filter((s) => s.filePath.startsWith(scope)).length
    : deadSymbols.length;

  // God classes (by line count)
  const scopeClause = scope ? `AND file_path LIKE ? || '%'` : '';
  const params: (string | number)[] = [repoId, GOD_CLASS_LINES];
  if (scope) params.push(scope);

  const godClassCount: number = (
    db
      .prepare<(string | number)[], { cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM symbols
         WHERE repo_id = ? AND kind = 'class' AND line_count > ?
           ${scopeClause}`,
      )
      .get(...params) ?? { cnt: 0 }
  ).cnt;

  // Files with too many methods
  const methodParams: (string | number)[] = [repoId, GOD_CLASS_METHODS];
  if (scope) methodParams.push(scope);
  const methodScopeClause = scope ? `AND file_path LIKE ? || '%'` : '';

  const godMethodFileCount: number = (
    db
      .prepare<(string | number)[], { cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM (
           SELECT file_path FROM symbols
           WHERE repo_id = ? AND kind = 'method' ${methodScopeClause}
           GROUP BY file_path
           HAVING COUNT(*) > ?
         )`,
      )
      .get(...methodParams) ?? { cnt: 0 }
  ).cnt;

  // Get total symbol count for context
  const symParams: string[] = [repoId];
  if (scope) symParams.push(scope);
  const symScopeClause = scope ? `AND file_path LIKE ? || '%'` : '';
  const totalSymbols: number = (
    db
      .prepare<string[], { cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM symbols WHERE repo_id = ? ${symScopeClause}`,
      )
      .get(...symParams) ?? { cnt: 0 }
  ).cnt;

  if (totalSymbols === 0) {
    return {
      score: 100,
      label: 'excellent',
      rationale: 'No symbols found',
      available: false,
    };
  }

  const deadPenalty = Math.min(deadCount * 3, 40);
  const godPenalty = Math.min((godClassCount + godMethodFileCount) * 15, 40);
  const rawHealth = Math.max(0, 100 - deadPenalty - godPenalty);
  const score = Math.round(rawHealth);

  const issues: string[] = [];
  if (deadCount > 0) issues.push(`${deadCount} dead export(s)`);
  if (godClassCount > 0) issues.push(`${godClassCount} god class(es)`);
  if (godMethodFileCount > 0) issues.push(`${godMethodFileCount} file(s) with >${GOD_CLASS_METHODS} methods`);

  const rationale =
    issues.length === 0
      ? 'No dead code or oversized classes detected'
      : issues.join(', ');

  return { score, label: toLabel(score), rationale, available: true };
}

function computeDocumentationAxis(
  db: Database.Database,
  repoId: string,
  scope: string | undefined,
): AxisScore {
  const scopeClause = scope ? `AND file_path LIKE ? || '%'` : '';
  const params: string[] = [repoId];
  if (scope) params.push(scope);

  const totals = db
    .prepare<string[], { total: number; documented: number }>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN LENGTH(summary) > ${DOC_MIN_LENGTH} THEN 1 ELSE 0 END) AS documented
       FROM symbols
       WHERE repo_id = ?
         ${scopeClause}
         AND kind NOT IN ('type','const','enum')`,
    )
    .get(...params) ?? { total: 0, documented: 0 };

  if (totals.total === 0) {
    return {
      score: 100,
      label: 'excellent',
      rationale: 'No documentable symbols found',
      available: false,
    };
  }

  const pct = Math.round((totals.documented / totals.total) * 100);
  const score = pct;  // 0–100 directly maps to coverage percentage
  const rationale = `${totals.documented}/${totals.total} documentable symbols have summaries (${pct}%)`;

  return { score, label: toLabel(score), rationale, available: true };
}

function computeStabilityAxis(
  db: Database.Database,
  repoId: string,
  scope: string | undefined,
): AxisScore {
  const hasGit = db
    .prepare<[string], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM git_metadata WHERE repo_id = ? LIMIT 1`,
    )
    .get(repoId);

  if (!hasGit || hasGit.cnt === 0) {
    return {
      score: 100,
      label: 'excellent',
      rationale: 'No git metadata available — stability cannot be measured',
      available: false,
    };
  }

  const churnSinceMs = Date.now() - CHURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const scopeClause = scope ? `AND file_path LIKE ? || '%'` : '';
  const params: (string | number)[] = [repoId, Math.floor(churnSinceMs / 1000)];
  if (scope) params.push(scope);

  interface ChurnRow { commit_count: number }
  const churnRows = db
    .prepare<(string | number)[], ChurnRow>(
      `SELECT COUNT(DISTINCT commit_sha) AS commit_count
       FROM git_metadata
       WHERE repo_id = ? AND commit_date >= ?
         ${scopeClause}
       GROUP BY file_path
       HAVING COUNT(DISTINCT commit_sha) > 0`,
    )
    .all(...params);

  if (churnRows.length === 0) {
    return {
      score: 100,
      label: 'excellent',
      rationale: `No file changes in the last ${CHURN_WINDOW_DAYS} days`,
      available: true,
    };
  }

  const hotspots = churnRows.filter((r) => r.commit_count >= CHURN_HIGH).length;
  const critical = churnRows.filter((r) => r.commit_count >= CHURN_CRITICAL).length;
  const total = churnRows.length;

  const hotspotRatio = hotspots / total;
  const critPenalty = critical * 10;
  const rawHealth = Math.max(0, 100 - hotspotRatio * 60 - critPenalty);
  const score = Math.round(rawHealth);

  const rationale =
    hotspots === 0
      ? `All ${total} changed files are within churn budget (${CHURN_WINDOW_DAYS}-day window)`
      : `${hotspots}/${total} files are churn hotspots (>${CHURN_HIGH} commits in ${CHURN_WINDOW_DAYS} days)`;

  return { score, label: toLabel(score), rationale, available: true };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  scope?: string;
  includeStability?: boolean;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, scope, includeStability = true } = args;

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

    // Count documented symbols
    const symDocParams: string[] = [repoId];
    if (scope) symDocParams.push(scope);
    const documentedSymbols: number = (
      db
        .prepare<string[], { cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM symbols
           WHERE repo_id = ? ${symScopeClause}
             AND LENGTH(summary) > ${DOC_MIN_LENGTH}`,
        )
        .get(...symDocParams) ?? { cnt: 0 }
    ).cnt;

    // ── Compute axes ────────────────────────────────────────────────────────
    const complexityAxis = computeComplexityAxis(db, repoId, scope);
    const couplingAxis = computeCouplingAxis(db, repoId, scope);
    const maintainabilityAxis = computeMaintainabilityAxis(db, repoId, scope);
    const documentationAxis = computeDocumentationAxis(db, repoId, scope);
    const stabilityAxis = includeStability
      ? computeStabilityAxis(db, repoId, scope)
      : {
          score: 100,
          label: 'excellent' as HealthLabel,
          rationale: 'Stability analysis disabled by caller',
          available: false,
        };

    // ── Overall health ──────────────────────────────────────────────────────
    // Use available axes only; documentation is lower weight (proxy metric)
    const availableAxes = [
      { axis: complexityAxis, weight: 0.30 },
      { axis: couplingAxis, weight: 0.25 },
      { axis: maintainabilityAxis, weight: 0.25 },
      { axis: documentationAxis, weight: 0.10 },
      { axis: stabilityAxis, weight: 0.10 },
    ].filter((a) => a.axis.available);

    let overallHealth: number;
    if (availableAxes.length === 0) {
      overallHealth = 100; // No data → assume healthy
    } else {
      // Renormalize weights to sum to 1 for the available subset
      const totalWeight = availableAxes.reduce((s, a) => s + a.weight, 0);
      overallHealth = Math.round(
        availableAxes.reduce(
          (s, a) => s + (a.axis.score * a.weight) / totalWeight,
          0,
        ),
      );
    }

    const axesWithData = [
      complexityAxis,
      couplingAxis,
      maintainabilityAxis,
      documentationAxis,
      stabilityAxis,
    ].filter((a) => a.available).length;

    const gitDataAvailable = stabilityAxis.available &&
      !stabilityAxis.rationale.includes('No git metadata');

    const output: HealthRadarOutput = {
      repoId,
      generatedAt: new Date().toISOString(),
      scope,
      axes: {
        complexity: complexityAxis,
        coupling: couplingAxis,
        maintainability: maintainabilityAxis,
        documentation: documentationAxis,
        stability: stabilityAxis,
      },
      overallHealth,
      grade: healthGrade(overallHealth),
      summary: {
        totalFiles,
        totalSymbols,
        documentedSymbols,
        axesWithData,
        gitDataAvailable,
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
