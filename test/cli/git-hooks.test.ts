/**
 * Phase 97, Task 600 — git hook shims (post-checkout / post-merge / post-rewrite).
 *
 * Install/uninstall idempotency, chaining into a pre-existing hook body,
 * `core.hooksPath` respected, linked-worktree install landing in the COMMON
 * dir, and the runner's inline/detach/skip decisions with spawns stubbed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  installGitHooks,
  uninstallGitHooks,
  gitHooksStatus,
  buildHookBlock,
  mergeHookFile,
  stripHookBlock,
  planGitHook,
  runGitHook,
  START_MARKER,
  END_MARKER,
  GIT_HOOK_NAMES,
} from '../../src/cli/git-hooks.js';
import { gitHooksDir, gitCommonDir } from '../../src/core/git-head.js';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { computeRepoId, openDatabase, setGitTreeSha } from '../../src/core/db/schema.js';
import { registerHandler } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

registerHandler(typescriptHandler);

const LAUNCH = { nodeBin: 'C:\\Program Files\\nodejs\\node.exe', cliScript: 'D:\\pc\\dist\\index.js' };

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', ['-c', 'user.name=pc', '-c', 'user.email=pc@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

let base: string;
let repo: string;

beforeAll(async () => {
  await initParser();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pc-githooks-')));
  repo = join(base, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'a.ts'), 'export const A = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
}, 30_000);

afterAll(() => {
  try { deleteIndex(computeRepoId(repo)); } catch { /* ignore */ }
  rmSync(base, { recursive: true, force: true });
});

describe('shim text', () => {
  it('uses forward slashes, LF only, and never exits non-zero', () => {
    const block = buildHookBlock('post-checkout', LAUNCH);
    expect(block).toContain('"C:/Program Files/nodejs/node.exe" "D:/pc/dist/index.js" git-hook post-checkout "$@"');
    expect(block).toContain('|| true');
    expect(block).not.toContain('\r');
    expect(block.startsWith(START_MARKER)).toBe(true);
    expect(block.endsWith(END_MARKER)).toBe(true);
  });

  it('merges into a fresh file with a shebang', () => {
    const out = mergeHookFile(null, 'BLOCK');
    expect(out).toBe('#!/bin/sh\nBLOCK\n');
  });

  it('chains after the shebang of a foreign hook so its exit cannot skip us', () => {
    const foreign = '#!/bin/sh\n. "$(dirname "$0")/_/husky.sh"\nnpm test\nexit 0\n';
    const out = mergeHookFile(foreign, `${START_MARKER}\nours\n${END_MARKER}`);
    const lines = out.split('\n');
    expect(lines[0]).toBe('#!/bin/sh');
    expect(lines[1]).toBe(START_MARKER);
    expect(out).toContain('npm test');
    // Re-merging replaces the block in place (idempotent).
    const again = mergeHookFile(out, `${START_MARKER}\nours-v2\n${END_MARKER}`);
    expect(again.split(START_MARKER).length).toBe(2);
    expect(again).toContain('ours-v2');
    expect(again).not.toContain('\nours\n');
    // Stripping restores the foreign body.
    expect(stripHookBlock(again)).toBe(foreign);
    // Stripping an ours-only file deletes it.
    expect(stripHookBlock(`#!/bin/sh\n${START_MARKER}\nx\n${END_MARKER}\n`)).toBeNull();
  });
});

describe('install / uninstall', () => {
  it('writes the three shims into the git hooks dir, idempotently', () => {
    const res = installGitHooks(repo, LAUNCH);
    expect(res.hooksDir.toLowerCase()).toBe(join(gitCommonDir(repo)!, 'hooks').toLowerCase());
    expect(res.written.length).toBe(3);
    expect(res.chained).toEqual([]);
    for (const h of GIT_HOOK_NAMES) {
      const text = readFileSync(join(res.hooksDir, h), 'utf8');
      expect(text.startsWith('#!/bin/sh\n')).toBe(true);
      expect(text).toContain(`git-hook ${h}`);
      expect(text).not.toContain('\r');
    }
    const again = installGitHooks(repo, LAUNCH);
    for (const h of GIT_HOOK_NAMES) {
      expect(readFileSync(join(again.hooksDir, h), 'utf8').split(START_MARKER).length).toBe(2);
    }
    const st = gitHooksStatus(repo);
    expect(st.installed).toEqual({ 'post-checkout': true, 'post-merge': true, 'post-rewrite': true });
  });

  it('keeps a pre-existing foreign hook and chains into it', () => {
    uninstallGitHooks(repo);
    const hooksDir = gitHooksDir(repo)!;
    writeFileSync(join(hooksDir, 'post-merge'), '#!/bin/sh\necho merged\n');
    const res = installGitHooks(repo, LAUNCH);
    expect(res.chained).toEqual([join(hooksDir, 'post-merge')]);
    const text = readFileSync(join(hooksDir, 'post-merge'), 'utf8');
    expect(text).toContain('echo merged');
    expect(text.indexOf(START_MARKER)).toBeLessThan(text.indexOf('echo merged'));
    const un = uninstallGitHooks(repo);
    expect(un.removed.length).toBe(3);
    expect(readFileSync(join(hooksDir, 'post-merge'), 'utf8')).toBe('#!/bin/sh\necho merged\n');
    expect(existsSync(join(hooksDir, 'post-checkout'))).toBe(false);
    expect(gitHooksStatus(repo).installed['post-merge']).toBe(false);
  });

  it('honours core.hooksPath (husky shape)', () => {
    git(repo, 'config', 'core.hooksPath', '.husky');
    try {
      expect(gitHooksDir(repo)?.toLowerCase()).toBe(join(repo, '.husky').toLowerCase());
      const res = installGitHooks(repo, LAUNCH);
      expect(res.hooksDir.toLowerCase()).toBe(join(repo, '.husky').toLowerCase());
      expect(existsSync(join(repo, '.husky', 'post-checkout'))).toBe(true);
      uninstallGitHooks(repo);
      expect(existsSync(join(repo, '.husky', 'post-checkout'))).toBe(false);
    } finally {
      git(repo, 'config', '--unset', 'core.hooksPath');
    }
  });

  it('a linked worktree installs into the COMMON hooks dir (one install covers all worktrees)', () => {
    const wt = join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', wt);
    try {
      const res = installGitHooks(wt, LAUNCH);
      expect(res.hooksDir.toLowerCase()).toBe(join(gitCommonDir(repo)!, 'hooks').toLowerCase());
      expect(gitHooksStatus(repo).installed['post-checkout']).toBe(true);
    } finally {
      uninstallGitHooks(repo);
      git(repo, 'worktree', 'remove', '--force', wt);
    }
  });
});

describe('runner plan (never blocks)', () => {
  it('not indexed → detach', () => {
    const plan = planGitHook('post-checkout', ['0'.repeat(40), 'abc', '1'], repo, 200);
    expect(plan.action).toBe('detach');
    expect(plan.reason).toBe('not_indexed');
  });

  it('nothing changed → skip; small change → inline; over limit → detach; flag 0 → verify+detach', async () => {
    const r = await indexFolder(repo, { concurrency: 1, cloneFromWorktree: false });
    expect(planGitHook('post-merge', [], repo, 200).action).toBe('skip');

    writeFileSync(join(repo, 'b.ts'), 'export const B = 2;\n');
    const small = planGitHook('post-merge', [], repo, 200);
    expect(small.action).toBe('inline');
    expect(small.changedCount).toBe(1);

    expect(planGitHook('post-merge', [], repo, 0).action).toBe('detach');
    expect(planGitHook('post-merge', [], repo, 0).reason).toBe('over_inline_limit');

    const verify = planGitHook('post-checkout', ['x', 'x', '0'], repo, 200);
    expect(verify.action).toBe('detach');
    expect(verify.flags).toContain('--verify');

    // Stored sha gone from the object store → the full path is expected → detach.
    const db = openDatabase(r.repoId);
    setGitTreeSha(db, r.repoId, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    db.close();
    expect(planGitHook('post-merge', [], repo, 200).reason).toBe('full_fallback_expected');
  }, 30_000);

  it('runGitHook spawns index-changed with --job, and re-detaches on an inline timeout', () => {
    const inlineCalls: string[][] = [];
    const detachCalls: string[][] = [];
    const plan = runGitHook('post-merge', [], {
      cwd: repo,
      launch: LAUNCH,
      spawnInline: (a) => { inlineCalls.push(a); return { timedOut: true }; },
      spawnDetached: (a) => { detachCalls.push(a); },
    });
    expect(plan).not.toBeNull();
    // stored sha is the deadbeef one → detach straight away
    expect(detachCalls.length).toBe(1);
    expect(detachCalls[0]).toEqual([LAUNCH.cliScript, 'index-changed', '--repo', repo, '--job']);
    expect(runGitHook('pre-commit', [], { cwd: repo, launch: LAUNCH })).toBeNull();
  });
});
