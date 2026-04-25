import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, reindexFiles, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase, computeRepoId } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';
import { getForwardDeps } from '../../src/core/db/dep-store.js';
import { getFileContent } from '../../src/core/db/file-store.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

// ─── Global setup: register handlers and init parser ─────────────────────────

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();
});

describe('indexFolder — basic-ts-project fixture', () => {
  const repoId = computeRepoId(FIXTURE);

  afterEach(() => {
    deleteIndex(repoId);
  });

  it('indexes the fixture and returns counts', async () => {
    const result = await indexFolder(FIXTURE, { fileLimit: 50 });
    expect(result.repoId).toBe(repoId);
    expect(result.filesIndexed).toBeGreaterThan(0);
    expect(result.symbolsFound).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.errors).toHaveLength(0);
  });

  it('finds TypeScript symbols in the DB after indexing', async () => {
    await indexFolder(FIXTURE, { fileLimit: 50 });

    const db = openDatabase(repoId);
    const symbols = searchSymbols(db, repoId, '');
    db.close();

    const names = symbols.map((s) => s.name);
    // Symbols defined in the fixture
    expect(names).toContain('DiagnosticRunner');
    expect(names).toContain('createRunner');
    expect(names).toContain('formatDiagnostic');
  });

  it('builds dependency edges for fixture imports', async () => {
    await indexFolder(FIXTURE, { fileLimit: 50 });

    const db = openDatabase(repoId);
    // src/index.ts imports src/utils.ts
    const edges = getForwardDeps(db, repoId, 'src/index.ts');
    db.close();

    const targets = edges.map((e) => e.targetFile);
    expect(targets).toContain('src/utils.ts');
    expect(targets).toContain('src/types.ts');
  });

  it('stores raw file content in the DB', async () => {
    await indexFolder(FIXTURE, { fileLimit: 50 });

    const db = openDatabase(repoId);
    const content = getFileContent(db, repoId, 'src/index.ts');
    db.close();

    expect(content).not.toBeNull();
    expect(content!.toString()).toContain('DiagnosticRunner');
  });

  it('skips unchanged files on re-run (incremental)', async () => {
    const first = await indexFolder(FIXTURE, { fileLimit: 50 });
    const second = await indexFolder(FIXTURE, { fileLimit: 50 });

    // Second run should process nothing (all hashes the same)
    expect(second.filesIndexed).toBe(0);
    expect(second.filesSkipped).toBeGreaterThan(0);
    // filesIndexed from first run should be more than second
    expect(first.filesIndexed).toBeGreaterThan(second.filesIndexed);
  });

  it('returns no errors for a clean fixture', async () => {
    const result = await indexFolder(FIXTURE, { fileLimit: 50 });
    expect(result.errors).toHaveLength(0);
  });

  it('reports edgesFound > 0 for a project with imports', async () => {
    const result = await indexFolder(FIXTURE, { fileLimit: 50 });
    expect(result.edgesFound).toBeGreaterThan(0);
  });
});

// ─── reindexFiles ─────────────────────────────────────────────────────────────

describe('reindexFiles', () => {
  const repoId = computeRepoId(FIXTURE);

  afterEach(() => {
    deleteIndex(repoId);
  });

  it('throws for unknown repoId', async () => {
    await expect(reindexFiles('does-not-exist', [])).rejects.toThrow();
  });

  it('re-indexes a modified file and updates symbols', async () => {
    // Full index first
    await indexFolder(FIXTURE, { fileLimit: 50 });

    // Simulate a modified file by calling reindexFiles with it
    const result = await reindexFiles(repoId, ['src/index.ts']);
    expect(result.filesIndexed).toBe(1);
    expect(result.symbolsFound).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
  });

  it('handles deleted paths gracefully', async () => {
    await indexFolder(FIXTURE, { fileLimit: 50 });
    // Pass a non-existent file as deleted — should not throw
    const result = await reindexFiles(repoId, [], ['ghost/file.ts']);
    expect(result.errors).toHaveLength(0);
  });
});

// ─── deleteIndex ──────────────────────────────────────────────────────────────

describe('deleteIndex', () => {
  const root = join(tmpdir(), `purecontext-del-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'a.ts'), 'export const x = 1;');
  const repoId = computeRepoId(resolve(root));

  afterEach(() => {
    deleteIndex(repoId);
    rmSync(root, { recursive: true, force: true });
  });

  it('no-op when DB does not exist', () => {
    expect(() => deleteIndex(repoId)).not.toThrow();
  });

  it('removes the DB after indexing', async () => {
    await indexFolder(root, { fileLimit: 10 });
    // Should exist now
    const { existsSync } = await import('fs');
    const { join: j2 } = await import('path');
    const { getIndexDir } = await import('../../src/core/db/schema.js');
    const dbPath = j2(getIndexDir(), `${repoId}.db`);
    expect(existsSync(dbPath)).toBe(true);

    deleteIndex(repoId);
    expect(existsSync(dbPath)).toBe(false);
  });
});
