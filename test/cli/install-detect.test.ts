/**
 * Tests for detectInstalledIDEs (Task 275).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { detectInstalledIDEs, getClaudeDesktopConfigPath } from '../../src/cli/install-detect.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── detectInstalledIDEs ──────────────────────────────────────────────────────

describe('detectInstalledIDEs', () => {
  afterEach(() => {});

  it('returns empty array when no IDE directories are present', async () => {
    const root = makeTempDir('detect-empty');
    try {
      // Only check project-scoped signals; home .claude may exist on the test machine
      const result = await detectInstalledIDEs(root);
      // Remove 'claude' (may be detected from home dir) and 'claude-desktop' (platform config)
      const projectOnly = result.filter((t) => t !== 'claude' && t !== 'claude-desktop');
      expect(projectOnly).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects cursor when .cursor/ directory exists', async () => {
    const root = makeTempDir('detect-cursor');
    mkdirSync(join(root, '.cursor'));
    try {
      const result = await detectInstalledIDEs(root);
      expect(result).toContain('cursor');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects windsurf when .windsurf/ directory exists', async () => {
    const root = makeTempDir('detect-windsurf');
    mkdirSync(join(root, '.windsurf'));
    try {
      const result = await detectInstalledIDEs(root);
      expect(result).toContain('windsurf');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects continue when .continue/ directory exists', async () => {
    const root = makeTempDir('detect-continue');
    mkdirSync(join(root, '.continue'));
    try {
      const result = await detectInstalledIDEs(root);
      expect(result).toContain('continue');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects cline and copilot independently when .vscode/ exists', async () => {
    const root = makeTempDir('detect-copilot');
    mkdirSync(join(root, '.vscode'));
    try {
      const result = await detectInstalledIDEs(root);
      expect(result).toContain('cline');
      expect(result).toContain('copilot');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects roo-code when .roo/ directory exists', async () => {
    const root = makeTempDir('detect-roo');
    mkdirSync(join(root, '.roo'));
    try {
      const result = await detectInstalledIDEs(root);
      expect(result).toContain('roo-code');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects claude from project .claude/ directory', async () => {
    const root = makeTempDir('detect-claude-proj');
    mkdirSync(join(root, '.claude'));
    try {
      const result = await detectInstalledIDEs(root);
      expect(result).toContain('claude');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects claude from home dir even if project has no .claude/', async () => {
    // The home dir .claude/ should already exist on the test machine
    // (CI may not have it — skip if absent)
    const homeClaudeExists = require('fs').existsSync(join(homedir(), '.claude'));
    if (!homeClaudeExists) return;

    const root = makeTempDir('detect-claude-home');
    try {
      const result = await detectInstalledIDEs(root);
      expect(result).toContain('claude');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects multiple IDEs simultaneously', async () => {
    const root = makeTempDir('detect-multi');
    mkdirSync(join(root, '.cursor'));
    mkdirSync(join(root, '.windsurf'));
    mkdirSync(join(root, '.vscode'));
    try {
      const result = await detectInstalledIDEs(root);
      expect(result).toContain('cursor');
      expect(result).toContain('windsurf');
      expect(result).toContain('cline');
      expect(result).toContain('copilot');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── getClaudeDesktopConfigPath ───────────────────────────────────────────────

describe('getClaudeDesktopConfigPath', () => {
  it('returns a non-null path on the current platform', () => {
    const result = getClaudeDesktopConfigPath();
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
  });

  it('path ends with claude_desktop_config.json', () => {
    const result = getClaudeDesktopConfigPath();
    expect(result).toMatch(/claude_desktop_config\.json$/i);
  });
});
