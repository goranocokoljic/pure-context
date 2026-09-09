/**
 * Phase 97, Task 601 — stored HEAD + changed-only re-index.
 *
 * Acceptance gate (P3): a changed-only run after commits, edits, deletes,
 * renames and untracked files must leave EXACTLY the tables a from-scratch
 * `indexFolder` of the same tree leaves (files, symbols, edges, FTS rows).
 * Plus the P2 fallbacks, each with its reason, and the drift fields.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { reindexChanged } from '../../src/core/index-changed.js';
import { openDatabase, getRepo, setGitTreeSha } from '../../src/core/db/schema.js';
import { gitHeadSha, readHeadDrift, formatDriftLine } from '../../src/core/git-head.js';
import { registerHandler } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

registerHandler(typescriptHandler);

// ─── Git fixture helpers ──────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', ['-c', 'user.name=pc', '-c', 'user.email=pc@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function initRepo(prefix: string): string {
  // realpath: on Windows tmpdir may be a short (8.3) path; git reports the long one.
  // realpathSync.native: on Windows CI the temp dir is an 8.3 short path
  // (C:/Users/RUNNER~1/...) while git reports the long form; the JS realpath
  // does not expand short names, the native one does.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  git(dir, 'init', '-q', '-b', 'main');
  // Byte-stable checkouts: the parity comparison is over byte offsets, so a
  // machine-wide core.autocrlf=true must not rewrite line endings on checkout.
  git(dir, 'config', 'core.autocrlf', 'false');
  return dir;
}

interface DbSnapshot {
  files: Array<{ path: string; hash: string; pkg: string | null }>;
  symbols: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  imports: Array<Record<string, unknown>>;
  fts: number;
}

/** Everything a fresh index and a changed-only index must agree on. */
function snapshot(repoId: string): DbSnapshot {
  const db = openDatabase(repoId);
  const files = db
    .prepare<[string], { path: string; hash: string; pkg: string | null }>(
      'SELECT path, content_hash AS hash, declared_package AS pkg FROM files WHERE repo_id = ? ORDER BY path',
    )
    .all(repoId);
  const symbols = db
    .prepare<[string], Record<string, unknown>>(
      `SELECT id, name, kind, file_path, start_byte, end_byte, signature, summary, framework_meta
       FROM symbols WHERE repo_id = ? ORDER BY file_path, start_byte, id`,
    )
    .all(repoId);
  const edges = db
    .prepare<[string], Record<string, unknown>>(
      `SELECT source_file, target_file, edge_type, specifier FROM dep_edges
       WHERE repo_id = ? ORDER BY source_file, target_file, specifier`,
    )
    .all(repoId);
  const imports = db
    .prepare<[string], Record<string, unknown>>(
      `SELECT source_file, specifier, imported_names FROM import_records
       WHERE repo_id = ? ORDER BY source_file, specifier`,
    )
    .all(repoId);
  const fts =
    db.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM fts_symbols WHERE repo_id = ?').get(repoId)
      ?.c ?? 0;
  db.close();
  return { files, symbols, edges, imports, fts };
}

function storedSha(repoId: string): string | null {
  const db = openDatabase(repoId);
  const sha = getRepo(db, repoId)?.gitTreeSha ?? null;
  db.close();
  return sha;
}

// ─── Fixture ──────────────────────────────────────────────────────────────────

let dir: string;
let repoId: string;

beforeAll(async () => {
  await initParser();
  dir = initRepo('pc-idxchg-');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const A = 1;\nexport function fa(): number { return A; }\n');
  writeFileSync(join(dir, 'src', 'b.ts'), "import { A } from './a';\nexport const B = A + 1;\n");
  writeFileSync(join(dir, 'src', 'c.ts'), 'export class C { run(): void {} }\n');
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  const r = await indexFolder(dir, { concurrency: 1, cloneFromWorktree: false });
  repoId = r.repoId;
}, 60_000);

afterAll(() => {
  try { deleteIndex(repoId); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
});

describe('stored HEAD (Task 601)', () => {
  it('indexFolder records HEAD on the repo row', () => {
    expect(storedSha(repoId)).toBe(gitHeadSha(dir));
  });

  it('readHeadDrift reports fresh right after indexing', () => {
    const d = readHeadDrift(dir, storedSha(repoId));
    expect(d?.status).toBe('fresh');
    expect(d?.behindBy).toBe(0);
    expect(formatDriftLine(d)).toContain('fresh');
  });
});

describe('changed-only ≡ full index (P3)', () => {
  it('after commits + edits + delete + rename + untracked, tables are byte-identical to a fresh index', async () => {
    // Commit 2: edit a, add d (imports c), delete README, rename b → e.
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const A = 42;\nexport function fa2(): number { return A; }\n');
    writeFileSync(join(dir, 'src', 'd.ts'), "import { C } from './c';\nexport const d = new C();\n");
    unlinkSync(join(dir, 'README.md'));
    git(dir, 'mv', 'src/b.ts', 'src/e.ts');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'second');
    // Commit 3: delete c entirely (d now imports a missing file — unresolved).
    git(dir, 'rm', '-q', 'src/c.ts');
    git(dir, 'commit', '-q', '-m', 'third');
    // Working tree: uncommitted edit to e, untracked f.
    writeFileSync(join(dir, 'src', 'e.ts'), "import { A } from './a';\nexport const E = A * 2;\n");
    writeFileSync(join(dir, 'src', 'f.ts'), 'export const F = "untracked";\n');

    const before = storedSha(repoId);
    const res = await reindexChanged(dir, { concurrency: 1, cloneFromWorktree: false });
    expect(res.mode).toBe('changed');
    expect(res.since).toBe(before);
    expect(res.reason).toBeUndefined();
    // a, d, e (renamed target + edited), f (untracked) re-parsed; README, b, c removed.
    expect(res.changedFiles).toBe(4);
    expect(res.deletedFiles).toBe(3);
    expect(storedSha(repoId)).toBe(gitHeadSha(dir));

    const changedOnly = snapshot(repoId);
    expect(changedOnly.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts']);

    // Fresh index of the identical tree.
    deleteIndex(repoId);
    await indexFolder(dir, { concurrency: 1, cloneFromWorktree: false });
    const fresh = snapshot(repoId);

    expect(changedOnly).toEqual(fresh);
    expect(fresh.symbols.length).toBeGreaterThan(0);
    expect(fresh.edges.length).toBeGreaterThan(0);
  }, 60_000);

  it('a no-op run touches nothing and stays in changed mode', async () => {
    const res = await reindexChanged(dir, { concurrency: 1, cloneFromWorktree: false });
    expect(res.mode).toBe('changed');
    // e.ts (uncommitted edit) + f.ts (untracked) are working-tree changes →
    // re-checked every run (cheap: hash-identical content re-parses only).
    expect(res.changedFiles).toBe(2);
    expect(res.deletedFiles).toBe(0);
  });
});

describe('fallbacks (P2) — always visible', () => {
  it('unreachable since sha → full, reason since_unreachable', async () => {
    const res = await reindexChanged(dir, {
      since: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      concurrency: 1,
      cloneFromWorktree: false,
    });
    expect(res.mode).toBe('full');
    expect(res.reason).toBe('since_unreachable');
    expect(storedSha(repoId)).toBe(gitHeadSha(dir)); // the full run re-records HEAD
  }, 60_000);

  it('no stored sha → full, reason no_stored_sha', async () => {
    const db = openDatabase(repoId);
    setGitTreeSha(db, repoId, null);
    db.close();
    const res = await reindexChanged(dir, { concurrency: 1, cloneFromWorktree: false });
    expect(res.mode).toBe('full');
    expect(res.reason).toBe('no_stored_sha');
    expect(storedSha(repoId)).not.toBeNull();
  }, 60_000);

  it('too many changes → full, reason too_many_changes', async () => {
    writeFileSync(join(dir, 'src', 'g.ts'), 'export const G = 1;\n');
    const res = await reindexChanged(dir, { maxFiles: 1, concurrency: 1, cloneFromWorktree: false });
    expect(res.mode).toBe('full');
    expect(res.reason).toBe('too_many_changes');
  }, 60_000);

  it('not indexed → full, reason not_indexed', async () => {
    const other = initRepo('pc-idxchg-other-');
    try {
      writeFileSync(join(other, 'x.ts'), 'export const X = 1;\n');
      git(other, 'add', '.');
      git(other, 'commit', '-q', '-m', 'init');
      const res = await reindexChanged(other, { concurrency: 1, cloneFromWorktree: false });
      expect(res.mode).toBe('full');
      expect(res.reason).toBe('not_indexed');
      expect(res.headSha).toBe(gitHeadSha(other));
      deleteIndex(res.repoId);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  }, 60_000);

  it('non-git folder → full, reason not_git; stored sha stays null', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'pc-idxchg-plain-'));
    try {
      writeFileSync(join(plain, 'x.ts'), 'export const X = 1;\n');
      const first = await indexFolder(plain, { concurrency: 1, cloneFromWorktree: false });
      expect(first.headSha).toBeNull();
      expect(storedSha(first.repoId)).toBeNull();
      const res = await reindexChanged(plain, { concurrency: 1, cloneFromWorktree: false });
      expect(res.mode).toBe('full');
      expect(res.reason).toBe('not_git');
      deleteIndex(first.repoId);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('drift fields', () => {
  it('reports behind after a commit and dirty after an edit', () => {
    const indexed = storedSha(repoId)!;
    writeFileSync(join(dir, 'src', 'h.ts'), 'export const H = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'fourth');
    const behind = readHeadDrift(dir, indexed);
    expect(behind?.status).toBe('behind');
    expect(behind?.behindBy).toBe(1);
    expect(formatDriftLine(behind)).toContain('1 commit(s) behind');

    const atHead = readHeadDrift(dir, gitHeadSha(dir));
    // g.ts / f.ts may still be untracked from earlier steps → dirty, else fresh
    expect(['fresh', 'dirty']).toContain(atHead?.status);

    const unknown = readHeadDrift(dir, null);
    expect(unknown?.status).toBe('unknown');
    expect(formatDriftLine(unknown)).toContain('unknown');
  });

  it('skipDirty omits the status walk', () => {
    const d = readHeadDrift(dir, gitHeadSha(dir), { skipDirty: true });
    expect(d?.dirtyFiles).toBeNull();
  });
});
