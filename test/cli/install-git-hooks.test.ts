/**
 * Phase 97 follow-up — the installer surfaces the git hooks:
 * `install … --with-git-hooks` installs them; without the flag the one-liner
 * hint is printed; outside a git repo nothing is attempted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { maybeInstallGitHooksForProject, hintGitHooks } from '../../src/cli/install.js';
import { uninstallGitHooks, gitHooksStatus } from '../../src/cli/git-hooks.js';

let base: string;
let repo: string;
let plain: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pc-install-githooks-')));
  repo = join(base, 'repo');
  plain = join(base, 'plain');
  mkdirSync(repo);
  mkdirSync(plain);
  const res = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(res.stderr);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('install --with-git-hooks', () => {
  it('dry-run only reports', () => {
    const lines: string[] = [];
    expect(maybeInstallGitHooksForProject(repo, { dryRun: true, log: (l) => lines.push(l) })).toBe('dry_run');
    expect(lines.join('\n')).toContain('[dry-run] Would install git hooks');
    expect(gitHooksStatus(repo).installed['post-checkout']).toBe(false);
  });

  it('installs, then reports "already" on a re-run, and uninstalls cleanly', () => {
    const lines: string[] = [];
    expect(maybeInstallGitHooksForProject(repo, { log: (l) => lines.push(l) })).toBe('installed');
    expect(lines[0]).toContain('installed in');
    const st = gitHooksStatus(repo);
    expect(st.installed).toEqual({ 'post-checkout': true, 'post-merge': true, 'post-rewrite': true });
    expect(existsSync(join(st.hooksDir!, 'post-merge'))).toBe(true);

    expect(maybeInstallGitHooksForProject(repo, { log: () => {} })).toBe('already');

    const hint: string[] = [];
    hintGitHooks(repo, (l) => hint.push(l));
    expect(hint.join('\n')).toContain('Git hooks: installed');

    uninstallGitHooks(repo);
    expect(gitHooksStatus(repo).installed['post-checkout']).toBe(false);
  });

  it('prints the one-liner when the hooks are not installed', () => {
    const hint: string[] = [];
    hintGitHooks(repo, (l) => hint.push(l));
    expect(hint.join('\n')).toContain('npx purecontext-mcp hooks --install --git');
  });

  it('outside a git repo: skipped, and no hint', () => {
    const lines: string[] = [];
    expect(maybeInstallGitHooksForProject(plain, { log: (l) => lines.push(l) })).toBe('not_git');
    const hint: string[] = [];
    hintGitHooks(plain, (l) => hint.push(l));
    expect(hint).toEqual([]);
  });
});
