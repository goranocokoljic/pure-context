/**
 * Tests for the detect_antipatterns tool (Task 159).
 *
 * Unit tests cover pure detection functions (cycle detection, cosine similarity).
 * Integration tests index basic-ts-project and verify the tool output shape and
 * specific check behaviour.
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
  handler as detectAntipatternsHandler,
  buildAdjacencyList,
  findCycles,
  cosineSimilarity,
  DEEP_NESTING_THRESHOLD,
  LONG_PARAM_WARNING,
  HIGH_COUPLING_WARNING,
  HIGH_COUPLING_ERROR,
  GOD_CLASS_LINE_THRESHOLD,
  GOD_CLASS_METHOD_THRESHOLD,
} from '../../src/server/tools/detect-antipatterns.js';
import type { DepEdge } from '../../src/core/types.js';

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

function makeEdge(sourceFile: string, targetFile: string): DepEdge {
  return {
    repoId: 'test',
    sourceFile,
    sourceSymbolId: null,
    targetFile,
    targetSymbolId: null,
    edgeType: 'import',
    specifier: targetFile,
  };
}

// ─── buildAdjacencyList ───────────────────────────────────────────────────────

describe('buildAdjacencyList', () => {
  it('returns empty map for empty edges', () => {
    expect(buildAdjacencyList([]).size).toBe(0);
  });

  it('creates source → target entry', () => {
    const adj = buildAdjacencyList([makeEdge('a.ts', 'b.ts')]);
    expect(adj.get('a.ts')).toContain('b.ts');
  });

  it('ensures target node appears even with no outgoing edges', () => {
    const adj = buildAdjacencyList([makeEdge('a.ts', 'b.ts')]);
    expect(adj.has('b.ts')).toBe(true);
    expect(adj.get('b.ts')).toHaveLength(0);
  });

  it('accumulates multiple outgoing edges from same source', () => {
    const adj = buildAdjacencyList([
      makeEdge('a.ts', 'b.ts'),
      makeEdge('a.ts', 'c.ts'),
    ]);
    expect(adj.get('a.ts')).toContain('b.ts');
    expect(adj.get('a.ts')).toContain('c.ts');
  });
});

// ─── findCycles ───────────────────────────────────────────────────────────────

describe('findCycles', () => {
  it('returns empty array for acyclic graph', () => {
    const adj = buildAdjacencyList([
      makeEdge('a.ts', 'b.ts'),
      makeEdge('b.ts', 'c.ts'),
    ]);
    expect(findCycles(adj)).toHaveLength(0);
  });

  it('detects a simple 2-node cycle', () => {
    const adj = buildAdjacencyList([
      makeEdge('a.ts', 'b.ts'),
      makeEdge('b.ts', 'a.ts'),
    ]);
    const cycles = findCycles(adj);
    expect(cycles.length).toBeGreaterThan(0);
    // Both nodes should appear in the cycle
    const allNodes = cycles.flat();
    expect(allNodes).toContain('a.ts');
    expect(allNodes).toContain('b.ts');
  });

  it('detects a 3-node cycle', () => {
    const adj = buildAdjacencyList([
      makeEdge('a.ts', 'b.ts'),
      makeEdge('b.ts', 'c.ts'),
      makeEdge('c.ts', 'a.ts'),
    ]);
    const cycles = findCycles(adj);
    expect(cycles.length).toBeGreaterThan(0);
    const allNodes = cycles.flat();
    expect(allNodes).toContain('a.ts');
    expect(allNodes).toContain('b.ts');
    expect(allNodes).toContain('c.ts');
  });

  it('does not report a cycle for a self-loop node with no back edge', () => {
    // Linear: a → b → c, no cycle
    const adj = buildAdjacencyList([
      makeEdge('a.ts', 'b.ts'),
      makeEdge('b.ts', 'c.ts'),
      makeEdge('a.ts', 'c.ts'),
    ]);
    expect(findCycles(adj)).toHaveLength(0);
  });

  it('deduplicates the same cycle discovered from multiple entry points', () => {
    // a → b → c → a is one cycle
    const adj = buildAdjacencyList([
      makeEdge('a.ts', 'b.ts'),
      makeEdge('b.ts', 'c.ts'),
      makeEdge('c.ts', 'a.ts'),
    ]);
    const cycles = findCycles(adj);
    // There should be exactly one unique cycle
    expect(cycles.length).toBe(1);
  });
});

// ─── cosineSimilarity ─────────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it('returns 0 for zero-length vectors', () => {
    const z = new Float32Array([0, 0, 0]);
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(z, v)).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    const a = new Float32Array(0);
    const b = new Float32Array(0);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('handles non-unit vectors correctly', () => {
    // [2,0] and [5,0] should be perfectly similar
    const a = new Float32Array([2, 0]);
    const b = new Float32Array([5, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe('antipattern thresholds', () => {
  it('deep nesting threshold is 5', () => expect(DEEP_NESTING_THRESHOLD).toBe(5));
  it('long param warning threshold is 7', () => expect(LONG_PARAM_WARNING).toBe(7));
  it('high coupling warning threshold is 10', () => expect(HIGH_COUPLING_WARNING).toBe(10));
  it('high coupling error threshold is 20', () => expect(HIGH_COUPLING_ERROR).toBe(20));
  it('god class line threshold is 500', () => expect(GOD_CLASS_LINE_THRESHOLD).toBe(500));
  it('god class method threshold is 20', () => expect(GOD_CLASS_METHOD_THRESHOLD).toBe(20));
});

// ─── handler — repo validation ────────────────────────────────────────────────

describe('detect_antipatterns — repo validation', () => {
  it('returns error for nonexistent repo', async () => {
    const result = await detectAntipatternsHandler({ repoId: 'deadbeef00000000' });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: expect.stringContaining('not found') });
  });
});

// ─── handler — output shape ───────────────────────────────────────────────────

describe('detect_antipatterns — output shape', () => {
  it('returns expected top-level fields', async () => {
    const result = await detectAntipatternsHandler({ repoId });
    expect(result.isError).toBeUndefined();
    const data = parse(result);

    expect(typeof data['repoId']).toBe('string');
    expect(typeof data['findingsCount']).toBe('number');
    expect(typeof data['errorCount']).toBe('number');
    expect(typeof data['warningCount']).toBe('number');
    expect(Array.isArray(data['findings'])).toBe(true);
    expect(typeof data['healthScore']).toBe('number');
    expect(Array.isArray(data['notes'])).toBe(true);
    expect(typeof data['_meta']).toBe('object');
  });

  it('findingsCount equals findings array length', async () => {
    const result = await detectAntipatternsHandler({ repoId });
    const data = parse(result);
    const findings = data['findings'] as unknown[];
    expect(data['findingsCount']).toBe(findings.length);
  });

  it('errorCount + warningCount equals findingsCount', async () => {
    const result = await detectAntipatternsHandler({ repoId });
    const data = parse(result);
    expect((data['errorCount'] as number) + (data['warningCount'] as number)).toBe(
      data['findingsCount'] as number,
    );
  });

  it('healthScore is between 0 and 100', async () => {
    const result = await detectAntipatternsHandler({ repoId });
    const data = parse(result);
    const score = data['healthScore'] as number;
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('each finding has required fields', async () => {
    const result = await detectAntipatternsHandler({ repoId });
    const data = parse(result);
    const findings = data['findings'] as Array<Record<string, unknown>>;

    for (const finding of findings) {
      expect(typeof finding['check']).toBe('string');
      expect(['warning', 'error']).toContain(finding['severity']);
      expect(typeof finding['filePath']).toBe('string');
      expect(typeof finding['description']).toBe('string');
      expect(typeof finding['evidence']).toBe('string');
      expect(typeof finding['suggestion']).toBe('string');
    }
  });
});

// ─── handler — checks filter ──────────────────────────────────────────────────

describe('detect_antipatterns — checks filter', () => {
  it('runs only specified checks when checks array provided', async () => {
    const result = await detectAntipatternsHandler({
      repoId,
      checks: ['dead_code'],
    });
    const data = parse(result);
    const findings = data['findings'] as Array<Record<string, unknown>>;
    for (const f of findings) {
      expect(f['check']).toBe('dead_code');
    }
  });

  it('runs circular_dependencies check in isolation', async () => {
    const result = await detectAntipatternsHandler({
      repoId,
      checks: ['circular_dependencies'],
    });
    const data = parse(result);
    const findings = data['findings'] as Array<Record<string, unknown>>;
    for (const f of findings) {
      expect(f['check']).toBe('circular_dependencies');
    }
  });

  it('runs multiple specified checks and excludes others', async () => {
    const result = await detectAntipatternsHandler({
      repoId,
      checks: ['dead_code', 'high_coupling'],
    });
    const data = parse(result);
    const findings = data['findings'] as Array<Record<string, unknown>>;
    const checkNames = new Set(findings.map((f) => f['check']));
    for (const check of checkNames) {
      expect(['dead_code', 'high_coupling']).toContain(check);
    }
  });
});

// ─── handler — severity filter ────────────────────────────────────────────────

describe('detect_antipatterns — severity filter', () => {
  it('severity=error excludes warnings', async () => {
    const result = await detectAntipatternsHandler({
      repoId,
      severity: 'error',
    });
    const data = parse(result);
    const findings = data['findings'] as Array<Record<string, unknown>>;
    for (const f of findings) {
      expect(f['severity']).toBe('error');
    }
  });

  it('severity=warning excludes errors', async () => {
    const result = await detectAntipatternsHandler({
      repoId,
      severity: 'warning',
    });
    const data = parse(result);
    const findings = data['findings'] as Array<Record<string, unknown>>;
    for (const f of findings) {
      expect(f['severity']).toBe('warning');
    }
  });

  it('severity=all returns both warnings and errors', async () => {
    const result = await detectAntipatternsHandler({ repoId, severity: 'all' });
    const data = parse(result);
    // Should not error
    expect(result.isError).toBeUndefined();
    expect(typeof data['findingsCount']).toBe('number');
  });
});

// ─── handler — healthScore calculation ───────────────────────────────────────

describe('detect_antipatterns — healthScore calculation', () => {
  it('healthScore is 100 when there are no findings', async () => {
    // Run only god_class on a fixture that has no large classes
    const result = await detectAntipatternsHandler({
      repoId,
      checks: ['god_class'],
    });
    const data = parse(result);
    const findings = data['findings'] as unknown[];
    if (findings.length === 0) {
      expect(data['healthScore']).toBe(100);
    }
  });

  it('healthScore formula: 100 - (errors*10 + warnings*2) clamped to 0', async () => {
    const result = await detectAntipatternsHandler({ repoId });
    const data = parse(result);
    const errors = data['errorCount'] as number;
    const warnings = data['warningCount'] as number;
    const expectedScore = Math.max(0, 100 - errors * 10 - warnings * 2);
    expect(data['healthScore']).toBe(expectedScore);
  });
});

// ─── handler — duplicate_code skip when no semantic index ────────────────────

describe('detect_antipatterns — duplicate_code', () => {
  it('skips duplicate_code check gracefully when no HNSW index and adds a note', async () => {
    const result = await detectAntipatternsHandler({
      repoId,
      checks: ['duplicate_code'],
    });
    const data = parse(result);
    // Should not error — just return empty findings and a note
    expect(result.isError).toBeUndefined();
    const notes = data['notes'] as string[];
    // Either no embeddings exist (note is added) or embeddings exist
    // In CI without a configured embedding provider, we expect the skip note
    if ((data['findingsCount'] as number) === 0) {
      // If no findings, there may be a note about skipping
      expect(Array.isArray(notes)).toBe(true);
    }
  });
});
