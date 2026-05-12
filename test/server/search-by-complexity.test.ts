/**
 * Tests for the search_by_complexity tool (Task 194).
 *
 * Fixture: test/fixtures/search-by-complexity-fixture/
 *   src/simple.ts       — low-complexity functions (CC=1, lines≤10, params≤2)
 *   src/complex.ts      — high-complexity functions (CC>=6, nesting>=4, params>=3)
 *   src/many-params.ts  — functions with 0–7 params, multiple returns
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as searchByComplexityHandler } from '../../src/server/tools/search-by-complexity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/search-by-complexity-fixture');

let repoId: string;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ComplexityMetrics {
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  lineCount: number;
  nestingDepth: number;
  paramCount: number;
  returnCount: number;
}

interface ComplexitySymbol {
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  signature: string;
  summary: string;
  metrics: ComplexityMetrics;
}

interface SearchByComplexityOutput {
  symbols: ComplexitySymbol[];
  totalFound: number;
  sortedBy: string;
  sortOrder: string;
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string };
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
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

// ─── Helper ───────────────────────────────────────────────────────────────────

async function search(args: {
  minCyclomaticComplexity?: number;
  maxCyclomaticComplexity?: number;
  minCognitiveComplexity?: number;
  maxCognitiveComplexity?: number;
  minLineCount?: number;
  maxLineCount?: number;
  minNestingDepth?: number;
  maxNestingDepth?: number;
  minParamCount?: number;
  maxParamCount?: number;
  minReturnCount?: number;
  maxReturnCount?: number;
  sortBy?: 'complexity' | 'cognitive' | 'size' | 'nesting' | 'params' | 'returns';
  sortOrder?: 'asc' | 'desc';
  kind?: string;
  filePath?: string;
  limit?: number;
}): Promise<SearchByComplexityOutput> {
  const result = await searchByComplexityHandler({ repoId, ...args });
  expect(result.isError).toBeFalsy();
  const text = (result.content[0] as { type: string; text: string }).text;
  return JSON.parse(text) as SearchByComplexityOutput;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('search_by_complexity — cyclomatic complexity filters', () => {
  it('returns all measurable symbols when no filters are applied', async () => {
    const out = await search({});
    // Should have functions from all 3 fixture files
    expect(out.symbols.length).toBeGreaterThan(0);
    // Every returned symbol has metrics attached
    for (const sym of out.symbols) {
      expect(sym.metrics).toBeDefined();
      expect(typeof sym.metrics.cyclomaticComplexity).toBe('number');
    }
  });

  it('finds high-complexity symbols with minCyclomaticComplexity', async () => {
    const out = await search({ minCyclomaticComplexity: 5 });
    expect(out.symbols.length).toBeGreaterThan(0);
    for (const sym of out.symbols) {
      expect(sym.metrics.cyclomaticComplexity).toBeGreaterThanOrEqual(5);
    }
    const names = out.symbols.map((s) => s.name);
    // Both complex functions should appear
    expect(names.some((n) => n === 'processData')).toBe(true);
    expect(names.some((n) => n === 'parseAndValidate')).toBe(true);
  });

  it('excludes high-complexity symbols with maxCyclomaticComplexity', async () => {
    const out = await search({ maxCyclomaticComplexity: 2 });
    for (const sym of out.symbols) {
      expect(sym.metrics.cyclomaticComplexity).toBeLessThanOrEqual(2);
    }
    const names = out.symbols.map((s) => s.name);
    // Simple functions should appear
    expect(names.some((n) => n === 'add' || n === 'greet' || n === 'identity')).toBe(true);
    // Complex functions should not appear
    expect(names).not.toContain('processData');
    expect(names).not.toContain('parseAndValidate');
  });

  it('applies both min and max cyclomatic complexity (range query)', async () => {
    const out = await search({ minCyclomaticComplexity: 1, maxCyclomaticComplexity: 3 });
    for (const sym of out.symbols) {
      expect(sym.metrics.cyclomaticComplexity).toBeGreaterThanOrEqual(1);
      expect(sym.metrics.cyclomaticComplexity).toBeLessThanOrEqual(3);
    }
  });

  it('returns empty result when complexity range is impossible', async () => {
    const out = await search({ minCyclomaticComplexity: 1000 });
    expect(out.symbols).toHaveLength(0);
    expect(out.totalFound).toBe(0);
  });
});

describe('search_by_complexity — line count filters', () => {
  it('finds short functions with maxLineCount', async () => {
    const out = await search({ maxLineCount: 10 });
    expect(out.symbols.length).toBeGreaterThan(0);
    for (const sym of out.symbols) {
      expect(sym.metrics.lineCount).toBeLessThanOrEqual(10);
    }
  });

  it('finds long functions with minLineCount', async () => {
    const out = await search({ minLineCount: 20 });
    expect(out.symbols.length).toBeGreaterThan(0);
    for (const sym of out.symbols) {
      expect(sym.metrics.lineCount).toBeGreaterThanOrEqual(20);
    }
    const names = out.symbols.map((s) => s.name);
    expect(names.some((n) => n === 'processData' || n === 'parseAndValidate')).toBe(true);
  });
});

describe('search_by_complexity — nesting depth filters', () => {
  it('finds deeply nested symbols with minNestingDepth', async () => {
    const out = await search({ minNestingDepth: 4 });
    expect(out.symbols.length).toBeGreaterThan(0);
    for (const sym of out.symbols) {
      expect(sym.metrics.nestingDepth).toBeGreaterThanOrEqual(4);
    }
    // processData has deep nesting (for loop inside function, ifs inside for)
    const names = out.symbols.map((s) => s.name);
    expect(names).toContain('processData');
  });

  it('finds shallow symbols with maxNestingDepth', async () => {
    const out = await search({ maxNestingDepth: 2 });
    for (const sym of out.symbols) {
      expect(sym.metrics.nestingDepth).toBeLessThanOrEqual(2);
    }
    const names = out.symbols.map((s) => s.name);
    // Simple functions have nesting=1
    expect(names.some((n) => n === 'add' || n === 'greet')).toBe(true);
  });
});

describe('search_by_complexity — param count filters', () => {
  it('finds zero-param functions with maxParamCount: 0', async () => {
    const out = await search({ maxParamCount: 0 });
    for (const sym of out.symbols) {
      expect(sym.metrics.paramCount).toBe(0);
    }
    const names = out.symbols.map((s) => s.name);
    expect(names).toContain('noParams');
  });

  it('finds functions with many params with minParamCount: 5', async () => {
    const out = await search({ minParamCount: 5 });
    expect(out.symbols.length).toBeGreaterThan(0);
    for (const sym of out.symbols) {
      expect(sym.metrics.paramCount).toBeGreaterThanOrEqual(5);
    }
    const names = out.symbols.map((s) => s.name);
    expect(names.some((n) => n === 'fiveParams' || n === 'sevenParams' || n === 'processData')).toBe(true);
  });

  it('finds functions with exactly 1 param using min+max', async () => {
    const out = await search({ minParamCount: 1, maxParamCount: 1 });
    for (const sym of out.symbols) {
      expect(sym.metrics.paramCount).toBe(1);
    }
    const names = out.symbols.map((s) => s.name);
    expect(names.some((n) => n === 'oneParam' || n === 'greet' || n === 'identity')).toBe(true);
  });
});

describe('search_by_complexity — return count filters', () => {
  it('finds functions with multiple return statements', async () => {
    const out = await search({ minReturnCount: 3 });
    expect(out.symbols.length).toBeGreaterThan(0);
    for (const sym of out.symbols) {
      expect(sym.metrics.returnCount).toBeGreaterThanOrEqual(3);
    }
    // multiReturn and parseAndValidate have many returns
    const names = out.symbols.map((s) => s.name);
    expect(names.some((n) => n === 'multiReturn' || n === 'parseAndValidate')).toBe(true);
  });
});

describe('search_by_complexity — cognitive complexity filters', () => {
  it('finds symbols with high cognitive complexity', async () => {
    const out = await search({ minCognitiveComplexity: 3 });
    expect(out.symbols.length).toBeGreaterThan(0);
    for (const sym of out.symbols) {
      expect(sym.metrics.cognitiveComplexity).toBeGreaterThanOrEqual(3);
    }
  });

  it('finds simple symbols with low cognitive complexity', async () => {
    const out = await search({ maxCognitiveComplexity: 1 });
    for (const sym of out.symbols) {
      expect(sym.metrics.cognitiveComplexity).toBeLessThanOrEqual(1);
    }
    const names = out.symbols.map((s) => s.name);
    expect(names.some((n) => n === 'add' || n === 'greet' || n === 'noParams')).toBe(true);
  });
});

describe('search_by_complexity — combined filters', () => {
  it('combines cyclomatic + param count filters (AND semantics)', async () => {
    // High-complexity AND many params
    const out = await search({ minCyclomaticComplexity: 5, minParamCount: 4 });
    for (const sym of out.symbols) {
      expect(sym.metrics.cyclomaticComplexity).toBeGreaterThanOrEqual(5);
      expect(sym.metrics.paramCount).toBeGreaterThanOrEqual(4);
    }
    // processData matches both (CC>=6, 5 params)
    const names = out.symbols.map((s) => s.name);
    expect(names).toContain('processData');
  });

  it('combines cyclomatic complexity and file path filter', async () => {
    const out = await search({
      minCyclomaticComplexity: 5,
      filePath: 'src/complex.ts',
    });
    for (const sym of out.symbols) {
      expect(sym.metrics.cyclomaticComplexity).toBeGreaterThanOrEqual(5);
      expect(sym.filePath).toBe('src/complex.ts');
    }
  });
});

describe('search_by_complexity — sorting', () => {
  it('default sort is by cyclomatic complexity descending', async () => {
    const out = await search({});
    expect(out.sortedBy).toBe('complexity');
    expect(out.sortOrder).toBe('desc');
    // First symbol should have highest cyclomatic complexity
    for (let i = 1; i < out.symbols.length; i++) {
      expect(out.symbols[i - 1]!.metrics.cyclomaticComplexity).toBeGreaterThanOrEqual(
        out.symbols[i]!.metrics.cyclomaticComplexity,
      );
    }
  });

  it('sorts by line count descending when sortBy="size"', async () => {
    const out = await search({ sortBy: 'size' });
    expect(out.sortedBy).toBe('size');
    for (let i = 1; i < out.symbols.length; i++) {
      expect(out.symbols[i - 1]!.metrics.lineCount).toBeGreaterThanOrEqual(
        out.symbols[i]!.metrics.lineCount,
      );
    }
  });

  it('sorts by line count ascending when sortBy="size", sortOrder="asc"', async () => {
    const out = await search({ sortBy: 'size', sortOrder: 'asc' });
    expect(out.sortOrder).toBe('asc');
    for (let i = 1; i < out.symbols.length; i++) {
      expect(out.symbols[i - 1]!.metrics.lineCount).toBeLessThanOrEqual(
        out.symbols[i]!.metrics.lineCount,
      );
    }
  });

  it('sorts by nesting depth descending when sortBy="nesting"', async () => {
    const out = await search({ sortBy: 'nesting' });
    for (let i = 1; i < out.symbols.length; i++) {
      expect(out.symbols[i - 1]!.metrics.nestingDepth).toBeGreaterThanOrEqual(
        out.symbols[i]!.metrics.nestingDepth,
      );
    }
    // processData (deepest nesting) should come first
    expect(out.symbols[0]!.name).toBe('processData');
  });

  it('sorts by param count descending when sortBy="params"', async () => {
    const out = await search({ sortBy: 'params' });
    for (let i = 1; i < out.symbols.length; i++) {
      expect(out.symbols[i - 1]!.metrics.paramCount).toBeGreaterThanOrEqual(
        out.symbols[i]!.metrics.paramCount,
      );
    }
  });

  it('sorts by return count descending when sortBy="returns"', async () => {
    const out = await search({ sortBy: 'returns' });
    for (let i = 1; i < out.symbols.length; i++) {
      expect(out.symbols[i - 1]!.metrics.returnCount).toBeGreaterThanOrEqual(
        out.symbols[i]!.metrics.returnCount,
      );
    }
  });

  it('sorts by cognitive complexity descending when sortBy="cognitive"', async () => {
    const out = await search({ sortBy: 'cognitive' });
    for (let i = 1; i < out.symbols.length; i++) {
      expect(out.symbols[i - 1]!.metrics.cognitiveComplexity).toBeGreaterThanOrEqual(
        out.symbols[i]!.metrics.cognitiveComplexity,
      );
    }
  });
});

describe('search_by_complexity — kind filter', () => {
  it('returns only functions when kind="function"', async () => {
    const out = await search({ kind: 'function' });
    for (const sym of out.symbols) {
      expect(sym.kind).toBe('function');
    }
  });
});

describe('search_by_complexity — filePath filter', () => {
  it('restricts results to the specified file', async () => {
    const out = await search({ filePath: 'src/simple.ts' });
    for (const sym of out.symbols) {
      expect(sym.filePath).toBe('src/simple.ts');
    }
    const names = out.symbols.map((s) => s.name);
    expect(names).toContain('add');
    expect(names).toContain('greet');
  });

  it('restricts results to a directory prefix', async () => {
    const out = await search({ filePath: 'src/' });
    for (const sym of out.symbols) {
      expect(sym.filePath).toMatch(/^src\//);
    }
  });
});

describe('search_by_complexity — limit', () => {
  it('respects the limit parameter', async () => {
    const out = await search({ limit: 2 });
    expect(out.symbols.length).toBeLessThanOrEqual(2);
  });

  it('default limit is 50', async () => {
    const out = await search({});
    expect(out.symbols.length).toBeLessThanOrEqual(50);
  });
});

describe('search_by_complexity — output shape', () => {
  it('returns required fields on each symbol', async () => {
    const out = await search({});
    for (const sym of out.symbols) {
      expect(sym).toHaveProperty('symbolId');
      expect(sym).toHaveProperty('name');
      expect(sym).toHaveProperty('kind');
      expect(sym).toHaveProperty('filePath');
      expect(sym).toHaveProperty('startLine');
      expect(sym).toHaveProperty('signature');
      expect(sym).toHaveProperty('summary');
      expect(sym).toHaveProperty('metrics');
      expect(typeof sym.startLine).toBe('number');
      expect(sym.startLine).toBeGreaterThanOrEqual(1);
    }
  });

  it('metrics object contains all six dimensions', async () => {
    const out = await search({});
    for (const sym of out.symbols) {
      expect(sym.metrics).toHaveProperty('cyclomaticComplexity');
      expect(sym.metrics).toHaveProperty('cognitiveComplexity');
      expect(sym.metrics).toHaveProperty('lineCount');
      expect(sym.metrics).toHaveProperty('nestingDepth');
      expect(sym.metrics).toHaveProperty('paramCount');
      expect(sym.metrics).toHaveProperty('returnCount');
      expect(typeof sym.metrics.cyclomaticComplexity).toBe('number');
      expect(typeof sym.metrics.lineCount).toBe('number');
    }
  });

  it('returns totalFound equal to symbols array length', async () => {
    const out = await search({});
    expect(out.totalFound).toBe(out.symbols.length);
  });

  it('returns _tokenEstimate > 0 when results found', async () => {
    const out = await search({});
    expect(out.totalFound).toBeGreaterThan(0);
    expect(out._tokenEstimate).toBeGreaterThan(0);
  });

  it('returns _meta with timing_ms and powered_by', async () => {
    const out = await search({});
    expect(out._meta).toBeDefined();
    expect(out._meta.timing_ms).toBeGreaterThanOrEqual(0);
    expect(out._meta.powered_by).toBe('PureContext MCP');
  });

  it('returns sortedBy and sortOrder in response', async () => {
    const out = await search({ sortBy: 'params', sortOrder: 'asc' });
    expect(out.sortedBy).toBe('params');
    expect(out.sortOrder).toBe('asc');
  });
});
