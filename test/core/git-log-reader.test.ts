/**
 * Tests for src/core/git-log-reader.ts
 *
 * Strategy: mock `node:child_process` so tests never need a real git
 * installation or a real repository.  Each test controls exactly what
 * stdout/stderr the fake subprocess emits and what exit code it returns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock child_process before importing the module under test ────────────────
// `mockSpawn` must be created with vi.hoisted() so it is initialised before
// the vi.mock() factory runs (vi.mock calls are hoisted to the top of the file).

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

// Import AFTER mocking so the module picks up the mock.
import {
  isGitRepo,
  readFileHistory,
  readRepoMeta,
  parseRepoCommitFiles,
  parseRepoFileHistories,
  readRepoFileHistories,
  type CommitRecord,
} from '../../src/core/git-log-reader.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface FakeProcessOptions {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** If true, emit an 'error' event instead of a 'close' event. */
  spawnError?: boolean;
  spawnErrorCode?: string;
}

/**
 * Build a fake EventEmitter-based child process that drives mockSpawn.
 */
function makeFakeProcess(opts: FakeProcessOptions = {}) {
  const { stdout = '', stderr = '', exitCode = 0, spawnError = false, spawnErrorCode } = opts;

  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  const makeStream = (data: string) => ({
    on: (event: string, cb: (chunk: Buffer) => void) => {
      if (event === 'data') {
        // Emit asynchronously so the caller has time to attach listeners.
        Promise.resolve().then(() => cb(Buffer.from(data)));
      }
    },
  });

  const proc = {
    stdout: makeStream(stdout),
    stderr: makeStream(stderr),
    on: (event: string, cb: (...args: unknown[]) => void) => {
      handlers[event] = handlers[event] ?? [];
      handlers[event].push(cb);
      if (event === 'error' && spawnError) {
        const err = Object.assign(new Error('spawn failed'), { code: spawnErrorCode ?? 'ENOENT' });
        Promise.resolve().then(() => cb(err));
      } else if (event === 'close' && !spawnError) {
        Promise.resolve().then(() => cb(exitCode));
      }
    },
    kill: vi.fn(),
  };

  return proc;
}

/**
 * Format a git log line in the `%H|%an|%ae|%at|%s` format.
 */
function formatLogLine(c: CommitRecord): string {
  return `${c.sha}|${c.authorName}|${c.authorEmail}|${c.date}|${c.message}`;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── isGitRepo ─────────────────────────────────────────────────────────────────

describe('isGitRepo', () => {
  it('returns true when git rev-parse --git-dir succeeds', async () => {
    mockSpawn.mockReturnValueOnce(makeFakeProcess({ stdout: '.git\n' }));
    expect(await isGitRepo('/some/repo')).toBe(true);
  });

  it('returns false when git exits non-zero (not a git dir)', async () => {
    mockSpawn.mockReturnValueOnce(
      makeFakeProcess({ exitCode: 128, stderr: 'fatal: not a git repository' }),
    );
    expect(await isGitRepo('/not/a/repo')).toBe(false);
  });

  it('returns false when git is not on PATH (ENOENT spawn error)', async () => {
    mockSpawn.mockReturnValueOnce(makeFakeProcess({ spawnError: true, spawnErrorCode: 'ENOENT' }));
    expect(await isGitRepo('/any/dir')).toBe(false);
  });
});

// ── readFileHistory ───────────────────────────────────────────────────────────

describe('readFileHistory', () => {
  it('parses git log output correctly — all fields', async () => {
    const commit: CommitRecord = {
      sha: 'abc123def456abc123def456abc123def456abc1',
      authorName: 'Alice Smith',
      authorEmail: 'alice@example.com',
      date: 1_700_000_000,
      message: 'feat: add awesome feature',
    };

    const logLine = formatLogLine(commit);
    // First call: git log (history)
    mockSpawn.mockReturnValueOnce(makeFakeProcess({ stdout: logLine + '\n' }));
    // Second call: git log --oneline (commit count)
    mockSpawn.mockReturnValueOnce(makeFakeProcess({ stdout: 'abc123d feat: add awesome feature\n' }));

    const result = await readFileHistory('/repo', 'src/foo.ts');

    expect(result).not.toBeNull();
    expect(result!.history).toHaveLength(1);
    expect(result!.lastCommit).toMatchObject({
      sha: commit.sha,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      date: commit.date,
      message: commit.message,
    });
    expect(result!.commitCount).toBe(1);
  });

  it('handles a message that contains | characters', async () => {
    const logLine = 'deadbeef|Jane|jane@x.com|1699000000|fix: handle a|b splits';
    mockSpawn.mockReturnValueOnce(makeFakeProcess({ stdout: logLine + '\n' }));
    mockSpawn.mockReturnValueOnce(makeFakeProcess({ stdout: 'deadbeef fix: handle a|b splits\n' }));

    const result = await readFileHistory('/repo', 'src/bar.ts');

    expect(result).not.toBeNull();
    expect(result!.lastCommit.message).toBe('fix: handle a|b splits');
  });

  it('returns null for a file with no git history', async () => {
    // git log returns empty output (file never committed)
    mockSpawn.mockReturnValueOnce(makeFakeProcess({ stdout: '' }));
    // count call — we still make it even though history is empty, but the
    // null return happens before the second call is needed.
    // (In practice the implementation short-circuits — no second spawn call.)

    const result = await readFileHistory('/repo', 'src/never-committed.ts');
    expect(result).toBeNull();
  });

  it('returns null when the directory is not a git repo', async () => {
    mockSpawn.mockReturnValueOnce(
      makeFakeProcess({ exitCode: 128, stderr: 'fatal: not a git repository' }),
    );
    const result = await readFileHistory('/not-a-repo', 'file.ts');
    expect(result).toBeNull();
  });

  it('commitCount accurate for a file with fewer than 10 commits', async () => {
    const commits = Array.from({ length: 3 }, (_, i) => ({
      sha: `sha${i}${'0'.repeat(35 - String(i).length)}`,
      authorName: 'Dev',
      authorEmail: 'dev@x.com',
      date: 1_700_000_000 - i * 86400,
      message: `commit ${i}`,
    }));

    const logOutput = commits.map(formatLogLine).join('\n') + '\n';
    const onelineOutput = commits.map((c) => `${c.sha.slice(0, 7)} ${c.message}`).join('\n') + '\n';

    mockSpawn.mockReturnValueOnce(makeFakeProcess({ stdout: logOutput }));
    mockSpawn.mockReturnValueOnce(makeFakeProcess({ stdout: onelineOutput }));

    const result = await readFileHistory('/repo', 'src/small.ts', 10);

    expect(result).not.toBeNull();
    expect(result!.history).toHaveLength(3);
    expect(result!.commitCount).toBe(3);
  });

  it('uses the provided limit argument', async () => {
    const commit: CommitRecord = {
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      authorName: 'Bob',
      authorEmail: 'bob@x.com',
      date: 1_699_000_000,
      message: 'chore: update deps',
    };

    mockSpawn.mockReturnValueOnce(makeFakeProcess({ stdout: formatLogLine(commit) + '\n' }));
    mockSpawn.mockReturnValueOnce(makeFakeProcess({ stdout: `aaaaaaa chore: update deps\n` }));

    await readFileHistory('/repo', 'package.json', 5);

    // Verify that the spawn call included the correct -n argument.
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const nIdx = spawnArgs.indexOf('-n');
    expect(nIdx).toBeGreaterThan(-1);
    expect(spawnArgs[nIdx + 1]).toBe('5');
  });
});

// ── readRepoMeta ─────────────────────────────────────────────────────────────

describe('readRepoMeta', () => {
  it('returns defaultBranch, headSha, and remoteUrl', async () => {
    const headSha = 'cafebabe00000000000000000000000000000000';

    // rev-parse HEAD
    mockSpawn.mockReturnValueOnce(makeFakeProcess({ stdout: headSha + '\n' }));
    // rev-parse --abbrev-ref HEAD
    mockSpawn.mockReturnValueOnce(makeFakeProcess({ stdout: 'main\n' }));
    // remote get-url origin
    mockSpawn.mockReturnValueOnce(makeFakeProcess({ stdout: 'https://github.com/org/repo.git\n' }));

    const meta = await readRepoMeta('/repo');

    expect(meta.headSha).toBe(headSha);
    expect(meta.defaultBranch).toBe('main');
    expect(meta.remoteUrl).toBe('https://github.com/org/repo.git');
  });

  it('returns remoteUrl as undefined when no remote is configured', async () => {
    const headSha = 'deadbeef00000000000000000000000000000000';

    mockSpawn.mockReturnValueOnce(makeFakeProcess({ stdout: headSha + '\n' }));
    mockSpawn.mockReturnValueOnce(makeFakeProcess({ stdout: 'feature/x\n' }));
    // remote get-url fails (no remote)
    mockSpawn.mockReturnValueOnce(makeFakeProcess({ exitCode: 2, stderr: 'error: No such remote' }));

    const meta = await readRepoMeta('/repo');

    expect(meta.defaultBranch).toBe('feature/x');
    expect(meta.headSha).toBe(headSha);
    expect(meta.remoteUrl).toBeUndefined();
  });

  it('throws when git is not available', async () => {
    mockSpawn.mockReturnValue(makeFakeProcess({ spawnError: true, spawnErrorCode: 'ENOENT' }));

    await expect(readRepoMeta('/repo')).rejects.toThrow(/git is not available/i);
  });
});

describe('parseRepoCommitFiles', () => {
  const M = '@@PCXCOMMIT@@';

  it('parses commits and their touched files', () => {
    const out = [
      `${M}abc123|1700000000`,
      '',
      'src/a.ts',
      'src/b.ts',
      '',
      `${M}def456|1699990000`,
      '',
      'src/c.ts',
      '',
    ].join('\n');

    const commits = parseRepoCommitFiles(out);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({ sha: 'abc123', date: 1700000000, files: ['src/a.ts', 'src/b.ts'] });
    expect(commits[1]).toEqual({ sha: 'def456', date: 1699990000, files: ['src/c.ts'] });
  });

  it('normalizes backslashes and drops file-less commits', () => {
    const out = [
      `${M}aaa|1`,
      'src\\win\\path.ts',
      `${M}bbb|2`, // commit with no files — dropped
    ].join('\n');

    const commits = parseRepoCommitFiles(out);
    expect(commits).toHaveLength(1);
    expect(commits[0].files).toEqual(['src/win/path.ts']);
  });

  it('returns empty array for empty output', () => {
    expect(parseRepoCommitFiles('')).toEqual([]);
  });
});

describe('parseRepoFileHistories', () => {
  const M = '@@PCXCOMMIT@@';

  // Build a single-pass `git log --name-only --format=<M>%H|%an|%ae|%at|%s` stream.
  function stream(
    commits: Array<{ c: CommitRecord; files: string[] }>,
  ): string {
    const lines: string[] = [];
    for (const { c, files } of commits) {
      lines.push(`${M}${c.sha}|${c.authorName}|${c.authorEmail}|${c.date}|${c.message}`);
      lines.push('');
      lines.push(...files);
      lines.push('');
    }
    return lines.join('\n');
  }

  const mk = (sha: string, date: number, message = 'msg'): CommitRecord => ({
    sha,
    authorName: 'Ada',
    authorEmail: 'ada@x.com',
    date,
    message,
  });

  it('aggregates each file across commits, newest-first', () => {
    // Commits arrive newest-first (as git log emits them).
    const out = stream([
      { c: mk('c3', 3003), files: ['src/a.ts', 'src/b.ts'] },
      { c: mk('c2', 2002), files: ['src/a.ts'] },
      { c: mk('c1', 1001), files: ['src/a.ts', 'src/c.ts'] },
    ]);

    const map = parseRepoFileHistories(out);

    const a = map.get('src/a.ts')!;
    expect(a.commitCount).toBe(3);
    expect(a.history.map((h) => h.sha)).toEqual(['c3', 'c2', 'c1']);
    expect(a.lastCommit.sha).toBe('c3'); // newest

    expect(map.get('src/b.ts')!.commitCount).toBe(1);
    expect(map.get('src/c.ts')!.commitCount).toBe(1);
  });

  it('caps history length at the historyLimit but keeps the full count', () => {
    const commits = Array.from({ length: 25 }, (_, i) =>
      ({ c: mk(`s${25 - i}`, 5000 - i), files: ['src/hot.ts'] }),
    );
    const map = parseRepoFileHistories(stream(commits), 10);

    const hot = map.get('src/hot.ts')!;
    expect(hot.history).toHaveLength(10);          // limited
    expect(hot.history[0].sha).toBe('s25');        // newest kept
    expect(hot.commitCount).toBe(25);              // full count preserved
  });

  it('caps reported commitCount at 501 ("500+")', () => {
    const commits = Array.from({ length: 600 }, (_, i) =>
      ({ c: mk(`x${i}`, 9000 - i), files: ['src/churny.ts'] }),
    );
    const map = parseRepoFileHistories(stream(commits), 10);
    expect(map.get('src/churny.ts')!.commitCount).toBe(501);
  });

  it('normalizes backslashes in paths', () => {
    const out = stream([{ c: mk('w1', 100), files: ['src\\win\\path.ts'] }]);
    const map = parseRepoFileHistories(out);
    expect(map.has('src/win/path.ts')).toBe(true);
  });

  it('returns an empty map for empty output', () => {
    expect(parseRepoFileHistories('').size).toBe(0);
  });
});

describe('readRepoFileHistories', () => {
  const M = '@@PCXCOMMIT@@';

  it('captures all files in a SINGLE git spawn', async () => {
    const out = [
      `${M}abc|Ada|ada@x.com|3003|feat: x`,
      '',
      'src/a.ts',
      'src/b.ts',
      '',
    ].join('\n');

    mockSpawn.mockReturnValueOnce(makeFakeProcess({ stdout: out }));

    const map = await readRepoFileHistories('/repo');

    expect(mockSpawn).toHaveBeenCalledTimes(1); // the whole point: one spawn
    expect(map).not.toBeNull();
    expect(map!.get('src/a.ts')!.lastCommit.sha).toBe('abc');
    expect(map!.get('src/b.ts')!.commitCount).toBe(1);
  });

  it('omits -n for full history (maxCommits=0 default)', async () => {
    mockSpawn.mockReturnValueOnce(makeFakeProcess({ stdout: '' }));
    await readRepoFileHistories('/repo');
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--name-only');
    expect(args.indexOf('-n')).toBe(-1);
  });

  it('passes -n when a positive maxCommits is given', async () => {
    mockSpawn.mockReturnValueOnce(makeFakeProcess({ stdout: '' }));
    await readRepoFileHistories('/repo', { maxCommits: 500 });
    const args = mockSpawn.mock.calls[0][1] as string[];
    const nIdx = args.indexOf('-n');
    expect(nIdx).toBeGreaterThan(-1);
    expect(args[nIdx + 1]).toBe('500');
  });

  it('returns null when git fails', async () => {
    mockSpawn.mockReturnValueOnce(makeFakeProcess({ exitCode: 128, stderr: 'fatal' }));
    expect(await readRepoFileHistories('/repo')).toBeNull();
  });
});
