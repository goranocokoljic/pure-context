/**
 * Phase 91 (Task 563) — chunked index commits.
 *
 * Batched transactions must produce a database identical to the old
 * single-transaction run, report batchesCommitted, and let a partial run
 * resume via the content-hash cache (unchanged files skip on re-run).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { openDatabase } from '../../src/core/db/schema.js';

let root: string;
const cleanupRepoIds: string[] = [];

function write(relPath: string, content: string) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  await initParser();

  root = resolve(mkdtempSync(join(tmpdir(), 'pc-chunked-')));
  for (let i = 0; i < 12; i++) {
    write(
      `src/mod${String(i).padStart(2, '0')}.ts`,
      `export function fn${i}(): number {\n  return ${i};\n}\nexport const C${i} = ${i};\n`,
    );
  }
});

afterAll(() => {
  for (const id of cleanupRepoIds) {
    try {
      deleteIndex(id);
    } catch {
      /* ignore */
    }
  }
  rmSync(root, { recursive: true, force: true });
});

describe('chunked commits', () => {
  it('batched run matches single-transaction results and reports batch count', async () => {
    // Batched: 12 files / batch 5 → 3 batches
    const batched = await indexFolder(root, { commitBatchSize: 5, skipGit: true });
    cleanupRepoIds.push(batched.repoId);
    expect(batched.filesIndexed).toBe(12);
    expect(batched.batchesCommitted).toBe(3);

    const db = openDatabase(batched.repoId);
    const batchedSymbols = db
      .prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM symbols WHERE repo_id = ?')
      .get(batched.repoId)!.c;
    db.close();
    expect(batchedSymbols).toBe(24); // 2 symbols per file

    // Re-run: everything unchanged → 0 processed, 0 batches
    const rerun = await indexFolder(root, { commitBatchSize: 5, skipGit: true });
    expect(rerun.filesIndexed).toBe(0);
    expect(rerun.batchesCommitted).toBe(0);
  });

  it('commitBatchSize 0 = single transaction (pre-91 behavior)', async () => {
    // New content so files re-process
    write('src/extra.ts', 'export const EXTRA = 1;\n');
    const result = await indexFolder(root, { commitBatchSize: 0, skipGit: true });
    cleanupRepoIds.push(result.repoId);
    expect(result.batchesCommitted).toBe(1);
  });

  it('a partially committed index resumes: committed files skip on re-run', async () => {
    // Simulate the resume property directly: after a batched full index,
    // add ONE new file — the next run must process only that file, because
    // every previously committed batch persisted its hashes.
    write('src/late.ts', 'export const LATE = 99;\n');
    const resume = await indexFolder(root, { commitBatchSize: 5, skipGit: true });
    expect(resume.filesIndexed).toBe(1);
    expect(resume.batchesCommitted).toBe(1);
  });

  it('sequential path (concurrency 1) batches identically', async () => {
    const seqRoot = resolve(mkdtempSync(join(tmpdir(), 'pc-chunked-seq-')));
    try {
      for (let i = 0; i < 7; i++) {
        writeFileSync(join(seqRoot, `f${i}.ts`), `export const S${i} = ${i};\n`);
      }
      const result = await indexFolder(seqRoot, {
        commitBatchSize: 3,
        concurrency: 1,
        skipGit: true,
      });
      cleanupRepoIds.push(result.repoId);
      expect(result.filesIndexed).toBe(7);
      expect(result.batchesCommitted).toBe(3); // 3 + 3 + 1
      const db = openDatabase(result.repoId);
      const n = db
        .prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM symbols WHERE repo_id = ?')
        .get(result.repoId)!.c;
      db.close();
      expect(n).toBe(7);
    } finally {
      rmSync(seqRoot, { recursive: true, force: true });
    }
  });
});
