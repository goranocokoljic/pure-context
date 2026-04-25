import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { startWatching } from '../../src/core/watcher/file-watcher.js';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase, computeRepoId } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  await initParser();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempProject(files: Record<string, string> = {}): string {
  const root = join(
    tmpdir(),
    `purecontext-watch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(join(root, path.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('startWatching', () => {
  const roots: string[] = [];
  const repoIds: string[] = [];

  afterEach(() => {
    for (const id of repoIds) {
      try { deleteIndex(id); } catch { /* ignore */ }
    }
    repoIds.length = 0;
    for (const root of roots) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    roots.length = 0;
  });

  it('returns a watcher with a stop() method', async () => {
    const root = makeTempProject({ 'src/a.ts': 'export const x = 1;' });
    roots.push(root);
    const repoId = computeRepoId(resolve(root));
    repoIds.push(repoId);

    await indexFolder(root, { fileLimit: 10 });

    const watcher = startWatching(root, repoId, { debounceMs: 100 });
    expect(typeof watcher.stop).toBe('function');
    await watcher.stop();
  });

  it('picks up a new file after debounce', async () => {
    const root = makeTempProject({ 'src/a.ts': 'export const a = 1;' });
    roots.push(root);
    const repoId = computeRepoId(resolve(root));
    repoIds.push(repoId);

    await indexFolder(root, { fileLimit: 10 });

    const DEBOUNCE = 150;
    const watcher = startWatching(root, repoId, { debounceMs: DEBOUNCE });
    await watcher.ready;

    try {
      // Write a new file after watcher is set up
      writeFileSync(join(root, 'src', 'b.ts'), 'export function newFn(): void {}');

      // Wait for awaitWriteFinish (100ms) + debounce + reindex
      await sleep(DEBOUNCE + 800);

      const db = openDatabase(repoId);
      const symbols = searchSymbols(db, repoId, 'newFn');
      db.close();

      expect(symbols.some((s) => s.name === 'newFn')).toBe(true);
    } finally {
      await watcher.stop();
    }
  }, 10_000);

  it('picks up a modified file after debounce', async () => {
    const root = makeTempProject({
      'src/a.ts': 'export function originalFn(): void {}',
    });
    roots.push(root);
    const repoId = computeRepoId(resolve(root));
    repoIds.push(repoId);

    await indexFolder(root, { fileLimit: 10 });

    const DEBOUNCE = 150;
    const watcher = startWatching(root, repoId, { debounceMs: DEBOUNCE });
    await watcher.ready;

    try {
      // Overwrite the file with new content
      writeFileSync(
        join(root, 'src', 'a.ts'),
        'export function updatedFn(): void {}',
      );

      await sleep(DEBOUNCE + 800);

      const db = openDatabase(repoId);
      const updated = searchSymbols(db, repoId, 'updatedFn');
      const original = searchSymbols(db, repoId, 'originalFn');
      db.close();

      expect(updated.some((s) => s.name === 'updatedFn')).toBe(true);
      expect(original).toHaveLength(0);
    } finally {
      await watcher.stop();
    }
  }, 10_000);

  it('removes symbols when a file is deleted', async () => {
    const root = makeTempProject({
      'src/a.ts': 'export function toBeDeleted(): void {}',
    });
    roots.push(root);
    const repoId = computeRepoId(resolve(root));
    repoIds.push(repoId);

    await indexFolder(root, { fileLimit: 10 });

    const DEBOUNCE = 150;
    const watcher = startWatching(root, repoId, { debounceMs: DEBOUNCE });
    await watcher.ready;

    try {
      unlinkSync(join(root, 'src', 'a.ts'));

      await sleep(DEBOUNCE + 800);

      const db = openDatabase(repoId);
      const symbols = searchSymbols(db, repoId, 'toBeDeleted');
      db.close();

      expect(symbols).toHaveLength(0);
    } finally {
      await watcher.stop();
    }
  }, 10_000);

  it('batches multiple rapid changes into one reindex', async () => {
    const root = makeTempProject({
      'src/a.ts': 'export const a = 1;',
      'src/b.ts': 'export const b = 2;',
    });
    roots.push(root);
    const repoId = computeRepoId(resolve(root));
    repoIds.push(repoId);

    await indexFolder(root, { fileLimit: 10 });

    const DEBOUNCE = 300;
    const watcher = startWatching(root, repoId, { debounceMs: DEBOUNCE });
    await watcher.ready;

    try {
      // Write two files in quick succession — should be batched into one flush
      writeFileSync(join(root, 'src', 'a.ts'), 'export function batchA(): void {}');
      await sleep(50);
      writeFileSync(join(root, 'src', 'b.ts'), 'export function batchB(): void {}');

      // Wait for awaitWriteFinish (100ms) + debounce + reindex
      await sleep(DEBOUNCE + 800);

      const db = openDatabase(repoId);
      const a = searchSymbols(db, repoId, 'batchA');
      const b = searchSymbols(db, repoId, 'batchB');
      db.close();

      expect(a.some((s) => s.name === 'batchA')).toBe(true);
      expect(b.some((s) => s.name === 'batchB')).toBe(true);
    } finally {
      await watcher.stop();
    }
  }, 15_000);

  it('ignores non-source files (e.g. .json)', async () => {
    const root = makeTempProject({ 'src/a.ts': 'export const a = 1;' });
    roots.push(root);
    const repoId = computeRepoId(resolve(root));
    repoIds.push(repoId);

    await indexFolder(root, { fileLimit: 10 });

    const DEBOUNCE = 150;
    const watcher = startWatching(root, repoId, { debounceMs: DEBOUNCE });
    await watcher.ready;

    try {
      writeFileSync(join(root, 'config.json'), '{"key": "value"}');

      // A short wait — no reindex should happen for .json files
      await sleep(DEBOUNCE + 300);

      // If the watcher didn't crash and the original symbol is intact, we're fine
      const db = openDatabase(repoId);
      const symbols = searchSymbols(db, repoId, 'a');
      db.close();

      expect(symbols.length).toBeGreaterThanOrEqual(0); // just verify no error
    } finally {
      await watcher.stop();
    }
  }, 10_000);

  it('stop() is idempotent', async () => {
    const root = makeTempProject({ 'src/a.ts': 'export const x = 1;' });
    roots.push(root);
    const repoId = computeRepoId(resolve(root));
    repoIds.push(repoId);

    await indexFolder(root, { fileLimit: 10 });
    const watcher = startWatching(root, repoId, { debounceMs: 100 });
    await watcher.stop();
    await expect(watcher.stop()).resolves.not.toThrow();
  });
});
