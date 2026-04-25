import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, reloadConfig } from '../../src/config/config-loader.js';
import { DEFAULT_CONFIG } from '../../src/config/config-schema.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempConfig(content: string): string {
  const dir = join(tmpdir(), `purecontext-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.json');
  writeFileSync(path, content, 'utf8');
  return path;
}

afterEach(() => {
  reloadConfig(); // clear singleton between tests
});

// ─── Default fallbacks ────────────────────────────────────────────────────────

describe('loadConfig — defaults', () => {
  it('returns defaults when no config file exists', () => {
    const cfg = loadConfig('/nonexistent/path/config.json');
    expect(cfg.fileLimit).toBe(DEFAULT_CONFIG.fileLimit);
    expect(cfg.watchDebounceMs).toBe(DEFAULT_CONFIG.watchDebounceMs);
    expect(cfg.adapters).toBe('auto');
    expect(cfg.ai.provider).toBe('none');
    expect(cfg.ai.allowRemoteAI).toBe(false);
  });

  it('returns defaults when config file contains invalid JSON', () => {
    const path = makeTempConfig('{ not valid json }');
    const cfg = loadConfig(path);
    expect(cfg.fileLimit).toBe(DEFAULT_CONFIG.fileLimit);
  });

  it('returns defaults when config fails validation', () => {
    const path = makeTempConfig(JSON.stringify({ fileLimit: 'not-a-number' }));
    const cfg = loadConfig(path);
    expect(cfg.fileLimit).toBe(DEFAULT_CONFIG.fileLimit);
  });
});

// ─── Merging ──────────────────────────────────────────────────────────────────

describe('loadConfig — merging', () => {
  it('overrides fileLimit from config file', () => {
    const path = makeTempConfig(JSON.stringify({ fileLimit: 500 }));
    const cfg = loadConfig(path);
    expect(cfg.fileLimit).toBe(500);
  });

  it('overrides watchDebounceMs', () => {
    const path = makeTempConfig(JSON.stringify({ watchDebounceMs: 5000 }));
    const cfg = loadConfig(path);
    expect(cfg.watchDebounceMs).toBe(5000);
  });

  it('overrides indexDir', () => {
    const path = makeTempConfig(JSON.stringify({ indexDir: '/custom/dir' }));
    const cfg = loadConfig(path);
    expect(cfg.indexDir).toBe('/custom/dir');
  });

  it('overrides excludePatterns', () => {
    const path = makeTempConfig(JSON.stringify({ excludePatterns: ['**/*.gen.ts'] }));
    const cfg = loadConfig(path);
    expect(cfg.excludePatterns).toEqual(['**/*.gen.ts']);
  });

  it('overrides adapters with explicit list', () => {
    const path = makeTempConfig(JSON.stringify({ adapters: ['vue'] }));
    const cfg = loadConfig(path);
    expect(cfg.adapters).toEqual(['vue']);
  });

  it('overrides adapters to "none"', () => {
    const path = makeTempConfig(JSON.stringify({ adapters: 'none' }));
    const cfg = loadConfig(path);
    expect(cfg.adapters).toBe('none');
  });

  it('overrides ai.provider', () => {
    const path = makeTempConfig(JSON.stringify({ ai: { provider: 'anthropic' } }));
    const cfg = loadConfig(path);
    expect(cfg.ai.provider).toBe('anthropic');
    // Unspecified sub-fields fall back to defaults
    expect(cfg.ai.allowRemoteAI).toBe(false);
  });

  it('overrides ai.allowRemoteAI', () => {
    const path = makeTempConfig(JSON.stringify({ ai: { allowRemoteAI: true } }));
    const cfg = loadConfig(path);
    expect(cfg.ai.allowRemoteAI).toBe(true);
    expect(cfg.ai.provider).toBe('none');
  });

  it('keeps defaults for unspecified fields', () => {
    const path = makeTempConfig(JSON.stringify({ fileLimit: 200 }));
    const cfg = loadConfig(path);
    // Only fileLimit was overridden; everything else stays default
    expect(cfg.watchDebounceMs).toBe(DEFAULT_CONFIG.watchDebounceMs);
    expect(cfg.adapters).toBe('auto');
    expect(cfg.excludePatterns).toEqual([]);
  });

  it('handles JSON with comments (strip-safe — currently passes if valid JSON)', () => {
    // Pure JSON without comments should always work
    const path = makeTempConfig(JSON.stringify({ fileLimit: 99 }));
    expect(loadConfig(path).fileLimit).toBe(99);
  });
});
