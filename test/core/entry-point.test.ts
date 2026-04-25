import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENTRY = resolve(__dirname, '../../dist/index.js');

function run(args: string): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(`node "${ENTRY}" ${args}`, {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      code: e.status ?? 1,
    };
  }
}

describe('entry point CLI', () => {
  it('--version prints version and exits 0', () => {
    const { stdout, code } = run('--version');
    expect(code).toBe(0);
    expect(stdout).toMatch(/purecontext-mcp v\d+\.\d+\.\d+/);
  });

  it('-v is alias for --version', () => {
    const { stdout, code } = run('-v');
    expect(code).toBe(0);
    expect(stdout).toContain('purecontext-mcp');
  });

  it('--help prints usage and exits 0', () => {
    const { stdout, code } = run('--help');
    expect(code).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('purecontext-mcp config');
  });

  it('-h is alias for --help', () => {
    const { code } = run('-h');
    expect(code).toBe(0);
  });

  it('config prints JSON to stdout and exits 0', () => {
    const { stdout, code } = run('config');
    expect(code).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
    const cfg = JSON.parse(stdout);
    expect(typeof cfg.fileLimit).toBe('number');
    expect(typeof cfg.indexDir).toBe('string');
  });

  it('config --check exits 0 when prerequisites are met', () => {
    const { code } = run('config --check');
    expect(code).toBe(0);
  });

  it('unknown command exits 1', () => {
    const { code, stderr } = run('unknown-command');
    expect(code).toBe(1);
    expect(stderr).toContain('Unknown command');
  });
});
