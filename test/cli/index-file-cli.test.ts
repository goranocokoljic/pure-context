/**
 * Tests for the `index-file` CLI subcommand (Phase 80, Task 480).
 *
 * Verifies the cheap targeted re-index path the PostToolUse hook calls, plus the
 * first-edit bootstrap fallback to a full index when the repo is not yet indexed.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { cmdIndexFile } from '../../src/config/cli.js';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { computeRepoId } from '../../src/core/db/schema.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();
}, 30_000);

async function runCommand(fn: () => Promise<void>): Promise<{ stdout: string; exitCode: number }> {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  let exitCode = 0;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    exitCode = Number(code ?? 0);
    throw new Error(`process.exit(${exitCode})`);
  });
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('process.exit(')) throw err;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { stdout: lines.join('\n'), exitCode };
}

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc-index-file-cli-'));
  writeFileSync(join(dir, 'index.ts'), 'export function seed(): number { return 1; }\n');
  return resolve(dir);
}

describe('cmdIndexFile — targeted re-index', () => {
  let root: string;
  let repoId: string;

  beforeAll(async () => {
    root = makeTempProject();
    const r = await indexFolder(root, { fileLimit: 50 });
    repoId = r.repoId;
  }, 30_000);

  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(() => {
    deleteIndex(repoId);
    rmSync(root, { recursive: true, force: true });
  });

  it('re-indexes only the named file (not a full index)', async () => {
    const changed = join(root, 'feature.ts');
    writeFileSync(changed, 'export function newFeature(): string { return "x"; }\n');

    const { stdout } = await runCommand(() => cmdIndexFile(['--repo', root, changed]));
    const data = JSON.parse(stdout) as { repoId: string; filesIndexed: number; symbolsFound: number };

    expect(data.repoId).toBe(repoId);
    expect(data.filesIndexed).toBe(1); // targeted — not the whole tree
    expect(data.symbolsFound).toBeGreaterThan(0);
  });
});

describe('cmdIndexFile — first-edit bootstrap fallback', () => {
  let root: string;

  beforeAll(() => {
    root = makeTempProject();
  });

  afterEach(() => {
    deleteIndex(computeRepoId(root));
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('falls back to a full index when the repo is not indexed yet', async () => {
    // No prior indexFolder — the targeted path can't find the repo, so it bootstraps.
    const changed = join(root, 'index.ts');
    const { stdout } = await runCommand(() => cmdIndexFile(['--repo', root, changed]));
    const data = JSON.parse(stdout) as { repoId: string; symbolsFound: number };

    expect(data.repoId).toBe(computeRepoId(root));
    expect(data.symbolsFound).toBeGreaterThan(0);
  }, 30_000);
});
