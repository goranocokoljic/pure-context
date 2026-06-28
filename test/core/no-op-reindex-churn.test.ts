/**
 * Phase 80, Task 481 — recurring no-op re-parse churn fix.
 *
 * A file that yields 0 symbols AND 0 imports used to never have its hash
 * persisted, so every subsequent index_folder re-read and re-parsed it. This
 * test proves a true no-op re-index now reports filesIndexed === 0 even when the
 * project contains such a file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

let root: string;
let repoId: string;

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  root = mkdtempSync(join(tmpdir(), 'pc-churn-'));
  // A normal file with a symbol …
  writeFileSync(join(root, 'real.ts'), 'export function real(): number { return 1; }\n');
  // … and a file that produces 0 symbols and 0 imports (comment-only).
  writeFileSync(join(root, 'empty.ts'), '// nothing to extract here\n');
  root = resolve(root);
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
  rmSync(root, { recursive: true, force: true });
});

describe('no-op re-index churn (Task 481)', () => {
  it('a second no-op index_folder re-parses 0 files', async () => {
    const first = await indexFolder(root, { fileLimit: 50 });
    repoId = first.repoId;
    expect(first.filesIndexed).toBeGreaterThan(0);

    const second = await indexFolder(root, { fileLimit: 50 });
    // The headline assertion: nothing re-parses on a true no-op, including the
    // comment-only file that previously churned every run.
    expect(second.filesIndexed).toBe(0);
    expect(second.filesSkipped).toBe(first.filesIndexed);
  }, 30_000);
});
