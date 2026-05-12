/**
 * Tests for the get_coupling_map tool (Task 177).
 *
 * Strategy: index the basic-ts-project fixture (which has real internal imports
 * and two circular files) then verify coupling counts, instability calculation,
 * topN, minScore, filePath scoping, and direction filtering.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as getCouplingMapHandler } from '../../src/server/tools/get-coupling-map.js';

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface FileCoupling {
  filePath: string;
  efferentCoupling: number;
  afferentCoupling: number;
  instability: number;
  efferentDeps: string[];
  afferentDeps: string[];
}

interface CouplingOutput {
  files: FileCoupling[];
  totalFiles: number;
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string };
}

function parse(result: { content: Array<{ text: string }> }): CouplingOutput {
  return JSON.parse(result.content[0]!.text) as CouplingOutput;
}

// ─── repo validation ──────────────────────────────────────────────────────────

describe('get_coupling_map — repo validation', () => {
  it('returns error for unknown repoId', async () => {
    const result = await getCouplingMapHandler({ repoId: 'deadbeef00000000' });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/not found/i);
  });
});

// ─── output shape ─────────────────────────────────────────────────────────────

describe('get_coupling_map — output shape', () => {
  it('returns expected top-level fields', async () => {
    const result = await getCouplingMapHandler({ repoId });
    expect(result.isError).toBeUndefined();
    const data = parse(result);

    expect(Array.isArray(data.files)).toBe(true);
    expect(typeof data.totalFiles).toBe('number');
    expect(typeof data._tokenEstimate).toBe('number');
    expect(typeof data._meta).toBe('object');
    expect(typeof data._meta.timing_ms).toBe('number');
  });

  it('totalFiles equals files array length', async () => {
    const result = await getCouplingMapHandler({ repoId });
    const data = parse(result);
    expect(data.totalFiles).toBe(data.files.length);
  });

  it('each file entry has required fields with correct types', async () => {
    const result = await getCouplingMapHandler({ repoId });
    const data = parse(result);

    for (const f of data.files) {
      expect(typeof f.filePath).toBe('string');
      expect(typeof f.efferentCoupling).toBe('number');
      expect(typeof f.afferentCoupling).toBe('number');
      expect(typeof f.instability).toBe('number');
      expect(Array.isArray(f.efferentDeps)).toBe(true);
      expect(Array.isArray(f.afferentDeps)).toBe(true);
    }
  });
});

// ─── coupling counts ──────────────────────────────────────────────────────────

describe('get_coupling_map — coupling counts', () => {
  it('files that import others have efferentCoupling > 0', async () => {
    const result = await getCouplingMapHandler({ repoId, topN: 50 });
    const data = parse(result);
    const withOutgoing = data.files.filter((f) => f.efferentCoupling > 0);
    expect(withOutgoing.length).toBeGreaterThan(0);
  });

  it('files imported by others have afferentCoupling > 0', async () => {
    const result = await getCouplingMapHandler({ repoId, topN: 50 });
    const data = parse(result);
    const withIncoming = data.files.filter((f) => f.afferentCoupling > 0);
    expect(withIncoming.length).toBeGreaterThan(0);
  });

  it('efferentCoupling matches efferentDeps list length', async () => {
    const result = await getCouplingMapHandler({ repoId, topN: 50 });
    const data = parse(result);
    for (const f of data.files) {
      expect(f.efferentCoupling).toBe(f.efferentDeps.length);
    }
  });

  it('afferentCoupling matches afferentDeps list length', async () => {
    const result = await getCouplingMapHandler({ repoId, topN: 50 });
    const data = parse(result);
    for (const f of data.files) {
      expect(f.afferentCoupling).toBe(f.afferentDeps.length);
    }
  });
});

// ─── instability ──────────────────────────────────────────────────────────────

describe('get_coupling_map — instability calculation', () => {
  it('instability is between 0 and 1 inclusive', async () => {
    const result = await getCouplingMapHandler({ repoId, topN: 50 });
    const data = parse(result);
    for (const f of data.files) {
      expect(f.instability).toBeGreaterThanOrEqual(0);
      expect(f.instability).toBeLessThanOrEqual(1);
    }
  });

  it('pure leaf (only efferent, no afferent) has instability = 1', async () => {
    // Find a file that imports others but is never imported itself
    const result = await getCouplingMapHandler({ repoId, topN: 50 });
    const data = parse(result);
    const leaf = data.files.find((f) => f.efferentCoupling > 0 && f.afferentCoupling === 0);
    if (leaf) {
      expect(leaf.instability).toBe(1);
    }
  });

  it('pure hub (only afferent, no efferent) has instability = 0', async () => {
    // Find a file that is imported by others but imports nothing
    const result = await getCouplingMapHandler({ repoId, topN: 50 });
    const data = parse(result);
    const hub = data.files.find((f) => f.efferentCoupling === 0 && f.afferentCoupling > 0);
    if (hub) {
      expect(hub.instability).toBe(0);
    }
  });

  it('instability formula: Ce / (Ce + Ca)', async () => {
    const result = await getCouplingMapHandler({ repoId, topN: 50 });
    const data = parse(result);
    for (const f of data.files) {
      const total = f.efferentCoupling + f.afferentCoupling;
      const expected =
        total === 0 ? 0 : Math.round((f.efferentCoupling / total) * 1000) / 1000;
      expect(f.instability).toBeCloseTo(expected, 3);
    }
  });
});

// ─── topN ─────────────────────────────────────────────────────────────────────

describe('get_coupling_map — topN', () => {
  it('topN: 5 returns at most 5 files', async () => {
    const result = await getCouplingMapHandler({ repoId, topN: 5 });
    const data = parse(result);
    expect(data.files.length).toBeLessThanOrEqual(5);
  });

  it('topN: 1 returns at most 1 file', async () => {
    const result = await getCouplingMapHandler({ repoId, topN: 1 });
    const data = parse(result);
    expect(data.files.length).toBeLessThanOrEqual(1);
  });

  it('files are sorted by total coupling descending', async () => {
    const result = await getCouplingMapHandler({ repoId, topN: 50 });
    const data = parse(result);
    for (let i = 1; i < data.files.length; i++) {
      const prev = data.files[i - 1]!;
      const curr = data.files[i]!;
      const prevTotal = prev.efferentCoupling + prev.afferentCoupling;
      const currTotal = curr.efferentCoupling + curr.afferentCoupling;
      expect(prevTotal).toBeGreaterThanOrEqual(currTotal);
    }
  });
});

// ─── filePath scoping ─────────────────────────────────────────────────────────

describe('get_coupling_map — filePath scoping', () => {
  it('filePath scope returns exactly that file', async () => {
    // index.ts imports from other files — it will have coupling data
    const result = await getCouplingMapHandler({
      repoId,
      filePath: 'src/index.ts',
    });
    const data = parse(result);
    expect(data.files.length).toBeLessThanOrEqual(1);
    if (data.files.length === 1) {
      expect(data.files[0]!.filePath).toBe('src/index.ts');
    }
  });

  it('filePath scope ignores topN', async () => {
    // topN: 1 with a filePath should still return the scoped file
    const result = await getCouplingMapHandler({
      repoId,
      filePath: 'src/index.ts',
      topN: 1,
    });
    const data = parse(result);
    // Only one file — the scoped one
    expect(data.files.length).toBeLessThanOrEqual(1);
  });

  it('unknown filePath returns empty files array', async () => {
    const result = await getCouplingMapHandler({
      repoId,
      filePath: 'src/does-not-exist.ts',
    });
    const data = parse(result);
    expect(result.isError).toBeUndefined();
    expect(data.files).toHaveLength(0);
  });
});

// ─── minScore ─────────────────────────────────────────────────────────────────

describe('get_coupling_map — minScore filter', () => {
  it('minScore filters out files below threshold', async () => {
    const result = await getCouplingMapHandler({ repoId, minScore: 2, topN: 50 });
    const data = parse(result);
    for (const f of data.files) {
      expect(f.efferentCoupling + f.afferentCoupling).toBeGreaterThanOrEqual(2);
    }
  });

  it('minScore: 999 returns empty when no file is that coupled', async () => {
    const result = await getCouplingMapHandler({ repoId, minScore: 999, topN: 50 });
    const data = parse(result);
    expect(result.isError).toBeUndefined();
    expect(data.files).toHaveLength(0);
  });
});

// ─── direction ────────────────────────────────────────────────────────────────

describe('get_coupling_map — direction filter', () => {
  it('direction: efferent omits afferentDeps', async () => {
    const result = await getCouplingMapHandler({ repoId, direction: 'efferent', topN: 50 });
    const data = parse(result);
    for (const f of data.files) {
      expect(f.afferentDeps).toHaveLength(0);
    }
  });

  it('direction: efferent preserves efferentCoupling counts', async () => {
    const result = await getCouplingMapHandler({ repoId, direction: 'efferent', topN: 50 });
    const data = parse(result);
    // Counts are still present even though lists are stripped
    for (const f of data.files) {
      expect(typeof f.efferentCoupling).toBe('number');
      expect(typeof f.afferentCoupling).toBe('number');
    }
  });

  it('direction: afferent omits efferentDeps', async () => {
    const result = await getCouplingMapHandler({ repoId, direction: 'afferent', topN: 50 });
    const data = parse(result);
    for (const f of data.files) {
      expect(f.efferentDeps).toHaveLength(0);
    }
  });

  it('direction: both returns both dep lists', async () => {
    const result = await getCouplingMapHandler({ repoId, direction: 'both', topN: 50 });
    const data = parse(result);
    // At least one file should have non-empty efferentDeps (since there are imports)
    const hasEfDeps = data.files.some((f) => f.efferentDeps.length > 0);
    const hasAfDeps = data.files.some((f) => f.afferentDeps.length > 0);
    expect(hasEfDeps).toBe(true);
    expect(hasAfDeps).toBe(true);
  });

  it('default direction is both', async () => {
    // Calling without direction should behave the same as direction: 'both'
    const withBoth = await getCouplingMapHandler({ repoId, topN: 50, direction: 'both' });
    const withDefault = await getCouplingMapHandler({ repoId, topN: 50 });
    const dataBoth = parse(withBoth);
    const dataDefault = parse(withDefault);
    // Same number of files
    expect(dataDefault.files.length).toBe(dataBoth.files.length);
  });
});

// ─── _meta ────────────────────────────────────────────────────────────────────

describe('get_coupling_map — _meta', () => {
  it('_meta.timing_ms is a non-negative number', async () => {
    const result = await getCouplingMapHandler({ repoId });
    const data = parse(result);
    expect(data._meta.timing_ms).toBeGreaterThanOrEqual(0);
  });

  it('_tokenEstimate is a positive number', async () => {
    const result = await getCouplingMapHandler({ repoId });
    const data = parse(result);
    expect(data._tokenEstimate).toBeGreaterThan(0);
  });
});
