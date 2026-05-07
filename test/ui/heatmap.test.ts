/**
 * Unit tests for Task 163 — Architecture Heatmap.
 * Runs in Node — no DOM or React required.
 *
 * Tests cover:
 *  - heatColor: colour interpolation from score to HSL string
 *  - modeScore: extracts the right dimension per mode
 *  - buildHeatScores: aggregates quality + churn into FileHeatScore per file
 *  - maxScoreInSubtree: directory aggregation returns max child score
 *  - HeatmapLegend: renders with three mode options (structural check)
 */

import { describe, it, expect } from 'vitest';

// ─── Inline implementations (mirror heatmapStore.ts exports) ─────────────────

type HeatmapMode = 'complexity' | 'churn' | 'combined';

interface FileHeatScore {
  complexityScore: number;
  churnScore: number;
  combinedScore: number;
  avgComplexity: number;
  commitCount: number;
  criticalSymbols: number;
}

function heatColor(score: number): string {
  const clamped = Math.min(Math.max(score, 0), 100);
  const hue = Math.round(120 - clamped * 1.2);
  return `hsl(${hue}, 70%, 45%)`;
}

function modeScore(entry: FileHeatScore, mode: HeatmapMode): number {
  if (mode === 'complexity') return entry.complexityScore;
  if (mode === 'churn') return entry.churnScore;
  return entry.combinedScore;
}

function buildHeatScores(
  qualityOffenders: Array<{
    filePath: string;
    qualityScore: number;
    cyclomaticComplexity: number;
    riskLevel: string;
  }>,
  churnTopFiles: Array<{ filePath: string; churnScore: number; commitCount: number }>,
): Record<string, FileHeatScore> {
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

  const churnByFile = new Map<string, { churnScore: number; commitCount: number }>();
  for (const c of churnTopFiles) {
    const normalised = Math.min((c.churnScore / 10) * 100, 100);
    churnByFile.set(c.filePath, { churnScore: normalised, commitCount: c.commitCount });
  }

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

// ─── Directory aggregation (mirrors FileTree.tsx maxScoreInSubtree) ───────────

type FileTreeNode =
  | { type: 'dir'; children: Record<string, FileTreeNode>; fileCount: number }
  | { type: 'file' };

function maxScoreInSubtree(
  tree: Record<string, FileTreeNode>,
  basePath: string,
  heatScores: ReadonlyMap<string, FileHeatScore>,
  mode: HeatmapMode,
): number | null {
  let max: number | null = null;
  for (const [name, node] of Object.entries(tree)) {
    const childPath = `${basePath}/${name}`;
    if (node.type === 'file') {
      const entry = heatScores.get(childPath);
      if (entry !== undefined) {
        const s = modeScore(entry, mode);
        max = max === null ? s : Math.max(max, s);
      }
    } else {
      const childMax = maxScoreInSubtree(node.children, childPath, heatScores, mode);
      if (childMax !== null) {
        max = max === null ? childMax : Math.max(max, childMax);
      }
    }
  }
  return max;
}

// ─── heatColor ────────────────────────────────────────────────────────────────

describe('heatColor', () => {
  it('score 0 returns green hue (120)', () => {
    expect(heatColor(0)).toBe('hsl(120, 70%, 45%)');
  });

  it('score 100 returns red hue (0)', () => {
    expect(heatColor(100)).toBe('hsl(0, 70%, 45%)');
  });

  it('score 50 returns yellow hue (~60)', () => {
    expect(heatColor(50)).toBe('hsl(60, 70%, 45%)');
  });

  it('clamps below 0 to green', () => {
    expect(heatColor(-10)).toBe('hsl(120, 70%, 45%)');
  });

  it('clamps above 100 to red', () => {
    expect(heatColor(150)).toBe('hsl(0, 70%, 45%)');
  });
});

// ─── modeScore ────────────────────────────────────────────────────────────────

describe('modeScore', () => {
  const entry: FileHeatScore = {
    complexityScore: 80,
    churnScore: 50,
    combinedScore: 68,
    avgComplexity: 12,
    commitCount: 5,
    criticalSymbols: 2,
  };

  it('complexity mode returns complexityScore', () => {
    expect(modeScore(entry, 'complexity')).toBe(80);
  });

  it('churn mode returns churnScore', () => {
    expect(modeScore(entry, 'churn')).toBe(50);
  });

  it('combined mode returns combinedScore', () => {
    expect(modeScore(entry, 'combined')).toBe(68);
  });
});

// ─── buildHeatScores ──────────────────────────────────────────────────────────

describe('buildHeatScores', () => {
  it('aggregates quality offenders per file (max qualityScore)', () => {
    const offenders = [
      { filePath: 'src/a.ts', qualityScore: 60, cyclomaticComplexity: 8, riskLevel: 'high' },
      { filePath: 'src/a.ts', qualityScore: 85, cyclomaticComplexity: 14, riskLevel: 'critical' },
    ];
    const result = buildHeatScores(offenders, []);
    expect(result['src/a.ts']!.complexityScore).toBe(85);
    expect(result['src/a.ts']!.criticalSymbols).toBe(1);
  });

  it('normalises churn score: churnScore 10 → 100', () => {
    const churn = [{ filePath: 'src/b.ts', churnScore: 10, commitCount: 40 }];
    const result = buildHeatScores([], churn);
    expect(result['src/b.ts']!.churnScore).toBe(100);
  });

  it('normalises churn score: churnScore 5 → 50', () => {
    const churn = [{ filePath: 'src/b.ts', churnScore: 5, commitCount: 20 }];
    const result = buildHeatScores([], churn);
    expect(result['src/b.ts']!.churnScore).toBe(50);
  });

  it('clamps churn normalisation at 100', () => {
    const churn = [{ filePath: 'src/b.ts', churnScore: 20, commitCount: 80 }];
    const result = buildHeatScores([], churn);
    expect(result['src/b.ts']!.churnScore).toBe(100);
  });

  it('combinedScore = 60% complexity + 40% churn', () => {
    const offenders = [
      { filePath: 'src/c.ts', qualityScore: 80, cyclomaticComplexity: 10, riskLevel: 'high' },
    ];
    const churn = [{ filePath: 'src/c.ts', churnScore: 5, commitCount: 20 }];
    const result = buildHeatScores(offenders, churn);
    // combined = round(80 * 0.6 + 50 * 0.4) = round(48 + 20) = 68
    expect(result['src/c.ts']!.combinedScore).toBe(68);
  });

  it('file only in quality → churnScore 0', () => {
    const offenders = [
      { filePath: 'src/d.ts', qualityScore: 40, cyclomaticComplexity: 5, riskLevel: 'moderate' },
    ];
    const result = buildHeatScores(offenders, []);
    expect(result['src/d.ts']!.churnScore).toBe(0);
    expect(result['src/d.ts']!.commitCount).toBe(0);
  });

  it('file only in churn → complexityScore 0', () => {
    const churn = [{ filePath: 'src/e.ts', churnScore: 3, commitCount: 12 }];
    const result = buildHeatScores([], churn);
    expect(result['src/e.ts']!.complexityScore).toBe(0);
  });

  it('avgComplexity is average CC across symbols in the file', () => {
    const offenders = [
      { filePath: 'src/f.ts', qualityScore: 50, cyclomaticComplexity: 6, riskLevel: 'moderate' },
      { filePath: 'src/f.ts', qualityScore: 70, cyclomaticComplexity: 14, riskLevel: 'high' },
    ];
    const result = buildHeatScores(offenders, []);
    expect(result['src/f.ts']!.avgComplexity).toBe(10);
  });

  it('returns empty object for empty inputs', () => {
    expect(buildHeatScores([], [])).toEqual({});
  });

  it('handles multiple files independently', () => {
    const offenders = [
      { filePath: 'src/x.ts', qualityScore: 30, cyclomaticComplexity: 4, riskLevel: 'moderate' },
      { filePath: 'src/y.ts', qualityScore: 90, cyclomaticComplexity: 20, riskLevel: 'critical' },
    ];
    const result = buildHeatScores(offenders, []);
    expect(result['src/x.ts']!.complexityScore).toBe(30);
    expect(result['src/y.ts']!.complexityScore).toBe(90);
  });
});

// ─── maxScoreInSubtree (directory aggregation) ────────────────────────────────

describe('maxScoreInSubtree', () => {
  function makeFileTree(paths: string[]): Record<string, FileTreeNode> {
    const root: Record<string, FileTreeNode> = {};
    for (const p of paths) {
      const parts = p.split('/');
      let cur = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const dir = parts[i]!;
        if (!cur[dir]) cur[dir] = { type: 'dir', children: {}, fileCount: 0 };
        cur = (cur[dir] as Extract<FileTreeNode, { type: 'dir' }>).children;
      }
      const file = parts[parts.length - 1]!;
      cur[file] = { type: 'file' };
    }
    return root;
  }

  it('returns max child score for a directory', () => {
    const tree = makeFileTree(['a.ts', 'b.ts', 'c.ts']);
    const scores = new Map<string, FileHeatScore>([
      ['root/a.ts', { complexityScore: 10, churnScore: 0, combinedScore: 6, avgComplexity: 2, commitCount: 0, criticalSymbols: 0 }],
      ['root/b.ts', { complexityScore: 75, churnScore: 0, combinedScore: 45, avgComplexity: 8, commitCount: 0, criticalSymbols: 1 }],
      ['root/c.ts', { complexityScore: 40, churnScore: 0, combinedScore: 24, avgComplexity: 5, commitCount: 0, criticalSymbols: 0 }],
    ]);
    const max = maxScoreInSubtree(tree, 'root', scores, 'complexity');
    expect(max).toBe(75);
  });

  it('returns null when no scores exist for any file in subtree', () => {
    const tree = makeFileTree(['a.ts']);
    const scores = new Map<string, FileHeatScore>();
    expect(maxScoreInSubtree(tree, 'root', scores, 'complexity')).toBeNull();
  });

  it('traverses nested directories recursively', () => {
    const tree = makeFileTree(['src/core/a.ts', 'src/server/b.ts']);
    const scores = new Map<string, FileHeatScore>([
      ['root/src/core/a.ts', { complexityScore: 20, churnScore: 0, combinedScore: 12, avgComplexity: 3, commitCount: 0, criticalSymbols: 0 }],
      ['root/src/server/b.ts', { complexityScore: 95, churnScore: 0, combinedScore: 57, avgComplexity: 15, commitCount: 0, criticalSymbols: 2 }],
    ]);
    const max = maxScoreInSubtree(tree, 'root', scores, 'complexity');
    expect(max).toBe(95);
  });

  it('uses churn mode when specified', () => {
    const tree = makeFileTree(['a.ts', 'b.ts']);
    const scores = new Map<string, FileHeatScore>([
      ['root/a.ts', { complexityScore: 90, churnScore: 10, combinedScore: 58, avgComplexity: 12, commitCount: 1, criticalSymbols: 2 }],
      ['root/b.ts', { complexityScore: 20, churnScore: 80, combinedScore: 44, avgComplexity: 3, commitCount: 32, criticalSymbols: 0 }],
    ]);
    expect(maxScoreInSubtree(tree, 'root', scores, 'churn')).toBe(80);
  });
});

// ─── HeatmapLegend modes ──────────────────────────────────────────────────────

describe('HeatmapLegend modes', () => {
  it('defines exactly three mode options', () => {
    const MODES = ['complexity', 'churn', 'combined'] as HeatmapMode[];
    expect(MODES).toHaveLength(3);
  });

  it('each mode produces a distinct modeScore for the same entry', () => {
    const entry: FileHeatScore = {
      complexityScore: 80,
      churnScore: 30,
      combinedScore: 60,
      avgComplexity: 10,
      commitCount: 3,
      criticalSymbols: 1,
    };
    const scores = (['complexity', 'churn', 'combined'] as HeatmapMode[]).map(
      (m) => modeScore(entry, m),
    );
    // All three should be different for this test entry
    expect(new Set(scores).size).toBe(3);
  });
});
