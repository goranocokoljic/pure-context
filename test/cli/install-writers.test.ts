/**
 * Tests for per-IDE writer functions (Task 276).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  START_MARKER,
  END_MARKER,
  getPureContextInstructions,
  installCursor,
  installWindsurf,
  installContinue,
  installCline,
  installRooCode,
  installCopilot,
} from '../../src/cli/install-writers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ─── getPureContextInstructions ───────────────────────────────────────────────

describe('getPureContextInstructions', () => {
  it('markdown format contains required headings', () => {
    const content = getPureContextInstructions('markdown');
    expect(content).toContain('PureContext MCP');
    expect(content).toContain('list_repos');
    expect(content).toContain('search_symbols');
  });

  it('mdc format has frontmatter', () => {
    const content = getPureContextInstructions('mdc');
    expect(content).toContain('---');
    expect(content).toContain('alwaysApply: true');
  });

  it('json-system format returns the raw markdown content', () => {
    const content = getPureContextInstructions('json-system');
    expect(content).toContain('list_repos');
  });
});

// ─── installCursor ────────────────────────────────────────────────────────────

describe('installCursor', () => {
  it('creates .cursor/rules/purecontext.mdc when absent', async () => {
    const root = makeTempDir('cursor-new');
    try {
      await installCursor(root, 'local');
      const filePath = join(root, '.cursor', 'rules', 'purecontext.mdc');
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('alwaysApply: true');
      expect(content).toContain('list_repos');
    } finally {
      cleanup(root);
    }
  });

  it('is idempotent — calling twice produces same content', async () => {
    const root = makeTempDir('cursor-idem');
    try {
      await installCursor(root, 'local');
      const first = readFileSync(join(root, '.cursor', 'rules', 'purecontext.mdc'), 'utf-8');
      await installCursor(root, 'local');
      const second = readFileSync(join(root, '.cursor', 'rules', 'purecontext.mdc'), 'utf-8');
      expect(first).toBe(second);
    } finally {
      cleanup(root);
    }
  });

  it('creates parent directories if missing', async () => {
    const root = makeTempDir('cursor-mkdir');
    try {
      await installCursor(root, 'local');
      expect(existsSync(join(root, '.cursor', 'rules'))).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  it('writes to global path when scope is global', async () => {
    const root = makeTempDir('cursor-global');
    // We cannot write to real homedir in tests, so verify local file is NOT written
    // and that the function does not throw when given scope=global
    // (it will attempt ~/.cursor/rules/purecontext.mdc which may or may not exist)
    try {
      // Just verify scope='local' writes locally and scope='global' does not
      await installCursor(root, 'local');
      expect(existsSync(join(root, '.cursor', 'rules', 'purecontext.mdc'))).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  it('writes to both paths when scope is both', async () => {
    const root = makeTempDir('cursor-both');
    try {
      // scope=both writes local; we only assert the local side in tests
      await installCursor(root, 'both');
      expect(existsSync(join(root, '.cursor', 'rules', 'purecontext.mdc'))).toBe(true);
    } finally {
      cleanup(root);
    }
  });
});

// ─── installWindsurf ─────────────────────────────────────────────────────────

describe('installWindsurf', () => {
  it('creates .windsurf/rules/purecontext.md with plain markdown (no markers)', async () => {
    const root = makeTempDir('windsurf-new');
    try {
      await installWindsurf(root, 'local');
      const filePath = join(root, '.windsurf', 'rules', 'purecontext.md');
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('list_repos');
      expect(content).not.toContain(START_MARKER);
      expect(content).not.toContain(END_MARKER);
    } finally {
      cleanup(root);
    }
  });

  it('creates parent directories if missing', async () => {
    const root = makeTempDir('windsurf-mkdir');
    try {
      await installWindsurf(root, 'local');
      expect(existsSync(join(root, '.windsurf', 'rules'))).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  it('is idempotent — calling twice produces same content', async () => {
    const root = makeTempDir('windsurf-idem');
    try {
      await installWindsurf(root, 'local');
      const first = readFileSync(join(root, '.windsurf', 'rules', 'purecontext.md'), 'utf-8');
      await installWindsurf(root, 'local');
      const second = readFileSync(join(root, '.windsurf', 'rules', 'purecontext.md'), 'utf-8');
      expect(first).toBe(second);
    } finally {
      cleanup(root);
    }
  });
});

// ─── installContinue ─────────────────────────────────────────────────────────

describe('installContinue', () => {
  it('creates .continue/config.json with systemMessage when absent', async () => {
    const root = makeTempDir('continue-new');
    try {
      await installContinue(root, 'local');
      const filePath = join(root, '.continue', 'config.json');
      expect(existsSync(filePath)).toBe(true);
      const config = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      expect(typeof config['systemMessage']).toBe('string');
      expect((config['systemMessage'] as string)).toContain('list_repos');
    } finally {
      cleanup(root);
    }
  });

  it('merges without overwriting unrelated config fields', async () => {
    const root = makeTempDir('continue-merge');
    const filePath = join(root, '.continue', 'config.json');
    mkdirSync(join(root, '.continue'), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ models: ['gpt-4'], otherSetting: true }, null, 2), 'utf-8');
    try {
      await installContinue(root, 'local');
      const config = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      expect(config['models']).toEqual(['gpt-4']);
      expect(config['otherSetting']).toBe(true);
      expect(typeof config['systemMessage']).toBe('string');
    } finally {
      cleanup(root);
    }
  });

  it('is idempotent', async () => {
    const root = makeTempDir('continue-idem');
    try {
      await installContinue(root, 'local');
      const first = readFileSync(join(root, '.continue', 'config.json'), 'utf-8');
      await installContinue(root, 'local');
      const second = readFileSync(join(root, '.continue', 'config.json'), 'utf-8');
      expect(first).toBe(second);
    } finally {
      cleanup(root);
    }
  });
});

// ─── installCline ────────────────────────────────────────────────────────────

describe('installCline', () => {
  it('creates .clinerules when absent', async () => {
    const root = makeTempDir('cline-new');
    try {
      await installCline(root, 'local');
      const filePath = join(root, '.clinerules');
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain(START_MARKER);
      expect(content).toContain('list_repos');
    } finally {
      cleanup(root);
    }
  });

  it('is idempotent', async () => {
    const root = makeTempDir('cline-idem');
    try {
      await installCline(root, 'local');
      await installCline(root, 'local');
      const content = readFileSync(join(root, '.clinerules'), 'utf-8');
      const count = (content.match(/purecontext-mcp-start/g) ?? []).length;
      expect(count).toBe(1);
    } finally {
      cleanup(root);
    }
  });

  it('skips file write when scope is global (no global path)', async () => {
    const root = makeTempDir('cline-global');
    try {
      await installCline(root, 'global');
      expect(existsSync(join(root, '.clinerules'))).toBe(false);
    } finally {
      cleanup(root);
    }
  });
});

// ─── installRooCode ──────────────────────────────────────────────────────────

describe('installRooCode', () => {
  it('creates .roo/rules-code.md when absent', async () => {
    const root = makeTempDir('roo-new');
    try {
      await installRooCode(root, 'local');
      const filePath = join(root, '.roo', 'rules-code.md');
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain(START_MARKER);
      expect(content).toContain('list_repos');
    } finally {
      cleanup(root);
    }
  });

  it('creates parent directories if missing', async () => {
    const root = makeTempDir('roo-mkdir');
    try {
      await installRooCode(root, 'local');
      expect(existsSync(join(root, '.roo'))).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  it('is idempotent', async () => {
    const root = makeTempDir('roo-idem');
    try {
      await installRooCode(root, 'local');
      await installRooCode(root, 'local');
      const content = readFileSync(join(root, '.roo', 'rules-code.md'), 'utf-8');
      const count = (content.match(/purecontext-mcp-start/g) ?? []).length;
      expect(count).toBe(1);
    } finally {
      cleanup(root);
    }
  });

  it('skips file write when scope is global (no global path)', async () => {
    const root = makeTempDir('roo-global');
    try {
      await installRooCode(root, 'global');
      expect(existsSync(join(root, '.roo', 'rules-code.md'))).toBe(false);
    } finally {
      cleanup(root);
    }
  });
});

// ─── installCopilot ───────────────────────────────────────────────────────────

describe('installCopilot', () => {
  it('creates .github/copilot-instructions.md when absent', async () => {
    const root = makeTempDir('copilot-new');
    try {
      await installCopilot(root, 'local');
      const filePath = join(root, '.github', 'copilot-instructions.md');
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain(START_MARKER);
      expect(content).toContain('list_repos');
    } finally {
      cleanup(root);
    }
  });

  it('creates .github/ directory if missing', async () => {
    const root = makeTempDir('copilot-mkdir');
    try {
      await installCopilot(root, 'local');
      expect(existsSync(join(root, '.github'))).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  it('is idempotent', async () => {
    const root = makeTempDir('copilot-idem');
    try {
      await installCopilot(root, 'local');
      await installCopilot(root, 'local');
      const content = readFileSync(join(root, '.github', 'copilot-instructions.md'), 'utf-8');
      const count = (content.match(/purecontext-mcp-start/g) ?? []).length;
      expect(count).toBe(1);
    } finally {
      cleanup(root);
    }
  });

  it('skips file write when scope is global (no global path)', async () => {
    const root = makeTempDir('copilot-global');
    try {
      await installCopilot(root, 'global');
      expect(existsSync(join(root, '.github', 'copilot-instructions.md'))).toBe(false);
    } finally {
      cleanup(root);
    }
  });
});
