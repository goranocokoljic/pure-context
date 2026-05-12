/**
 * Tests for the check_move_safe tool (Task 186).
 *
 * Fixture: test/fixtures/check-move-safe-fixture/
 *   src/utils/hash.ts          — hashValue, shortHash (imported by 3 files)
 *   src/main.ts                — imports from './utils/hash'
 *   src/routes.ts              — imports from './utils/hash'
 *   src/api/handler.ts         — imports from '../utils/hash'
 *   src/lib/parser.ts          — parseContent (imported by deep/nested/consumer.ts)
 *   src/deep/nested/consumer.ts — imports from '../../lib/parser'
 *   src/standalone.ts          — no importers
 *   src/cyclic/a.ts            — imports from './b' (part of a↔b cycle)
 *   src/cyclic/b.ts            — imports from './a' (part of a↔b cycle)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as checkMoveSafeHandler } from '../../src/server/tools/check-move-safe.js';
import type { ImportUpdate } from '../../src/server/tools/check-move-safe.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/check-move-safe-fixture');

let repoId: string;

// ─── Types ────────────────────────────────────────────────────────────────────

interface CheckMoveSafeOutput {
  safe: boolean;
  verdict: string;
  filePath: string;
  newFilePath: string;
  importUpdates: ImportUpdate[];
  importUpdateCount: number;
  newCycles: string[][];
  wouldIntroduceCycles: boolean;
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string };
}

function parse(result: { content: Array<{ text: string }> }): CheckMoveSafeOutput {
  return JSON.parse(result.content[0]!.text) as CheckMoveSafeOutput;
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

describe('check_move_safe — validation', () => {
  it('returns error for unknown repoId', async () => {
    const result = await checkMoveSafeHandler({
      repoId: 'deadbeef00000000',
      filePath: 'src/utils/hash.ts',
      newFilePath: 'src/core/hash.ts',
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/not found/i);
  });

  it('returns safe no-op when source and destination are the same', async () => {
    const result = await checkMoveSafeHandler({
      repoId,
      filePath: 'src/utils/hash.ts',
      newFilePath: 'src/utils/hash.ts',
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.safe).toBe(true);
    expect(data.importUpdates).toHaveLength(0);
    expect(data.wouldIntroduceCycles).toBe(false);
    expect(data.verdict).toMatch(/no-op/i);
  });
});

// ─── hash.ts with 3 importers ─────────────────────────────────────────────────

describe('check_move_safe — hash.ts (3 importers)', () => {
  let result: CheckMoveSafeOutput;

  beforeAll(async () => {
    const raw = await checkMoveSafeHandler({
      repoId,
      filePath: 'src/utils/hash.ts',
      newFilePath: 'src/core/hash.ts',
    });
    expect(raw.isError).toBeUndefined();
    result = parse(raw);
  });

  it('reports 3 importUpdates', () => {
    expect(result.importUpdateCount).toBe(3);
    expect(result.importUpdates).toHaveLength(3);
  });

  it('lists correct importerFilePaths', () => {
    const paths = result.importUpdates.map((u) => u.importerFilePath);
    expect(paths).toContain('src/main.ts');
    expect(paths).toContain('src/routes.ts');
    expect(paths).toContain('src/api/handler.ts');
  });

  it('main.ts update: ./utils/hash → ./core/hash', () => {
    const update = result.importUpdates.find((u) => u.importerFilePath === 'src/main.ts');
    expect(update).toBeDefined();
    expect(update!.currentImportPath).toBe('./utils/hash');
    expect(update!.newImportPath).toBe('./core/hash');
  });

  it('routes.ts update: ./utils/hash → ./core/hash', () => {
    const update = result.importUpdates.find((u) => u.importerFilePath === 'src/routes.ts');
    expect(update).toBeDefined();
    expect(update!.currentImportPath).toBe('./utils/hash');
    expect(update!.newImportPath).toBe('./core/hash');
  });

  it('api/handler.ts update: ../utils/hash → ../core/hash', () => {
    const update = result.importUpdates.find((u) => u.importerFilePath === 'src/api/handler.ts');
    expect(update).toBeDefined();
    expect(update!.currentImportPath).toBe('../utils/hash');
    expect(update!.newImportPath).toBe('../core/hash');
  });

  it('each update includes a positive line number', () => {
    for (const update of result.importUpdates) {
      expect(update.line).toBeGreaterThan(0);
    }
  });

  it('safe: true and no cycles', () => {
    expect(result.safe).toBe(true);
    expect(result.wouldIntroduceCycles).toBe(false);
    expect(result.newCycles).toHaveLength(0);
  });

  it('verdict mentions the file count', () => {
    expect(result.verdict).toMatch(/3/);
  });
});

// ─── standalone.ts with no importers ─────────────────────────────────────────

describe('check_move_safe — standalone.ts (no importers)', () => {
  let result: CheckMoveSafeOutput;

  beforeAll(async () => {
    const raw = await checkMoveSafeHandler({
      repoId,
      filePath: 'src/standalone.ts',
      newFilePath: 'src/lib/standalone.ts',
    });
    expect(raw.isError).toBeUndefined();
    result = parse(raw);
  });

  it('importUpdates is empty', () => {
    expect(result.importUpdates).toHaveLength(0);
    expect(result.importUpdateCount).toBe(0);
  });

  it('safe: true', () => {
    expect(result.safe).toBe(true);
  });

  it('wouldIntroduceCycles: false', () => {
    expect(result.wouldIntroduceCycles).toBe(false);
    expect(result.newCycles).toHaveLength(0);
  });

  it('verdict mentions no importers', () => {
    expect(result.verdict).toMatch(/no importer/i);
  });
});

// ─── cyclic/a.ts — move introduces cycle at new location ─────────────────────

describe('check_move_safe — cyclic/a.ts (part of a↔b cycle)', () => {
  let result: CheckMoveSafeOutput;

  beforeAll(async () => {
    const raw = await checkMoveSafeHandler({
      repoId,
      filePath: 'src/cyclic/a.ts',
      newFilePath: 'src/other/a.ts',
    });
    expect(raw.isError).toBeUndefined();
    result = parse(raw);
  });

  it('wouldIntroduceCycles: true', () => {
    expect(result.wouldIntroduceCycles).toBe(true);
  });

  it('safe: false', () => {
    expect(result.safe).toBe(false);
  });

  it('newCycles is non-empty and includes newFilePath', () => {
    expect(result.newCycles.length).toBeGreaterThan(0);
    const allFiles = result.newCycles.flat();
    expect(allFiles.some((f) => f.includes('other/a.ts'))).toBe(true);
  });

  it('cyclic/b.ts has an importUpdate pointing to other/a.ts', () => {
    const update = result.importUpdates.find((u) => u.importerFilePath === 'src/cyclic/b.ts');
    expect(update).toBeDefined();
    expect(update!.newImportPath).toContain('../other/a');
  });

  it('verdict mentions cycles', () => {
    expect(result.verdict).toMatch(/cycle/i);
  });
});

// ─── Deep relative path computation: ../../lib/parser → ../parser ────────────

describe('check_move_safe — path computation (deep relative path)', () => {
  let result: CheckMoveSafeOutput;

  beforeAll(async () => {
    // Move src/lib/parser.ts to src/deep/parser.ts
    // src/deep/nested/consumer.ts imports '../../lib/parser'
    // After move, new import should be '../parser' (from src/deep/nested/ to src/deep/parser.ts)
    const raw = await checkMoveSafeHandler({
      repoId,
      filePath: 'src/lib/parser.ts',
      newFilePath: 'src/deep/parser.ts',
    });
    expect(raw.isError).toBeUndefined();
    result = parse(raw);
  });

  it('finds the nested consumer as an importer', () => {
    const update = result.importUpdates.find(
      (u) => u.importerFilePath === 'src/deep/nested/consumer.ts',
    );
    expect(update).toBeDefined();
  });

  it('currentImportPath is ../../lib/parser', () => {
    const update = result.importUpdates.find(
      (u) => u.importerFilePath === 'src/deep/nested/consumer.ts',
    );
    expect(update!.currentImportPath).toBe('../../lib/parser');
  });

  it('newImportPath is ../parser (correct relative path after move)', () => {
    const update = result.importUpdates.find(
      (u) => u.importerFilePath === 'src/deep/nested/consumer.ts',
    );
    expect(update!.newImportPath).toBe('../parser');
  });
});

// ─── checkCycles: false skips cycle detection ────────────────────────────────

describe('check_move_safe — checkCycles: false', () => {
  it('skips cycle detection and returns empty newCycles', async () => {
    const raw = await checkMoveSafeHandler({
      repoId,
      filePath: 'src/cyclic/a.ts',
      newFilePath: 'src/other/a.ts',
      checkCycles: false,
    });
    expect(raw.isError).toBeUndefined();
    const data = parse(raw);
    expect(data.newCycles).toHaveLength(0);
    expect(data.wouldIntroduceCycles).toBe(false);
    // Even with checkCycles: false, importUpdates should still be present
    expect(data.importUpdates.length).toBeGreaterThan(0);
  });
});

// ─── Output shape ─────────────────────────────────────────────────────────────

describe('check_move_safe — output shape', () => {
  it('response includes all required fields', async () => {
    const raw = await checkMoveSafeHandler({
      repoId,
      filePath: 'src/utils/hash.ts',
      newFilePath: 'src/core/hash.ts',
    });
    const data = parse(raw);
    expect(data).toHaveProperty('safe');
    expect(data).toHaveProperty('verdict');
    expect(data).toHaveProperty('filePath');
    expect(data).toHaveProperty('newFilePath');
    expect(data).toHaveProperty('importUpdates');
    expect(data).toHaveProperty('importUpdateCount');
    expect(data).toHaveProperty('newCycles');
    expect(data).toHaveProperty('wouldIntroduceCycles');
    expect(data).toHaveProperty('_tokenEstimate');
    expect(data).toHaveProperty('_meta');
  });

  it('importUpdateCount matches importUpdates length', async () => {
    const raw = await checkMoveSafeHandler({
      repoId,
      filePath: 'src/utils/hash.ts',
      newFilePath: 'src/core/hash.ts',
    });
    const data = parse(raw);
    expect(data.importUpdateCount).toBe(data.importUpdates.length);
  });

  it('each importUpdate has all required fields', async () => {
    const raw = await checkMoveSafeHandler({
      repoId,
      filePath: 'src/utils/hash.ts',
      newFilePath: 'src/core/hash.ts',
    });
    const data = parse(raw);
    for (const update of data.importUpdates) {
      expect(update).toHaveProperty('importerFilePath');
      expect(update).toHaveProperty('currentImportPath');
      expect(update).toHaveProperty('newImportPath');
      expect(update).toHaveProperty('line');
      expect(typeof update.importerFilePath).toBe('string');
      expect(typeof update.currentImportPath).toBe('string');
      expect(typeof update.newImportPath).toBe('string');
      expect(typeof update.line).toBe('number');
    }
  });

  it('filePath and newFilePath are echoed back in output', async () => {
    const raw = await checkMoveSafeHandler({
      repoId,
      filePath: 'src/utils/hash.ts',
      newFilePath: 'src/core/hash.ts',
    });
    const data = parse(raw);
    expect(data.filePath).toBe('src/utils/hash.ts');
    expect(data.newFilePath).toBe('src/core/hash.ts');
  });
});
