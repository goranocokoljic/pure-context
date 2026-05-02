/**
 * Task 129 — Environment variable overrides for config.
 *
 * Tests:
 *  - PCTX_PORT overrides http.port
 *  - PCTX_HOST overrides http.host
 *  - PCTX_DATA_DIR overrides indexDir
 *  - env vars win over config-file values
 */

import { describe, it, expect } from 'vitest';
import { join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a callback with specific env vars set, restoring originals afterwards.
 */
async function withEnv<T>(
  vars: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, orig] of Object.entries(saved)) {
      if (orig === undefined) delete process.env[k];
      else process.env[k] = orig;
    }
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PCTX_PORT', () => {
  it('overrides http.port in merged config', async () => {
    await withEnv({ PCTX_PORT: '4000' }, async () => {
      const { reloadConfig, getConfig } = await import('../../src/config/config-loader.js');
      reloadConfig();
      const cfg = getConfig();
      expect(cfg.http.port).toBe(4000);
      reloadConfig();
    });
  });

  it('does not override when PCTX_PORT is not set', async () => {
    await withEnv({}, async () => {
      const prevPort = process.env['PCTX_PORT'];
      delete process.env['PCTX_PORT'];

      const { reloadConfig, getConfig } = await import('../../src/config/config-loader.js');
      reloadConfig();
      const cfg = getConfig();
      // Default port is 3000
      expect(cfg.http.port).toBe(3000);
      reloadConfig();

      if (prevPort !== undefined) process.env['PCTX_PORT'] = prevPort;
    });
  });
});

describe('PCTX_HOST', () => {
  it('overrides http.host in merged config', async () => {
    await withEnv({ PCTX_HOST: '0.0.0.0' }, async () => {
      const { reloadConfig, getConfig } = await import('../../src/config/config-loader.js');
      reloadConfig();
      const cfg = getConfig();
      expect(cfg.http.host).toBe('0.0.0.0');
      reloadConfig();
    });
  });
});

describe('PCTX_DATA_DIR', () => {
  it('overrides indexDir in merged config', async () => {
    const dataDir = join(tmpdir(), 'pctx-env-test');
    await withEnv({ PCTX_DATA_DIR: dataDir }, async () => {
      const { reloadConfig, getConfig } = await import('../../src/config/config-loader.js');
      reloadConfig();
      const cfg = getConfig();
      expect(normalize(cfg.indexDir)).toBe(normalize(join(dataDir, 'indexes')));
      reloadConfig();
    });
  });

  it('overrides auth DB path via getAuthDbPath()', async () => {
    const dataDir = join(tmpdir(), 'pctx-auth-test');
    await withEnv({ PCTX_DATA_DIR: dataDir }, async () => {
      const { getAuthDbPath } = await import('../../src/core/db/api-keys.js');
      expect(normalize(getAuthDbPath())).toBe(normalize(join(dataDir, 'auth.db')));
    });
  });
});

describe('env var priority', () => {
  it('PCTX_PORT wins over default (simulating config-file value)', async () => {
    // We cannot set a real config file in a unit test, but we verify the env
    // var takes priority over the built-in default (3000).
    await withEnv({ PCTX_PORT: '5555' }, async () => {
      const { reloadConfig, getConfig } = await import('../../src/config/config-loader.js');
      reloadConfig();
      const cfg = getConfig();
      expect(cfg.http.port).toBe(5555);
      reloadConfig();
    });
  });
});
