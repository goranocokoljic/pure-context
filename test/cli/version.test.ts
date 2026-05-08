/**
 * Task 125: --version and --health CLI flags.
 *
 * Tests call cmdHealth() directly (capturing output via the write callback)
 * rather than spawning a subprocess, which keeps them fast and avoids
 * requiring a compiled binary on the test runner.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { cmdHealth } from '../../src/config/cli.js';
import { GRAMMARS_DIR } from '../../src/core/parse-dispatcher.js';
import { VERSION } from '../../src/version.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  await initParser();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Capture all lines written by cmdHealth into an array. */
function captureHealth(): { lines: string[]; ok: boolean } {
  const lines: string[] = [];
  const ok = cmdHealth((line) => lines.push(line));
  return { lines, ok };
}

// ─── VERSION constant ─────────────────────────────────────────────────────────

describe('VERSION constant', () => {
  it('is a semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ─── cmdHealth() ──────────────────────────────────────────────────────────────

describe('cmdHealth()', () => {
  it('prints the version as the first line', () => {
    const { lines } = captureHealth();
    expect(lines[0]).toContain(VERSION);
    expect(lines[0]).toContain('purecontext-mcp');
  });

  it('prints a Node.js version check line', () => {
    const { lines } = captureHealth();
    const nodeLine = lines.find((l) => l.includes('Node.js'));
    expect(nodeLine).toBeDefined();
    expect(nodeLine).toContain(process.version.replace(/^v/, ''));
  });

  it('Node.js check passes on current runtime (>= 18)', () => {
    const { lines } = captureHealth();
    const nodeLine = lines.find((l) => l.includes('Node.js'))!;
    expect(nodeLine).toContain('✓');
  });

  it('prints a better-sqlite3 check line', () => {
    const { lines } = captureHealth();
    const sqliteLine = lines.find((l) => l.includes('better-sqlite3'));
    expect(sqliteLine).toBeDefined();
  });

  it('better-sqlite3 check passes when driver is available', () => {
    const { lines } = captureHealth();
    const sqliteLine = lines.find((l) => l.includes('better-sqlite3'))!;
    expect(sqliteLine).toContain('✓');
  });

  it('prints a grammars check line', () => {
    const { lines } = captureHealth();
    const grammarLine = lines.find((l) => l.toLowerCase().includes('grammar'));
    expect(grammarLine).toBeDefined();
  });

  it('grammar check passes when .wasm files are present', () => {
    const tsWasm = join(GRAMMARS_DIR, 'tree-sitter-typescript.wasm');
    if (!existsSync(tsWasm)) return; // skip if grammars not present in this env
    const { lines } = captureHealth();
    const grammarLine = lines.find((l) => l.toLowerCase().includes('grammar'))!;
    expect(grammarLine).toContain('✓');
    expect(grammarLine).toMatch(/\d+ languages? available/);
  });

  it('prints a config check line', () => {
    const { lines } = captureHealth();
    const configLine = lines.find((l) => l.toLowerCase().includes('config'));
    expect(configLine).toBeDefined();
  });

  it('prints an index dir check line', () => {
    const { lines } = captureHealth();
    const indexLine = lines.find((l) => l.toLowerCase().includes('index dir'));
    expect(indexLine).toBeDefined();
  });

  it('prints exactly 6 lines total (version header + 5 checks)', () => {
    const { lines } = captureHealth();
    expect(lines).toHaveLength(6);
  });

  it('returns true when all checks pass on a clean install', () => {
    const tsWasm = join(GRAMMARS_DIR, 'tree-sitter-typescript.wasm');
    if (!existsSync(tsWasm)) return; // skip if grammars not present
    const { ok } = captureHealth();
    expect(ok).toBe(true);
  });

  it('check lines all start with ✓ or ✗ (never raw text)', () => {
    // Structural check: every check line (not the version header) must start with ✓ or ✗.
    const { lines } = captureHealth();
    const checkLines = lines.slice(1); // skip version header
    for (const line of checkLines) {
      expect(line).toMatch(/^[✓✗]/);
    }
  });
});

// ─── _meta serverVersion ──────────────────────────────────────────────────────

describe('buildMeta() server_version field', () => {
  it('includes server_version in the meta envelope', async () => {
    const { buildMeta } = await import('../../src/server/tools/_meta.js');
    const meta = buildMeta({ timingMs: 0 });
    expect(meta.server_version).toBe(VERSION);
  });

  it('server_version matches VERSION constant when savings are included', async () => {
    const { buildMeta } = await import('../../src/server/tools/_meta.js');
    const meta = buildMeta({ timingMs: 100, rawBytes: 1000, responseBytes: 200 });
    expect(meta.server_version).toBe(VERSION);
  });
});
