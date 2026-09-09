/**
 * Phase 97, Task 602 — worktree index cloning.
 *
 * P3 gate: seeding a new worktree's index from a sibling (copy + repo_id
 * rewrite) and applying the delta must produce EXACTLY the tables a
 * from-scratch index of that worktree produces — through BOTH routes
 * (`reindexChanged` = clone + git delta; `indexFolder` = clone + incremental
 * walk). Plus sibling selection rules and the R4 "no foreign rows" check.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { reindexChanged } from '../../src/core/index-changed.js';
import {
  findCloneSource,
  countRowsWithRepoId,
  tablesWithRepoIdColumn,
  maybeCloneWorktreeIndex,
} from '../../src/core/worktree-clone.js';
import { computeRepoId, openDatabase, getRepo, getIndexDir } from '../../src/core/db/schema.js';
import { gitHeadSha, isLinkedWorktree, gitWorktreeList, gitHooksDir } from '../../src/core/git-head.js';
import { registerHandler } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

registerHandler(typescriptHandler);

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', ['-c', 'user.name=pc', '-c', 'user.email=pc@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function snapshot(repoId: string) {
  const db = openDatabase(repoId);
  const files = db
    .prepare<[string], Record<string, unknown>>(
      'SELECT path, content_hash, declared_package FROM files WHERE repo_id = ? ORDER BY path',
    )
    .all(repoId);
  const symbols = db
    .prepare<[string], Record<string, unknown>>(
      `SELECT id, name, kind, file_path, start_byte, end_byte, signature, summary
       FROM symbols WHERE repo_id = ? ORDER BY file_path, start_byte, id`,
    )
    .all(repoId);
  const edges = db
    .prepare<[string], Record<string, unknown>>(
      `SELECT source_file, target_file, edge_type, specifier FROM dep_edges
       WHERE repo_id = ? ORDER BY source_file, target_file, specifier`,
    )
    .all(repoId);
  const fts = db
    .prepare<[string], Record<string, unknown>>(
      'SELECT symbol_id, content FROM fts_symbols WHERE repo_id = ? ORDER BY symbol_id',
    )
    .all(repoId);
  const imports = db
    .prepare<[string], Record<string, unknown>>(
      'SELECT source_file, specifier FROM import_records WHERE repo_id = ? ORDER BY source_file, specifier',
    )
    .all(repoId);
  db.close();
  return { files, symbols, edges, fts, imports };
}

let base: string;
let main: string;
let wt: string;
let mainRepoId: string;

beforeAll(async () => {
  await initParser();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pc-wtclone-')));
  main = join(base, 'main');
  mkdirSync(join(main, 'src'), { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'core.autocrlf', 'false');
  for (let i = 0; i < 12; i++) {
    writeFileSync(
      join(main, 'src', `m${i}.ts`),
      `export const M${i} = ${i};\nexport function f${i}(): number { return M${i}; }\n`,
    );
  }
  writeFileSync(join(main, 'src', 'index.ts'), "import { M0 } from './m0';\nimport { M1 } from './m1';\nexport const sum = M0 + M1;\n");
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'initial');
  const r = await indexFolder(main, { concurrency: 1 });
  mainRepoId = r.repoId;
  expect(r.clonedFrom).toBeUndefined();

  // Linked worktree on a new branch that diverges: edit, add, delete.
  wt = join(base, 'wt-feature');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
  writeFileSync(join(wt, 'src', 'm0.ts'), 'export const M0 = 100;\nexport function f0changed(): number { return M0; }\n');
  writeFileSync(join(wt, 'src', 'new.ts'), "import { sum } from './index';\nexport const twice = sum * 2;\n");
  git(wt, 'rm', '-q', 'src/m11.ts');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'feature work');
}, 60_000);

afterAll(() => {
  try { deleteIndex(mainRepoId); } catch { /* ignore */ }
  try { deleteIndex(computeRepoId(wt)); } catch { /* ignore */ }
  rmSync(base, { recursive: true, force: true });
});

describe('detection', () => {
  it('main is not linked; the worktree is; both share one hooks dir', () => {
    expect(isLinkedWorktree(main)).toBe(false);
    expect(isLinkedWorktree(wt)).toBe(true);
    const list = gitWorktreeList(wt);
    expect(list.length).toBe(2);
    expect(list[0].isMain).toBe(true);
    expect(gitHooksDir(wt)?.toLowerCase()).toBe(gitHooksDir(main)?.toLowerCase());
  });

  it('findCloneSource picks the main worktree and its stored sha', () => {
    const src = findCloneSource(wt);
    expect(src?.repoId).toBe(mainRepoId);
    expect(src?.isMain).toBe(true);
    expect(src?.sha).toBe(gitHeadSha(main));
  });

  it('a plain (non-linked) repo never clones', () => {
    expect(maybeCloneWorktreeIndex(main, mainRepoId)).toBeNull();
  });
});

describe('clone + delta ≡ fresh (P3)', () => {
  it('reindexChanged on an unindexed worktree clones then applies the git delta', async () => {
    const wtRepoId = computeRepoId(wt);
    expect(existsSync(join(getIndexDir(), `${wtRepoId}.db`))).toBe(false);

    const res = await reindexChanged(wt, { concurrency: 1 });
    expect(res.mode).toBe('changed');
    expect(res.clonedFrom?.repoId).toBe(mainRepoId);
    expect(res.since).toBe(gitHeadSha(main));
    expect(res.changedFiles).toBe(2); // m0 edited, new added
    expect(res.deletedFiles).toBe(1); // m11 removed

    const db = openDatabase(wtRepoId);
    const meta = getRepo(db, wtRepoId);
    expect(meta?.rootPath).toBe(wt);
    expect(meta?.gitTreeSha).toBe(gitHeadSha(wt));
    // R4: no row anywhere still carries the source repo id.
    expect(countRowsWithRepoId(db, mainRepoId)).toBe(0);
    expect(tablesWithRepoIdColumn(db)).toContain('fts_symbols');
    expect(tablesWithRepoIdColumn(db)).toContain('symbols');
    expect(tablesWithRepoIdColumn(db)).toContain('dep_edges');
    db.close();

    const viaClone = snapshot(wtRepoId);
    deleteIndex(wtRepoId);
    await indexFolder(wt, { concurrency: 1, cloneFromWorktree: false });
    const fresh = snapshot(wtRepoId);
    expect(viaClone).toEqual(fresh);
    expect(fresh.symbols.some((s) => s.name === 'f0changed')).toBe(true);
    expect(fresh.symbols.some((s) => s.name === 'M11')).toBe(false);

    // The main worktree's index is untouched by the clone.
    const mdb = openDatabase(mainRepoId);
    expect(getRepo(mdb, mainRepoId)?.rootPath).toBe(main);
    expect(countRowsWithRepoId(mdb, mainRepoId)).toBeGreaterThan(0);
    mdb.close();
  }, 60_000);

  it('indexFolder on an unindexed worktree also clones, then walks incrementally to the same tables', async () => {
    const wtRepoId = computeRepoId(wt);
    const fresh = snapshot(wtRepoId);
    deleteIndex(wtRepoId);

    const res = await indexFolder(wt, { concurrency: 1 });
    expect(res.clonedFrom?.repoId).toBe(mainRepoId);
    // Only the files that differ from the sibling re-parse; m11 is pruned.
    expect(res.filesIndexed).toBe(2);
    expect(res.filesPruned).toBe(1);
    expect(snapshot(wtRepoId)).toEqual(fresh);
  }, 60_000);
});

describe('sibling working-tree edits', () => {
  it('an uncommitted edit in the sibling is not inherited by the new worktree', async () => {
    // Sibling (main) gets a WIP edit and re-indexes it (the PostToolUse shape).
    writeFileSync(
      join(main, 'src', 'm5.ts'),
      ['export const M5 = 555;', 'export function wip(): number { return M5; }', ''].join('\n'),
    );
    await indexFolder(main, { concurrency: 1 });
    const mdb = openDatabase(mainRepoId);
    expect(mdb.prepare('SELECT COUNT(*) AS c FROM symbols WHERE repo_id = ? AND name = ?').get(mainRepoId, 'wip')).toEqual({ c: 1 });
    mdb.close();

    const wtRepoId = computeRepoId(wt);
    deleteIndex(wtRepoId);
    const res = await reindexChanged(wt, { concurrency: 1 });
    expect(res.clonedFrom?.repoId).toBe(mainRepoId);
    const db = openDatabase(wtRepoId);
    const wip = db.prepare('SELECT COUNT(*) AS c FROM symbols WHERE repo_id = ? AND name = ?').get(wtRepoId, 'wip') as { c: number };
    db.close();
    expect(wip.c).toBe(0); // the worktree has the COMMITTED m5, not main's WIP

    // Restore main.
    git(main, 'checkout', '-q', '--', 'src/m5.ts');
    await indexFolder(main, { concurrency: 1 });
  }, 60_000);
});

describe('sibling selection rules', () => {
  it('a sibling at an older schema version is skipped (falls back to full)', async () => {
    const wtRepoId = computeRepoId(wt);
    deleteIndex(wtRepoId);
    const mdb = openDatabase(mainRepoId);
    mdb.prepare('UPDATE repos SET schema_version = 10 WHERE id = ?').run(mainRepoId);
    mdb.close();
    try {
      expect(findCloneSource(wt)).toBeNull();
      const res = await reindexChanged(wt, { concurrency: 1 });
      expect(res.mode).toBe('full');
      expect(res.reason).toBe('not_indexed');
      expect(res.clonedFrom).toBeUndefined();
    } finally {
      // openDatabase re-runs migrations; restore the version explicitly.
      const mdb2 = openDatabase(mainRepoId);
      mdb2.prepare('UPDATE repos SET schema_version = 11 WHERE id = ?').run(mainRepoId);
      mdb2.close();
    }
  }, 60_000);

  it('a sibling without a stored sha is skipped', () => {
    const mdb = openDatabase(mainRepoId);
    mdb.prepare('UPDATE repos SET git_tree_sha = NULL WHERE id = ?').run(mainRepoId);
    mdb.close();
    expect(findCloneSource(wt)).toBeNull();
    const mdb2 = openDatabase(mainRepoId);
    mdb2.prepare('UPDATE repos SET git_tree_sha = ? WHERE id = ?').run(gitHeadSha(main), mainRepoId);
    mdb2.close();
    expect(findCloneSource(wt)?.repoId).toBe(mainRepoId);
  });
});
