/**
 * Tests for the find_refactoring_opportunities tool (Task 162).
 *
 * Unit tests cover pure detection helpers (estimateEffort).
 * Integration tests index basic-ts-project and verify tool output shape,
 * individual detection types, minImpact filtering, and types filtering.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import {
  handler as findRefactoringHandler,
  estimateEffort,
  EXTRACT_FUNCTION_LINE_THRESHOLD,
  EXTRACT_FUNCTION_CC_THRESHOLD,
  INTRODUCE_PARAM_OBJECT_THRESHOLD,
  INLINE_FUNCTION_MAX_LINES,
  SIMPLIFY_NESTING_THRESHOLD,
  SIMPLIFY_RETURN_THRESHOLD,
  CONSOLIDATE_SIMILARITY_THRESHOLD,
} from '../../src/server/tools/find-refactoring-opportunities.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

let repoId: string;

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

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

// ─── estimateEffort ───────────────────────────────────────────────────────────

describe('estimateEffort', () => {
  it('trivial for very small functions', () => {
    expect(estimateEffort(5)).toBe('trivial');
    expect(estimateEffort(10)).toBe('trivial');
  });

  it('small for moderate functions', () => {
    expect(estimateEffort(11)).toBe('small');
    expect(estimateEffort(30)).toBe('small');
  });

  it('medium for larger functions', () => {
    expect(estimateEffort(31)).toBe('medium');
    expect(estimateEffort(100)).toBe('medium');
  });

  it('large for very long functions', () => {
    expect(estimateEffort(101)).toBe('large');
    expect(estimateEffort(500)).toBe('large');
  });
});

// ─── Exported constants sanity check ─────────────────────────────────────────

describe('exported thresholds', () => {
  it('extract_function thresholds are positive integers', () => {
    expect(EXTRACT_FUNCTION_LINE_THRESHOLD).toBeGreaterThan(0);
    expect(EXTRACT_FUNCTION_CC_THRESHOLD).toBeGreaterThan(0);
  });

  it('introduce_parameter_object threshold is positive', () => {
    expect(INTRODUCE_PARAM_OBJECT_THRESHOLD).toBeGreaterThan(0);
  });

  it('inline function max lines is positive', () => {
    expect(INLINE_FUNCTION_MAX_LINES).toBeGreaterThan(0);
  });

  it('simplify conditional thresholds are positive', () => {
    expect(SIMPLIFY_NESTING_THRESHOLD).toBeGreaterThan(0);
    expect(SIMPLIFY_RETURN_THRESHOLD).toBeGreaterThan(0);
  });

  it('consolidate similarity threshold is in (0, 1)', () => {
    expect(CONSOLIDATE_SIMILARITY_THRESHOLD).toBeGreaterThan(0);
    expect(CONSOLIDATE_SIMILARITY_THRESHOLD).toBeLessThan(1);
  });
});

// ─── Integration: tool output shape ──────────────────────────────────────────

describe('find_refactoring_opportunities — output shape', () => {
  it('returns valid JSON with required top-level fields', async () => {
    const result = await findRefactoringHandler({ repoId });
    const out = parse(result);

    expect(out).toHaveProperty('repoId', repoId);
    expect(typeof out['totalOpportunities']).toBe('number');
    expect(Array.isArray(out['opportunities'])).toBe(true);
    expect(typeof out['estimatedImpact']).toBe('string');
    expect(Array.isArray(out['notes'])).toBe(true);
    expect(out).toHaveProperty('_meta');
  });

  it('totalOpportunities matches opportunities array length', async () => {
    const result = await findRefactoringHandler({ repoId });
    const out = parse(result);
    expect(out['totalOpportunities']).toBe((out['opportunities'] as unknown[]).length);
  });

  it('each opportunity has required fields', async () => {
    const result = await findRefactoringHandler({ repoId });
    const out = parse(result);
    for (const opp of out['opportunities'] as Record<string, unknown>[]) {
      expect(typeof opp['type']).toBe('string');
      expect(['low', 'medium', 'high']).toContain(opp['impact']);
      expect(typeof opp['symbolName']).toBe('string');
      expect(typeof opp['filePath']).toBe('string');
      expect(typeof opp['description']).toBe('string');
      expect(typeof opp['suggestion']).toBe('string');
      expect(['trivial', 'small', 'medium', 'large']).toContain(opp['effort']);
    }
  });
});

// ─── Integration: types filter ────────────────────────────────────────────────

describe('find_refactoring_opportunities — types filter', () => {
  it('only returns the requested types when types is specified', async () => {
    const result = await findRefactoringHandler({
      repoId,
      types: ['extract_function'],
    });
    const out = parse(result);
    const types = (out['opportunities'] as Record<string, unknown>[]).map((o) => o['type']);
    for (const t of types) {
      expect(t).toBe('extract_function');
    }
  });

  it('returns all types when types is omitted', async () => {
    const result = await findRefactoringHandler({ repoId });
    const out = parse(result);
    // Result may be empty if fixture is clean — just verify it does not error
    expect(out['totalOpportunities']).toBeGreaterThanOrEqual(0);
  });

  it('multiple types are each represented or not found', async () => {
    const result = await findRefactoringHandler({
      repoId,
      types: ['introduce_parameter_object', 'simplify_conditional'],
    });
    const out = parse(result);
    const types = new Set((out['opportunities'] as Record<string, unknown>[]).map((o) => o['type']));
    // All reported types must be from the requested set
    for (const t of types) {
      expect(['introduce_parameter_object', 'simplify_conditional']).toContain(t);
    }
  });
});

// ─── Integration: minImpact filter ───────────────────────────────────────────

describe('find_refactoring_opportunities — minImpact filter', () => {
  it('minImpact high excludes low and medium', async () => {
    const result = await findRefactoringHandler({ repoId, minImpact: 'high' });
    const out = parse(result);
    for (const opp of out['opportunities'] as Record<string, unknown>[]) {
      expect(opp['impact']).toBe('high');
    }
  });

  it('minImpact medium excludes low', async () => {
    const result = await findRefactoringHandler({ repoId, minImpact: 'medium' });
    const out = parse(result);
    for (const opp of out['opportunities'] as Record<string, unknown>[]) {
      expect(['medium', 'high']).toContain(opp['impact']);
    }
  });

  it('minImpact low returns all (default behaviour)', async () => {
    const [all, filtered] = await Promise.all([
      findRefactoringHandler({ repoId }),
      findRefactoringHandler({ repoId, minImpact: 'low' }),
    ]);
    expect(parse(all)['totalOpportunities']).toBe(parse(filtered)['totalOpportunities']);
  });
});

// ─── Integration: sort order ──────────────────────────────────────────────────

describe('find_refactoring_opportunities — sort order', () => {
  it('results are sorted impact DESC then effort ASC', async () => {
    const result = await findRefactoringHandler({ repoId });
    const opps = (parse(result)['opportunities'] as Record<string, unknown>[]);
    const IMPACT: Record<string, number> = { low: 0, medium: 1, high: 2 };
    const EFFORT: Record<string, number> = { trivial: 0, small: 1, medium: 2, large: 3 };

    for (let i = 1; i < opps.length; i++) {
      const prev = opps[i - 1]!;
      const curr = opps[i]!;
      const impactDiff = IMPACT[curr['impact'] as string]! - IMPACT[prev['impact'] as string]!;
      if (impactDiff > 0) {
        // curr has higher impact than prev — violates sort
        expect(impactDiff).toBeLessThanOrEqual(0);
      } else if (impactDiff === 0) {
        // Same impact: effort must be ascending
        const effortDiff = EFFORT[curr['effort'] as string]! - EFFORT[prev['effort'] as string]!;
        expect(effortDiff).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ─── Integration: missing repo ───────────────────────────────────────────────

describe('find_refactoring_opportunities — error handling', () => {
  it('returns isError for unknown repoId', async () => {
    const result = await findRefactoringHandler({ repoId: 'nonexistent-repo-id' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    const out = JSON.parse(text) as { error: string };
    expect(out.error).toMatch(/not found/i);
  });
});

// ─── Integration: consolidate_duplicates skipped without index ───────────────

describe('find_refactoring_opportunities — consolidate_duplicates', () => {
  it('gracefully skips when no semantic index present', async () => {
    const result = await findRefactoringHandler({
      repoId,
      types: ['consolidate_duplicates'],
    });
    const out = parse(result);
    // Either 0 findings (no index) or valid findings — no error either way
    expect(result.isError).toBeFalsy();
    expect(out['totalOpportunities']).toBeGreaterThanOrEqual(0);
    // If skipped, a note should appear
    const notes = out['notes'] as string[];
    if ((out['totalOpportunities'] as number) === 0) {
      // No embeddings in test fixture — expect a skip note
      expect(notes.some((n) => n.includes('consolidate_duplicates') || n.includes('semantic index'))).toBe(true);
    }
  });
});
