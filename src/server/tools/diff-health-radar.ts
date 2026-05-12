/**
 * diff-health-radar.ts
 *
 * MCP tool: diff_health_radar
 *
 * Compare health radar scores between two indexed repos (or two states of the
 * same codebase). Primary use cases:
 *
 *   • PR review: index main branch → index feature branch → compare
 *   • Refactoring validation: index before → refactor → re-index → compare
 *   • Cross-repo benchmark: compare health of two different projects
 *
 * Runs health_radar on both repos, then computes per-axis deltas (head − base).
 * Positive delta = improvement; negative delta = regression.
 *
 * Output:
 *   • base snapshot — health scores from baseRepoId
 *   • head snapshot — health scores from headRepoId
 *   • axes delta map — score change per axis with trend label
 *   • overallDelta — change in overall health (head − base)
 *   • trend — 'improved' | 'degraded' | 'stable' (based on overallDelta)
 *   • regressions — axis names that degraded by > SIGNIFICANT_DELTA
 *   • improvements — axis names that improved by > SIGNIFICANT_DELTA
 *
 * A delta of +5 or more is treated as a meaningful improvement.
 * A delta of −5 or more (negative) is treated as a meaningful regression.
 */

import { z } from 'zod';
import { handler as healthRadarHandler, type AxisScore } from './health-radar.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ─── Tool exports ─────────────────────────────────────────────────────────────

export const name = 'diff_health_radar';

export const description =
  'Compare health radar scores between two indexed repos (or two states of the same codebase). ' +
  'Runs health_radar on baseRepoId and headRepoId, then computes per-axis deltas. ' +
  'Positive delta = improvement; negative delta = regression. ' +
  'Primary use cases: PR review (index main vs feature branch), refactoring validation ' +
  '(index before/after), and cross-repo health benchmarking. ' +
  'Use health_radar for a single-repo snapshot.';

export const inputSchema = {
  baseRepoId: z
    .string()
    .describe('Baseline repo ID (e.g. main branch). From index_folder or resolve_repo.'),
  headRepoId: z
    .string()
    .describe('Head repo ID to compare against the baseline (e.g. feature branch).'),
  scope: z
    .string()
    .optional()
    .describe(
      'Directory prefix filter applied to both repos (e.g. "src/core/"). ' +
      'Narrows analysis to the same subtree in each repo.',
    ),
  includeStability: z
    .boolean()
    .optional()
    .describe(
      'Include churn-based stability axis in both snapshots (requires git metadata; default true). ' +
      'Set false to skip git queries when git data is absent.',
    ),
};

// ─── Internal types ───────────────────────────────────────────────────────────

type AxisName = 'complexity' | 'coupling' | 'maintainability' | 'documentation' | 'stability';

type Trend = 'improved' | 'degraded' | 'stable';

interface AxisDelta {
  baseScore: number;
  headScore: number;
  delta: number;     // head − base; positive = improvement
  trend: Trend;
  baseAvailable: boolean;
  headAvailable: boolean;
}

interface RadarSnapshot {
  repoId: string;
  overallHealth: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  axes: Record<AxisName, AxisScore>;
  gitDataAvailable: boolean;
}

interface DiffHealthRadarOutput {
  baseRepoId: string;
  headRepoId: string;
  scope: string | undefined;
  generatedAt: string;
  base: RadarSnapshot;
  head: RadarSnapshot;
  axes: Record<AxisName, AxisDelta>;
  overallDelta: number;
  trend: Trend;
  regressions: AxisName[];
  improvements: AxisName[];
  summary: {
    axesCompared: number;
    regressionCount: number;
    improvementCount: number;
    stableCount: number;
    overallGradeChange: string;  // e.g. "B → A" or "A → A"
  };
  _tokenEstimate: number;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SIGNIFICANT_DELTA = 5;  // Minimum delta (absolute) to count as meaningful

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toTrend(delta: number): Trend {
  if (delta >= SIGNIFICANT_DELTA) return 'improved';
  if (delta <= -SIGNIFICANT_DELTA) return 'degraded';
  return 'stable';
}

// Parsed shape of health_radar JSON output (subset we use)
interface HealthRadarJson {
  repoId: string;
  overallHealth: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  axes: {
    complexity: AxisScore;
    coupling: AxisScore;
    maintainability: AxisScore;
    documentation: AxisScore;
    stability: AxisScore;
  };
  summary: {
    gitDataAvailable: boolean;
  };
}

function parseSnapshot(result: CallToolResult, repoId: string): HealthRadarJson | null {
  if (result.isError) return null;
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as HealthRadarJson;
  } catch {
    return null;
  }
}

const AXIS_NAMES: AxisName[] = [
  'complexity',
  'coupling',
  'maintainability',
  'documentation',
  'stability',
];

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  baseRepoId: string;
  headRepoId: string;
  scope?: string;
  includeStability?: boolean;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { baseRepoId, headRepoId, scope, includeStability = true } = args;

  // ── Run health_radar on both repos in parallel ────────────────────────────
  const [baseResult, headResult] = await Promise.all([
    healthRadarHandler({ repoId: baseRepoId, scope, includeStability }),
    healthRadarHandler({ repoId: headRepoId, scope, includeStability }),
  ]);

  // ── Validate both succeeded ────────────────────────────────────────────────
  const baseJson = parseSnapshot(baseResult, baseRepoId);
  const headJson = parseSnapshot(headResult, headRepoId);

  if (!baseJson) {
    // Forward the base error
    if (baseResult.isError) return baseResult;
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Failed to compute health radar for base repo "${baseRepoId}"` }) }],
      isError: true,
    };
  }

  if (!headJson) {
    // Forward the head error
    if (headResult.isError) return headResult;
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Failed to compute health radar for head repo "${headRepoId}"` }) }],
      isError: true,
    };
  }

  // ── Compute per-axis deltas ────────────────────────────────────────────────
  const axes = {} as Record<AxisName, AxisDelta>;
  const regressions: AxisName[] = [];
  const improvements: AxisName[] = [];

  for (const axisName of AXIS_NAMES) {
    const baseAxis = baseJson.axes[axisName];
    const headAxis = headJson.axes[axisName];

    const baseScore = baseAxis.score;
    const headScore = headAxis.score;
    const delta = headScore - baseScore;
    const trend = toTrend(delta);

    axes[axisName] = {
      baseScore,
      headScore,
      delta,
      trend,
      baseAvailable: baseAxis.available,
      headAvailable: headAxis.available,
    };

    if (trend === 'degraded') regressions.push(axisName);
    if (trend === 'improved') improvements.push(axisName);
  }

  // ── Overall delta and trend ────────────────────────────────────────────────
  const overallDelta = headJson.overallHealth - baseJson.overallHealth;
  const trend = toTrend(overallDelta);

  // ── Snapshots (subset for output) ─────────────────────────────────────────
  const base: RadarSnapshot = {
    repoId: baseRepoId,
    overallHealth: baseJson.overallHealth,
    grade: baseJson.grade,
    axes: baseJson.axes,
    gitDataAvailable: baseJson.summary.gitDataAvailable,
  };

  const head: RadarSnapshot = {
    repoId: headRepoId,
    overallHealth: headJson.overallHealth,
    grade: headJson.grade,
    axes: headJson.axes,
    gitDataAvailable: headJson.summary.gitDataAvailable,
  };

  // ── Summary ────────────────────────────────────────────────────────────────
  const axesCompared = AXIS_NAMES.filter(
    (n) => axes[n].baseAvailable || axes[n].headAvailable,
  ).length;

  const gradeChange =
    base.grade === head.grade
      ? base.grade
      : `${base.grade} → ${head.grade}`;

  const output: DiffHealthRadarOutput = {
    baseRepoId,
    headRepoId,
    scope,
    generatedAt: new Date().toISOString(),
    base,
    head,
    axes,
    overallDelta,
    trend,
    regressions,
    improvements,
    summary: {
      axesCompared,
      regressionCount: regressions.length,
      improvementCount: improvements.length,
      stableCount: AXIS_NAMES.length - regressions.length - improvements.length,
      overallGradeChange: gradeChange,
    },
    _tokenEstimate: 0,
    _meta: buildMeta({ timingMs: Date.now() - t0 }),
  };

  const text = JSON.stringify(output, null, 2);
  output._tokenEstimate = Math.ceil(text.length / 4);

  return {
    content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
  };
}
