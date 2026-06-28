/**
 * Tests for the check_index_staleness tool (Phase 80, Task 482).
 *
 * Cheap fresh/stale verdicts per file (no discovery pass), plus a repo-level
 * summary and the unindexed-repo case.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { computeRepoId } from '../../src/core/db/schema.js';
import { handler as stalenessHandler } from '../../src/server/tools/check-index-staleness.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

interface FileVerdict { path: string; status: 'fresh' | 'stale'; reason?: string }
interface Output {
  indexed: boolean;
  allFresh?: boolean;
  staleCount?: number;
  stalePaths?: string[];
  files?: FileVerdict[];
  fileCount?: number;
  lastIndexedAt?: number | null;
}

function parse(result: { content: { text: string }[] }): Output {
  return JSON.parse(result.content[0].text) as Output;
}

let root: string;
let repoId: string;

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  root = mkdtempSync(join(tmpdir(), 'pc-staleness-'));
  writeFileSync(join(root, 'a.ts'), 'export function a(): number { return 1; }\n');
  writeFileSync(join(root, 'b.ts'), 'export function b(): number { return 2; }\n');
  root = resolve(root);
  const r = await indexFolder(root, { fileLimit: 50 });
  repoId = r.repoId;
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
  rmSync(root, { recursive: true, force: true });
});

describe('check_index_staleness — unindexed repo', () => {
  it('reports indexed:false for an unknown repo', () => {
    // Derive an id from a path that has never been indexed/opened, so no stray
    // .db file in the shared index dir can make this collide.
    const neverIndexed = computeRepoId(resolve(tmpdir(), 'pc-staleness-never-indexed-xyz'));
    const data = parse(stalenessHandler({ repoId: neverIndexed }));
    expect(data.indexed).toBe(false);
    expect(data.allFresh).toBe(false);
  });
});

describe('check_index_staleness — repo-level summary', () => {
  it('returns counts and last-indexed time with no filePaths', () => {
    const data = parse(stalenessHandler({ repoId }));
    expect(data.indexed).toBe(true);
    expect(data.fileCount).toBeGreaterThan(0);
    expect(typeof data.lastIndexedAt).toBe('number');
  });
});

describe('check_index_staleness — per-file verdicts', () => {
  it('an unchanged indexed file is fresh', () => {
    const data = parse(stalenessHandler({ repoId, filePaths: [join(root, 'a.ts')] }));
    expect(data.allFresh).toBe(true);
    expect(data.files?.[0].status).toBe('fresh');
  });

  it('a modified file is stale (modified)', () => {
    writeFileSync(join(root, 'a.ts'), 'export function a(): number { return 999; }\n');
    const data = parse(stalenessHandler({ repoId, filePaths: [join(root, 'a.ts')] }));
    expect(data.allFresh).toBe(false);
    expect(data.staleCount).toBe(1);
    expect(data.files?.[0]).toMatchObject({ status: 'stale', reason: 'modified' });
  });

  it('a changed-but-unindexed (new) file reports stale (not_indexed)', () => {
    const newFile = join(root, 'c.ts');
    writeFileSync(newFile, 'export const C = 3;\n');
    const data = parse(stalenessHandler({ repoId, filePaths: [newFile] }));
    expect(data.files?.[0]).toMatchObject({ status: 'stale', reason: 'not_indexed' });
  });

  it('an indexed file deleted from disk reports stale (deleted)', () => {
    const abs = join(root, 'b.ts');
    unlinkSync(abs);
    const data = parse(stalenessHandler({ repoId, filePaths: [abs] }));
    expect(data.files?.[0]).toMatchObject({ status: 'stale', reason: 'deleted' });
  });
});
