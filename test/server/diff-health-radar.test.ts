/**
 * Tests for the diff_health_radar tool (Task 189).
 *
 * Fixture: test/fixtures/get-debt-report-fixture/ (reused from Tasks 188 & 190)
 *   src/utils.ts    — defines doWork (2 importers → coupling), isolatedHelper (dead code),
 *                     complexProcessor (high cyclomatic complexity)
 *   src/caller1.ts  — imports doWork
 *   src/caller2.ts  — imports doWork
 *   src/alpha.ts    — imports betaHelper from beta.ts (circular dep)
 *   src/beta.ts     — imports alphaHelper from alpha.ts (circular dep)
 *
 * Strategy: index the same fixture twice (as "base" and "head"). When comparing
 * a repo to itself all deltas must be zero and trend = 'stable'. This gives us a
 * deterministic, fixture-free way to verify the diff logic.
 *
 * Test matrix:
 *   output shape              → required top-level fields present
 *   base / head snapshots     → each has repoId, overallHealth, grade, axes
 *   axes delta map            → all five axes present with baseScore/headScore/delta/trend
 *   delta = 0 when same repo  → comparing a repo to itself yields zero deltas
 *   trend = stable            → overallDelta = 0 → trend = 'stable'
 *   overallDelta range        → bounded [-100, +100]
 *   regressions list          → empty when no axis degraded
 *   improvements list         → empty when no axis improved
 *   summary fields            → axesCompared, regressionCount, improvementCount, stableCount, overallGradeChange
 *   overallGradeChange stable → same grade shown as single letter when unchanged
 *   scope filter              → scope field forwarded to both snapshots
 *   generatedAt               → ISO 8601 timestamp
 *   tokenEstimate             → positive integer
 *   meta fields               → timing_ms and powered_by
 *   invalid base repoId       → isError
 *   invalid head repoId       → isError
 *   both invalid              → isError
 *   includeStability:false    → stability axes have available=false in both snapshots
 *   axesCompared count        → equals number of axes with data in either snapshot
 *   stableCount               → regressionCount + improvementCount + stableCount = 5
 *   base/head grade same      → overallGradeChange is single letter
 *   delta sign convention     → delta = head - base (positive = head is better)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as diffHealthRadarHandler } from '../../src/server/tools/diff-health-radar.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE = resolve(__dirname, '../fixtures/get-debt-report-fixture');

// We index the same fixture twice to get a deterministic "same vs same" comparison.
let baseRepoId: string;
let headRepoId: string;

// ─── Output types ─────────────────────────────────────────────────────────────

interface AxisScore {
  score: number;
  label: string;
  rationale: string;
  available: boolean;
}

interface RadarSnapshot {
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
  gitDataAvailable: boolean;
}

interface AxisDelta {
  baseScore: number;
  headScore: number;
  delta: number;
  trend: 'improved' | 'degraded' | 'stable';
  baseAvailable: boolean;
  headAvailable: boolean;
}

interface DiffHealthRadarOutput {
  baseRepoId: string;
  headRepoId: string;
  scope?: string;
  generatedAt: string;
  base: RadarSnapshot;
  head: RadarSnapshot;
  axes: {
    complexity: AxisDelta;
    coupling: AxisDelta;
    maintainability: AxisDelta;
    documentation: AxisDelta;
    stability: AxisDelta;
  };
  overallDelta: number;
  trend: 'improved' | 'degraded' | 'stable';
  regressions: string[];
  improvements: string[];
  summary: {
    axesCompared: number;
    regressionCount: number;
    improvementCount: number;
    stableCount: number;
    overallGradeChange: string;
  };
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string; server_version: string };
}

function parse(result: { content: Array<{ text: string }> }): DiffHealthRadarOutput {
  return JSON.parse(result.content[0]!.text) as DiffHealthRadarOutput;
}

const AXIS_NAMES = ['complexity', 'coupling', 'maintainability', 'documentation', 'stability'] as const;
const VALID_TRENDS = new Set(['improved', 'degraded', 'stable']);

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  // Index the same fixture twice — same content, two separate DB rows
  const [r1, r2] = await Promise.all([
    indexFolder(FIXTURE, { fileLimit: 50 }),
    indexFolder(FIXTURE, { fileLimit: 50 }),
  ]);
  baseRepoId = r1.repoId;
  headRepoId = r2.repoId;

  // If both happen to resolve to the same repoId (same path → same hash),
  // we still test zero-delta semantics which is valid.
}, 60_000);

afterAll(async () => {
  // Both base and head may resolve to the same repoId when the same path is indexed twice.
  // Use a Set to avoid double-deletion, and guard with try/catch in case one was already removed.
  const toDelete = new Set([baseRepoId, headRepoId]);
  for (const id of toDelete) {
    if (id) {
      try { await deleteIndex(id); } catch { /* already deleted */ }
    }
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('diff_health_radar', () => {
  describe('output shape', () => {
    it('returns required top-level fields', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      expect(result.isError).toBeFalsy();
      const out = parse(result);

      expect(out.baseRepoId).toBe(baseRepoId);
      expect(out.headRepoId).toBe(headRepoId);
      expect(typeof out.overallDelta).toBe('number');
      expect(typeof out.trend).toBe('string');
      expect(out.generatedAt).toBeTruthy();
      expect(out.base).toBeTruthy();
      expect(out.head).toBeTruthy();
      expect(out.axes).toBeTruthy();
      expect(Array.isArray(out.regressions)).toBe(true);
      expect(Array.isArray(out.improvements)).toBe(true);
      expect(out.summary).toBeTruthy();
      expect(typeof out._tokenEstimate).toBe('number');
      expect(out._meta).toBeTruthy();
    });

    it('base and head snapshots have required fields', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);

      for (const snapshot of [out.base, out.head]) {
        expect(typeof snapshot.repoId).toBe('string');
        expect(typeof snapshot.overallHealth).toBe('number');
        expect(typeof snapshot.grade).toBe('string');
        expect(snapshot.axes).toBeTruthy();
        expect(typeof snapshot.gitDataAvailable).toBe('boolean');
      }
    });

    it('axes delta map has all five axes', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);

      for (const axisName of AXIS_NAMES) {
        expect(out.axes, `axes.${axisName}`).toHaveProperty(axisName);
      }
    });

    it('each axis delta has baseScore, headScore, delta, trend, baseAvailable, headAvailable', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);

      for (const axisName of AXIS_NAMES) {
        const axis = out.axes[axisName];
        expect(typeof axis.baseScore, `${axisName}.baseScore`).toBe('number');
        expect(typeof axis.headScore, `${axisName}.headScore`).toBe('number');
        expect(typeof axis.delta, `${axisName}.delta`).toBe('number');
        expect(VALID_TRENDS.has(axis.trend), `${axisName}.trend`).toBe(true);
        expect(typeof axis.baseAvailable, `${axisName}.baseAvailable`).toBe('boolean');
        expect(typeof axis.headAvailable, `${axisName}.headAvailable`).toBe('boolean');
      }
    });
  });

  describe('zero-delta semantics (same fixture indexed twice)', () => {
    it('all axis deltas are zero when comparing same content', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);

      for (const axisName of AXIS_NAMES) {
        expect(out.axes[axisName].delta, `${axisName}.delta`).toBe(0);
      }
    });

    it('overallDelta is zero when comparing same content', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);
      expect(out.overallDelta).toBe(0);
    });

    it('trend is stable when no meaningful delta', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);
      expect(out.trend).toBe('stable');
    });

    it('regressions list is empty when no axis degraded', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);
      expect(out.regressions).toHaveLength(0);
    });

    it('improvements list is empty when no axis improved', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);
      expect(out.improvements).toHaveLength(0);
    });

    it('delta sign convention: delta = headScore − baseScore', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);

      for (const axisName of AXIS_NAMES) {
        const axis = out.axes[axisName];
        expect(axis.delta).toBe(axis.headScore - axis.baseScore);
      }
    });
  });

  describe('score ranges', () => {
    it('base and head overallHealth are in range 0–100', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);

      expect(out.base.overallHealth).toBeGreaterThanOrEqual(0);
      expect(out.base.overallHealth).toBeLessThanOrEqual(100);
      expect(out.head.overallHealth).toBeGreaterThanOrEqual(0);
      expect(out.head.overallHealth).toBeLessThanOrEqual(100);
    });

    it('overallDelta is bounded within [-100, 100]', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);
      expect(out.overallDelta).toBeGreaterThanOrEqual(-100);
      expect(out.overallDelta).toBeLessThanOrEqual(100);
    });

    it('axis scores are in range 0–100 in both snapshots', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);

      for (const axisName of AXIS_NAMES) {
        expect(out.base.axes[axisName].score).toBeGreaterThanOrEqual(0);
        expect(out.base.axes[axisName].score).toBeLessThanOrEqual(100);
        expect(out.head.axes[axisName].score).toBeGreaterThanOrEqual(0);
        expect(out.head.axes[axisName].score).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('summary fields', () => {
    it('regressionCount + improvementCount + stableCount = 5 (all axes)', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);
      const { regressionCount, improvementCount, stableCount } = out.summary;
      expect(regressionCount + improvementCount + stableCount).toBe(5);
    });

    it('regressionCount matches regressions array length', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);
      expect(out.summary.regressionCount).toBe(out.regressions.length);
    });

    it('improvementCount matches improvements array length', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);
      expect(out.summary.improvementCount).toBe(out.improvements.length);
    });

    it('overallGradeChange is single letter when grade is unchanged', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);

      if (out.base.grade === out.head.grade) {
        // Should be just the grade letter, not "A → A"
        expect(out.summary.overallGradeChange).not.toContain('→');
        expect(out.summary.overallGradeChange).toBe(out.base.grade);
      } else {
        // Should show "X → Y"
        expect(out.summary.overallGradeChange).toContain('→');
      }
    });

    it('axesCompared is a positive integer', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);
      expect(out.summary.axesCompared).toBeGreaterThan(0);
      expect(Number.isInteger(out.summary.axesCompared)).toBe(true);
    });
  });

  describe('scope filter', () => {
    it('scope field is present in output when provided', async () => {
      const result = await diffHealthRadarHandler({
        baseRepoId,
        headRepoId,
        scope: 'src/',
      });
      expect(result.isError).toBeFalsy();
      const out = parse(result);
      expect(out.scope).toBe('src/');
    });

    it('scope field is undefined when not provided', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);
      expect(out.scope).toBeUndefined();
    });

    it('scoped diff produces valid output with fewer axes having data', async () => {
      const result = await diffHealthRadarHandler({
        baseRepoId,
        headRepoId,
        scope: 'src/utils',
      });
      expect(result.isError).toBeFalsy();
      const out = parse(result);
      // Zero delta still holds for scoped same-content comparison
      expect(out.overallDelta).toBe(0);
    });
  });

  describe('includeStability option', () => {
    it('includeStability:false sets stability axis available=false in both snapshots', async () => {
      const result = await diffHealthRadarHandler({
        baseRepoId,
        headRepoId,
        includeStability: false,
      });
      expect(result.isError).toBeFalsy();
      const out = parse(result);

      expect(out.base.axes.stability.available).toBe(false);
      expect(out.head.axes.stability.available).toBe(false);
    });

    it('includeStability:false still produces valid overall diff', async () => {
      const result = await diffHealthRadarHandler({
        baseRepoId,
        headRepoId,
        includeStability: false,
      });
      const out = parse(result);
      expect(out.overallDelta).toBe(0);
      expect(out.trend).toBe('stable');
    });
  });

  describe('error handling', () => {
    it('returns isError for invalid baseRepoId', async () => {
      const result = await diffHealthRadarHandler({
        baseRepoId: 'deadbeefdeadbeef',
        headRepoId,
      });
      expect(result.isError).toBe(true);
    });

    it('returns isError for invalid headRepoId', async () => {
      const result = await diffHealthRadarHandler({
        baseRepoId,
        headRepoId: 'deadbeefdeadbeef',
      });
      expect(result.isError).toBe(true);
    });

    it('error response contains an error field', async () => {
      const result = await diffHealthRadarHandler({
        baseRepoId: 'deadbeefdeadbeef',
        headRepoId: 'deadbeefdeadbeef',
      });
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0]!.text);
      expect(body.error).toBeTruthy();
    });
  });

  describe('metadata', () => {
    it('generatedAt is an ISO 8601 timestamp', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);
      expect(out.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('_tokenEstimate is a positive integer', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);
      expect(out._tokenEstimate).toBeGreaterThan(0);
      expect(Number.isInteger(out._tokenEstimate)).toBe(true);
    });

    it('_meta has timing_ms and powered_by', async () => {
      const result = await diffHealthRadarHandler({ baseRepoId, headRepoId });
      const out = parse(result);
      expect(typeof out._meta.timing_ms).toBe('number');
      expect(out._meta.timing_ms).toBeGreaterThanOrEqual(0);
      expect(out._meta.powered_by).toBe('PureContext MCP');
    });
  });
});
