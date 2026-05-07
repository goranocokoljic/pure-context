import { create } from 'zustand';
import type { HeatmapMode, FileHeatScore } from '../api/types.js';

// ─── State ────────────────────────────────────────────────────────────────────

interface HeatmapState {
  /** Currently selected heatmap visualisation mode. */
  mode: HeatmapMode;

  /** Whether the heatmap overlay is visible in the file tree. */
  enabled: boolean;

  /**
   * Per-repo, per-file heatmap scores.
   * Outer key: repoId. Inner key: repo-relative file path.
   */
  data: Record<string, Record<string, FileHeatScore>>;

  /** True while quality + churn data is being fetched. */
  loading: boolean;

  /** Fetch error message, or null. */
  error: string | null;

  /**
   * Whether the repo has quality metrics available (i.e. has been analysed).
   * null = unknown (not yet checked), false = no metrics, true = has metrics.
   */
  qualityAvailable: Record<string, boolean | null>;

  // ─── Actions ────────────────────────────────────────────────────────────────

  setMode(mode: HeatmapMode): void;
  setEnabled(enabled: boolean): void;
  setData(repoId: string, data: Record<string, FileHeatScore>): void;
  setLoading(loading: boolean): void;
  setError(error: string | null): void;
  setQualityAvailable(repoId: string, available: boolean): void;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useHeatmapStore = create<HeatmapState>((set) => ({
  mode: 'complexity',
  enabled: false,
  data: {},
  loading: false,
  error: null,
  qualityAvailable: {},

  setMode: (mode) => set({ mode }),
  setEnabled: (enabled) => set({ enabled }),
  setData: (repoId, data) =>
    set((s) => ({ data: { ...s.data, [repoId]: data } })),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setQualityAvailable: (repoId, available) =>
    set((s) => ({
      qualityAvailable: { ...s.qualityAvailable, [repoId]: available },
    })),
}));

// ─── Scoring helpers ──────────────────────────────────────────────────────────

/**
 * Extract the 0–100 score for the currently active heatmap mode.
 */
export function modeScore(entry: FileHeatScore, mode: HeatmapMode): number {
  if (mode === 'complexity') return entry.complexityScore;
  if (mode === 'churn') return entry.churnScore;
  return entry.combinedScore;
}

/**
 * Interpolate a 0–100 quality score to an HSL colour string.
 * 0 → green (hue 120), 50 → yellow (hue 60), 100 → red (hue 0).
 */
export function heatColor(score: number): string {
  const clamped = Math.min(Math.max(score, 0), 100);
  const hue = Math.round(120 - clamped * 1.2);
  return `hsl(${hue}, 70%, 45%)`;
}

/**
 * Build the per-file FileHeatScore map from raw quality + churn API responses.
 * Used by RepoDetail when it fetches heatmap data.
 */
export function buildHeatScores(
  qualityOffenders: Array<{
    filePath: string;
    qualityScore: number;
    cyclomaticComplexity: number;
    riskLevel: string;
  }>,
  churnTopFiles: Array<{ filePath: string; churnScore: number; commitCount: number }>,
): Record<string, FileHeatScore> {
  // Aggregate quality data per file
  const byFile = new Map<
    string,
    { maxQualityScore: number; totalCC: number; ccCount: number; criticalCount: number }
  >();

  for (const sym of qualityOffenders) {
    let entry = byFile.get(sym.filePath);
    if (!entry) {
      entry = { maxQualityScore: 0, totalCC: 0, ccCount: 0, criticalCount: 0 };
      byFile.set(sym.filePath, entry);
    }
    entry.maxQualityScore = Math.max(entry.maxQualityScore, sym.qualityScore);
    entry.totalCC += sym.cyclomaticComplexity;
    entry.ccCount += 1;
    if (sym.riskLevel === 'critical') entry.criticalCount += 1;
  }

  // Build churn lookup
  const churnByFile = new Map<string, { churnScore: number; commitCount: number }>();
  for (const c of churnTopFiles) {
    // Normalise churnScore (commits/90d) to 0–100: cap at 10 commits/90d = 100
    const normalised = Math.min((c.churnScore / 10) * 100, 100);
    churnByFile.set(c.filePath, { churnScore: normalised, commitCount: c.commitCount });
  }

  // Combine: union of all files seen in either dataset
  const allPaths = new Set([...byFile.keys(), ...churnByFile.keys()]);
  const result: Record<string, FileHeatScore> = {};

  for (const filePath of allPaths) {
    const q = byFile.get(filePath);
    const c = churnByFile.get(filePath);

    const complexityScore = q?.maxQualityScore ?? 0;
    const churnScore = c?.churnScore ?? 0;
    const combinedScore = Math.round(complexityScore * 0.6 + churnScore * 0.4);
    const avgComplexity = q && q.ccCount > 0
      ? Math.round((q.totalCC / q.ccCount) * 10) / 10
      : 0;

    result[filePath] = {
      complexityScore,
      churnScore,
      combinedScore,
      avgComplexity,
      commitCount: c?.commitCount ?? 0,
      criticalSymbols: q?.criticalCount ?? 0,
    };
  }

  return result;
}
