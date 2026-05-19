/**
 * Tests for the Edit Guard PreToolUse hook (Task 265).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOOK = resolve(__dirname, '../../scripts/hooks/purecontext-edit-guard.mjs');

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

async function importHook() {
  return import(pathToFileURL(HOOK).href) as Promise<{
    shouldWarn: (toolName: string) => boolean;
    buildWarning: (filePath: string) => string;
  }>;
}

describe('shouldWarn', () => {
  it('returns true for Edit', async () => {
    const { shouldWarn } = await importHook();
    expect(shouldWarn('Edit')).toBe(true);
  });

  it('returns true for Write', async () => {
    const { shouldWarn } = await importHook();
    expect(shouldWarn('Write')).toBe(true);
  });

  it('returns true for MultiEdit', async () => {
    const { shouldWarn } = await importHook();
    expect(shouldWarn('MultiEdit')).toBe(true);
  });

  it('returns false for Read', async () => {
    const { shouldWarn } = await importHook();
    expect(shouldWarn('Read')).toBe(false);
  });

  it('returns false for Bash', async () => {
    const { shouldWarn } = await importHook();
    expect(shouldWarn('Bash')).toBe(false);
  });
});

describe('buildWarning', () => {
  it('includes the file path in the warning', async () => {
    const { buildWarning } = await importHook();
    const msg = buildWarning('/src/utils.ts');
    expect(msg).toContain('/src/utils.ts');
  });

  it('mentions get_symbol_source', async () => {
    const { buildWarning } = await importHook();
    expect(buildWarning('/foo.ts')).toContain('get_symbol_source');
  });

  it('mentions get_blast_radius', async () => {
    const { buildWarning } = await importHook();
    expect(buildWarning('/foo.ts')).toContain('get_blast_radius');
  });

  it('mentions find_references', async () => {
    const { buildWarning } = await importHook();
    expect(buildWarning('/foo.ts')).toContain('find_references');
  });

  it('works with empty file path', async () => {
    const { buildWarning } = await importHook();
    const msg = buildWarning('');
    expect(msg).toContain('PureContext: before editing');
  });
});

describe('hook subprocess', () => {
  it('writes warning to stderr for Edit tool', () => {
    const result = runHook(JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: '/src/auth.ts' },
    }));
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('PureContext');
    expect(result.stderr).toContain('get_symbol_source');
  });

  it('writes warning to stderr for MultiEdit tool', () => {
    const result = runHook(JSON.stringify({
      tool_name: 'MultiEdit',
      tool_input: { edits: [{ file_path: '/src/foo.ts' }] },
    }));
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('PureContext');
  });

  it('is silent when PURECONTEXT_ALLOW_RAW_WRITE=1', () => {
    const result = runHook(
      JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/src/foo.ts' } }),
      { PURECONTEXT_ALLOW_RAW_WRITE: '1' },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('exits 0 and is silent for non-Edit tools', () => {
    const result = runHook(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/src/foo.ts' } }));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('always exits 0', () => {
    const result = runHook('bad json here');
    expect(result.status).toBe(0);
  });
});
