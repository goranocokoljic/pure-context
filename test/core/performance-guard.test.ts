import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { computeRepoId } from '../../src/core/db/schema.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

// ── Synthetic 200-file fixture ────────────────────────────────────────────────

const FIXTURE_DIR = resolve(tmpdir(), `purecontext-perf-guard-${Date.now()}`);
const FILE_COUNT = 200;
let repoId: string;

function buildSyntheticFixture(): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });

  for (let i = 0; i < FILE_COUNT; i++) {
    const content = [
      `// generated file ${i}`,
      `export function compute${i}(x: number): number {`,
      `  return x * ${i + 1};`,
      `}`,
      ``,
      `export const SCALE_${i} = ${i + 1};`,
      ``,
      `export interface Shape${i} {`,
      `  id: number;`,
      `  value${i}: string;`,
      `}`,
    ].join('\n');

    writeFileSync(join(FIXTURE_DIR, `file-${i}.ts`), content, 'utf-8');
  }
}

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  buildSyntheticFixture();
  repoId = computeRepoId(FIXTURE_DIR);
});

afterAll(() => {
  try {
    deleteIndex(repoId);
  } catch {
    // index may not exist if the test failed before indexing
  }
  try {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('performance guard — synthetic 200-file fixture (Task 118)', () => {
  it('indexes 200 files with concurrency:4 in under 5 seconds', async () => {
    const result = await indexFolder(FIXTURE_DIR, { concurrency: 4 });

    expect(result.errors).toHaveLength(0);
    expect(result.filesIndexed).toBe(FILE_COUNT);
    expect(result.totalSymbolsInDb).toBeGreaterThan(0);
    // Generous upper bound — the point is to catch catastrophic regressions.
    // On CI (slower I/O, single-core) this runs ~1–2s; 5s is a safe ceiling.
    expect(result.durationMs).toBeLessThan(5000);
  }, 15_000);

  it('symbols found equals totalSymbolsInDb — no parallel write loss', async () => {
    // Fresh delete so the test is independent of test order.
    try { deleteIndex(repoId); } catch { /* ok */ }

    const result = await indexFolder(FIXTURE_DIR, { concurrency: 4 });

    expect(result.errors).toHaveLength(0);
    expect(result.totalSymbolsInDb).toBe(result.symbolsFound);
    // Each file contributes 2 functions + 1 const + 1 interface = 4 symbols.
    // Allow a small variance in case the TS handler collapses some.
    expect(result.totalSymbolsInDb).toBeGreaterThanOrEqual(FILE_COUNT * 2);
  }, 15_000);
});
