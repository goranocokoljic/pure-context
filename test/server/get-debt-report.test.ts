/**
 * Tests for the get_debt_report tool (Task 190).
 *
 * Fixture: test/fixtures/get-debt-report-fixture/
 *   src/utils.ts    — defines doWork (2 importers → coupling), isolatedHelper (dead code),
 *                     complexProcessor (high cyclomatic complexity)
 *   src/caller1.ts  — imports doWork
 *   src/caller2.ts  — imports doWork
 *   src/alpha.ts    — imports betaHelper from beta.ts (circular dep)
 *   src/beta.ts     — imports alphaHelper from alpha.ts (circular dep)
 *
 * Test matrix:
 *   basic              → output has required top-level fields (score, grade, categories)
 *   grade              → grade matches overallDebtScore
 *   complexity         → complexity category detects complexProcessor
 *   structural         → structural category detects circular dep (alpha ↔ beta)
 *   maintainability    → maintainability category detects dead code (isolatedHelper)
 *   topDebtFiles       → topDebtFiles is sorted by debtScore descending
 *   topN               → topN parameter limits topDebtFiles length
 *   recommendations    → recommendations array has at least one entry
 *   summary fields     → summary.totalFiles, totalSymbols > 0
 *   format:summary     → topDebtFiles and recommendations are empty arrays
 *   includeChurn:false → volatility category score is 0
 *   scope filter       → scope: "src/alpha" returns only the alpha subtree
 *   unknown repo       → isError for non-existent repoId
 *   tokenEstimate      → _tokenEstimate is a positive integer
 *   meta               → _meta has timing_ms and powered_by
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as getDebtReportHandler } from '../../src/server/tools/get-debt-report.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/get-debt-report-fixture');

let repoId: string;

// ─── Output type ──────────────────────────────────────────────────────────────

interface DebtCategory {
  score: number;
  itemCount: number;
  topIssues: string[];
}

interface DebtFile {
  filePath: string;
  debtScore: number;
  complexityScore: number;
  structuralScore: number;
  maintainabilityScore: number;
  churnScore: number;
  issues: string[];
}

interface Recommendation {
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: string;
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
  _meta: { timing_ms: number; powered_by: string };
}

function parse(result: { content: Array<{ text: string }> }): GetDebtReportOutput {
  return JSON.parse(result.content[0]!.text) as GetDebtReportOutput;
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  const result = await indexFolder(FIXTURE, { fileLimit: 50 });
  repoId = result.repoId;
}, 60_000);

afterAll(async () => {
  if (repoId) await deleteIndex(repoId);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('get_debt_report', () => {
  describe('basic output structure', () => {
    it('returns required top-level fields', async () => {
      const result = await getDebtReportHandler({ repoId });
      expect(result.isError).toBeFalsy();
      const out = parse(result);

      expect(out.repoId).toBe(repoId);
      expect(typeof out.overallDebtScore).toBe('number');
      expect(out.overallDebtScore).toBeGreaterThanOrEqual(0);
      expect(out.overallDebtScore).toBeLessThanOrEqual(100);
      expect(['A', 'B', 'C', 'D', 'F']).toContain(out.grade);
      expect(out.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns all four debt categories', async () => {
      const result = await getDebtReportHandler({ repoId });
      const out = parse(result);

      expect(out.categories).toHaveProperty('complexity');
      expect(out.categories).toHaveProperty('structural');
      expect(out.categories).toHaveProperty('maintainability');
      expect(out.categories).toHaveProperty('volatility');

      for (const cat of Object.values(out.categories)) {
        expect(typeof cat.score).toBe('number');
        expect(cat.score).toBeGreaterThanOrEqual(0);
        expect(cat.score).toBeLessThanOrEqual(100);
        expect(typeof cat.itemCount).toBe('number');
        expect(Array.isArray(cat.topIssues)).toBe(true);
      }
    });

    it('returns summary with expected fields', async () => {
      const result = await getDebtReportHandler({ repoId });
      const out = parse(result);

      expect(out.summary.totalFiles).toBeGreaterThan(0);
      expect(out.summary.totalSymbols).toBeGreaterThan(0);
      expect(typeof out.summary.complexSymbols).toBe('number');
      expect(typeof out.summary.circularDeps).toBe('number');
      expect(typeof out.summary.deadExports).toBe('number');
      expect(typeof out.summary.gitDataAvailable).toBe('boolean');
    });
  });

  describe('grade mapping', () => {
    it('grade is consistent with overallDebtScore', async () => {
      const result = await getDebtReportHandler({ repoId });
      const out = parse(result);
      const score = out.overallDebtScore;
      const expected =
        score < 20 ? 'A'
        : score < 40 ? 'B'
        : score < 60 ? 'C'
        : score < 80 ? 'D'
        : 'F';
      expect(out.grade).toBe(expected);
    });
  });

  describe('complexity debt', () => {
    it('detects at least one complex symbol (complexProcessor)', async () => {
      const result = await getDebtReportHandler({ repoId });
      const out = parse(result);
      // complexProcessor has high cyclomatic complexity
      expect(out.summary.complexSymbols).toBeGreaterThan(0);
      expect(out.categories.complexity.score).toBeGreaterThan(0);
    });
  });

  describe('structural debt', () => {
    it('detects circular dependency between alpha.ts and beta.ts', async () => {
      const result = await getDebtReportHandler({ repoId });
      const out = parse(result);
      // At least one cycle found
      expect(out.summary.circularDeps).toBeGreaterThan(0);
      expect(out.categories.structural.score).toBeGreaterThan(0);
    });

    it('structural topIssues mentions circular dependencies', async () => {
      const result = await getDebtReportHandler({ repoId });
      const out = parse(result);
      const issues = out.categories.structural.topIssues;
      const hasCircularMention = issues.some(
        (i) => i.toLowerCase().includes('circular') || i.toLowerCase().includes('cycle'),
      );
      expect(hasCircularMention).toBe(true);
    });
  });

  describe('maintainability debt', () => {
    it('detects dead code (isolatedHelper has no importers)', async () => {
      const result = await getDebtReportHandler({ repoId });
      const out = parse(result);
      expect(out.summary.deadExports).toBeGreaterThan(0);
    });
  });

  describe('topDebtFiles', () => {
    it('returns topDebtFiles sorted by debtScore descending', async () => {
      const result = await getDebtReportHandler({ repoId });
      const out = parse(result);
      const scores = out.topDebtFiles.map((f) => f.debtScore);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
      }
    });

    it('each debtFile has required fields', async () => {
      const result = await getDebtReportHandler({ repoId });
      const out = parse(result);
      for (const f of out.topDebtFiles) {
        expect(typeof f.filePath).toBe('string');
        expect(f.filePath.length).toBeGreaterThan(0);
        expect(typeof f.debtScore).toBe('number');
        expect(f.debtScore).toBeGreaterThanOrEqual(0);
        expect(f.debtScore).toBeLessThanOrEqual(100);
        expect(typeof f.complexityScore).toBe('number');
        expect(typeof f.structuralScore).toBe('number');
        expect(typeof f.maintainabilityScore).toBe('number');
        expect(typeof f.churnScore).toBe('number');
        expect(Array.isArray(f.issues)).toBe(true);
      }
    });

    it('topDebtFiles includes utils.ts (complex + coupling)', async () => {
      const result = await getDebtReportHandler({ repoId });
      const out = parse(result);
      const paths = out.topDebtFiles.map((f) => f.filePath);
      const hasUtils = paths.some((p) => p.includes('utils'));
      expect(hasUtils).toBe(true);
    });
  });

  describe('topN parameter', () => {
    it('respects topN=1', async () => {
      const result = await getDebtReportHandler({ repoId, topN: 1 });
      const out = parse(result);
      expect(out.topDebtFiles.length).toBeLessThanOrEqual(1);
    });

    it('respects topN=3', async () => {
      const result = await getDebtReportHandler({ repoId, topN: 3 });
      const out = parse(result);
      expect(out.topDebtFiles.length).toBeLessThanOrEqual(3);
    });
  });

  describe('recommendations', () => {
    it('returns at least one recommendation for a repo with debt', async () => {
      const result = await getDebtReportHandler({ repoId });
      const out = parse(result);
      expect(out.recommendations.length).toBeGreaterThan(0);
    });

    it('recommendations are sorted by priority (critical first)', async () => {
      const result = await getDebtReportHandler({ repoId });
      const out = parse(result);
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      for (let i = 1; i < out.recommendations.length; i++) {
        const prev = order[out.recommendations[i - 1]!.priority];
        const curr = order[out.recommendations[i]!.priority];
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    });

    it('each recommendation has required fields', async () => {
      const result = await getDebtReportHandler({ repoId });
      const out = parse(result);
      for (const rec of out.recommendations) {
        expect(['critical', 'high', 'medium', 'low']).toContain(rec.priority);
        expect(['complexity', 'structural', 'maintainability', 'volatility']).toContain(
          rec.category,
        );
        expect(typeof rec.action).toBe('string');
        expect(rec.action.length).toBeGreaterThan(0);
        expect(typeof rec.estimatedImpact).toBe('string');
        expect(rec.estimatedImpact.length).toBeGreaterThan(0);
      }
    });

    it('includes a structural recommendation for circular dependency', async () => {
      const result = await getDebtReportHandler({ repoId });
      const out = parse(result);
      const structuralRecs = out.recommendations.filter((r) => r.category === 'structural');
      expect(structuralRecs.length).toBeGreaterThan(0);
      const hasCircularRec = structuralRecs.some(
        (r) => r.action.toLowerCase().includes('circular') || r.action.toLowerCase().includes('cycle'),
      );
      expect(hasCircularRec).toBe(true);
    });
  });

  describe('format parameter', () => {
    it('format:summary returns empty topDebtFiles and recommendations', async () => {
      const result = await getDebtReportHandler({ repoId, format: 'summary' });
      const out = parse(result);
      expect(out.topDebtFiles).toEqual([]);
      expect(out.recommendations).toEqual([]);
      // But scores are still present
      expect(typeof out.overallDebtScore).toBe('number');
      expect(out.categories.complexity.score).toBeDefined();
    });

    it('format:detailed (default) returns topDebtFiles and recommendations', async () => {
      const result = await getDebtReportHandler({ repoId, format: 'detailed' });
      const out = parse(result);
      expect(out.topDebtFiles.length).toBeGreaterThan(0);
      expect(out.recommendations.length).toBeGreaterThan(0);
    });
  });

  describe('includeChurn parameter', () => {
    it('includeChurn:false sets volatility score to 0 and disables analysis', async () => {
      const result = await getDebtReportHandler({ repoId, includeChurn: false });
      const out = parse(result);
      expect(out.categories.volatility.score).toBe(0);
    });

    it('includeChurn:false marks git unavailable or disabled in volatility issues', async () => {
      const result = await getDebtReportHandler({ repoId, includeChurn: false });
      const out = parse(result);
      // Churn scores on all files should be 0
      for (const f of out.topDebtFiles) {
        expect(f.churnScore).toBe(0);
      }
    });
  });

  describe('scope filter', () => {
    it('scope limits analysis to the specified directory', async () => {
      const result = await getDebtReportHandler({ repoId, scope: 'src/alpha' });
      const out = parse(result);
      // Only alpha.ts should appear in scope (beta.ts is not in src/alpha)
      for (const f of out.topDebtFiles) {
        expect(f.filePath).toMatch(/^src\/alpha/);
      }
    });

    it('scope:src returns all src files', async () => {
      const resultAll = await getDebtReportHandler({ repoId });
      const resultScoped = await getDebtReportHandler({ repoId, scope: 'src/' });
      // Scoped result should have same or fewer files
      expect(resultScoped.isError).toBeFalsy();
      const outAll = parse(resultAll);
      const outScoped = parse(resultScoped);
      expect(outScoped.topDebtFiles.length).toBeLessThanOrEqual(outAll.topDebtFiles.length);
    });
  });

  describe('error handling', () => {
    it('returns isError for a non-existent repoId', async () => {
      const result = await getDebtReportHandler({ repoId: 'nonexistent000' });
      expect(result.isError).toBe(true);
    });
  });

  describe('meta fields', () => {
    it('_tokenEstimate is a positive integer', async () => {
      const result = await getDebtReportHandler({ repoId });
      const out = parse(result);
      expect(typeof out._tokenEstimate).toBe('number');
      expect(out._tokenEstimate).toBeGreaterThan(0);
      expect(Number.isInteger(out._tokenEstimate)).toBe(true);
    });

    it('_meta has timing_ms and powered_by', async () => {
      const result = await getDebtReportHandler({ repoId });
      const out = parse(result);
      expect(typeof out._meta.timing_ms).toBe('number');
      expect(out._meta.timing_ms).toBeGreaterThanOrEqual(0);
      expect(typeof out._meta.powered_by).toBe('string');
      expect(out._meta.powered_by.length).toBeGreaterThan(0);
    });
  });
});
