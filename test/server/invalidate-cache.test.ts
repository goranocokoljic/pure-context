/**
 * Tests for the invalidate_cache tool (Task 134).
 *
 * Strategy: index the basic-ts-project fixture, verify data exists,
 * then exercise each invalidation variant and check that rows are gone.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { join } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as invalidateCacheHandler } from '../../src/server/tools/invalidate-cache.js';
import { PureContextError } from '../../src/core/errors.js';
import { openDatabase, computeRepoId, getIndexDir } from '../../src/core/db/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();
}, 30_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function indexFixture(): Promise<string> {
  const result = await indexFolder(FIXTURE, { fileLimit: 50 });
  expect(result.symbolsFound).toBeGreaterThan(0);
  return result.repoId;
}

function rowCount(repoId: string, table: string): number {
  const db = openDatabase(repoId);
  try {
    const row = db.prepare<[string], { c: number }>(
      `SELECT COUNT(*) AS c FROM ${table} WHERE repo_id = ?`,
    ).get(repoId);
    return row?.c ?? 0;
  } finally {
    db.close();
  }
}

function repoExists(repoId: string): boolean {
  const db = openDatabase(repoId);
  try {
    const row = db.prepare<[string], { id: string }>('SELECT id FROM repos WHERE id = ?').get(repoId);
    return row !== undefined;
  } finally {
    db.close();
  }
}

interface InvalidateCacheOutput {
  deleted: Array<{
    repoId: string;
    repoPath: string;
    symbolsDeleted: number;
    filesDeleted: number;
  }>;
  _meta: { timing_ms: number; powered_by: string };
}

function parseResult(result: { content: { text: string }[] }): InvalidateCacheOutput {
  return JSON.parse(result.content[0].text) as InvalidateCacheOutput;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('invalidate_cache — by repoId', () => {
  let repoId: string;

  beforeAll(async () => {
    repoId = await indexFixture();
  });

  afterAll(() => {
    // Clean up the DB file whether or not invalidation already ran
    deleteIndex(repoId);
  });

  it('deletes all indexed rows and returns correct counts', () => {
    const symbolsBefore = rowCount(repoId, 'symbols');
    const filesBefore = rowCount(repoId, 'files');

    expect(symbolsBefore).toBeGreaterThan(0);
    expect(filesBefore).toBeGreaterThan(0);

    const result = invalidateCacheHandler({ repoId });
    const data = parseResult(result);

    expect(data.deleted).toHaveLength(1);
    expect(data.deleted[0].repoId).toBe(repoId);
    expect(data.deleted[0].symbolsDeleted).toBe(symbolsBefore);
    expect(data.deleted[0].filesDeleted).toBe(filesBefore);
    expect(typeof data.deleted[0].repoPath).toBe('string');
    expect(data.deleted[0].repoPath.length).toBeGreaterThan(0);
  });

  it('repo row is gone after invalidation', () => {
    // This test relies on the previous test having run invalidation.
    // Re-check by querying the DB directly.
    expect(repoExists(repoId)).toBe(false);
  });

  it('symbols and files tables have zero rows for the repo after invalidation', () => {
    expect(rowCount(repoId, 'symbols')).toBe(0);
    expect(rowCount(repoId, 'files')).toBe(0);
    expect(rowCount(repoId, 'dep_edges')).toBe(0);
  });

  it('returns _meta with timing', () => {
    // Re-index so we have something to invalidate (previous tests already cleared it)
    const newRepoId = computeRepoId(FIXTURE);
    const result = invalidateCacheHandler({ repoId: newRepoId });
    const data = parseResult(result);

    expect(typeof data._meta.timing_ms).toBe('number');
    expect(data._meta.timing_ms).toBeGreaterThanOrEqual(0);
    expect(data._meta.powered_by).toBe('PureContext MCP');
  });
});

describe('invalidate_cache — by repoPath', () => {
  let repoId: string;

  beforeAll(async () => {
    repoId = await indexFixture();
  });

  afterAll(() => {
    deleteIndex(repoId);
  });

  it('resolves path to repoId and invalidates', () => {
    expect(repoExists(repoId)).toBe(true);

    const result = invalidateCacheHandler({ repoPath: FIXTURE });
    const data = parseResult(result);

    expect(data.deleted).toHaveLength(1);
    expect(data.deleted[0].repoId).toBe(repoId);
    expect(data.deleted[0].symbolsDeleted).toBeGreaterThan(0);
    expect(repoExists(repoId)).toBe(false);
  });
});

describe('invalidate_cache — all: true', () => {
  let repoId: string;

  beforeAll(async () => {
    repoId = await indexFixture();
  });

  afterAll(() => {
    // Safety net in case the test failed before clearing
    deleteIndex(repoId);
  });

  it('clears all indexed repos, including the fixture repo', () => {
    expect(repoExists(repoId)).toBe(true);

    const result = invalidateCacheHandler({ all: true });
    const data = parseResult(result);

    // At minimum, our fixture repo must appear in deleted list
    const entry = data.deleted.find((d) => d.repoId === repoId);
    expect(entry).toBeDefined();
    expect(entry!.symbolsDeleted).toBeGreaterThan(0);

    // Repo row must be gone
    expect(repoExists(repoId)).toBe(false);
  });
});

describe('invalidate_cache — subsequent re-index', () => {
  let repoId: string;

  afterAll(() => {
    deleteIndex(repoId);
  });

  it('re-indexes successfully after invalidation', async () => {
    repoId = await indexFixture();
    expect(repoExists(repoId)).toBe(true);

    // Invalidate
    invalidateCacheHandler({ repoId });
    expect(repoExists(repoId)).toBe(false);

    // Re-index
    const result = await indexFolder(FIXTURE, { fileLimit: 50 });
    expect(result.repoId).toBe(repoId);
    expect(result.symbolsFound).toBeGreaterThan(0);
    expect(repoExists(repoId)).toBe(true);
  }, 30_000);
});

describe('invalidate_cache — validation errors', () => {
  it('throws PureContextError when no params are provided', () => {
    expect(() => invalidateCacheHandler({})).toThrow(PureContextError);
  });

  it('throws PureContextError when multiple params are provided', () => {
    const fakeId = computeRepoId(FIXTURE);
    expect(() => invalidateCacheHandler({ repoId: fakeId, repoPath: FIXTURE })).toThrow(
      PureContextError,
    );
  });

  it('throws PureContextError when repoId and all are both provided', () => {
    const fakeId = computeRepoId(FIXTURE);
    expect(() => invalidateCacheHandler({ repoId: fakeId, all: true })).toThrow(PureContextError);
  });
});

describe('invalidate_cache — non-existent repo', () => {
  it('returns empty deleted array for an unknown repoId', () => {
    const result = invalidateCacheHandler({ repoId: 'deadbeefdeadbeef' });
    const data = parseResult(result);

    expect(data.deleted).toHaveLength(0);
  });
});
