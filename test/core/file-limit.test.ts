/**
 * Task 123: fileLimit behavior — warning when limit is reached, unlimited (0) mode,
 * and maxFileSize skipping.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { computeRepoId } from '../../src/core/db/schema.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  await initParser();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTsFixture(dir: string, count: number): void {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(
      join(dir, `file${i}.ts`),
      `export const value${i} = ${i};\n`,
    );
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('fileLimit enforcement', () => {
  let fixtureDir: string;

  afterEach(() => {
    const repoId = computeRepoId(fixtureDir);
    deleteIndex(repoId);
    try { rmSync(fixtureDir, { recursive: true }); } catch { /* best effort */ }
  });

  it('adds a warning when fileLimit is reached and filesSkipped reflects dropped files', async () => {
    fixtureDir = join(tmpdir(), `pc-test-limit-${Date.now()}`);
    createTsFixture(fixtureDir, 15);

    const result = await indexFolder(fixtureDir, { fileLimit: 10, concurrency: 1 });

    expect(result.filesIndexed).toBe(10);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('fileLimit of 10 reached');
    expect(result.warnings[0]).toContain('5 file(s) were skipped');
    expect(result.warnings[0]).toContain("~/.purecontext/config.json");
    // filesSkipped should include the 5 dropped by the limit
    expect(result.filesSkipped).toBeGreaterThanOrEqual(5);
  });

  it('emits no warning when all files fit within the limit', async () => {
    fixtureDir = join(tmpdir(), `pc-test-nolimit-${Date.now()}`);
    createTsFixture(fixtureDir, 5);

    const result = await indexFolder(fixtureDir, { fileLimit: 10, concurrency: 1 });

    expect(result.warnings).toHaveLength(0);
    expect(result.filesIndexed).toBeLessThanOrEqual(5);
  });

  it('fileLimit=0 (unlimited) indexes all files and emits no warning', async () => {
    fixtureDir = join(tmpdir(), `pc-test-unlimited-${Date.now()}`);
    createTsFixture(fixtureDir, 15);

    const result = await indexFolder(fixtureDir, { fileLimit: 0, concurrency: 1 });

    expect(result.warnings).toHaveLength(0);
    // All 15 files should be indexed (no limit applied)
    expect(result.filesIndexed).toBe(15);
  });
});
