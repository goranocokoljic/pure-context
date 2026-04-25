import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cmdInit, cmdCheck, cmdShow } from '../../src/config/cli.js';
import * as schema from '../../src/config/config-schema.js';

// ─── cmdInit ──────────────────────────────────────────────────────────────────

describe('cmdInit', () => {
  const tmpConfigPaths: string[] = [];

  afterEach(() => {
    for (const p of tmpConfigPaths) {
      try { rmSync(p, { force: true }); } catch { /* ignore */ }
    }
    tmpConfigPaths.length = 0;
    vi.restoreAllMocks();
  });

  it('creates a config file at the expected path', () => {
    const dir = join(tmpdir(), `purecontext-init-${Date.now()}`);
    const path = join(dir, 'config.json');
    tmpConfigPaths.push(dir);

    vi.spyOn(schema, 'getConfigPath').mockReturnValue(path);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    cmdInit();

    expect(existsSync(path)).toBe(true);
  });

  it('written file is parseable JSON after stripping comments', () => {
    const dir = join(tmpdir(), `purecontext-init2-${Date.now()}`);
    const path = join(dir, 'config.json');
    tmpConfigPaths.push(dir);

    vi.spyOn(schema, 'getConfigPath').mockReturnValue(path);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    cmdInit();

    const text = require('fs').readFileSync(path, 'utf8');
    // Strip single-line comments before parsing
    const stripped = text.replace(/^\s*\/\/.*$/gm, '');
    expect(() => JSON.parse(stripped)).not.toThrow();
  });

  it('does not overwrite an existing config', () => {
    const dir = join(tmpdir(), `purecontext-init3-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'config.json');
    tmpConfigPaths.push(dir);

    writeFileSync(path, '{"fileLimit":42}', 'utf8');
    vi.spyOn(schema, 'getConfigPath').mockReturnValue(path);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    cmdInit();

    // File should still have the original content
    const content = require('fs').readFileSync(path, 'utf8');
    expect(content).toBe('{"fileLimit":42}');
  });
});

// ─── cmdCheck ─────────────────────────────────────────────────────────────────

describe('cmdCheck', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when no config file exists (defaults are valid)', () => {
    vi.spyOn(schema, 'getConfigPath').mockReturnValue('/definitely/not/a/real/path.json');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = cmdCheck();
    expect(result).toBe(true);
  });

  it('returns false when config file has invalid content', () => {
    const dir = join(tmpdir(), `purecontext-check-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ fileLimit: 'bad' }), 'utf8');

    vi.spyOn(schema, 'getConfigPath').mockReturnValue(path);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = cmdCheck();
    expect(result).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── cmdShow ──────────────────────────────────────────────────────────────────

describe('cmdShow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints valid JSON to stdout', () => {
    vi.spyOn(schema, 'getConfigPath').mockReturnValue('/no/config/here.json');
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => lines.push(s));

    cmdShow();

    const combined = lines.join('');
    expect(() => JSON.parse(combined)).not.toThrow();

    const parsed = JSON.parse(combined);
    expect(typeof parsed.fileLimit).toBe('number');
    expect(typeof parsed.indexDir).toBe('string');
  });
});
