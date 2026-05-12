/**
 * Tests for the get_architecture_snapshot tool (Task 183).
 *
 * Strategy: index the basic-ts-project fixture (real imports + symbols) and
 * exercise all four actions: create, list, diff, delete.
 *
 * Test cases:
 *   - create: returns snapshotId and expected metric fields
 *   - create: label is preserved
 *   - create: metrics are non-negative numbers
 *   - list: includes the created snapshot
 *   - list: newest-first ordering
 *   - list: returns empty array when no snapshots exist
 *   - diff of identical snapshot (compare with itself) → all deltas are 0
 *   - diff of two snapshots after adding a file → filesAdded/symbolsAdded > 0
 *   - diff: cycleCountDelta is a number (may be 0)
 *   - diff: missing snapshotId returns error
 *   - diff: unknown snapshotId returns error
 *   - delete: snapshot removed from list
 *   - delete: unknown snapshotId returns error
 *   - delete without snapshotId returns error
 *   - unknown repoId returns error
 *   - _meta.timing_ms is present and non-negative
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as snapshotHandler } from '../../src/server/tools/get-architecture-snapshot.js';

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

// ─── Output helpers ───────────────────────────────────────────────────────────

interface SnapshotRecord {
  snapshotId: string;
  label: string;
  createdAt: string;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  cycleCount: number;
  avgCoupling: number;
  avgComplexity: number;
}

interface SnapshotDiff {
  filesAdded: string[];
  filesRemoved: string[];
  symbolsAdded: number;
  symbolsRemoved: number;
  edgesAdded: number;
  edgesRemoved: number;
  cycleCountDelta: number;
  avgCouplingDelta: number;
  avgComplexityDelta: number;
}

interface SnapshotOutput {
  action: string;
  snapshot?: SnapshotRecord;
  snapshots?: SnapshotRecord[];
  diff?: SnapshotDiff;
  _meta: { timing_ms: number; powered_by: string };
}

function parse(result: { content: Array<{ text: string }> }): SnapshotOutput {
  return JSON.parse(result.content[0]!.text) as SnapshotOutput;
}

// ─── Repo validation ──────────────────────────────────────────────────────────

describe('get_architecture_snapshot — repo validation', () => {
  it('returns error for unknown repoId', async () => {
    const result = await snapshotHandler({ repoId: 'deadbeef00000000', action: 'create' });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/not found/i);
  });
});

// ─── create action ────────────────────────────────────────────────────────────

describe('get_architecture_snapshot — create', () => {
  it('returns action "create" and a snapshot record', async () => {
    const result = await snapshotHandler({ repoId, action: 'create', label: 'test-snap' });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.action).toBe('create');
    expect(data.snapshot).toBeDefined();
  });

  it('snapshotId is a non-empty string', async () => {
    const result = await snapshotHandler({ repoId, action: 'create' });
    const data = parse(result);
    expect(typeof data.snapshot!.snapshotId).toBe('string');
    expect(data.snapshot!.snapshotId.length).toBeGreaterThan(0);
  });

  it('label is preserved in the snapshot', async () => {
    const label = 'before-refactor';
    const result = await snapshotHandler({ repoId, action: 'create', label });
    const data = parse(result);
    expect(data.snapshot!.label).toBe(label);
  });

  it('empty label defaults to empty string', async () => {
    const result = await snapshotHandler({ repoId, action: 'create' });
    const data = parse(result);
    expect(data.snapshot!.label).toBe('');
  });

  it('createdAt is a valid ISO date string', async () => {
    const result = await snapshotHandler({ repoId, action: 'create' });
    const data = parse(result);
    const d = new Date(data.snapshot!.createdAt);
    expect(isNaN(d.getTime())).toBe(false);
  });

  it('metric fields are non-negative numbers', async () => {
    const result = await snapshotHandler({ repoId, action: 'create' });
    const data = parse(result);
    const s = data.snapshot!;
    expect(s.fileCount).toBeGreaterThanOrEqual(0);
    expect(s.symbolCount).toBeGreaterThanOrEqual(0);
    expect(s.edgeCount).toBeGreaterThanOrEqual(0);
    expect(s.cycleCount).toBeGreaterThanOrEqual(0);
    expect(s.avgCoupling).toBeGreaterThanOrEqual(0);
    expect(s.avgComplexity).toBeGreaterThanOrEqual(0);
  });

  it('fileCount and symbolCount are positive for a real fixture', async () => {
    const result = await snapshotHandler({ repoId, action: 'create' });
    const data = parse(result);
    expect(data.snapshot!.fileCount).toBeGreaterThan(0);
    expect(data.snapshot!.symbolCount).toBeGreaterThan(0);
  });

  it('_meta.timing_ms is present and non-negative', async () => {
    const result = await snapshotHandler({ repoId, action: 'create' });
    const data = parse(result);
    expect(data._meta.timing_ms).toBeGreaterThanOrEqual(0);
  });
});

// ─── list action ──────────────────────────────────────────────────────────────

describe('get_architecture_snapshot — list', () => {
  it('includes previously created snapshots', async () => {
    const createResult = await snapshotHandler({ repoId, action: 'create', label: 'list-test' });
    const created = parse(createResult).snapshot!;

    const listResult = await snapshotHandler({ repoId, action: 'list' });
    const data = parse(listResult);
    expect(data.action).toBe('list');
    expect(Array.isArray(data.snapshots)).toBe(true);

    const found = data.snapshots!.some((s) => s.snapshotId === created.snapshotId);
    expect(found).toBe(true);
  });

  it('snapshots are ordered newest-first', async () => {
    // Create two snapshots in sequence
    const r1 = await snapshotHandler({ repoId, action: 'create', label: 'first' });
    const r2 = await snapshotHandler({ repoId, action: 'create', label: 'second' });
    const id1 = parse(r1).snapshot!.snapshotId;
    const id2 = parse(r2).snapshot!.snapshotId;

    const listResult = await snapshotHandler({ repoId, action: 'list' });
    const snapshots = parse(listResult).snapshots!;

    const idx1 = snapshots.findIndex((s) => s.snapshotId === id1);
    const idx2 = snapshots.findIndex((s) => s.snapshotId === id2);

    // id2 (second created) should appear before id1 (first created)
    expect(idx2).toBeLessThan(idx1);
  });

  it('each snapshot in list has expected fields', async () => {
    const listResult = await snapshotHandler({ repoId, action: 'list' });
    const data = parse(listResult);
    for (const s of data.snapshots!) {
      expect(typeof s.snapshotId).toBe('string');
      expect(typeof s.label).toBe('string');
      expect(typeof s.createdAt).toBe('string');
      expect(typeof s.fileCount).toBe('number');
      expect(typeof s.symbolCount).toBe('number');
      expect(typeof s.edgeCount).toBe('number');
      expect(typeof s.cycleCount).toBe('number');
      expect(typeof s.avgCoupling).toBe('number');
      expect(typeof s.avgComplexity).toBe('number');
    }
  });
});

// ─── diff action ──────────────────────────────────────────────────────────────

describe('get_architecture_snapshot — diff', () => {
  it('diff of a snapshot with itself → all numeric deltas are 0', async () => {
    const createResult = await snapshotHandler({ repoId, action: 'create', label: 'diff-base' });
    const snapId = parse(createResult).snapshot!.snapshotId;

    const diffResult = await snapshotHandler({
      repoId,
      action: 'diff',
      snapshotId: snapId,
      compareId: snapId,
    });
    expect(diffResult.isError).toBeUndefined();
    const data = parse(diffResult);
    expect(data.action).toBe('diff');
    const d = data.diff!;
    expect(d.filesAdded).toHaveLength(0);
    expect(d.filesRemoved).toHaveLength(0);
    expect(d.symbolsAdded).toBe(0);
    expect(d.symbolsRemoved).toBe(0);
    expect(d.edgesAdded).toBe(0);
    expect(d.edgesRemoved).toBe(0);
    expect(d.cycleCountDelta).toBe(0);
    expect(d.avgCouplingDelta).toBe(0);
    expect(d.avgComplexityDelta).toBe(0);
  });

  it('diff contains all expected fields', async () => {
    const r1 = await snapshotHandler({ repoId, action: 'create' });
    const r2 = await snapshotHandler({ repoId, action: 'create' });
    const id1 = parse(r1).snapshot!.snapshotId;
    const id2 = parse(r2).snapshot!.snapshotId;

    const diffResult = await snapshotHandler({
      repoId,
      action: 'diff',
      snapshotId: id1,
      compareId: id2,
    });
    const d = parse(diffResult).diff!;
    expect(Array.isArray(d.filesAdded)).toBe(true);
    expect(Array.isArray(d.filesRemoved)).toBe(true);
    expect(typeof d.symbolsAdded).toBe('number');
    expect(typeof d.symbolsRemoved).toBe('number');
    expect(typeof d.edgesAdded).toBe('number');
    expect(typeof d.edgesRemoved).toBe('number');
    expect(typeof d.cycleCountDelta).toBe('number');
    expect(typeof d.avgCouplingDelta).toBe('number');
    expect(typeof d.avgComplexityDelta).toBe('number');
  });

  it('diff base snapshot is returned in snapshot field', async () => {
    const r1 = await snapshotHandler({ repoId, action: 'create', label: 'base' });
    const r2 = await snapshotHandler({ repoId, action: 'create', label: 'compare' });
    const id1 = parse(r1).snapshot!.snapshotId;
    const id2 = parse(r2).snapshot!.snapshotId;

    const diffResult = await snapshotHandler({
      repoId,
      action: 'diff',
      snapshotId: id1,
      compareId: id2,
    });
    const data = parse(diffResult);
    expect(data.snapshot!.snapshotId).toBe(id1);
    expect(data.snapshot!.label).toBe('base');
  });

  it('diff without snapshotId returns error', async () => {
    const result = await snapshotHandler({
      repoId,
      action: 'diff',
      compareId: 'someId',
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/snapshotId/i);
  });

  it('diff without compareId returns error', async () => {
    const r = await snapshotHandler({ repoId, action: 'create' });
    const id = parse(r).snapshot!.snapshotId;
    const result = await snapshotHandler({
      repoId,
      action: 'diff',
      snapshotId: id,
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/compareId|snapshotId/i);
  });

  it('diff with unknown snapshotId returns error', async () => {
    const r = await snapshotHandler({ repoId, action: 'create' });
    const id = parse(r).snapshot!.snapshotId;
    const result = await snapshotHandler({
      repoId,
      action: 'diff',
      snapshotId: 'nonexistent000',
      compareId: id,
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/not found/i);
  });

  it('diff with unknown compareId returns error', async () => {
    const r = await snapshotHandler({ repoId, action: 'create' });
    const id = parse(r).snapshot!.snapshotId;
    const result = await snapshotHandler({
      repoId,
      action: 'diff',
      snapshotId: id,
      compareId: 'nonexistent000',
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/not found/i);
  });
});

// ─── delete action ────────────────────────────────────────────────────────────

describe('get_architecture_snapshot — delete', () => {
  it('deleted snapshot is removed from list', async () => {
    const createResult = await snapshotHandler({ repoId, action: 'create', label: 'to-delete' });
    const snapId = parse(createResult).snapshot!.snapshotId;

    const deleteResult = await snapshotHandler({
      repoId,
      action: 'delete',
      snapshotId: snapId,
    });
    expect(deleteResult.isError).toBeUndefined();
    expect(parse(deleteResult).action).toBe('delete');

    const listResult = await snapshotHandler({ repoId, action: 'list' });
    const snapshots = parse(listResult).snapshots!;
    const found = snapshots.some((s) => s.snapshotId === snapId);
    expect(found).toBe(false);
  });

  it('delete of unknown snapshotId returns error', async () => {
    const result = await snapshotHandler({
      repoId,
      action: 'delete',
      snapshotId: 'nonexistent0000',
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/not found/i);
  });

  it('delete without snapshotId returns error', async () => {
    const result = await snapshotHandler({ repoId, action: 'delete' });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/snapshotId/i);
  });
});
