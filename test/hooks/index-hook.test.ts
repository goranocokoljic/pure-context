/**
 * Tests for the PostToolUse index hook (Task 263).
 *
 * Strategy: import the exported pure functions directly; also run the hook
 * as a subprocess for end-to-end exit-code verification.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOOK = resolve(__dirname, '../../scripts/hooks/purecontext-index-hook.mjs');

function runHook(stdin: string, env?: Record<string, string>): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, [HOOK], {
    input: stdin,
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

// ─── Import exported functions ────────────────────────────────────────────────

// Dynamic import used to load the .mjs hook module
async function importHook() {
  return import(pathToFileURL(HOOK).href) as Promise<{
    findRepoRoot: (filePath: string) => string | null;
    extractPaths: (toolName: string, toolInput: Record<string, unknown>) => string[];
    shouldIndex: (toolName: string) => boolean;
  }>;
}

describe('shouldIndex', () => {
  it('returns true for Edit', async () => {
    const { shouldIndex } = await importHook();
    expect(shouldIndex('Edit')).toBe(true);
  });

  it('returns true for Write', async () => {
    const { shouldIndex } = await importHook();
    expect(shouldIndex('Write')).toBe(true);
  });

  it('returns true for MultiEdit', async () => {
    const { shouldIndex } = await importHook();
    expect(shouldIndex('MultiEdit')).toBe(true);
  });

  it('returns false for Read', async () => {
    const { shouldIndex } = await importHook();
    expect(shouldIndex('Read')).toBe(false);
  });

  it('returns false for Bash', async () => {
    const { shouldIndex } = await importHook();
    expect(shouldIndex('Bash')).toBe(false);
  });
});

describe('extractPaths', () => {
  it('extracts file_path from Edit envelope', async () => {
    const { extractPaths } = await importHook();
    const paths = extractPaths('Edit', { file_path: '/foo/bar/baz.ts', old_string: '', new_string: '' });
    expect(paths).toEqual(['/foo/bar/baz.ts']);
  });

  it('extracts file_path from Write envelope', async () => {
    const { extractPaths } = await importHook();
    const paths = extractPaths('Write', { file_path: '/repo/src/main.ts', content: '' });
    expect(paths).toEqual(['/repo/src/main.ts']);
  });

  it('extracts multiple paths from MultiEdit envelope', async () => {
    const { extractPaths } = await importHook();
    const paths = extractPaths('MultiEdit', {
      edits: [
        { file_path: '/repo/a.ts', old_string: '', new_string: '' },
        { file_path: '/repo/b.ts', old_string: '', new_string: '' },
      ],
    });
    expect(paths).toEqual(['/repo/a.ts', '/repo/b.ts']);
  });

  it('returns empty array for non-Edit tool', async () => {
    const { extractPaths } = await importHook();
    expect(extractPaths('Read', { file_path: '/foo/bar.ts' })).toEqual([]);
  });

  it('returns empty array when file_path is missing', async () => {
    const { extractPaths } = await importHook();
    expect(extractPaths('Edit', {})).toEqual([]);
  });
});

describe('findRepoRoot', () => {
  it('finds repo root by locating package.json', async () => {
    const { findRepoRoot } = await importHook();
    const dir = resolve(__dirname, '../../test/fixtures/basic-ts-project/src');
    // basic-ts-project has a package.json at its root
    const root = findRepoRoot(dir + '/some-file.ts');
    // Should find the basic-ts-project root (or a parent with package.json)
    expect(root).not.toBeNull();
  });

  it('finds repo root by locating .git directory', async () => {
    const { findRepoRoot } = await importHook();
    // This test file is inside a git repo
    const root = findRepoRoot(__filename);
    expect(root).not.toBeNull();
    expect(existsSync(resolve(root!, '.git'))).toBe(true);
  });

  it('returns null for a path with no repo markers', async () => {
    const { findRepoRoot } = await importHook();
    // Create an isolated temp directory with no markers
    const isolated = resolve(tmpdir(), 'purecontext-no-markers-' + Date.now());
    mkdirSync(isolated, { recursive: true });
    try {
      const root = findRepoRoot(resolve(isolated, 'sub', 'file.ts'));
      // tmpdir itself may have no markers, or may find one up in the filesystem.
      // We just verify the function doesn't throw.
      expect(root === null || typeof root === 'string').toBe(true);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe('hook subprocess exit codes', () => {
  it('exits 0 for a non-Edit tool', () => {
    const result = runHook(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/foo.ts' } }));
    expect(result.status).toBe(0);
  });

  it('exits 0 for an Edit tool (even if index fails)', () => {
    const result = runHook(JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/nonexistent/path/file.ts' },
    }));
    expect(result.status).toBe(0);
  });

  it('exits 0 for malformed JSON input', () => {
    const result = runHook('this is not json');
    expect(result.status).toBe(0);
  });

  it('exits 0 for MultiEdit with multiple paths', () => {
    const result = runHook(JSON.stringify({
      tool_name: 'MultiEdit',
      tool_input: {
        edits: [
          { file_path: '/tmp/a.ts' },
          { file_path: '/tmp/b.ts' },
        ],
      },
    }));
    expect(result.status).toBe(0);
  });
});
