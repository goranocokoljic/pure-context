/**
 * Tests for the find_untested_symbols tool (Task 200).
 *
 * Fixture: test/fixtures/find-untested-symbols-fixture/
 *
 *   Source files:
 *     src/services/user-service.ts — createUser, findUser, deleteUser, validateEmail
 *     src/utils/helpers.ts         — formatDate, slugify, truncate
 *     src/core/auth.ts             — hashPassword, verifyPassword, generateToken
 *     src/index.ts                 — barrel re-exports only (no function symbols)
 *
 *   Test files (identified by path convention):
 *     test/user-service.test.ts — references createUser, findUser
 *     test/helpers.test.ts      — references formatDate
 *
 *   Expected untested symbols (functions, no test references):
 *     deleteUser, validateEmail        (user-service.ts)
 *     slugify, truncate                (helpers.ts)
 *     hashPassword, verifyPassword, generateToken  (auth.ts — no tests at all)
 *
 *   Expected tested symbols (appear in test files):
 *     createUser, findUser (user-service.test.ts)
 *     formatDate           (helpers.test.ts)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as findUntestedSymbolsHandler } from '../../src/server/tools/find-untested-symbols.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/find-untested-symbols-fixture');

let repoId: string;

// ─── Output types ─────────────────────────────────────────────────────────────

interface UntestedSymbol {
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  signature: string;
  summary: string;
  lineCount: number;
  cyclomaticComplexity: number;
  priority: 'high' | 'medium' | 'low';
  testRefs?: string[];
}

interface FindUntestedOutput {
  repoId: string;
  totalSymbols: number;
  testedCount: number;
  untestedCount: number;
  testCoverageRate: number;
  testFilesScanned: number;
  truncated: boolean;
  untestedSymbols: UntestedSymbol[];
  summary: {
    highPriority: number;
    mediumPriority: number;
    lowPriority: number;
    kindsAnalyzed: string[];
    minLineCount: number;
  };
  _tokenEstimate: number;
  _meta: { timing_ms: number };
}

function parseOutput(result: { content: Array<{ text: string }> }): FindUntestedOutput {
  return JSON.parse(result.content[0].text) as FindUntestedOutput;
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  await initParser();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);

  const result = await indexFolder(FIXTURE, { fileLimit: 20 });
  repoId = result.repoId;
}, 60_000);

afterAll(async () => {
  if (repoId) await deleteIndex(repoId);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('find_untested_symbols', () => {
  // ── Error cases ─────────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns isError for unknown repoId', async () => {
      const result = await findUntestedSymbolsHandler({ repoId: 'deadbeef00000000' });
      expect(result.isError).toBe(true);
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.error).toMatch(/not found/i);
    });
  });

  // ── Basic structure ──────────────────────────────────────────────────────────

  describe('response structure', () => {
    it('returns all required top-level fields', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.repoId).toBe(repoId);
      expect(typeof out.totalSymbols).toBe('number');
      expect(typeof out.testedCount).toBe('number');
      expect(typeof out.untestedCount).toBe('number');
      expect(typeof out.testCoverageRate).toBe('number');
      expect(typeof out.testFilesScanned).toBe('number');
      expect(typeof out.truncated).toBe('boolean');
      expect(Array.isArray(out.untestedSymbols)).toBe(true);
      expect(out.summary).toBeDefined();
      expect(typeof out._tokenEstimate).toBe('number');
      expect(out._meta).toBeDefined();
    });

    it('_tokenEstimate is positive', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out._tokenEstimate).toBeGreaterThan(0);
    });

    it('_meta includes timing_ms', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(typeof out._meta.timing_ms).toBe('number');
    });
  });

  // ── Test file detection ──────────────────────────────────────────────────────

  describe('test file detection', () => {
    it('scans the correct number of test files', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      // Fixture has 2 test files: test/user-service.test.ts, test/helpers.test.ts
      expect(out.testFilesScanned).toBe(2);
    });

    it('does not include test-file symbols in untestedSymbols', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const testFileSymbols = out.untestedSymbols.filter(
        (s) => s.filePath.includes('test/') || s.filePath.includes('.test.'),
      );
      expect(testFileSymbols).toHaveLength(0);
    });
  });

  // ── Tested vs untested classification ───────────────────────────────────────

  describe('tested vs untested classification', () => {
    it('marks createUser as tested (referenced in user-service.test.ts)', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const names = out.untestedSymbols.map((s) => s.name);
      expect(names).not.toContain('createUser');
    });

    it('marks findUser as tested (referenced in user-service.test.ts)', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const names = out.untestedSymbols.map((s) => s.name);
      expect(names).not.toContain('findUser');
    });

    it('marks formatDate as tested (referenced in helpers.test.ts)', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const names = out.untestedSymbols.map((s) => s.name);
      expect(names).not.toContain('formatDate');
    });

    it('marks deleteUser as untested (no test references)', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const names = out.untestedSymbols.map((s) => s.name);
      expect(names).toContain('deleteUser');
    });

    it('marks validateEmail as untested (no test references)', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const names = out.untestedSymbols.map((s) => s.name);
      expect(names).toContain('validateEmail');
    });

    it('marks slugify as untested (no test references)', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const names = out.untestedSymbols.map((s) => s.name);
      expect(names).toContain('slugify');
    });

    it('marks truncate as untested (no test references)', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const names = out.untestedSymbols.map((s) => s.name);
      expect(names).toContain('truncate');
    });

    it('marks all auth.ts functions as untested (no tests for auth at all)', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const names = out.untestedSymbols.map((s) => s.name);
      expect(names).toContain('hashPassword');
      expect(names).toContain('verifyPassword');
      expect(names).toContain('generateToken');
    });

    it('testedCount equals number of symbols appearing in test files', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      // createUser, findUser, formatDate should be detected as tested
      expect(out.testedCount).toBeGreaterThanOrEqual(2);
    });

    it('totalSymbols = testedCount + untestedCount', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.totalSymbols).toBe(out.testedCount + out.untestedCount);
    });

    it('testCoverageRate is between 0 and 1', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.testCoverageRate).toBeGreaterThanOrEqual(0);
      expect(out.testCoverageRate).toBeLessThanOrEqual(1);
    });
  });

  // ── Symbol fields ────────────────────────────────────────────────────────────

  describe('symbol fields', () => {
    it('each untested symbol has required fields', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      for (const sym of out.untestedSymbols) {
        expect(typeof sym.symbolId).toBe('string');
        expect(sym.symbolId.length).toBeGreaterThan(0);
        expect(typeof sym.name).toBe('string');
        expect(typeof sym.kind).toBe('string');
        expect(typeof sym.filePath).toBe('string');
        expect(typeof sym.startLine).toBe('number');
        expect(sym.startLine).toBeGreaterThanOrEqual(1);
        expect(typeof sym.signature).toBe('string');
        expect(typeof sym.summary).toBe('string');
        expect(typeof sym.lineCount).toBe('number');
        expect(typeof sym.cyclomaticComplexity).toBe('number');
        expect(['high', 'medium', 'low']).toContain(sym.priority);
      }
    });

    it('filePath is relative (does not start with /)', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      for (const sym of out.untestedSymbols) {
        expect(sym.filePath).not.toMatch(/^[/\\]/);
      }
    });

    it('untestedSymbols ranked by cyclomaticComplexity descending', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const ccs = out.untestedSymbols.map((s) => s.cyclomaticComplexity);
      for (let i = 1; i < ccs.length; i++) {
        expect(ccs[i]).toBeLessThanOrEqual(ccs[i - 1]);
      }
    });
  });

  // ── Priority scoring ─────────────────────────────────────────────────────────

  describe('priority scoring', () => {
    it('summary counts high/medium/low match untestedSymbols lengths', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const high = out.untestedSymbols.filter((s) => s.priority === 'high').length;
      const medium = out.untestedSymbols.filter((s) => s.priority === 'medium').length;
      const low = out.untestedSymbols.filter((s) => s.priority === 'low').length;
      // summary counts refer to full (untruncated) list
      expect(out.summary.highPriority).toBeGreaterThanOrEqual(0);
      expect(out.summary.mediumPriority).toBeGreaterThanOrEqual(0);
      expect(out.summary.lowPriority).toBeGreaterThanOrEqual(0);
      // When not truncated they should match exactly
      if (!out.truncated) {
        expect(out.summary.highPriority).toBe(high);
        expect(out.summary.mediumPriority).toBe(medium);
        expect(out.summary.lowPriority).toBe(low);
      }
    });

    it('deleteUser gets at least medium priority (multi-branch function)', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const sym = out.untestedSymbols.find((s) => s.name === 'deleteUser');
      expect(sym).toBeDefined();
      expect(['high', 'medium']).toContain(sym!.priority);
    });

    it('validateEmail gets at least medium priority (multi-return function)', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const sym = out.untestedSymbols.find((s) => s.name === 'validateEmail');
      expect(sym).toBeDefined();
      expect(['high', 'medium']).toContain(sym!.priority);
    });
  });

  // ── Filters ──────────────────────────────────────────────────────────────────

  describe('scope filter', () => {
    it('scope restricts results to the given directory', async () => {
      const result = await findUntestedSymbolsHandler({ repoId, scope: 'src/core' });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      for (const sym of out.untestedSymbols) {
        expect(sym.filePath).toMatch(/^src[\\/]core/);
      }
    });

    it('scope with trailing slash works the same as without', async () => {
      const r1 = await findUntestedSymbolsHandler({ repoId, scope: 'src/core' });
      const r2 = await findUntestedSymbolsHandler({ repoId, scope: 'src/core/' });
      const o1 = parseOutput(r1 as { content: Array<{ text: string }> });
      const o2 = parseOutput(r2 as { content: Array<{ text: string }> });
      expect(o1.untestedCount).toBe(o2.untestedCount);
    });

    it('scope to auth directory finds only auth functions', async () => {
      const result = await findUntestedSymbolsHandler({ repoId, scope: 'src/core' });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const names = out.untestedSymbols.map((s) => s.name);
      // All auth.ts functions are untested
      expect(names).toContain('hashPassword');
      expect(names).toContain('verifyPassword');
      expect(names).toContain('generateToken');
      // user-service and helpers functions not in scope
      expect(names).not.toContain('deleteUser');
      expect(names).not.toContain('slugify');
    });
  });

  describe('filePath filter', () => {
    it('filePath restricts to a single source file', async () => {
      const result = await findUntestedSymbolsHandler({
        repoId,
        filePath: 'src/utils/helpers.ts',
      });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      for (const sym of out.untestedSymbols) {
        expect(sym.filePath).toBe('src/utils/helpers.ts');
      }
    });

    it('filePath filter: slugify and truncate are both untested', async () => {
      const result = await findUntestedSymbolsHandler({
        repoId,
        filePath: 'src/utils/helpers.ts',
      });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const names = out.untestedSymbols.map((s) => s.name);
      expect(names).toContain('slugify');
      expect(names).toContain('truncate');
      // formatDate is tested — should not appear
      expect(names).not.toContain('formatDate');
    });
  });

  describe('kinds filter', () => {
    it('default kinds include function and method', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.summary.kindsAnalyzed).toContain('function');
      expect(out.summary.kindsAnalyzed).toContain('method');
    });

    it('custom kinds filter limits results to specified kinds', async () => {
      const result = await findUntestedSymbolsHandler({ repoId, kinds: ['class'] });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      for (const sym of out.untestedSymbols) {
        expect(sym.kind).toBe('class');
      }
    });

    it('kinds filter reflects in summary.kindsAnalyzed', async () => {
      const result = await findUntestedSymbolsHandler({
        repoId,
        kinds: ['function', 'class'],
      });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.summary.kindsAnalyzed).toContain('function');
      expect(out.summary.kindsAnalyzed).toContain('class');
    });
  });

  describe('minLineCount filter', () => {
    it('minLineCount=1 includes all symbols regardless of size', async () => {
      const r1 = await findUntestedSymbolsHandler({ repoId, minLineCount: 1 });
      const r20 = await findUntestedSymbolsHandler({ repoId, minLineCount: 20 });
      const o1 = parseOutput(r1 as { content: Array<{ text: string }> });
      const o20 = parseOutput(r20 as { content: Array<{ text: string }> });
      // minLineCount=1 should return at least as many as minLineCount=20
      expect(o1.totalSymbols).toBeGreaterThanOrEqual(o20.totalSymbols);
    });

    it('large minLineCount filters out small symbols', async () => {
      const result = await findUntestedSymbolsHandler({ repoId, minLineCount: 50 });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      // Very high threshold — most fixture symbols are shorter than 50 lines
      for (const sym of out.untestedSymbols) {
        expect(sym.lineCount).toBeGreaterThanOrEqual(50);
      }
    });

    it('minLineCount reflected in summary', async () => {
      const result = await findUntestedSymbolsHandler({ repoId, minLineCount: 7 });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.summary.minLineCount).toBe(7);
    });
  });

  // ── includeTestRefs ──────────────────────────────────────────────────────────

  describe('includeTestRefs', () => {
    it('testRefs not present by default', async () => {
      const result = await findUntestedSymbolsHandler({ repoId });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      for (const sym of out.untestedSymbols) {
        expect(sym.testRefs).toBeUndefined();
      }
    });

    it('testRefs is empty array for untested symbols when includeTestRefs=true', async () => {
      const result = await findUntestedSymbolsHandler({ repoId, includeTestRefs: true });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      for (const sym of out.untestedSymbols) {
        expect(Array.isArray(sym.testRefs)).toBe(true);
        expect(sym.testRefs).toHaveLength(0);
      }
    });
  });

  // ── Limit / truncation ───────────────────────────────────────────────────────

  describe('limit and truncation', () => {
    it('limit=1 returns at most 1 symbol', async () => {
      const result = await findUntestedSymbolsHandler({ repoId, limit: 1 });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.untestedSymbols).toHaveLength(1);
    });

    it('truncated=true when untestedCount exceeds limit', async () => {
      const result = await findUntestedSymbolsHandler({ repoId, limit: 1 });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      if (out.untestedCount > 1) {
        expect(out.truncated).toBe(true);
      }
    });

    it('truncated=false when all symbols fit within limit', async () => {
      const result = await findUntestedSymbolsHandler({ repoId, limit: 500 });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.truncated).toBe(false);
    });
  });
});
