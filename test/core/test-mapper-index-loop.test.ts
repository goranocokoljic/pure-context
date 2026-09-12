/**
 * Phase 104 (Tasks 649–650) — the test mapper inside the index loop:
 * whole-tree run builds it, a no-op run skips it in 0 ms, `reindexFiles`
 * (the index_file path) keeps it current, and `skipTestMapper` leaves an
 * absent mapping that the first tool call builds on demand.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { indexFolder, reindexFiles } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import {
  ensureTestMappings,
  getAllCoverageForRepo,
  getTestMapperFreshness,
} from '../../src/core/test-mapper.js';
import { registerHandler } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';

registerHandler(typescriptHandler);

let dir: string;
let repoId: string;

function statusOf(name: string): { status: string; files: string[] } | undefined {
  const db = openDatabase(repoId);
  try {
    const sym = db
      .prepare<[string, string], { id: string }>('SELECT id FROM symbols WHERE repo_id = ? AND name = ?')
      .get(repoId, name);
    if (!sym) return undefined;
    const m = getAllCoverageForRepo(repoId, db).find((c) => c.symbolId === sym.id);
    return m ? { status: m.coverageStatus, files: m.testFilePaths } : undefined;
  } finally {
    db.close();
  }
}

describe('test mapper in the index loop', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pctx-tm-loop-'));
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'export function alpha() { return 1; }\nexport function beta() { return 2; }\n');
    writeFileSync(join(dir, 'test', 'a.test.ts'), "import { alpha } from '../src/a';\nalpha();\n");
    const result = await indexFolder(dir, { skipGit: true });
    repoId = result.repoId;
    expect(result.testMapper?.mode).toBe('full');
    expect(result.testMapper?.testFiles).toBe(1);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('whole-tree run maps alpha tested, beta untested', () => {
    expect(statusOf('alpha')).toEqual({ status: 'tested', files: ['test/a.test.ts'] });
    expect(statusOf('beta')).toEqual({ status: 'untested', files: [] });
  });

  it('a no-op whole-tree run skips the mapper outright (P1)', async () => {
    const r = await indexFolder(dir, { skipGit: true });
    expect(r.filesIndexed).toBe(0);
    expect(r.testMapper).toEqual({ ms: 0, testFiles: 0, symbols: 0, mode: 'skipped' });
  });

  it('reindexFiles (index_file) re-tokenizes a changed test file', async () => {
    writeFileSync(join(dir, 'test', 'a.test.ts'), "import { alpha, beta } from '../src/a';\nalpha(); beta();\n");
    const r = await reindexFiles(repoId, ['test/a.test.ts']);
    expect(r.testMapper?.mode).toBe('full'); // token side moved → every symbol re-mapped
    expect(statusOf('beta')).toEqual({ status: 'tested', files: ['test/a.test.ts'] });
  });

  it('reindexFiles maps a new production symbol incrementally', async () => {
    writeFileSync(join(dir, 'src', 'b.ts'), 'export function gamma() { return 3; }\n');
    const r = await reindexFiles(repoId, ['src/b.ts']);
    expect(r.testMapper?.mode).toBe('incremental');
    expect(r.testMapper?.symbols).toBe(1);
    expect(statusOf('gamma')).toEqual({ status: 'untested', files: [] });
  });

  it('reindexFiles with a deleted test file drops its mentions', async () => {
    unlinkSync(join(dir, 'test', 'a.test.ts'));
    const r = await reindexFiles(repoId, [], ['test/a.test.ts']);
    expect(r.testMapper?.mode).toBe('full');
    expect(statusOf('alpha')).toEqual({ status: 'untested', files: [] });
    const db = openDatabase(repoId);
    try {
      expect(getTestMapperFreshness(repoId, db)).toBe('fresh');
    } finally {
      db.close();
    }
  });

  it('skipTestMapper leaves the mapping absent; the first tool call builds it', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'pctx-tm-lazy-'));
    try {
      mkdirSync(join(dir2, 'src'));
      mkdirSync(join(dir2, 'test'));
      writeFileSync(join(dir2, 'src', 'a.ts'), 'export function alpha() { return 1; }\n');
      writeFileSync(join(dir2, 'test', 'a.test.ts'), "import { alpha } from '../src/a';\nalpha();\n");
      const r = await indexFolder(dir2, { skipGit: true, skipTestMapper: true });
      expect(r.testMapper?.mode).toBe('skipped');
      const db = openDatabase(r.repoId);
      try {
        expect(getTestMapperFreshness(r.repoId, db)).toBe('absent');
        const ensured = ensureTestMappings(r.repoId, db);
        expect(ensured.built).toBe(true);
        expect(ensured.before).toBe('absent');
        expect(getTestMapperFreshness(r.repoId, db)).toBe('fresh');
        expect(getAllCoverageForRepo(r.repoId, db).map((m) => m.coverageStatus)).toEqual(['tested']);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
