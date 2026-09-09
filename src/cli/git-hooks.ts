/**
 * Git hooks (Phase 97, Task 600): post-checkout / post-merge / post-rewrite.
 *
 * `purecontext-mcp hooks --install --git [--repo <path>]` writes three shims
 * into the directory git actually runs hooks from (`core.hooksPath` when set —
 * husky / lefthook — else the COMMON dir's `hooks/`, so one install covers
 * every worktree of the repository). Each shim runs
 * `node <cli> git-hook <name> "$@"` and always exits 0.
 *
 * Runner contract (P1 — never block git):
 * - the changed set since the stored HEAD is counted first (two cheap git
 *   calls); at most `hooks.inlineFileLimit` (200) files run INLINE with a
 *   10 s cap, anything larger — or a run that needs the full path — is
 *   handed to a DETACHED process and a job marker is written so
 *   `list_repos` / `check_index_staleness` say "re-index in progress";
 * - every failure is swallowed; nothing here can turn a checkout red.
 *
 * Shims are marker-delimited and idempotent; a pre-existing hook body is kept
 * and our block is inserted right after its shebang so their `exit` cannot
 * skip us and our block cannot skip them (R5).
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServerLaunch } from './resolve-node.js';
import {
  gitChangedFilesBetween,
  gitCommitExists,
  gitDirtyFiles,
  gitHeadSha,
  gitHooksDir,
  gitTopLevel,
} from '../core/git-head.js';
import { computeRepoId, getIndexDir, getRepo, openDatabase } from '../core/db/schema.js';
import { getConfig } from '../config/config-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const GIT_HOOK_NAMES = ['post-checkout', 'post-merge', 'post-rewrite'] as const;
export type GitHookName = (typeof GIT_HOOK_NAMES)[number];

export const START_MARKER = '# purecontext-mcp-start';
export const END_MARKER = '# purecontext-mcp-end';

/** Inline runs are killed (and re-run detached) after this long. */
const INLINE_CAP_MS = 10_000;

export interface HookLaunch {
  nodeBin: string;
  cliScript: string;
}

function defaultLaunch(): HookLaunch {
  return {
    nodeBin: resolveServerLaunch().command,
    cliScript: resolve(__dirname, '..', 'index.js'),
  };
}

/** Forward slashes: safe inside double quotes for sh AND Git Bash on Windows. */
function shPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** The managed block for one hook (LF only — R8). */
export function buildHookBlock(hook: GitHookName, launch: HookLaunch): string {
  return [
    START_MARKER,
    `# PureContext: re-index after ${hook} (installed by \`purecontext-mcp hooks --install --git\`).`,
    '# Never blocks git: small changes re-index inline (10 s cap), large ones detach; always exits 0.',
    '# Remove with `purecontext-mcp hooks --uninstall --git`.',
    `"${shPath(launch.nodeBin)}" "${shPath(launch.cliScript)}" git-hook ${hook} "$@" </dev/null >/dev/null 2>&1 || true`,
    END_MARKER,
  ].join('\n');
}

/**
 * Merge the managed block into an existing hook file's text (or create one).
 * Exported for tests. Returns the new file content.
 */
export function mergeHookFile(existing: string | null, block: string): string {
  if (existing === null || existing.trim() === '') {
    return `#!/bin/sh\n${block}\n`;
  }
  const text = existing.replace(/\r\n/g, '\n');
  const s = text.indexOf(START_MARKER);
  const e = text.indexOf(END_MARKER);
  if (s !== -1 && e !== -1 && e > s) {
    return text.slice(0, s) + block + text.slice(e + END_MARKER.length);
  }
  // Foreign hook body: insert after the shebang line so an early `exit` in
  // their script cannot skip us, and our block (which never exits) cannot
  // skip them.
  const lines = text.split('\n');
  if (lines[0]?.startsWith('#!')) {
    return [lines[0], block, ...lines.slice(1)].join('\n');
  }
  return `#!/bin/sh\n${block}\n${text}`;
}

/** Strip the managed block; null when the file should be deleted (nothing else in it). */
export function stripHookBlock(existing: string): string | null {
  const text = existing.replace(/\r\n/g, '\n');
  const s = text.indexOf(START_MARKER);
  const e = text.indexOf(END_MARKER);
  if (s === -1 || e === -1 || e < s) return text;
  // Remove the block AND the single newline that followed it, so a chained
  // foreign hook comes back byte-identical to what it was before install.
  let tail = text.slice(e + END_MARKER.length);
  if (tail.startsWith('\n')) tail = tail.slice(1);
  const out = text.slice(0, s) + tail;
  const rest = out.replace(/^#!.*\n?/, '').trim();
  return rest === '' ? null : out;
}

export interface InstallGitHooksResult {
  hooksDir: string;
  written: string[];
  chained: string[];
}

/** Install (or refresh) the three shims for the repository containing `repoPath`. */
export function installGitHooks(
  repoPath: string,
  launch: HookLaunch = defaultLaunch(),
): InstallGitHooksResult {
  const hooksDir = gitHooksDir(repoPath);
  if (!hooksDir) throw new Error(`${repoPath} is not inside a git repository`);
  mkdirSync(hooksDir, { recursive: true });
  const written: string[] = [];
  const chained: string[] = [];
  for (const hook of GIT_HOOK_NAMES) {
    const file = join(hooksDir, hook);
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const isForeign = existing !== null && !existing.includes(START_MARKER) && existing.trim() !== '';
    const content = mergeHookFile(existing, buildHookBlock(hook, launch));
    writeFileSync(file, content, { encoding: 'utf8' });
    try {
      chmodSync(file, 0o755);
    } catch {
      /* Windows: mode bits are advisory */
    }
    written.push(file);
    if (isForeign) chained.push(file);
  }
  return { hooksDir, written, chained };
}

export interface UninstallGitHooksResult {
  hooksDir: string;
  removed: string[];
}

/** Remove the managed block from each shim; delete the file when nothing else remains. */
export function uninstallGitHooks(repoPath: string): UninstallGitHooksResult {
  const hooksDir = gitHooksDir(repoPath);
  if (!hooksDir) throw new Error(`${repoPath} is not inside a git repository`);
  const removed: string[] = [];
  for (const hook of GIT_HOOK_NAMES) {
    const file = join(hooksDir, hook);
    if (!existsSync(file)) continue;
    const existing = readFileSync(file, 'utf8');
    if (!existing.includes(START_MARKER)) continue;
    const rest = stripHookBlock(existing);
    if (rest === null) {
      unlinkSync(file);
    } else {
      writeFileSync(file, rest, { encoding: 'utf8' });
    }
    removed.push(file);
  }
  return { hooksDir, removed };
}

export interface GitHooksStatus {
  hooksDir: string | null;
  installed: Record<GitHookName, boolean>;
}

export function gitHooksStatus(repoPath: string): GitHooksStatus {
  const hooksDir = gitHooksDir(repoPath);
  const installed = { 'post-checkout': false, 'post-merge': false, 'post-rewrite': false };
  if (hooksDir) {
    for (const hook of GIT_HOOK_NAMES) {
      const file = join(hooksDir, hook);
      try {
        installed[hook] = existsSync(file) && readFileSync(file, 'utf8').includes(START_MARKER);
      } catch {
        installed[hook] = false;
      }
    }
  }
  return { hooksDir, installed };
}

// ─── Runner (`purecontext-mcp git-hook <name> <git args…>`) ──────────────────

export interface GitHookPlan {
  root: string;
  repoId: string;
  /** Why this hook run does what it does — logged, never fatal. */
  action: 'skip' | 'inline' | 'detach';
  reason: string;
  /** Extra CLI flags for index-changed. */
  flags: string[];
  changedCount: number | null;
}

/**
 * Decide inline vs detached for a hook invocation. Pure over git state so it
 * can be unit-tested without spawning the indexer.
 */
export function planGitHook(
  hook: GitHookName,
  gitArgs: string[],
  cwd: string,
  inlineFileLimit: number = getConfig().hooks?.inlineFileLimit ?? 200,
): GitHookPlan {
  const root = gitTopLevel(cwd) ?? resolve(cwd);
  const repoId = computeRepoId(root);
  const flags: string[] = [];

  // post-checkout <old> <new> <flag>: flag 0 = file checkout (git gives no
  // paths) → verify indexed hashes; flag 1 = branch switch / worktree add.
  if (hook === 'post-checkout' && gitArgs[2] === '0') {
    flags.push('--verify');
  }

  const dbPath = join(getIndexDir(), `${repoId}.db`);
  if (!existsSync(dbPath)) {
    // No index for this path: a fresh worktree clones from a sibling (cheap,
    // but unknown size) or needs a full index — detach either way.
    return { root, repoId, action: 'detach', reason: 'not_indexed', flags, changedCount: null };
  }

  let stored: string | null = null;
  try {
    const db = openDatabase(repoId);
    stored = getRepo(db, repoId)?.gitTreeSha ?? null;
    db.close();
  } catch {
    stored = null;
  }
  const head = gitHeadSha(root);
  if (!stored || !head || !gitCommitExists(root, stored)) {
    return { root, repoId, action: 'detach', reason: 'full_fallback_expected', flags, changedCount: null };
  }

  const committed = stored === head ? [] : gitChangedFilesBetween(root, stored, head, 5_000);
  const dirty = gitDirtyFiles(root, 5_000);
  if (committed === null || dirty === null) {
    return { root, repoId, action: 'detach', reason: 'git_count_failed', flags, changedCount: null };
  }
  const changedCount = new Set([...committed, ...dirty]).size;
  if (changedCount === 0 && flags.length === 0) {
    return { root, repoId, action: 'skip', reason: 'nothing_changed', flags, changedCount };
  }
  if (flags.includes('--verify')) {
    // Hash verification reads every indexed file — always off the git path.
    return { root, repoId, action: 'detach', reason: 'verify_requested', flags, changedCount };
  }
  if (changedCount > inlineFileLimit) {
    return { root, repoId, action: 'detach', reason: 'over_inline_limit', flags, changedCount };
  }
  return { root, repoId, action: 'inline', reason: 'within_inline_limit', flags, changedCount };
}

export interface RunGitHookOptions {
  cwd?: string;
  launch?: HookLaunch;
  /** Test seam: replaces the process spawns. */
  spawnInline?: (args: string[]) => { timedOut: boolean };
  spawnDetached?: (args: string[]) => void;
}

/**
 * Execute a hook invocation. Never throws, never exits non-zero — the shim
 * already discards our exit code, but the contract is kept here too.
 */
export function runGitHook(
  hook: string,
  gitArgs: string[],
  opts: RunGitHookOptions = {},
): GitHookPlan | null {
  if (!(GIT_HOOK_NAMES as readonly string[]).includes(hook)) return null;
  const cwd = opts.cwd ?? process.cwd();
  let plan: GitHookPlan;
  try {
    plan = planGitHook(hook as GitHookName, gitArgs, cwd);
  } catch {
    return null;
  }
  if (plan.action === 'skip') return plan;

  const launch = opts.launch ?? defaultLaunch();
  const args = [launch.cliScript, 'index-changed', '--repo', plan.root, '--job', ...plan.flags];

  const detach =
    opts.spawnDetached ??
    ((a: string[]) => {
      try {
        const child = spawn(launch.nodeBin, a, {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
      } catch {
        /* never block */
      }
    });

  if (plan.action === 'inline') {
    const inline =
      opts.spawnInline ??
      ((a: string[]) => {
        const res = spawnSync(launch.nodeBin, a, {
          stdio: 'ignore',
          timeout: INLINE_CAP_MS,
          windowsHide: true,
        });
        return { timedOut: res.error !== undefined || res.signal !== null };
      });
    let timedOut = false;
    try {
      timedOut = inline(args).timedOut;
    } catch {
      timedOut = true;
    }
    if (timedOut) {
      // The killed child never advanced the stored sha, so the detached run
      // recomputes the same delta from scratch.
      detach(args);
      return { ...plan, action: 'detach', reason: 'inline_timeout' };
    }
    return plan;
  }

  detach(args);
  return plan;
}

/** CLI entry: `purecontext-mcp git-hook <name> [git args…]`. */
export function cmdGitHook(args: string[]): void {
  try {
    runGitHook(args[0] ?? '', args.slice(1));
  } catch {
    /* never block git */
  }
}
