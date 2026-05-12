/**
 * Tests for the check_rename_safe tool (Task 184).
 *
 * Fixture: test/fixtures/check-rename-safe-fixture/
 *   src/auth.ts       — defines authenticate, verifyIdentity, processToken, isolatedFunc
 *   src/routes.ts     — imports + calls authenticate
 *   src/middleware.ts — imports + calls authenticate
 *   src/service.ts    — imports + calls authenticate
 *   src/dynamic.ts    — references processToken as a string literal
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';
import { handler as checkRenameSafeHandler } from '../../src/server/tools/check-rename-safe.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/check-rename-safe-fixture');

let repoId: string;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findSymbolId(name: string): string {
  const db = openDatabase(repoId);
  try {
    const results = searchSymbols(db, repoId, name, { kind: 'function' });
    const match = results.find((s) => s.name === name);
    if (!match) throw new Error(`Symbol "${name}" not found in index`);
    return match.id;
  } finally {
    db.close();
  }
}

interface AffectedSite {
  filePath: string;
  line: number;
  column: number;
  context: string;
  changeType: 'call' | 'import' | 'type-reference' | 'string-literal' | 'comment';
}

interface CheckRenameSafeOutput {
  safe: boolean;
  verdict: string;
  symbolName: string;
  newName: string;
  conflicts: string[];
  affectedSites: AffectedSite[];
  affectedFileCount: number;
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string };
}

function parse(result: { content: Array<{ text: string }> }): CheckRenameSafeOutput {
  return JSON.parse(result.content[0]!.text) as CheckRenameSafeOutput;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  const result = await indexFolder(FIXTURE, { fileLimit: 50 });
  repoId = result.repoId;
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

// ─── Repo / symbol validation ─────────────────────────────────────────────────

describe('check_rename_safe — validation', () => {
  it('returns error for unknown repoId', async () => {
    const result = await checkRenameSafeHandler({
      repoId: 'deadbeef00000000',
      symbolId: 'does-not-matter',
      newName: 'foo',
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/not found/i);
  });

  it('returns error for unknown symbolId', async () => {
    const result = await checkRenameSafeHandler({
      repoId,
      symbolId: 'aaaaaaaaaaaaaaaa',
      newName: 'foo',
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/not found/i);
  });
});

// ─── No-op: same name ─────────────────────────────────────────────────────────

describe('check_rename_safe — same name (no-op)', () => {
  it('returns safe: true immediately when newName equals current name', async () => {
    const symbolId = findSymbolId('authenticate');
    const result = await checkRenameSafeHandler({
      repoId,
      symbolId,
      newName: 'authenticate',
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.safe).toBe(true);
    expect(data.affectedSites).toEqual([]);
    expect(data.affectedFileCount).toBe(0);
    expect(data.verdict).toMatch(/no-op/i);
  });
});

// ─── Symbol used in 3 files ───────────────────────────────────────────────────

describe('check_rename_safe — authenticate (3 call files)', () => {
  let symbolId: string;

  beforeAll(() => {
    symbolId = findSymbolId('authenticate');
  });

  it('finds all affected sites across 3 files', async () => {
    const result = await checkRenameSafeHandler({
      repoId,
      symbolId,
      newName: 'newAuth',
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.affectedFileCount).toBe(3);
    const paths = data.affectedSites.map((s) => s.filePath);
    expect(paths.some((p) => p.includes('routes'))).toBe(true);
    expect(paths.some((p) => p.includes('middleware'))).toBe(true);
    expect(paths.some((p) => p.includes('service'))).toBe(true);
  });

  it('is safe when there are no conflicts and no string literals', async () => {
    const result = await checkRenameSafeHandler({
      repoId,
      symbolId,
      newName: 'newAuth',
    });
    const data = parse(result);
    expect(data.safe).toBe(true);
    expect(data.conflicts).toEqual([]);
  });

  it('verdict mentions affected file count', async () => {
    const result = await checkRenameSafeHandler({
      repoId,
      symbolId,
      newName: 'newAuth',
    });
    const data = parse(result);
    expect(data.verdict).toMatch(/3 file/i);
    expect(data.verdict).toMatch(/no conflicts/i);
  });

  it('import sites have changeType: import', async () => {
    const result = await checkRenameSafeHandler({
      repoId,
      symbolId,
      newName: 'newAuth',
    });
    const data = parse(result);
    const imports = data.affectedSites.filter((s) => s.changeType === 'import');
    expect(imports.length).toBeGreaterThanOrEqual(3); // one per consumer file
  });

  it('call sites have changeType: call', async () => {
    const result = await checkRenameSafeHandler({
      repoId,
      symbolId,
      newName: 'newAuth',
    });
    const data = parse(result);
    const calls = data.affectedSites.filter((s) => s.changeType === 'call');
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('each site has required fields', async () => {
    const result = await checkRenameSafeHandler({
      repoId,
      symbolId,
      newName: 'newAuth',
    });
    const data = parse(result);
    for (const site of data.affectedSites) {
      expect(site).toHaveProperty('filePath');
      expect(site).toHaveProperty('line');
      expect(site).toHaveProperty('column');
      expect(site).toHaveProperty('context');
      expect(site).toHaveProperty('changeType');
      expect(site.line).toBeGreaterThan(0);
      expect(site.column).toBeGreaterThan(0);
      expect(site.context.length).toBeLessThanOrEqual(120);
    }
  });

  it('output has all required top-level fields', async () => {
    const result = await checkRenameSafeHandler({
      repoId,
      symbolId,
      newName: 'newAuth',
    });
    const data = parse(result);
    expect(data).toHaveProperty('safe');
    expect(data).toHaveProperty('verdict');
    expect(data).toHaveProperty('symbolName');
    expect(data).toHaveProperty('newName');
    expect(data).toHaveProperty('conflicts');
    expect(data).toHaveProperty('affectedSites');
    expect(data).toHaveProperty('affectedFileCount');
    expect(data).toHaveProperty('_tokenEstimate');
    expect(data).toHaveProperty('_meta');
    expect(data.symbolName).toBe('authenticate');
    expect(data.newName).toBe('newAuth');
  });
});

// ─── Conflict detection ───────────────────────────────────────────────────────

describe('check_rename_safe — conflict with existing symbol', () => {
  it('safe: false when newName already exists in the same file', async () => {
    const symbolId = findSymbolId('authenticate');
    // verifyIdentity is already defined in auth.ts alongside authenticate
    const result = await checkRenameSafeHandler({
      repoId,
      symbolId,
      newName: 'verifyIdentity',
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.safe).toBe(false);
    expect(data.conflicts.length).toBeGreaterThan(0);
    expect(data.conflicts[0]).toMatch(/verifyIdentity/);
  });

  it('verdict mentions conflict', async () => {
    const symbolId = findSymbolId('authenticate');
    const result = await checkRenameSafeHandler({
      repoId,
      symbolId,
      newName: 'verifyIdentity',
    });
    const data = parse(result);
    expect(data.verdict).toMatch(/not safe/i);
    expect(data.verdict).toMatch(/conflict/i);
  });

  it('no conflict when checkConflicts: false', async () => {
    const symbolId = findSymbolId('authenticate');
    const result = await checkRenameSafeHandler({
      repoId,
      symbolId,
      newName: 'verifyIdentity',
      checkConflicts: false,
    });
    const data = parse(result);
    expect(data.conflicts).toEqual([]);
    // safe is now determined only by string-literal check (authenticate has none)
    expect(data.safe).toBe(true);
  });
});

// ─── String literal reference ─────────────────────────────────────────────────

describe('check_rename_safe — string-literal reference', () => {
  it('safe: false when symbol name appears as a string literal', async () => {
    const symbolId = findSymbolId('processToken');
    // dynamic.ts has: const HANDLER = 'processToken'
    const result = await checkRenameSafeHandler({
      repoId,
      symbolId,
      newName: 'parseToken',
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.safe).toBe(false);
  });

  it('string-literal site has correct changeType', async () => {
    const symbolId = findSymbolId('processToken');
    const result = await checkRenameSafeHandler({
      repoId,
      symbolId,
      newName: 'parseToken',
    });
    const data = parse(result);
    const strSites = data.affectedSites.filter((s) => s.changeType === 'string-literal');
    expect(strSites.length).toBeGreaterThan(0);
    expect(strSites[0]!.context).toContain('processToken');
  });

  it('verdict mentions string-literal requirement', async () => {
    const symbolId = findSymbolId('processToken');
    const result = await checkRenameSafeHandler({
      repoId,
      symbolId,
      newName: 'parseToken',
    });
    const data = parse(result);
    expect(data.verdict).toMatch(/not safe/i);
    expect(data.verdict).toMatch(/string-literal/i);
  });
});

// ─── Zero references ──────────────────────────────────────────────────────────

describe('check_rename_safe — zero references', () => {
  it('safe: true with empty affectedSites for an unreferenced symbol', async () => {
    const symbolId = findSymbolId('isolatedFunc');
    const result = await checkRenameSafeHandler({
      repoId,
      symbolId,
      newName: 'standaloneFunc',
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.safe).toBe(true);
    expect(data.affectedSites).toEqual([]);
    expect(data.affectedFileCount).toBe(0);
    expect(data.conflicts).toEqual([]);
  });

  it('verdict mentions 0 files for unreferenced symbol', async () => {
    const symbolId = findSymbolId('isolatedFunc');
    const result = await checkRenameSafeHandler({
      repoId,
      symbolId,
      newName: 'standaloneFunc',
    });
    const data = parse(result);
    expect(data.verdict).toMatch(/0 file/i);
  });
});
