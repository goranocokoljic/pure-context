/**
 * Tests for the index_repo tool (Task 40: Remote Repository Indexing).
 *
 * git clone calls are mocked via vi.mock to avoid real network access.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ─── Mock child_process.spawn ──────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// We also need to mock the clones dir so tests don't pollute ~/.purecontext
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return {
    ...orig,
    homedir: () => process.env['PURECONTEXT_TEST_HOME'] ?? orig.homedir(),
  };
});

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpHome(): string {
  const dir = join(tmpdir(), `purecontext-repo-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a fake spawn result that simulates a successful `git clone` by
 * writing a minimal TypeScript file to targetDir (the last arg to spawn).
 */
function makeSuccessSpawn(contentFn?: (targetDir: string) => void) {
  return vi.fn().mockImplementation((_cmd: string, args: string[]) => {
    const targetDir = args[args.length - 1]!;
    mkdirSync(targetDir, { recursive: true });

    if (contentFn) {
      contentFn(targetDir);
    } else {
      // Minimal TypeScript file so indexing finds something
      mkdirSync(join(targetDir, 'src'), { recursive: true });
      writeFileSync(join(targetDir, 'src', 'index.ts'), 'export const hello = "world";');
      writeFileSync(join(targetDir, 'package.json'), '{"name":"remote-repo","version":"0.1.0"}');
    }

    const ee = new EventEmitter() as ReturnType<typeof spawn>;
    (ee as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    // Emit close on next tick
    setImmediate(() => ee.emit('close', 0));
    return ee;
  });
}

/**
 * Create a fake spawn that simulates a git clone failure.
 */
function makeFailSpawn(exitCode = 1) {
  return vi.fn().mockImplementation(() => {
    const ee = new EventEmitter() as ReturnType<typeof spawn>;
    (ee as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    setImmediate(() => ee.emit('close', exitCode));
    return ee;
  });
}

/**
 * Create a fake spawn that simulates git not being on PATH.
 */
function makeNotFoundSpawn() {
  return vi.fn().mockImplementation(() => {
    const ee = new EventEmitter() as ReturnType<typeof spawn>;
    (ee as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    setImmediate(() => ee.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
    return ee;
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let tmpHome: string;

beforeEach(() => {
  tmpHome = makeTmpHome();
  process.env['PURECONTEXT_TEST_HOME'] = tmpHome;
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env['PURECONTEXT_TEST_HOME'];
  if (tmpHome && existsSync(tmpHome)) {
    rmSync(tmpHome, { recursive: true });
  }
});

describe('index_repo — URL validation', () => {
  it('rejects non-http/git@ URLs', async () => {
    // Dynamic import so the mock is applied
    const { handler } = await import('../../src/server/tools/index-repo.js');
    const result = await handler({ url: 'ftp://example.com/repo.git' });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toMatch(/Invalid URL scheme/);
  });

  it('rejects file:// URLs', async () => {
    const { handler } = await import('../../src/server/tools/index-repo.js');
    const result = await handler({ url: 'file:///local/path' });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toMatch(/Invalid URL scheme/);
  });

  it('accepts https:// URLs', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementation(makeSuccessSpawn());
    const { handler } = await import('../../src/server/tools/index-repo.js');
    const result = await handler({ url: 'https://github.com/example/repo.git', fileLimit: 100 });
    // Should not be a URL validation error
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error ?? '').not.toMatch(/Invalid URL scheme/);
  });

  it('accepts git@ URLs', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementation(makeSuccessSpawn());
    const { handler } = await import('../../src/server/tools/index-repo.js');
    const result = await handler({ url: 'git@github.com:example/repo.git', fileLimit: 100 });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error ?? '').not.toMatch(/Invalid URL scheme/);
  });
});

describe('index_repo — git clone errors', () => {
  it('returns error when git clone exits with non-zero code', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementation(makeFailSpawn(128));
    const { handler } = await import('../../src/server/tools/index-repo.js');
    const result = await handler({ url: 'https://github.com/example/repo.git' });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toMatch(/git clone exited with code 128/);
  });

  it('returns error when git is not on PATH', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementation(makeNotFoundSpawn());
    const { handler } = await import('../../src/server/tools/index-repo.js');
    const result = await handler({ url: 'https://github.com/example/repo.git' });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toMatch(/git is not available/i);
  });
});

describe('index_repo — successful indexing', () => {
  it('returns repoId, filesIndexed, symbolsFound on success', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementation(makeSuccessSpawn());
    const { handler } = await import('../../src/server/tools/index-repo.js');
    const result = await handler({
      url: 'https://github.com/example/repo.git',
      fileLimit: 100,
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.repoId).toBeDefined();
    expect(typeof body.filesIndexed).toBe('number');
    expect(typeof body.symbolsFound).toBe('number');
    expect(body.cloneDir).toBeDefined();
  });

  it('includes cloneDir in response', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementation(makeSuccessSpawn());
    const { handler } = await import('../../src/server/tools/index-repo.js');
    const result = await handler({ url: 'https://github.com/example/repo.git', fileLimit: 100 });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.cloneDir).toContain('clones');
  });

  it('passes branch argument to git clone when provided', async () => {
    const spawnMock = makeSuccessSpawn();
    (spawn as ReturnType<typeof vi.fn>).mockImplementation(spawnMock);
    const { handler } = await import('../../src/server/tools/index-repo.js');
    await handler({ url: 'https://github.com/example/repo.git', branch: 'develop', fileLimit: 100 });
    const spawnArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]];
    expect(spawnArgs[1]).toContain('--branch');
    expect(spawnArgs[1]).toContain('develop');
  });

  it('does not include token in spawn args directly (injected into URL)', async () => {
    const spawnMock = makeSuccessSpawn();
    (spawn as ReturnType<typeof vi.fn>).mockImplementation(spawnMock);
    const { handler } = await import('../../src/server/tools/index-repo.js');
    await handler({
      url: 'https://github.com/example/repo.git',
      token: 'mysecrettoken',
      fileLimit: 100,
    });
    const spawnArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]];
    // Token should be in the URL arg, not as a separate flag
    const urlArg = spawnArgs[1].find((a) => a.includes('mysecrettoken'));
    expect(urlArg).toBeDefined();
    expect(urlArg).not.toBe('mysecrettoken'); // embedded in URL, not standalone
  });

  it('reuses existing clone directory without calling git clone again', async () => {
    const spawnMock = makeSuccessSpawn();
    (spawn as ReturnType<typeof vi.fn>).mockImplementation(spawnMock);
    const { handler } = await import('../../src/server/tools/index-repo.js');

    // First call — clone happens
    await handler({ url: 'https://github.com/example/repo.git', fileLimit: 100 });
    expect((spawn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    // Second call — same URL, clone dir already exists
    vi.clearAllMocks();
    await handler({ url: 'https://github.com/example/repo.git', fileLimit: 100 });
    // spawn should NOT have been called again
    expect((spawn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
