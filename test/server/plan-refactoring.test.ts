/**
 * Tests for the plan_refactoring tool (Task 187).
 *
 * Fixture: test/fixtures/plan-refactoring-fixture/
 *   src/utils.ts    — defines doWork (used in caller1 + caller2), isolatedHelper,
 *                     and complexProcessor (complex for quality metrics)
 *   src/caller1.ts  — imports + calls doWork
 *   src/caller2.ts  — imports + calls doWork
 *   src/alpha.ts    — imports betaHelper from beta.ts (creates alpha ↔ beta cycle)
 *   src/beta.ts     — imports alphaHelper from alpha.ts (completes the cycle)
 *
 * Test matrix:
 *   rename-symbol  → steps in bottom-up order (declaration last)
 *   delete-symbol  → reference removal steps precede deletion step
 *   break-cycle    → step identifies weakest edge in 2-file cycle
 *   extract-module → import update steps + move step
 *   reduce-coupling → coupling-based suggestions for a file
 *   general        → at least 1 step from quality/antipattern findings
 *   estimatedRisk  → aggregation from step risks is correct
 *   validation     → missing required args produce isError responses
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';
import { handler as planRefactoringHandler } from '../../src/server/tools/plan-refactoring.js';
import type { RefactoringStep } from '../../src/server/tools/plan-refactoring.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/plan-refactoring-fixture');

let repoId: string;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findSymbolId(name: string): string {
  const db = openDatabase(repoId);
  try {
    const results = searchSymbols(db, repoId, name, {});
    const match = results.find((s) => s.name === name);
    if (!match) throw new Error(`Symbol "${name}" not found in index`);
    return match.id;
  } finally {
    db.close();
  }
}

interface PlanRefactoringOutput {
  goal: string;
  summary: string;
  steps: RefactoringStep[];
  totalSteps: number;
  estimatedRisk: 'low' | 'medium' | 'high';
  warnings: string[];
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string };
}

function parse(result: { content: Array<{ text: string }> }): PlanRefactoringOutput {
  return JSON.parse(result.content[0]!.text) as PlanRefactoringOutput;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  const result = await indexFolder(FIXTURE, { fileLimit: 50 });
  repoId = result.repoId;
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

// ─── Validation ───────────────────────────────────────────────────────────────

describe('plan_refactoring — validation', () => {
  it('returns error for unknown repoId', async () => {
    const result = await planRefactoringHandler({
      repoId: 'deadbeef00000000',
      goal: 'general',
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/not found/i);
  });

  it('returns error for rename-symbol without newName', async () => {
    const symbolId = findSymbolId('doWork');
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'rename-symbol',
      // newName omitted
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/newName/i);
  });

  it('returns error for rename-symbol without symbolId', async () => {
    const result = await planRefactoringHandler({
      repoId,
      goal: 'rename-symbol',
      newName: 'processData',
    });
    expect(result.isError).toBe(true);
  });

  it('returns error for delete-symbol without symbolId', async () => {
    const result = await planRefactoringHandler({
      repoId,
      goal: 'delete-symbol',
    });
    expect(result.isError).toBe(true);
  });

  it('returns error for extract-module without newFilePath', async () => {
    const result = await planRefactoringHandler({
      repoId,
      filePath: 'src/utils.ts',
      goal: 'extract-module',
      // newFilePath omitted
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/newFilePath/i);
  });

  it('returns error for break-cycle without filePath or symbolId', async () => {
    const result = await planRefactoringHandler({
      repoId,
      goal: 'break-cycle',
    });
    expect(result.isError).toBe(true);
  });
});

// ─── rename-symbol ────────────────────────────────────────────────────────────

describe('plan_refactoring — rename-symbol', () => {
  let symbolId: string;

  beforeAll(() => {
    symbolId = findSymbolId('doWork');
  });

  it('returns a plan with the correct goal', async () => {
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'rename-symbol',
      newName: 'processData',
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.goal).toBe('rename-symbol');
  });

  it('summary mentions the old and new name', async () => {
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'rename-symbol',
      newName: 'processData',
    });
    const data = parse(result);
    expect(data.summary).toMatch(/doWork/);
    expect(data.summary).toMatch(/processData/);
  });

  it('generates steps for references in caller1 and caller2', async () => {
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'rename-symbol',
      newName: 'processData',
    });
    const data = parse(result);
    const filePaths = data.steps.map((s) => s.filePath);
    expect(filePaths.some((p) => p.includes('caller1'))).toBe(true);
    expect(filePaths.some((p) => p.includes('caller2'))).toBe(true);
  });

  it('declaration rename step is the last step', async () => {
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'rename-symbol',
      newName: 'processData',
    });
    const data = parse(result);
    expect(data.steps.length).toBeGreaterThan(0);

    const lastStep = data.steps[data.steps.length - 1]!;
    expect(lastStep.filePath).toMatch(/utils/);
    expect(lastStep.action).toMatch(/declaration/i);
  });

  it('steps have sequential order numbers starting at 1', async () => {
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'rename-symbol',
      newName: 'processData',
    });
    const data = parse(result);
    data.steps.forEach((step, idx) => {
      expect(step.order).toBe(idx + 1);
    });
  });

  it('all steps are automated and low-risk (no conflicts, no string literals)', async () => {
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'rename-symbol',
      newName: 'processData',
    });
    const data = parse(result);
    for (const step of data.steps) {
      expect(step.automated).toBe(true);
      expect(step.risk).toBe('low');
    }
    expect(data.estimatedRisk).toBe('low');
  });

  it('each step has required fields', async () => {
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'rename-symbol',
      newName: 'processData',
    });
    const data = parse(result);
    for (const step of data.steps) {
      expect(step).toHaveProperty('order');
      expect(step).toHaveProperty('action');
      expect(step).toHaveProperty('filePath');
      expect(step).toHaveProperty('detail');
      expect(step).toHaveProperty('automated');
      expect(step).toHaveProperty('risk');
      expect(['low', 'medium', 'high']).toContain(step.risk);
    }
  });

  it('totalSteps matches steps array length', async () => {
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'rename-symbol',
      newName: 'processData',
    });
    const data = parse(result);
    expect(data.totalSteps).toBe(data.steps.length);
  });
});

// ─── delete-symbol ────────────────────────────────────────────────────────────

describe('plan_refactoring — delete-symbol', () => {
  let symbolId: string;

  beforeAll(() => {
    symbolId = findSymbolId('doWork');
  });

  it('returns a plan with goal delete-symbol', async () => {
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'delete-symbol',
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.goal).toBe('delete-symbol');
  });

  it('reference removal steps appear before the deletion step', async () => {
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'delete-symbol',
    });
    const data = parse(result);
    expect(data.steps.length).toBeGreaterThan(1);

    const deletionStep = data.steps.find((s) =>
      s.action.toLowerCase().includes('delete') && s.filePath.includes('utils'),
    );
    expect(deletionStep).toBeDefined();

    // Deletion step should be the last step
    const lastStep = data.steps[data.steps.length - 1]!;
    expect(lastStep.action).toMatch(/delete/i);
  });

  it('deletion step has risk: high', async () => {
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'delete-symbol',
    });
    const data = parse(result);
    const lastStep = data.steps[data.steps.length - 1]!;
    expect(lastStep.risk).toBe('high');
  });

  it('estimatedRisk is high because deletion step is high-risk', async () => {
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'delete-symbol',
    });
    const data = parse(result);
    expect(data.estimatedRisk).toBe('high');
  });

  it('reference steps come before deletion in order', async () => {
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'delete-symbol',
    });
    const data = parse(result);

    // Find the first deletion-type step
    const deletionIdx = data.steps.findIndex((s) => s.risk === 'high');
    expect(deletionIdx).toBeGreaterThan(0);

    // All steps before it should not be the deletion step
    const stepsBeforeDeletion = data.steps.slice(0, deletionIdx);
    expect(stepsBeforeDeletion.length).toBeGreaterThan(0);
    for (const s of stepsBeforeDeletion) {
      expect(s.risk).not.toBe('high');
    }
  });
});

// ─── break-cycle ──────────────────────────────────────────────────────────────

describe('plan_refactoring — break-cycle', () => {
  it('returns a plan for the alpha ↔ beta cycle', async () => {
    const result = await planRefactoringHandler({
      repoId,
      filePath: 'src/alpha.ts',
      goal: 'break-cycle',
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.goal).toBe('break-cycle');
    expect(data.steps.length).toBeGreaterThan(0);
  });

  it('plan identifies the weakest edge (alpha or beta file)', async () => {
    const result = await planRefactoringHandler({
      repoId,
      filePath: 'src/alpha.ts',
      goal: 'break-cycle',
    });
    const data = parse(result);

    // The first step should mention a "shared module" or "cycle"
    const firstStep = data.steps[0]!;
    expect(firstStep.detail).toMatch(/alpha|beta/i);
    expect(firstStep.detail).toMatch(/shared|cycle|weakest/i);
  });

  it('cycle-breaking steps are not automated (require design judgment)', async () => {
    const result = await planRefactoringHandler({
      repoId,
      filePath: 'src/alpha.ts',
      goal: 'break-cycle',
    });
    const data = parse(result);
    const nonAutomatedSteps = data.steps.filter((s) => !s.automated);
    expect(nonAutomatedSteps.length).toBeGreaterThan(0);
  });

  it('step detail mentions the cycle files', async () => {
    const result = await planRefactoringHandler({
      repoId,
      filePath: 'src/alpha.ts',
      goal: 'break-cycle',
    });
    const data = parse(result);
    const allDetails = data.steps.map((s) => s.detail).join(' ');
    expect(allDetails).toMatch(/alpha/i);
    expect(allDetails).toMatch(/beta/i);
  });

  it('works when scoped via symbolId (derives filePath from symbol)', async () => {
    const symbolId = findSymbolId('alphaHelper');
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'break-cycle',
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.steps.length).toBeGreaterThan(0);
  });
});

// ─── extract-module ───────────────────────────────────────────────────────────

describe('plan_refactoring — extract-module', () => {
  it('returns a plan to move utils.ts to a new location', async () => {
    const result = await planRefactoringHandler({
      repoId,
      filePath: 'src/utils.ts',
      newFilePath: 'src/core/utils.ts',
      goal: 'extract-module',
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.goal).toBe('extract-module');
    expect(data.steps.length).toBeGreaterThan(0);
  });

  it('generates import update steps for caller1 and caller2', async () => {
    const result = await planRefactoringHandler({
      repoId,
      filePath: 'src/utils.ts',
      newFilePath: 'src/core/utils.ts',
      goal: 'extract-module',
    });
    const data = parse(result);
    const importSteps = data.steps.filter(
      (s) => s.action.toLowerCase().includes('import') && s.action.toLowerCase().includes('update'),
    );
    expect(importSteps.length).toBeGreaterThanOrEqual(2); // caller1 + caller2
  });

  it('file move step is the last step', async () => {
    const result = await planRefactoringHandler({
      repoId,
      filePath: 'src/utils.ts',
      newFilePath: 'src/core/utils.ts',
      goal: 'extract-module',
    });
    const data = parse(result);
    const lastStep = data.steps[data.steps.length - 1]!;
    expect(lastStep.action.toLowerCase()).toMatch(/move/i);
    expect(lastStep.filePath).toMatch(/utils/);
  });

  it('summary mentions both source and destination paths', async () => {
    const result = await planRefactoringHandler({
      repoId,
      filePath: 'src/utils.ts',
      newFilePath: 'src/core/utils.ts',
      goal: 'extract-module',
    });
    const data = parse(result);
    expect(data.summary).toMatch(/utils\.ts/);
    expect(data.summary).toMatch(/core/);
  });
});

// ─── reduce-coupling ──────────────────────────────────────────────────────────

describe('plan_refactoring — reduce-coupling', () => {
  it('returns a plan for utils.ts (has afferent coupling from caller1 + caller2)', async () => {
    const result = await planRefactoringHandler({
      repoId,
      filePath: 'src/utils.ts',
      goal: 'reduce-coupling',
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.goal).toBe('reduce-coupling');
    expect(data.steps.length).toBeGreaterThan(0);
  });

  it('reduce-coupling steps are not automated (require design judgment)', async () => {
    const result = await planRefactoringHandler({
      repoId,
      filePath: 'src/utils.ts',
      goal: 'reduce-coupling',
    });
    const data = parse(result);
    const nonAuto = data.steps.filter((s) => !s.automated);
    expect(nonAuto.length).toBeGreaterThan(0);
  });

  it('summary mentions the file and coupling data', async () => {
    const result = await planRefactoringHandler({
      repoId,
      filePath: 'src/utils.ts',
      goal: 'reduce-coupling',
    });
    const data = parse(result);
    expect(data.summary).toMatch(/utils\.ts/);
  });
});

// ─── general ─────────────────────────────────────────────────────────────────

describe('plan_refactoring — general', () => {
  it('returns a plan with at least 1 step from quality findings for complexProcessor', async () => {
    // complexProcessor is designed with high cyclomatic complexity
    const result = await planRefactoringHandler({
      repoId,
      filePath: 'src/utils.ts',
      goal: 'general',
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.goal).toBe('general');
    // Should find at least one quality issue (complexProcessor) or antipattern
    expect(data.steps.length).toBeGreaterThanOrEqual(1);
  });

  it('steps reference the target file', async () => {
    const result = await planRefactoringHandler({
      repoId,
      filePath: 'src/utils.ts',
      goal: 'general',
    });
    const data = parse(result);
    // At least one step should be in utils.ts
    const utilsSteps = data.steps.filter((s) => s.filePath.includes('utils'));
    expect(utilsSteps.length).toBeGreaterThan(0);
  });

  it('contextHint is included in the summary', async () => {
    const result = await planRefactoringHandler({
      repoId,
      filePath: 'src/utils.ts',
      goal: 'general',
      contextHint: 'reducing complexity before Q3 release',
    });
    const data = parse(result);
    expect(data.summary).toMatch(/reducing complexity/i);
  });

  it('works without filePath (uses whole repo)', async () => {
    const result = await planRefactoringHandler({
      repoId,
      goal: 'general',
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.steps.length).toBeGreaterThanOrEqual(0);
  });
});

// ─── estimatedRisk aggregation ────────────────────────────────────────────────

describe('plan_refactoring — estimatedRisk aggregation', () => {
  it('estimatedRisk: high when delete-symbol (has high-risk deletion step)', async () => {
    const symbolId = findSymbolId('doWork');
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'delete-symbol',
    });
    const data = parse(result);
    expect(data.estimatedRisk).toBe('high');
  });

  it('estimatedRisk: low when rename-symbol with no conflicts or string literals', async () => {
    const symbolId = findSymbolId('doWork');
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'rename-symbol',
      newName: 'processData',
    });
    const data = parse(result);
    // All rename steps are low risk — no string literals, no conflicts
    expect(data.estimatedRisk).toBe('low');
  });

  it('estimatedRisk: medium or high for break-cycle (at least medium steps)', async () => {
    const result = await planRefactoringHandler({
      repoId,
      filePath: 'src/alpha.ts',
      goal: 'break-cycle',
    });
    const data = parse(result);
    expect(['medium', 'high']).toContain(data.estimatedRisk);
  });

  it('estimatedRisk reflects the worst step risk', async () => {
    const symbolId = findSymbolId('doWork');
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'delete-symbol',
    });
    const data = parse(result);
    const worstStepRisk = data.steps.reduce<'low' | 'medium' | 'high'>((worst, s) => {
      if (s.risk === 'high') return 'high';
      if (s.risk === 'medium' && worst !== 'high') return 'medium';
      return worst;
    }, 'low');
    expect(data.estimatedRisk).toBe(worstStepRisk);
  });
});

// ─── Output structure ─────────────────────────────────────────────────────────

describe('plan_refactoring — output structure', () => {
  it('output has all required top-level fields', async () => {
    const symbolId = findSymbolId('doWork');
    const result = await planRefactoringHandler({
      repoId,
      symbolId,
      goal: 'rename-symbol',
      newName: 'processData',
    });
    const data = parse(result);
    expect(data).toHaveProperty('goal');
    expect(data).toHaveProperty('summary');
    expect(data).toHaveProperty('steps');
    expect(data).toHaveProperty('totalSteps');
    expect(data).toHaveProperty('estimatedRisk');
    expect(data).toHaveProperty('warnings');
    expect(data).toHaveProperty('_tokenEstimate');
    expect(data).toHaveProperty('_meta');
    expect(Array.isArray(data.steps)).toBe(true);
    expect(Array.isArray(data.warnings)).toBe(true);
    expect(data._tokenEstimate).toBeGreaterThanOrEqual(0);
  });

  it('_meta has timing_ms and powered_by', async () => {
    const result = await planRefactoringHandler({
      repoId,
      filePath: 'src/utils.ts',
      goal: 'general',
    });
    const data = parse(result);
    expect(data._meta).toHaveProperty('timing_ms');
    expect(data._meta).toHaveProperty('powered_by');
    expect(data._meta.timing_ms).toBeGreaterThanOrEqual(0);
  });
});
