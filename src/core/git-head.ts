/**
 * Synchronous, time-bounded git helpers for index freshness (Phase 97).
 *
 * Everything here is cheap plumbing over `git` invocations that finish in
 * milliseconds on real repositories: HEAD lookup, tree diffs between two
 * commits, worktree enumeration, hook-directory resolution. All calls are
 * bounded (`GIT_TIMEOUT_MS`) and fail SOFT — a missing git binary, a non-git
 * directory or a timeout yields `null` / `[]`, never a throw — because every
 * consumer (list_repos drift line, hooks, the changed-only re-index) must
 * degrade to "no freshness info" rather than break indexing.
 *
 * Sync on purpose: `list_repos` and the hook entry points are synchronous and
 * a spawn-per-repo of `git rev-parse` is well under the budget.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Hard cap per git invocation. Drift lookups must never stall a tool call. */
export const GIT_TIMEOUT_MS = 2_000;

/** The all-zero sha git passes as "old" for a brand-new worktree/branch. */
const NULL_SHA_RE = /^0{40}$/;

export function isNullSha(sha: string | null | undefined): boolean {
  return !sha || NULL_SHA_RE.test(sha);
}

/**
 * Run `git <args>` in `cwd`. Returns trimmed stdout on exit 0, else null.
 * Never throws.
 */
export function runGitSync(
  args: string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): string | null {
  try {
    const res = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (res.error || res.status !== 0) return null;
    return (res.stdout ?? '').replace(/\r?\n$/, '');
  } catch {
    return null;
  }
}

/** True when `dir` is inside a git work tree (any worktree, main or linked). */
export function isGitWorkTree(dir: string): boolean {
  return runGitSync(['rev-parse', '--is-inside-work-tree'], dir) === 'true';
}

/** Current HEAD commit sha, or null (not git / unborn branch / timeout). */
export function gitHeadSha(dir: string): string | null {
  const out = runGitSync(['rev-parse', 'HEAD'], dir);
  return out && /^[0-9a-f]{40}$/.test(out) ? out : null;
}

/** Whether `sha` names a commit object the repo still holds. */
export function gitCommitExists(dir: string, sha: string): boolean {
  if (isNullSha(sha)) return false;
  return runGitSync(['cat-file', '-e', `${sha}^{commit}`], dir) !== null;
}

/** Whether `ancestor` is reachable from `descendant` (`merge-base --is-ancestor`). */
export function gitIsAncestor(dir: string, ancestor: string, descendant: string): boolean {
  if (isNullSha(ancestor) || isNullSha(descendant)) return false;
  return runGitSync(['merge-base', '--is-ancestor', ancestor, descendant], dir) !== null;
}

/**
 * Commits reachable from `to` but not from `from` (`rev-list --count from..to`).
 * Null when either side is unknown.
 */
export function gitRevListCount(dir: string, from: string, to: string): number | null {
  if (isNullSha(from) || isNullSha(to)) return null;
  const out = runGitSync(['rev-list', '--count', `${from}..${to}`], dir);
  if (out === null) return null;
  const n = Number(out);
  return Number.isFinite(n) ? n : null;
}

/**
 * Repo-relative paths (forward slashes) whose content differs between the
 * two commit TREES — renames reported as delete + add (`--no-renames`) so the
 * old path can be pruned and the new path indexed. Null on failure.
 *
 * A tree diff needs no ancestry between the shas: it stays valid after a
 * rebase or force-push as long as `from` is still an object in the repo.
 */
export function gitChangedFilesBetween(
  dir: string,
  from: string,
  to: string,
  timeoutMs = 30_000,
): string[] | null {
  if (isNullSha(from) || isNullSha(to)) return null;
  const out = runGitSync(
    ['diff', '--name-only', '--no-renames', '--diff-filter=ACMD', '-z', from, to],
    dir,
    timeoutMs,
  );
  if (out === null) return null;
  return splitZ(out);
}

/**
 * Working-tree paths that differ from HEAD: staged, unstaged, untracked
 * (ignored files excluded, as git does by default). Deleted files are
 * included — the caller checks disk existence to route them. Null on failure.
 */
export function gitDirtyFiles(dir: string, timeoutMs = 30_000): string[] | null {
  const out = runGitSync(
    ['status', '--porcelain', '--untracked-files=all', '--no-renames', '-z'],
    dir,
    timeoutMs,
  );
  if (out === null) return null;
  const paths: string[] = [];
  for (const entry of splitZ(out)) {
    // Porcelain v1 -z: "XY <path>" — two status chars, a space, the path.
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
  }
  return paths;
}

/** Count of dirty entries, bounded; null when unknown. */
export function gitDirtyCount(dir: string, timeoutMs = GIT_TIMEOUT_MS): number | null {
  const files = gitDirtyFiles(dir, timeoutMs);
  return files === null ? null : files.length;
}

// ─── Worktrees ───────────────────────────────────────────────────────────────

/** Absolute path of the repository's common git dir, or null. */
export function gitCommonDir(dir: string): string | null {
  const out = runGitSync(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir);
  return out ? resolve(out) : null;
}

/** Absolute path of this worktree's own git dir (`.git` or `.git/worktrees/<n>`). */
export function gitDir(dir: string): string | null {
  const out = runGitSync(['rev-parse', '--path-format=absolute', '--git-dir'], dir);
  return out ? resolve(out) : null;
}

/**
 * True when `dir` is a LINKED worktree (created with `git worktree add`) —
 * its git dir differs from the repository's common dir.
 */
export function isLinkedWorktree(dir: string): boolean {
  const own = gitDir(dir);
  const common = gitCommonDir(dir);
  if (!own || !common) return false;
  return own.toLowerCase() !== common.toLowerCase();
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  /** First entry of `git worktree list` — the main worktree. */
  isMain: boolean;
}

/** All worktrees of the repository containing `dir`, main worktree first. */
export function gitWorktreeList(dir: string): WorktreeEntry[] {
  const out = runGitSync(['worktree', 'list', '--porcelain'], dir);
  if (out === null) return [];
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = {
        path: resolve(line.slice('worktree '.length)),
        head: null,
        branch: null,
        isMain: entries.length === 0,
      };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice(5);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice(7);
    }
  }
  if (current) entries.push(current);
  return entries;
}

// ─── Hooks directory ─────────────────────────────────────────────────────────

/**
 * Directory git will run hooks from for the repository containing `dir`:
 * `core.hooksPath` when set (husky / lefthook repos), else the common dir's
 * `hooks/` — which, for a linked worktree, is the MAIN repository's hook dir,
 * so one install covers every worktree. Null when not a git repo.
 */
export function gitHooksDir(dir: string): string | null {
  const configured = runGitSync(['config', '--get', 'core.hooksPath'], dir);
  if (configured) {
    let p = configured;
    if (p.startsWith('~/') || p === '~') p = join(homedir(), p.slice(1));
    if (!isAbsolute(p)) {
      // Relative hooksPath is relative to the worktree root (git semantics).
      const top = runGitSync(['rev-parse', '--show-toplevel'], dir);
      p = resolve(top ?? dir, p);
    }
    return resolve(p);
  }
  const common = gitCommonDir(dir);
  return common ? join(common, 'hooks') : null;
}

/** Top-level directory of the worktree containing `dir`, or null. */
export function gitTopLevel(dir: string): string | null {
  const out = runGitSync(['rev-parse', '--show-toplevel'], dir);
  return out ? resolve(out) : null;
}

// ─── Drift ───────────────────────────────────────────────────────────────────

export interface HeadDrift {
  /** Commit the index was last brought up to (null on pre-1.30 indexes). */
  indexedSha: string | null;
  /** Current HEAD of the working tree (null when not git). */
  currentSha: string | null;
  /** Commits in HEAD not covered by the index; null when unknown. */
  behindBy: number | null;
  /** Working-tree entries that differ from HEAD (staged/unstaged/untracked). */
  dirtyFiles: number | null;
  /** A detached re-index is running for this repo (job marker + live pid). */
  inProgress: boolean;
  /** One-word verdict for humans and hook lines. */
  status: 'fresh' | 'behind' | 'dirty' | 'unknown' | 'in_progress';
}

export interface HeadDriftOptions {
  /** Skip the `git status` walk (hooks on huge trees). Default false. */
  skipDirty?: boolean;
  /** Job marker directory (Task 600 detach). */
  jobsDir?: string;
  repoId?: string;
}

/**
 * Compare the stored index sha with the working tree. Cheap: `rev-parse`,
 * `rev-list --count`, and (unless skipped) one `git status`. Never throws.
 */
export function readHeadDrift(
  rootPath: string,
  indexedSha: string | null,
  opts: HeadDriftOptions = {},
): HeadDrift | null {
  if (!existsSync(rootPath)) return null;
  const currentSha = gitHeadSha(rootPath);
  if (!currentSha) return null;

  const inProgress =
    opts.jobsDir && opts.repoId ? isJobInProgress(opts.jobsDir, opts.repoId) : false;

  let behindBy: number | null = null;
  if (indexedSha) {
    behindBy =
      indexedSha === currentSha ? 0 : gitRevListCount(rootPath, indexedSha, currentSha);
    // Unreachable old sha (rebase / force-push): rev-list still counts what
    // HEAD has beyond it; a null here means the object is gone entirely.
  }

  const dirtyFiles = opts.skipDirty ? null : gitDirtyCount(rootPath);

  let status: HeadDrift['status'];
  if (inProgress) status = 'in_progress';
  else if (!indexedSha || behindBy === null) status = 'unknown';
  else if (behindBy > 0 || indexedSha !== currentSha) status = 'behind';
  else if (dirtyFiles !== null && dirtyFiles > 0) status = 'dirty';
  else status = 'fresh';

  return { indexedSha, currentSha, behindBy, dirtyFiles, inProgress, status };
}

/** One human line for hook injections and CLI output. */
export function formatDriftLine(d: HeadDrift | null): string {
  if (!d) return 'freshness unknown (not a git checkout)';
  switch (d.status) {
    case 'in_progress':
      return 're-index in progress';
    case 'fresh':
      return 'fresh (index matches HEAD)';
    case 'dirty':
      return `fresh at HEAD, ${d.dirtyFiles} uncommitted change(s) — index_file covers edits`;
    case 'behind': {
      const n = d.behindBy;
      const commits = n === null ? 'commits' : `${n} commit(s)`;
      return `${commits} behind HEAD — run index_folder({ onlyChanged: true })`;
    }
    default:
      return 'freshness unknown (index predates 1.30.0 — run index_folder once)';
  }
}

// ─── Job markers (Task 600 detached re-index) ────────────────────────────────

export interface JobMarker {
  repoId: string;
  rootPath: string;
  pid: number;
  startedAt: number;
  mode: string;
}

/** Markers older than this are ignored even when the pid check cannot run. */
const JOB_MARKER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function jobMarkerPath(jobsDir: string, repoId: string): string {
  return join(jobsDir, `${repoId}.json`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours; ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Write the marker for this process. Never throws. */
export function writeJobMarker(jobsDir: string, marker: Omit<JobMarker, 'pid' | 'startedAt'>): void {
  try {
    mkdirSync(jobsDir, { recursive: true });
    const full: JobMarker = { ...marker, pid: process.pid, startedAt: Date.now() };
    writeFileSync(jobMarkerPath(jobsDir, marker.repoId), JSON.stringify(full));
  } catch {
    /* marker is advisory */
  }
}

/** Remove this repo's marker (only if it belongs to this pid, unless force). */
export function clearJobMarker(jobsDir: string, repoId: string, force = false): void {
  const p = jobMarkerPath(jobsDir, repoId);
  try {
    if (!existsSync(p)) return;
    if (!force) {
      const marker = JSON.parse(readFileSync(p, 'utf8')) as Partial<JobMarker>;
      if (marker.pid !== process.pid) return;
    }
    unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/** A marker exists, is recent, and its pid is still alive. */
export function isJobInProgress(jobsDir: string, repoId: string): boolean {
  const p = jobMarkerPath(jobsDir, repoId);
  if (!existsSync(p)) return false;
  try {
    const marker = JSON.parse(readFileSync(p, 'utf8')) as Partial<JobMarker>;
    const age = Date.now() - (marker.startedAt ?? statSync(p).mtimeMs);
    if (age > JOB_MARKER_MAX_AGE_MS) return false;
    return typeof marker.pid === 'number' && pidAlive(marker.pid);
  } catch {
    return false;
  }
}

// ─── Internals ───────────────────────────────────────────────────────────────

function splitZ(out: string): string[] {
  return out
    .split('\0')
    .map((s) => s.replace(/\r$/, ''))
    .filter((s) => s.length > 0);
}
