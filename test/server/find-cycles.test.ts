/**
 * Tests for the find_cycles tool (Task 176).
 *
 * Fixture: test/fixtures/cycles-fixture/
 *   src/a.ts  — imports b  (part of a↔b mutual cycle and a→b→c→a triangle)
 *   src/b.ts  — imports a, c
 *   src/c.ts  — imports a  (completes the triangle)
 *   src/standalone.ts — no imports, not part of any cycle
 *
 * Expected cycles (all edges are internal):
 *   [src/a.ts, src/b.ts]          length 2, severity 'error'  (a←→b)
 *   [src/a.ts, src/b.ts, src/c.ts] length 3, severity 'error'  (a→b→c→a)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as findCyclesHandler } from '../../src/server/tools/find-cycles.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/cycles-fixture');

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface CyclePath {
  files: string[];
  length: number;
  severity: 'warning' | 'error';
}

interface FindCyclesOutput {
  cycles: CyclePath[];
  totalFound: number;
  truncated: boolean;
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string };
}

function parse(result: { content: Array<{ text: string }> }): FindCyclesOutput {
  return JSON.parse(result.content[0]!.text) as FindCyclesOutput;
}

// ─── repo validation ──────────────────────────────────────────────────────────

describe('find_cycles — repo validation', () => {
  it('returns error for unknown repoId', async () => {
    const result = await findCyclesHandler({ repoId: 'deadbeef00000000' });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/not found/i);
  });
});

// ─── output shape ─────────────────────────────────────────────────────────────

describe('find_cycles — output shape', () => {
  it('returns expected top-level fields', async () => {
    const result = await findCyclesHandler({ repoId });
    expect(result.isError).toBeUndefined();
    const data = parse(result);

    expect(Array.isArray(data.cycles)).toBe(true);
    expect(typeof data.totalFound).toBe('number');
    expect(typeof data.truncated).toBe('boolean');
    expect(typeof data._tokenEstimate).toBe('number');
    expect(typeof data._meta).toBe('object');
    expect(typeof data._meta.timing_ms).toBe('number');
  });

  it('totalFound equals cycles array length', async () => {
    const result = await findCyclesHandler({ repoId });
    const data = parse(result);
    expect(data.totalFound).toBe(data.cycles.length);
  });

  it('each cycle entry has required fields with correct types', async () => {
    const result = await findCyclesHandler({ repoId });
    const data = parse(result);
    for (const c of data.cycles) {
      expect(Array.isArray(c.files)).toBe(true);
      expect(typeof c.length).toBe('number');
      expect(['warning', 'error']).toContain(c.severity);
      expect(c.length).toBe(c.files.length);
    }
  });
});

// ─── cycle detection ──────────────────────────────────────────────────────────

describe('find_cycles — cycle detection', () => {
  it('finds at least 2 cycles in the fixture (length-2 and length-3)', async () => {
    const result = await findCyclesHandler({ repoId });
    const data = parse(result);
    expect(data.cycles.length).toBeGreaterThanOrEqual(2);
  });

  it('finds a cycle of length 2 (a ↔ b mutual import)', async () => {
    const result = await findCyclesHandler({ repoId });
    const data = parse(result);
    const cycle2 = data.cycles.find((c) => c.length === 2);
    expect(cycle2).toBeDefined();
    expect(cycle2!.files).toHaveLength(2);
    // Both a.ts and b.ts must be in the cycle
    const fileNames = cycle2!.files.map((f) => f.replace(/\\/g, '/'));
    expect(fileNames.some((f) => f.endsWith('a.ts'))).toBe(true);
    expect(fileNames.some((f) => f.endsWith('b.ts'))).toBe(true);
  });

  it('length-2 cycle has severity "error"', async () => {
    const result = await findCyclesHandler({ repoId });
    const data = parse(result);
    const cycle2 = data.cycles.find((c) => c.length === 2);
    expect(cycle2?.severity).toBe('error');
  });

  it('finds a cycle of length 3 (a → b → c → a triangle)', async () => {
    const result = await findCyclesHandler({ repoId });
    const data = parse(result);
    const cycle3 = data.cycles.find((c) => c.length === 3);
    expect(cycle3).toBeDefined();
    const fileNames = cycle3!.files.map((f) => f.replace(/\\/g, '/'));
    expect(fileNames.some((f) => f.endsWith('a.ts'))).toBe(true);
    expect(fileNames.some((f) => f.endsWith('b.ts'))).toBe(true);
    expect(fileNames.some((f) => f.endsWith('c.ts'))).toBe(true);
  });

  it('length-3 cycle has severity "error"', async () => {
    const result = await findCyclesHandler({ repoId });
    const data = parse(result);
    const cycle3 = data.cycles.find((c) => c.length === 3);
    expect(cycle3?.severity).toBe('error');
  });

  it('cycles are not duplicated (no two cycles with identical files)', async () => {
    const result = await findCyclesHandler({ repoId });
    const data = parse(result);
    const keys = data.cycles.map((c) => [...c.files].sort().join('|'));
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });
});

// ─── filePath filter ──────────────────────────────────────────────────────────

describe('find_cycles — filePath filter', () => {
  it('filePath filter returns only cycles involving that file', async () => {
    const result = await findCyclesHandler({ repoId, filePath: 'src/c.ts' });
    const data = parse(result);
    // c.ts is only in the 3-node cycle (a→b→c→a), not in the 2-node cycle (a↔b)
    for (const cycle of data.cycles) {
      expect(
        cycle.files.some((f) => f.replace(/\\/g, '/').endsWith('c.ts')),
      ).toBe(true);
    }
  });

  it('filePath filter for c.ts finds only the length-3 cycle', async () => {
    const result = await findCyclesHandler({ repoId, filePath: 'src/c.ts' });
    const data = parse(result);
    expect(data.cycles).toHaveLength(1);
    expect(data.cycles[0]!.length).toBe(3);
  });

  it('filePath filter for a.ts finds both cycles', async () => {
    const result = await findCyclesHandler({ repoId, filePath: 'src/a.ts' });
    const data = parse(result);
    expect(data.cycles.length).toBeGreaterThanOrEqual(2);
  });

  it('filePath filter for standalone.ts finds no cycles', async () => {
    const result = await findCyclesHandler({ repoId, filePath: 'src/standalone.ts' });
    const data = parse(result);
    expect(result.isError).toBeUndefined();
    expect(data.cycles).toHaveLength(0);
  });
});

// ─── acyclic graph ────────────────────────────────────────────────────────────

describe('find_cycles — acyclic subgraph', () => {
  it('scoping to standalone.ts (no cycles) returns empty cycles array', async () => {
    const result = await findCyclesHandler({ repoId, filePath: 'src/standalone.ts' });
    const data = parse(result);
    expect(data.cycles).toHaveLength(0);
    expect(data.totalFound).toBe(0);
    expect(data.truncated).toBe(false);
  });
});

// ─── maxCycles ────────────────────────────────────────────────────────────────

describe('find_cycles — maxCycles', () => {
  it('maxCycles: 1 returns at most 1 cycle', async () => {
    const result = await findCyclesHandler({ repoId, maxCycles: 1 });
    const data = parse(result);
    expect(data.cycles.length).toBeLessThanOrEqual(1);
  });

  it('maxCycles: 1 sets truncated: true when more cycles exist', async () => {
    const result = await findCyclesHandler({ repoId, maxCycles: 1 });
    const data = parse(result);
    // The fixture has 2 cycles, so capping at 1 should truncate
    expect(data.truncated).toBe(true);
  });

  it('maxCycles larger than total cycles does not set truncated', async () => {
    const result = await findCyclesHandler({ repoId, maxCycles: 100 });
    const data = parse(result);
    expect(data.truncated).toBe(false);
  });
});

// ─── minLength ────────────────────────────────────────────────────────────────

describe('find_cycles — minLength', () => {
  it('minLength: 3 skips the length-2 mutual import', async () => {
    const result = await findCyclesHandler({ repoId, minLength: 3 });
    const data = parse(result);
    for (const c of data.cycles) {
      expect(c.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('minLength: 3 still finds the length-3 triangle', async () => {
    const result = await findCyclesHandler({ repoId, minLength: 3 });
    const data = parse(result);
    expect(data.cycles.some((c) => c.length === 3)).toBe(true);
  });
});

// ─── _meta ────────────────────────────────────────────────────────────────────

describe('find_cycles — _meta', () => {
  it('_meta.timing_ms is a non-negative number', async () => {
    const result = await findCyclesHandler({ repoId });
    const data = parse(result);
    expect(data._meta.timing_ms).toBeGreaterThanOrEqual(0);
  });

  it('_tokenEstimate is a non-negative number', async () => {
    const result = await findCyclesHandler({ repoId });
    const data = parse(result);
    expect(data._tokenEstimate).toBeGreaterThanOrEqual(0);
  });
});
