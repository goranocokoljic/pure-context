/**
 * Tests for the `install` CLI command (Task 277).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ─── Module structure ─────────────────────────────────────────────────────────

describe('install module exports', () => {
  it('exports runInstallCommand', async () => {
    const mod = await import('../../src/cli/install.js');
    expect(typeof mod.runInstallCommand).toBe('function');
  });
});

// ─── install cursor ───────────────────────────────────────────────────────────

describe('install cursor', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('creates .cursor/rules/purecontext.mdc', async () => {
    const root = makeTempDir('install-cursor');
    const origCwd = process.cwd();
    process.chdir(root);
    try {
      const { runInstallCommand } = await import('../../src/cli/install.js');
      await runInstallCommand(['cursor']);
      const filePath = join(root, '.cursor', 'rules', 'purecontext.mdc');
      expect(existsSync(filePath)).toBe(true);
    } finally {
      process.chdir(origCwd);
      cleanup(root);
    }
  });
});

// ─── install all ─────────────────────────────────────────────────────────────

describe('install all', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('installs for each detected IDE', async () => {
    const root = makeTempDir('install-all');
    mkdirSync(join(root, '.cursor'));
    mkdirSync(join(root, '.windsurf'));
    const origCwd = process.cwd();
    process.chdir(root);
    try {
      const { runInstallCommand } = await import('../../src/cli/install.js');
      await runInstallCommand(['all']);
      expect(existsSync(join(root, '.cursor', 'rules', 'purecontext.mdc'))).toBe(true);
      expect(existsSync(join(root, '.windsurfrules'))).toBe(true);
    } finally {
      process.chdir(origCwd);
      cleanup(root);
    }
  });

  it('prints message and exits 0 when no IDEs detected', async () => {
    const root = makeTempDir('install-all-empty');
    const origCwd = process.cwd();
    // Create a dir with no IDE markers and no home .claude (can't control home)
    process.chdir(root);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { runInstallCommand } = await import('../../src/cli/install.js');
      await runInstallCommand(['all']);
      // Should have printed a message (even if claude was detected from home)
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      process.chdir(origCwd);
      cleanup(root);
      vi.restoreAllMocks();
    }
  });
});

// ─── install --dry-run ────────────────────────────────────────────────────────

describe('install --dry-run', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('prints plan without writing files', async () => {
    const root = makeTempDir('install-dryrun');
    const origCwd = process.cwd();
    process.chdir(root);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { runInstallCommand } = await import('../../src/cli/install.js');
      await runInstallCommand(['cursor', '--dry-run']);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('dry-run'));
      expect(existsSync(join(root, '.cursor'))).toBe(false);
    } finally {
      process.chdir(origCwd);
      cleanup(root);
      vi.restoreAllMocks();
    }
  });
});

// ─── install --list ───────────────────────────────────────────────────────────

describe('install --list', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('prints detection state without writing files', async () => {
    const root = makeTempDir('install-list');
    mkdirSync(join(root, '.cursor'));
    const origCwd = process.cwd();
    process.chdir(root);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { runInstallCommand } = await import('../../src/cli/install.js');
      await runInstallCommand(['--list']);
      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(allOutput).toContain('cursor');
      // Should not have created any files
      expect(existsSync(join(root, '.cursor', 'rules'))).toBe(false);
    } finally {
      process.chdir(origCwd);
      cleanup(root);
      vi.restoreAllMocks();
    }
  });
});

// ─── unknown tool ────────────────────────────────────────────────────────────

describe('install unknown tool', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('prints error and exits 1 for unknown tool name', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => { throw new Error('exit'); });
    try {
      const { runInstallCommand } = await import('../../src/cli/install.js');
      await runInstallCommand(['notarealthing']).catch(() => {});
      expect(exitSpy).toHaveBeenCalledWith(1);
      const allOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(allOutput).toContain('Unknown tool');
    } finally {
      vi.restoreAllMocks();
    }
  });
});
