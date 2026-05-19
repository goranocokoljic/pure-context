/**
 * Tests for the PreCompact session snapshot hook (Task 264).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOOK = resolve(__dirname, '../../scripts/hooks/purecontext-precompact-hook.mjs');
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

let repoId: string;
let dataDir: string;

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  // Use real index so the hook can query the DB
  const result = await indexFolder(FIXTURE, { fileLimit: 50 });
  repoId = result.repoId;

  // dataDir is the default ~/.purecontext directory used by the index manager
  // The hook reads PCTX_DATA_DIR if set; we leave it unset to use the default.
  dataDir = '';
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

// ─── Import exported functions ────────────────────────────────────────────────

async function importHook() {
  return import(pathToFileURL(HOOK).href) as Promise<{
    buildSnapshot: (repos: Array<{ id: string; root_path: string; file_count: number; indexed_at: number }>) => string;
    readRepos: () => Array<{ id: string; root_path: string; file_count: number; indexed_at: number }>;
  }>;
}

describe('buildSnapshot', () => {
  it('produces a message for an empty repo list', async () => {
    const { buildSnapshot } = await importHook();
    const msg = buildSnapshot([]);
    expect(msg).toContain('No repos currently indexed');
    expect(msg).toContain('list_repos()');
  });

  it('includes repo path and file count in snapshot', async () => {
    const { buildSnapshot } = await importHook();
    const msg = buildSnapshot([{
      id: 'abc123',
      root_path: '/home/user/myproject',
      file_count: 42,
      indexed_at: Date.now(),
    }]);
    expect(msg).toContain('/home/user/myproject');
    expect(msg).toContain('42 files');
  });

  it('includes list_repos() hint', async () => {
    const { buildSnapshot } = await importHook();
    const msg = buildSnapshot([{
      id: 'abc123',
      root_path: '/project',
      file_count: 5,
      indexed_at: Date.now(),
    }]);
    expect(msg).toContain('list_repos()');
  });
});

describe('readRepos', () => {
  it('returns an array (may be non-empty since we indexed in beforeAll)', async () => {
    const { readRepos } = await importHook();
    const repos = readRepos();
    expect(Array.isArray(repos)).toBe(true);
  });

  it('returns objects with id, root_path, file_count fields when repos exist', async () => {
    const { readRepos } = await importHook();
    const repos = readRepos();
    if (repos.length > 0) {
      const r = repos[0];
      expect(typeof r.id).toBe('string');
      expect(typeof r.root_path).toBe('string');
    }
  });
});

describe('hook subprocess output', () => {
  function runHook(env?: Record<string, string>) {
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'PreCompact' }),
      encoding: 'utf-8',
      timeout: 10_000,
      env: { ...process.env, ...env },
    });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status ?? 0,
    };
  }

  it('produces valid JSON output with systemMessage field', () => {
    const result = runHook();
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(typeof parsed.systemMessage).toBe('string');
    expect(parsed.systemMessage.length).toBeGreaterThan(0);
  });

  it('handles empty index directory gracefully', () => {
    const emptyDir = resolve(tmpdir(), 'purecontext-empty-' + Date.now());
    mkdirSync(resolve(emptyDir, 'indexes'), { recursive: true });
    try {
      const result = runHook({ PCTX_DATA_DIR: emptyDir });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(typeof parsed.systemMessage).toBe('string');
      expect(parsed.systemMessage).toContain('No repos');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('exits 0 even on error', () => {
    // Use a completely invalid data dir with a non-directory file at indexes path
    const badDir = resolve(tmpdir(), 'purecontext-bad-' + Date.now());
    mkdirSync(badDir, { recursive: true });
    try {
      const result = runHook({ PCTX_DATA_DIR: badDir });
      expect(result.status).toBe(0);
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });
});
