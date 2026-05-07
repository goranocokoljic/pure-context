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

/**
 * Run a git command in `cwd` and return its stdout.
 * Rejects with a descriptive error on non-zero exit or if git is absent.
 */
function runGit(args: string[], cwd: string): Promise<string> {
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

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new Error('git is not available on PATH. Install git and try again.'));
      } else {
        reject(new Error(`git ${args[0] ?? ''} failed: ${err.message}`));
      }
    });

    proc.on('close', (code) => {
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
