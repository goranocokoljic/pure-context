/**
 * Tests for the check_delete_safe tool (Task 185).
 *
 * Fixture: test/fixtures/check-delete-safe-fixture/
 *   src/utils.ts          — deleteMe (2 live refs), orphan (0 refs, not exported),
 *                           exportedNoRefs (exported, 0 refs), testSubject (0 live, 1 test ref)
 *   src/caller1.ts        — imports + calls deleteMe
 *   src/caller2.ts        — imports + calls deleteMe
 *   src/exported-module.ts — alpha, beta, gamma (all exported, no refs — for filePath mode)
 *   test/utils.test.ts    — references testSubject
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
import { handler as checkDeleteSafeHandler } from '../../src/server/tools/check-delete-safe.js';
import type { DeleteRisk } from '../../src/server/tools/check-delete-safe.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/check-delete-safe-fixture');

let repoId: string;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findSymbolId(name: string): string {
  const db = openDatabase(repoId);
  try {
    const results = searchSymbols(db, repoId, name, {});
    const match = results.find((s) => s.name === name);
    if (!match) throw new Error(`Symbol "${name}" not found in index`);
    return match.id;
  } finally {
    db.close();
  }
}

interface CheckDeleteSafeOutput {
  safe: boolean;
  verdict: string;
  risks: DeleteRisk[];
  liveReferenceCount: number;
  isExported: boolean;
  isEntryPoint: boolean;
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string };
}

function parse(result: { content: Array<{ text: string }> }): CheckDeleteSafeOutput {
  return JSON.parse(result.content[0]!.text) as CheckDeleteSafeOutput;
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

// ─── Validation ───────────────────────────────────────────────────────────────

describe('check_delete_safe — validation', () => {
  it('returns error for unknown repoId', async () => {
    const result = await checkDeleteSafeHandler({
      repoId: 'deadbeef00000000',
      symbolId: 'does-not-matter',
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/not found/i);
  });

  it('returns error for unknown symbolId', async () => {
    const result = await checkDeleteSafeHandler({
      repoId,
      symbolId: 'aaaaaaaaaaaaaaaa',
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/not found/i);
  });

  it('returns error when neither symbolId nor filePath provided', async () => {
    const result = await checkDeleteSafeHandler({ repoId });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/symbolId|filePath/i);
  });

  it('returns error for unknown filePath', async () => {
    const result = await checkDeleteSafeHandler({
      repoId,
      filePath: 'src/does-not-exist.ts',
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/no symbols found/i);
  });
});

// ─── Symbol with 2 live references ───────────────────────────────────────────

describe('check_delete_safe — deleteMe (2 live references)', () => {
  let symbolId: string;

  beforeAll(() => {
    symbolId = findSymbolId('deleteMe');
  });

  it('safe: false when live references exist', async () => {
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.safe).toBe(false);
  });

  it('liveReferenceCount >= 2 (at least one ref per caller file)', async () => {
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    const data = parse(result);
    expect(data.liveReferenceCount).toBeGreaterThanOrEqual(2);
  });

  it('risks list includes live-reference entries for both caller files', async () => {
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    const data = parse(result);
    const liveRisks = data.risks.filter((r) => r.kind === 'live-reference');
    expect(liveRisks.length).toBeGreaterThanOrEqual(2);
    const paths = liveRisks.map((r) => r.filePath);
    expect(paths.some((p) => p.includes('caller1'))).toBe(true);
    expect(paths.some((p) => p.includes('caller2'))).toBe(true);
  });

  it('each live-reference risk has filePath, line, and detail', async () => {
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    const data = parse(result);
    const liveRisks = data.risks.filter((r) => r.kind === 'live-reference');
    for (const risk of liveRisks) {
      expect(risk).toHaveProperty('filePath');
      expect(risk).toHaveProperty('line');
      expect(risk).toHaveProperty('detail');
      expect(risk.line).toBeGreaterThan(0);
      expect(risk.detail.length).toBeGreaterThan(0);
    }
  });

  it('verdict mentions "unsafe" and reference count', async () => {
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    const data = parse(result);
    expect(data.verdict.toLowerCase()).toMatch(/unsafe/);
    expect(data.verdict).toMatch(/live reference/i);
  });

  it('output has all required top-level fields', async () => {
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    const data = parse(result);
    expect(data).toHaveProperty('safe');
    expect(data).toHaveProperty('verdict');
    expect(data).toHaveProperty('risks');
    expect(data).toHaveProperty('liveReferenceCount');
    expect(data).toHaveProperty('isExported');
    expect(data).toHaveProperty('isEntryPoint');
    expect(data).toHaveProperty('_tokenEstimate');
    expect(data).toHaveProperty('_meta');
  });
});

// ─── Symbol with zero references, not exported ───────────────────────────────

describe('check_delete_safe — orphan (0 refs, not exported)', () => {
  it('safe: true', async () => {
    const symbolId = findSymbolId('orphan');
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.safe).toBe(true);
  });

  it('liveReferenceCount: 0', async () => {
    const symbolId = findSymbolId('orphan');
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    const data = parse(result);
    expect(data.liveReferenceCount).toBe(0);
  });

  it('isExported: false', async () => {
    const symbolId = findSymbolId('orphan');
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    const data = parse(result);
    expect(data.isExported).toBe(false);
  });

  it('no risks', async () => {
    const symbolId = findSymbolId('orphan');
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    const data = parse(result);
    expect(data.risks).toEqual([]);
  });

  it('verdict mentions "safe to delete"', async () => {
    const symbolId = findSymbolId('orphan');
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    const data = parse(result);
    expect(data.verdict.toLowerCase()).toMatch(/safe to delete/);
  });
});

// ─── Exported symbol with zero internal references ────────────────────────────

describe('check_delete_safe — exportedNoRefs (exported, 0 internal refs)', () => {
  it('safe: false because symbol is exported (external risk)', async () => {
    const symbolId = findSymbolId('exportedNoRefs');
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.safe).toBe(false);
  });

  it('isExported: true', async () => {
    const symbolId = findSymbolId('exportedNoRefs');
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    const data = parse(result);
    expect(data.isExported).toBe(true);
  });

  it('liveReferenceCount: 0', async () => {
    const symbolId = findSymbolId('exportedNoRefs');
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    const data = parse(result);
    expect(data.liveReferenceCount).toBe(0);
  });

  it('risks contains exported-symbol risk', async () => {
    const symbolId = findSymbolId('exportedNoRefs');
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    const data = parse(result);
    const exportRisks = data.risks.filter((r) => r.kind === 'exported-symbol');
    expect(exportRisks.length).toBeGreaterThan(0);
  });

  it('safe: true when includeExternalRisk: false', async () => {
    const symbolId = findSymbolId('exportedNoRefs');
    const result = await checkDeleteSafeHandler({
      repoId,
      symbolId,
      includeExternalRisk: false,
    });
    const data = parse(result);
    expect(data.safe).toBe(true);
    const exportRisks = data.risks.filter((r) => r.kind === 'exported-symbol');
    expect(exportRisks.length).toBe(0);
  });

  it('verdict mentions exported symbol', async () => {
    const symbolId = findSymbolId('exportedNoRefs');
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    const data = parse(result);
    expect(data.verdict.toLowerCase()).toMatch(/unsafe/);
    expect(data.verdict.toLowerCase()).toMatch(/exported/);
  });
});

// ─── Symbol referenced only in test file ──────────────────────────────────────

describe('check_delete_safe — testSubject (referenced in test file only)', () => {
  it('test-subject risk is present', async () => {
    const symbolId = findSymbolId('testSubject');
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    const testRisks = data.risks.filter((r) => r.kind === 'test-subject');
    expect(testRisks.length).toBeGreaterThan(0);
  });

  it('test-subject risk points to the test file', async () => {
    const symbolId = findSymbolId('testSubject');
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    const data = parse(result);
    const testRisks = data.risks.filter((r) => r.kind === 'test-subject');
    const paths = testRisks.map((r) => r.filePath);
    expect(paths.some((p) => p.includes('utils.test'))).toBe(true);
  });

  it('liveReferenceCount: 0 (test refs are not live refs)', async () => {
    const symbolId = findSymbolId('testSubject');
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    const data = parse(result);
    expect(data.liveReferenceCount).toBe(0);
  });
});

// ─── filePath mode ────────────────────────────────────────────────────────────

describe('check_delete_safe — filePath mode (exported-module.ts with 3 symbols)', () => {
  const targetFile = 'src/exported-module.ts';

  it('checks all 3 exported symbols (each gets an exported-symbol risk)', async () => {
    const result = await checkDeleteSafeHandler({ repoId, filePath: targetFile });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    const exportRisks = data.risks.filter((r) => r.kind === 'exported-symbol');
    // alpha, beta, gamma — each exported with no refs → 3 exported-symbol risks
    expect(exportRisks.length).toBe(3);
  });

  it('safe: false because all symbols are exported', async () => {
    const result = await checkDeleteSafeHandler({ repoId, filePath: targetFile });
    const data = parse(result);
    expect(data.safe).toBe(false);
  });

  it('isExported: true (aggregate)', async () => {
    const result = await checkDeleteSafeHandler({ repoId, filePath: targetFile });
    const data = parse(result);
    expect(data.isExported).toBe(true);
  });

  it('liveReferenceCount: 0 (none of the symbols are called)', async () => {
    const result = await checkDeleteSafeHandler({ repoId, filePath: targetFile });
    const data = parse(result);
    expect(data.liveReferenceCount).toBe(0);
  });

  it('exported-symbol risks reference the expected symbol names', async () => {
    const result = await checkDeleteSafeHandler({ repoId, filePath: targetFile });
    const data = parse(result);
    const exportRisks = data.risks.filter((r) => r.kind === 'exported-symbol');
    const details = exportRisks.map((r) => r.detail);
    expect(details.some((d) => d.includes('alpha'))).toBe(true);
    expect(details.some((d) => d.includes('beta'))).toBe(true);
    expect(details.some((d) => d.includes('gamma'))).toBe(true);
  });

  it('safe: true in filePath mode when includeExternalRisk: false', async () => {
    const result = await checkDeleteSafeHandler({
      repoId,
      filePath: targetFile,
      includeExternalRisk: false,
    });
    const data = parse(result);
    expect(data.safe).toBe(true);
    expect(data.risks.filter((r) => r.kind === 'exported-symbol').length).toBe(0);
  });
});

// ─── Entry point detection ────────────────────────────────────────────────────

describe('check_delete_safe — entry point heuristic', () => {
  it('isEntryPoint: false for a regular exported function', async () => {
    const symbolId = findSymbolId('exportedNoRefs');
    const result = await checkDeleteSafeHandler({ repoId, symbolId });
    const data = parse(result);
    expect(data.isEntryPoint).toBe(false);
  });
});
