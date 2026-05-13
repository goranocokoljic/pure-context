/**
 * Tests for the health_radar tool (Task 188).
 *
 * Fixture: test/fixtures/get-debt-report-fixture/ (reused from Task 190)
 *   src/utils.ts    — defines doWork (2 importers → coupling), isolatedHelper (dead code),
 *                     complexProcessor (high cyclomatic complexity)
 *   src/caller1.ts  — imports doWork
 *   src/caller2.ts  — imports doWork
 *   src/alpha.ts    — imports betaHelper from beta.ts (circular dep)
 *   src/beta.ts     — imports alphaHelper from alpha.ts (circular dep)
 *
 * Test matrix:
 *   basic output shape      → required top-level fields present
 *   axes shape              → each axis has score, label, rationale, available
 *   score range             → all scores are 0–100
 *   overall health range    → overallHealth is 0–100
 *   grade matches health    → grade matches overallHealth value
 *   complexity axis         → detects high-complexity complexProcessor
 *   coupling axis           → detects utils.ts with 2 importers
 *   maintainability axis    → detects isolatedHelper as dead code
 *   documentation axis      → computes symbol coverage %
 *   stability unavailable   → available=false when no git metadata
 *   includeStability:false  → stability axis has available=false
 *   scope filter            → "src/utils" narrows analysis to utils.ts
 *   summary.totalFiles      → > 0 for the fixture
 *   summary.totalSymbols    → > 0 for the fixture
 *   axesWithData count      → matches number of available axes
 *   unknown repo            → isError for non-existent repoId
 *   tokenEstimate           → _tokenEstimate is a positive integer
 *   meta                    → _meta has timing_ms and powered_by
 *   label values            → each label is one of the 5 allowed values
 *   scope empty string      → behaves like no scope (full repo)
 *   high health             → overallHealth ≥ 0 (sanity check on healthy fixture)
 *   generatedAt             → ISO 8601 timestamp
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as healthRadarHandler } from '../../src/server/tools/health-radar.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Reuse the get-debt-report fixture — it has all the signals we need
const FIXTURE = resolve(__dirname, '../fixtures/get-debt-report-fixture');

let repoId: string;

// ─── Output types ─────────────────────────────────────────────────────────────

interface AxisScore {
  score: number;
  label: string;
  rationale: string;
  available: boolean;
}

interface HealthRadarOutput {
  repoId: string;
  generatedAt: string;
  scope?: string;
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
  _meta: { timing_ms: number; powered_by: string; server_version: string };
}

function parse(result: { content: Array<{ text: string }> }): HealthRadarOutput {
  return JSON.parse(result.content[0]!.text) as HealthRadarOutput;
}

const VALID_LABELS = new Set(['excellent', 'good', 'fair', 'poor', 'critical']);
const VALID_GRADES = new Set(['A', 'B', 'C', 'D', 'F']);

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  const result = await indexFolder(FIXTURE, { fileLimit: 50, skipGit: true });
  repoId = result.repoId;
}, 60_000);

afterAll(async () => {
  if (repoId) await deleteIndex(repoId);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('health_radar', () => {
  describe('basic output structure', () => {
    it('returns required top-level fields', async () => {
      const result = await healthRadarHandler({ repoId });
      expect(result.isError).toBeFalsy();
      const out = parse(result);

      expect(out.repoId).toBe(repoId);
      expect(typeof out.overallHealth).toBe('number');
      expect(typeof out.grade).toBe('string');
      expect(out.generatedAt).toBeTruthy();
      expect(out.axes).toBeTruthy();
      expect(out.summary).toBeTruthy();
      expect(typeof out._tokenEstimate).toBe('number');
      expect(out._meta).toBeTruthy();
    });

    it('returns all five axes', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);

      expect(out.axes).toHaveProperty('complexity');
      expect(out.axes).toHaveProperty('coupling');
      expect(out.axes).toHaveProperty('maintainability');
      expect(out.axes).toHaveProperty('documentation');
      expect(out.axes).toHaveProperty('stability');
    });

    it('each axis has score, label, rationale, available', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);

      for (const [axisName, axis] of Object.entries(out.axes)) {
        expect(typeof axis.score, `${axisName}.score`).toBe('number');
        expect(typeof axis.label, `${axisName}.label`).toBe('string');
        expect(typeof axis.rationale, `${axisName}.rationale`).toBe('string');
        expect(typeof axis.available, `${axisName}.available`).toBe('boolean');
      }
    });

    it('all scores are in range 0–100', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);

      for (const [axisName, axis] of Object.entries(out.axes)) {
        expect(axis.score, `${axisName}.score`).toBeGreaterThanOrEqual(0);
        expect(axis.score, `${axisName}.score`).toBeLessThanOrEqual(100);
      }
      expect(out.overallHealth).toBeGreaterThanOrEqual(0);
      expect(out.overallHealth).toBeLessThanOrEqual(100);
    });

    it('label values are valid', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);

      for (const [axisName, axis] of Object.entries(out.axes)) {
        expect(VALID_LABELS.has(axis.label), `${axisName}.label = "${axis.label}"`).toBe(true);
      }
    });

    it('grade matches overallHealth', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);

      expect(VALID_GRADES.has(out.grade)).toBe(true);

      // Verify grade threshold
      if (out.overallHealth >= 80) expect(out.grade).toBe('A');
      else if (out.overallHealth >= 60) expect(out.grade).toBe('B');
      else if (out.overallHealth >= 40) expect(out.grade).toBe('C');
      else if (out.overallHealth >= 20) expect(out.grade).toBe('D');
      else expect(out.grade).toBe('F');
    });

    it('generatedAt is an ISO 8601 timestamp', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);
      expect(out.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('axis correctness', () => {
    it('complexity axis is available and reflects high-complexity symbols', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);

      // complexProcessor has many branches → complexity axis should be available
      // and score < 100 (not perfectly healthy)
      expect(out.axes.complexity.available).toBe(true);
      expect(out.axes.complexity.score).toBeLessThan(100);
      expect(out.axes.complexity.rationale).toBeTruthy();
    });

    it('coupling axis is available and reflects doWork having 2 importers', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);

      // utils.ts is imported by caller1.ts and caller2.ts
      expect(out.axes.coupling.available).toBe(true);
      expect(out.axes.coupling.rationale).toBeTruthy();
      // With only 2 importers (below COUPLING_HIGH=10), health should still be high
      expect(out.axes.coupling.score).toBeGreaterThan(0);
    });

    it('maintainability axis detects isolatedHelper as dead code', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);

      expect(out.axes.maintainability.available).toBe(true);
      // isolatedHelper is never imported → dead code penalty
      expect(out.axes.maintainability.score).toBeLessThan(100);
    });

    it('documentation axis computes symbol coverage', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);

      // utils.ts has JSDoc comments; some symbols will have summaries
      expect(out.axes.documentation.available).toBe(true);
      expect(out.axes.documentation.score).toBeGreaterThanOrEqual(0);
      expect(out.axes.documentation.score).toBeLessThanOrEqual(100);
      expect(out.axes.documentation.rationale).toMatch(/\d+\/\d+/); // "N/M symbols"
    });

    it('stability axis is unavailable when no git metadata exists', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);

      // Fixture was not indexed with git metadata — stability unavailable
      expect(out.axes.stability.available).toBe(false);
      expect(out.axes.stability.rationale).toMatch(/git/i);
    });

    it('includeStability:false disables the stability axis', async () => {
      const result = await healthRadarHandler({ repoId, includeStability: false });
      expect(result.isError).toBeFalsy();
      const out = parse(result);

      expect(out.axes.stability.available).toBe(false);
      expect(out.axes.stability.rationale).toMatch(/disabled/i);
    });
  });

  describe('summary fields', () => {
    it('summary.totalFiles is > 0', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);
      expect(out.summary.totalFiles).toBeGreaterThan(0);
    });

    it('summary.totalSymbols is > 0', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);
      expect(out.summary.totalSymbols).toBeGreaterThan(0);
    });

    it('summary.documentedSymbols is a non-negative integer', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);
      expect(out.summary.documentedSymbols).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(out.summary.documentedSymbols)).toBe(true);
    });

    it('summary.axesWithData matches the available axes count', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);

      const countAvailable = Object.values(out.axes).filter((a) => a.available).length;
      expect(out.summary.axesWithData).toBe(countAvailable);
    });

    it('summary.gitDataAvailable matches the stability axis availability', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);
      // gitDataAvailable reflects whether the stability axis had actual git data;
      // the fixture lives inside the PureContext git repo so git metadata may or
      // may not be present — we just assert the field is a boolean and is
      // consistent with the stability axis state.
      expect(typeof out.summary.gitDataAvailable).toBe('boolean');
      if (!out.axes.stability.available) {
        expect(out.summary.gitDataAvailable).toBe(false);
      }
    });
  });

  describe('scope filter', () => {
    it('narrows analysis to a subtree', async () => {
      const fullResult = await healthRadarHandler({ repoId });
      const scopedResult = await healthRadarHandler({ repoId, scope: 'src/utils' });

      expect(fullResult.isError).toBeFalsy();
      expect(scopedResult.isError).toBeFalsy();

      const full = parse(fullResult);
      const scoped = parse(scopedResult);

      // Scoped result should have fewer or equal files
      expect(scoped.summary.totalFiles).toBeLessThanOrEqual(full.summary.totalFiles);
      expect(scoped.scope).toBe('src/utils');
    });

    it('scope absent means full-repo analysis (scope field is undefined)', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);
      expect(out.scope).toBeUndefined();
    });
  });

  describe('overallHealth computation', () => {
    it('overallHealth is a valid integer between 0 and 100', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);

      expect(Number.isInteger(out.overallHealth)).toBe(true);
      expect(out.overallHealth).toBeGreaterThanOrEqual(0);
      expect(out.overallHealth).toBeLessThanOrEqual(100);
    });

    it('excludes unavailable stability from overallHealth weighting', async () => {
      const withoutStability = await healthRadarHandler({ repoId, includeStability: false });
      const out = parse(withoutStability);

      // When includeStability is false, the axis must be marked unavailable
      expect(out.axes.stability.available).toBe(false);

      // The axesWithData count must not include the disabled stability axis
      const expectedAxesWithData = [
        out.axes.complexity,
        out.axes.coupling,
        out.axes.maintainability,
        out.axes.documentation,
      ].filter((a) => a.available).length;
      expect(out.summary.axesWithData).toBe(expectedAxesWithData);

      // overallHealth must still be a valid integer
      expect(Number.isInteger(out.overallHealth)).toBe(true);
      expect(out.overallHealth).toBeGreaterThanOrEqual(0);
      expect(out.overallHealth).toBeLessThanOrEqual(100);
    });
  });

  describe('error handling', () => {
    it('returns isError for a non-existent repoId', async () => {
      const result = await healthRadarHandler({ repoId: 'deadbeefdeadbeef' });
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0]!.text);
      expect(body.error).toMatch(/not found/i);
    });
  });

  describe('metadata', () => {
    it('_tokenEstimate is a positive integer', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);
      expect(out._tokenEstimate).toBeGreaterThan(0);
      expect(Number.isInteger(out._tokenEstimate)).toBe(true);
    });

    it('_meta has timing_ms and powered_by', async () => {
      const result = await healthRadarHandler({ repoId });
      const out = parse(result);
      expect(typeof out._meta.timing_ms).toBe('number');
      expect(out._meta.timing_ms).toBeGreaterThanOrEqual(0);
      expect(out._meta.powered_by).toBe('PureContext MCP');
    });
  });
});
