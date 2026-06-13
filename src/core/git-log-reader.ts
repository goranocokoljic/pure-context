/**
 * git-log-reader.ts
 *
 * Reads per-file commit history and repo-level metadata from a local git
 * repository using `git log`. Results feed the git_metadata table and the
 * last_commit_* columns on the files table.
 *
 * All functions fail gracefully (return null / throw with a clear message)
 * when the directory is not a git repo or git is not on PATH.
 */

import { spawn } from 'node:child_process';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CommitRecord {
  sha: string;
  authorName: string;
  authorEmail: string;
  date: number;       // Unix timestamp (seconds)
  message: string;    // First line (subject) only
}

export interface FileGitMeta {
  lastCommit: CommitRecord;
  commitCount: number;       // Capped at 500 — "500+" means more exist
  history: CommitRecord[];   // Last N commits (up to `limit`, default 10)
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const GIT_TIMEOUT_MS = 15_000;

/**
 * Run a git command in `cwd` and return its stdout.
 * Rejects with a descriptive error on non-zero exit or if git is absent.
 * Times out after GIT_TIMEOUT_MS to prevent hangs on large repos.
 */
function runGit(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      reject(new Error('git is not available on PATH. Install git and try again.'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch { /* ignore */ }
      reject(new Error(`git ${args[0] ?? ''} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error('git is not available on PATH. Install git and try again.'));
      } else {
        reject(new Error(`git ${args[0] ?? ''} failed: ${err.message}`));
      }
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `git ${args[0] ?? ''} exited with code ${code}: ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

/**
 * Parse `git log --format="%H|%an|%ae|%at|%s"` output into CommitRecord[].
 * Fields are separated by `|`; the message (subject) may itself contain `|`
 * so we only split on the first four delimiters.
 */
function parseGitLog(output: string): CommitRecord[] {
  const records: CommitRecord[] = [];

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Split into at most 5 parts so a `|` inside the message is preserved.
    const idx1 = trimmed.indexOf('|');
    const idx2 = trimmed.indexOf('|', idx1 + 1);
    const idx3 = trimmed.indexOf('|', idx2 + 1);
    const idx4 = trimmed.indexOf('|', idx3 + 1);

    if (idx1 < 0 || idx2 < 0 || idx3 < 0 || idx4 < 0) continue;

    const sha = trimmed.slice(0, idx1).trim();
    const authorName = trimmed.slice(idx1 + 1, idx2).trim();
    const authorEmail = trimmed.slice(idx2 + 1, idx3).trim();
    const dateStr = trimmed.slice(idx3 + 1, idx4).trim();
    const message = trimmed.slice(idx4 + 1).trim();

    const date = parseInt(dateStr, 10);
    if (!sha || isNaN(date)) continue;

    records.push({ sha, authorName, authorEmail, date, message });
  }

  return records;
}

export interface SymbolHistoryResult {
  /** Commits touching the symbol's line range, newest first (up to `limit`). */
  history: CommitRecord[];
  /** Oldest commit that introduced the lines — may be outside the `limit` window. */
  firstSeen: CommitRecord | null;
  /** Total commits touching the range, capped at 200. */
  totalCount: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if `dir` is inside a git repository (i.e. `git rev-parse
 * --git-dir` succeeds). Never throws — errors are silently treated as false.
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--git-dir'], dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the git commit history for a single file.
 *
 * @param repoRoot  Absolute path to the git working tree root.
 * @param filePath  Path to the file, relative to `repoRoot`.
 * @param limit     Maximum number of commits to return (default 10).
 * @returns         `FileGitMeta` or `null` if the file has no history or
 *                  the directory is not a git repo.
 */
export async function readFileHistory(
  repoRoot: string,
  filePath: string,
  limit = 10,
): Promise<FileGitMeta | null> {
  // Fetch last `limit` commits touching this file, following renames.
  let logOutput: string;
  try {
    logOutput = await runGit(
      [
        'log',
        '--follow',
        '--format=%H|%an|%ae|%at|%s',
        `-n`, String(limit),
        '--',
        filePath,
      ],
      repoRoot,
    );
  } catch {
    return null;
  }

  const history = parseGitLog(logOutput);
  if (history.length === 0) {
    return null;
  }

  // Count total commits touching this file (capped at 501 for display).
  // Using --oneline is cheaper than --format for a pure count.
  const COUNT_CAP = 501;
  let commitCount = 0;
  try {
    const countOutput = await runGit(
      ['log', '--follow', '--oneline', `-n`, String(COUNT_CAP), '--', filePath],
      repoRoot,
    );
    commitCount = countOutput.split('\n').filter((l) => l.trim()).length;
  } catch {
    // Fall back to the number of commits we already fetched.
    commitCount = history.length;
  }

  return {
    lastCommit: history[0],
    commitCount,
    history,
  };
}

/**
 * Read the git commit history for a symbol's line range within a file.
 *
 * Uses `git log -L<startLine>,<endLine>:<filePath>` which tracks changes to
 * those specific lines even when the function body moves within the file.
 *
 * @param repoRoot   Absolute path to the git working tree root.
 * @param filePath   Path to the file, relative to `repoRoot`.
 * @param startLine  1-based start line of the symbol.
 * @param endLine    1-based end line of the symbol.
 * @param limit      Max commits to return in `history` (default 10, max 50).
 * @returns          `SymbolHistoryResult` or `null` if the directory is not a
 *                   git repo or the file has no history.
 */
export async function readSymbolHistory(
  repoRoot: string,
  filePath: string,
  startLine: number,
  endLine: number,
  limit = 10,
): Promise<SymbolHistoryResult | null> {
  // Git expects forward slashes even on Windows.
  const normalizedPath = filePath.replace(/\\/g, '/');
  const lineRange = `${startLine},${endLine}:${normalizedPath}`;

  const baseArgs = ['log', `-L${lineRange}`, '--format=%H|%an|%ae|%at|%s'];

  // ── Main history (newest first) ──────────────────────────────────────────
  let logOutput: string;
  try {
    logOutput = await runGit([...baseArgs, '-n', String(limit)], repoRoot);
  } catch {
    return null;
  }

  const history = parseGitLog(logOutput);
  if (history.length === 0) {
    return { history: [], firstSeen: null, totalCount: 0 };
  }

  // ── Total commit count (capped at 200) ────────────────────────────────────
  const COUNT_CAP = 200;
  let totalCount = history.length;
  try {
    const countOutput = await runGit(
      ['log', `-L${lineRange}`, '--format=%H', '-n', String(COUNT_CAP)],
      repoRoot,
    );
    const shaCount = countOutput
      .split('\n')
      .filter((l) => /^[0-9a-f]{40}$/.test(l.trim())).length;
    if (shaCount > 0) totalCount = shaCount;
  } catch {
    // Fall back to the number of commits we already fetched.
  }

  // ── firstSeen: oldest commit touching this line range ────────────────────
  let firstSeen: CommitRecord | null = null;
  try {
    const firstOutput = await runGit(
      [...baseArgs, '--reverse', '-n', '1'],
      repoRoot,
    );
    const firstRecords = parseGitLog(firstOutput);
    firstSeen = firstRecords[0] ?? null;
  } catch {
    // Best-effort: use the last entry in our limited history window.
    firstSeen = history[history.length - 1] ?? null;
  }

  return { history, firstSeen, totalCount };
}

/**
 * Read repository-level metadata: current branch, HEAD SHA, and remote URL.
 *
 * @param repoRoot  Absolute path to the git working tree root.
 * @throws          If git is not available or `repoRoot` is not a git repo.
 */
export async function readRepoMeta(repoRoot: string): Promise<{
  defaultBranch: string;
  headSha: string;
  remoteUrl?: string;
}> {
  const [headSha, branch] = await Promise.all([
    runGit(['rev-parse', 'HEAD'], repoRoot).then((o) => o.trim()),
    runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).then((o) => o.trim()),
  ]);

  let remoteUrl: string | undefined;
  try {
    remoteUrl = (await runGit(['remote', 'get-url', 'origin'], repoRoot)).trim();
  } catch {
    // No remote configured — not an error.
  }

  return { defaultBranch: branch, headSha, remoteUrl };
}

// ─── Repo-level commit→files capture (co-change foundation) ────────────────────

/** One commit and the files it touched — the unit of temporal-coupling analysis. */
export interface RepoCommit {
  sha: string;
  date: number;        // Unix timestamp (seconds)
  files: string[];     // Repo-relative paths touched by this commit
}

/** Sentinel prefix that marks a commit-header line in the --name-only stream. */
const COMMIT_MARKER = '@@PCXCOMMIT@@';

/** Larger timeout for the single repo-wide log — output can be sizeable. */
const REPO_LOG_TIMEOUT_MS = 30_000;

/**
 * Parse the output of `git log --name-only --format=<marker>%H|%at`.
 *
 * The stream alternates between a marker line (`<marker><sha>|<unixDate>`) and
 * the list of files touched by that commit, separated by blank lines. Any line
 * that is not a marker and not blank is treated as a file path for the current
 * commit.
 */
export function parseRepoCommitFiles(output: string): RepoCommit[] {
  const commits: RepoCommit[] = [];
  let current: RepoCommit | null = null;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith(COMMIT_MARKER)) {
      const header = line.slice(COMMIT_MARKER.length);
      const bar = header.indexOf('|');
      if (bar < 0) { current = null; continue; }
      const sha = header.slice(0, bar).trim();
      const date = parseInt(header.slice(bar + 1).trim(), 10);
      if (!sha || isNaN(date)) { current = null; continue; }
      current = { sha, date, files: [] };
      commits.push(current);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || !current) continue;
    // Normalise to forward slashes for cross-platform stability.
    current.files.push(trimmed.replace(/\\/g, '/'));
  }

  // Drop commits that touched no files (e.g. empty commits).
  return commits.filter((c) => c.files.length > 0);
}

/**
 * Read the last `maxCommits` commits at the repo root, each with the full list
 * of files it touched.
 *
 * This is a SINGLE `git log` invocation (unlike the per-file `readFileHistory`),
 * so it is far cheaper and far deeper for co-change analysis. Merge commits are
 * excluded (`--no-merges`) to avoid mega-merge noise. Returns `null` when the
 * directory is not a git repo or git is unavailable.
 *
 * @param repoRoot   Absolute path to the git working tree root.
 * @param maxCommits Maximum number of commits to read (default 500).
 */
export async function readRepoCommitFiles(
  repoRoot: string,
  maxCommits = 500,
): Promise<RepoCommit[] | null> {
  let logOutput: string;
  try {
    logOutput = await runGit(
      [
        'log',
        '--no-merges',
        '--name-only',
        `--format=${COMMIT_MARKER}%H|%at`,
        '-n', String(maxCommits),
      ],
      repoRoot,
      REPO_LOG_TIMEOUT_MS,
    );
  } catch {
    return null;
  }

  return parseRepoCommitFiles(logOutput);
}
