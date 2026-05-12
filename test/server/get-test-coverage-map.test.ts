/**
 * Tests for the get_test_coverage_map tool (Task 201).
 *
 * Fixture: test/fixtures/get-test-coverage-map-fixture/src/
 *
 *   user-service.ts — createUser (line 8, covered ×5), findUser (line 14, covered ×3),
 *                     deleteUser (line 20, NOT covered)
 *   auth.ts         — hashPassword (line 6, covered ×8), generateToken (line 11, NOT covered)
 *   helpers.ts      — formatDate (line 6, covered ×4), slugify (line 14, NOT covered)
 *
 * Coverage is provided at runtime via a dynamically built Istanbul JSON that
 * references the actual fixture paths on disk.
 *
 * Istanbul JSON structure used:
 *   user-service.ts: 9 statements (6 covered), 3 functions (2 covered), 3 branches (6 sides, 3 covered)
 *   auth.ts:         4 statements (2 covered), 2 functions (1 covered), 0 branches
 *   helpers.ts:      7 statements (5 covered), 2 functions (1 covered), 0 branches
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as coverageMapHandler } from '../../src/server/tools/get-test-coverage-map.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/get-test-coverage-map-fixture');

let repoId: string;
let istanbulCoveragePath: string;
let v8CoveragePath: string;

// ─── Output types ─────────────────────────────────────────────────────────────

interface SymbolCov {
  symbolId: string;
  name: string;
  kind: string;
  startLine: number;
  covered: boolean;
  callCount: number;
}

interface FileCov {
  filePath: string;
  lineCoverage: number;
  statementCoverage: number | null;
  functionCoverage: number;
  branchCoverage: number | null;
  totalStatements: number;
  coveredStatements: number;
  totalFunctions: number;
  coveredFunctions: number;
  totalBranches: number;
  coveredBranchSides: number;
  uncoveredLines?: number[];
  symbols: SymbolCov[];
}

interface CovMapOutput {
  repoId: string;
  coveragePath: string;
  format: string;
  summary: {
    totalFiles: number;
    avgLineCoverage: number;
    avgStatementCoverage: number | null;
    avgFunctionCoverage: number;
    avgBranchCoverage: number | null;
    totalSymbols: number;
    coveredSymbols: number;
    uncoveredSymbols: number;
  };
  files: FileCov[];
  truncated: boolean;
  _tokenEstimate: number;
  _meta: { timing_ms: number };
}

function parseOutput(result: { content: Array<{ text: string }> }): CovMapOutput {
  return JSON.parse(result.content[0].text) as CovMapOutput;
}

// ─── Coverage JSON builders ────────────────────────────────────────────────────

/**
 * Build an Istanbul-format coverage object for the 3 fixture source files.
 *
 * Line map (see fixture source files):
 *   user-service.ts:  createUser=8, findUser=14, deleteUser=20
 *   auth.ts:          hashPassword=6, generateToken=11
 *   helpers.ts:       formatDate=6, slugify=14
 */
function buildIstanbulCoverage(fixturePath: string): object {
  const userServicePath = join(fixturePath, 'src', 'user-service.ts');
  const authPath = join(fixturePath, 'src', 'auth.ts');
  const helpersPath = join(fixturePath, 'src', 'helpers.ts');

  return {
    [userServicePath]: {
      path: userServicePath,
      statementMap: {
        '0': { start: { line: 8, column: 0 }, end: { line: 8, column: 50 } },
        '1': { start: { line: 9, column: 2 }, end: { line: 9, column: 40 } },
        '2': { start: { line: 10, column: 2 }, end: { line: 10, column: 28 } },
        '3': { start: { line: 14, column: 0 }, end: { line: 14, column: 44 } },
        '4': { start: { line: 15, column: 2 }, end: { line: 15, column: 22 } },
        '5': { start: { line: 16, column: 2 }, end: { line: 16, column: 30 } },
        '6': { start: { line: 20, column: 0 }, end: { line: 20, column: 43 } },
        '7': { start: { line: 21, column: 2 }, end: { line: 21, column: 38 } },
        '8': { start: { line: 22, column: 2 }, end: { line: 22, column: 15 } },
      },
      // statements 0-5 covered, 6-8 not covered
      s: { '0': 5, '1': 5, '2': 5, '3': 3, '4': 3, '5': 3, '6': 0, '7': 0, '8': 0 },
      fnMap: {
        '0': { name: 'createUser', loc: { start: { line: 8, column: 0 }, end: { line: 11, column: 1 } } },
        '1': { name: 'findUser',   loc: { start: { line: 14, column: 0 }, end: { line: 17, column: 1 } } },
        '2': { name: 'deleteUser', loc: { start: { line: 20, column: 0 }, end: { line: 23, column: 1 } } },
      },
      f: { '0': 5, '1': 3, '2': 0 },
      branchMap: {
        '0': { type: 'if', loc: { start: { line: 9, column: 2 } }, locations: [{ start: { line: 9 } }, { start: { line: 9 } }] },
        '1': { type: 'if', loc: { start: { line: 15, column: 2 } }, locations: [{ start: { line: 15 } }, { start: { line: 15 } }] },
        '2': { type: 'if', loc: { start: { line: 21, column: 2 } }, locations: [{ start: { line: 21 } }, { start: { line: 21 } }] },
      },
      // branch 0: [5, 2] → both sides covered; branch 1: [3, 0] → one side; branch 2: [0,0] → neither
      b: { '0': [5, 2], '1': [3, 0], '2': [0, 0] },
    },
    [authPath]: {
      path: authPath,
      statementMap: {
        '0': { start: { line: 6, column: 0 }, end: { line: 6, column: 46 } },
        '1': { start: { line: 7, column: 2 }, end: { line: 7, column: 28 } },
        '2': { start: { line: 11, column: 0 }, end: { line: 11, column: 44 } },
        '3': { start: { line: 12, column: 2 }, end: { line: 12, column: 50 } },
      },
      s: { '0': 8, '1': 8, '2': 0, '3': 0 },
      fnMap: {
        '0': { name: 'hashPassword',  loc: { start: { line: 6, column: 0 }, end: { line: 8, column: 1 } } },
        '1': { name: 'generateToken', loc: { start: { line: 11, column: 0 }, end: { line: 13, column: 1 } } },
      },
      f: { '0': 8, '1': 0 },
      branchMap: {},
      b: {},
    },
    [helpersPath]: {
      path: helpersPath,
      statementMap: {
        '0': { start: { line: 6, column: 0 }, end: { line: 6, column: 44 } },
        '1': { start: { line: 7, column: 2 }, end: { line: 7, column: 32 } },
        '2': { start: { line: 8, column: 2 }, end: { line: 8, column: 52 } },
        '3': { start: { line: 9, column: 2 }, end: { line: 9, column: 50 } },
        '4': { start: { line: 10, column: 2 }, end: { line: 10, column: 26 } },
        '5': { start: { line: 14, column: 0 }, end: { line: 14, column: 40 } },
        '6': { start: { line: 15, column: 2 }, end: { line: 15, column: 70 } },
      },
      s: { '0': 4, '1': 4, '2': 4, '3': 4, '4': 4, '5': 0, '6': 0 },
      fnMap: {
        '0': { name: 'formatDate', loc: { start: { line: 6, column: 0 }, end: { line: 11, column: 1 } } },
        '1': { name: 'slugify',    loc: { start: { line: 14, column: 0 }, end: { line: 16, column: 1 } } },
      },
      f: { '0': 4, '1': 0 },
      branchMap: {},
      b: {},
    },
  };
}

/**
 * Build a V8-format coverage array for user-service.ts only.
 */
function buildV8Coverage(fixturePath: string): object[] {
  const userServicePath = join(fixturePath, 'src', 'user-service.ts');
  // Build a file:// URL that works on Windows and Unix
  const fileUrl = 'file:///' + userServicePath.replace(/\\/g, '/').replace(/^\//, '');

  return [
    {
      url: fileUrl,
      scriptId: '1',
      functions: [
        // top-level wrapper — should be excluded from function count
        { functionName: '(top-level)', ranges: [{ startOffset: 0, endOffset: 900, count: 1 }], isBlockCoverage: false },
        // createUser — covered
        { functionName: 'createUser', ranges: [{ startOffset: 100, endOffset: 200, count: 5 }], isBlockCoverage: false },
        // findUser — covered
        { functionName: 'findUser', ranges: [{ startOffset: 250, endOffset: 320, count: 3 }], isBlockCoverage: false },
        // deleteUser — NOT covered
        { functionName: 'deleteUser', ranges: [{ startOffset: 370, endOffset: 440, count: 0 }], isBlockCoverage: false },
      ],
    },
  ];
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

  // Write Istanbul coverage to a temp file
  const tmpDir = tmpdir();
  istanbulCoveragePath = join(tmpDir, `coverage-istanbul-${Date.now()}.json`);
  const istanbulJson = buildIstanbulCoverage(FIXTURE);
  writeFileSync(istanbulCoveragePath, JSON.stringify(istanbulJson, null, 2));

  // Write V8 coverage to a temp file
  v8CoveragePath = join(tmpDir, `coverage-v8-${Date.now()}.json`);
  const v8Json = buildV8Coverage(FIXTURE);
  writeFileSync(v8CoveragePath, JSON.stringify(v8Json, null, 2));
}, 60_000);

afterAll(async () => {
  if (repoId) await deleteIndex(repoId);
  try { unlinkSync(istanbulCoveragePath); } catch { /* ignore */ }
  try { unlinkSync(v8CoveragePath); } catch { /* ignore */ }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('get_test_coverage_map', () => {

  // ── Error cases ─────────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns isError for unknown repoId', async () => {
      const result = await coverageMapHandler({
        repoId: 'deadbeef00000000',
        coveragePath: istanbulCoveragePath,
      });
      expect(result.isError).toBe(true);
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.error).toMatch(/not found/i);
    });

    it('returns isError when coverage file does not exist', async () => {
      const result = await coverageMapHandler({
        repoId,
        coveragePath: '/nonexistent/path/coverage.json',
      });
      expect(result.isError).toBe(true);
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.error).toMatch(/cannot read/i);
    });

    it('returns isError for malformed JSON', async () => {
      const tmpPath = join(tmpdir(), `bad-cov-${Date.now()}.json`);
      writeFileSync(tmpPath, '{ this is not json }');
      try {
        const result = await coverageMapHandler({ repoId, coveragePath: tmpPath });
        expect(result.isError).toBe(true);
        const body = JSON.parse((result.content[0] as { text: string }).text);
        expect(body.error).toMatch(/valid json/i);
      } finally {
        unlinkSync(tmpPath);
      }
    });

    it('returns isError for unrecognised format (non-object, non-array)', async () => {
      const tmpPath = join(tmpdir(), `scalar-cov-${Date.now()}.json`);
      writeFileSync(tmpPath, '"just a string"');
      try {
        const result = await coverageMapHandler({ repoId, coveragePath: tmpPath });
        expect(result.isError).toBe(true);
        const body = JSON.parse((result.content[0] as { text: string }).text);
        expect(body.error).toMatch(/unrecognised/i);
      } finally {
        unlinkSync(tmpPath);
      }
    });
  });

  // ── Response structure ───────────────────────────────────────────────────────

  describe('response structure', () => {
    it('returns all required top-level fields', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.repoId).toBe(repoId);
      expect(out.coveragePath).toBe(istanbulCoveragePath);
      expect(typeof out.format).toBe('string');
      expect(out.summary).toBeDefined();
      expect(Array.isArray(out.files)).toBe(true);
      expect(typeof out.truncated).toBe('boolean');
      expect(typeof out._tokenEstimate).toBe('number');
      expect(out._meta).toBeDefined();
    });

    it('_meta includes timing_ms', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(typeof out._meta.timing_ms).toBe('number');
    });

    it('_tokenEstimate is positive when files are returned', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out._tokenEstimate).toBeGreaterThan(0);
    });

    it('each file entry has required fields', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      for (const f of out.files) {
        expect(typeof f.filePath).toBe('string');
        expect(typeof f.lineCoverage).toBe('number');
        expect(typeof f.functionCoverage).toBe('number');
        expect(typeof f.totalFunctions).toBe('number');
        expect(typeof f.coveredFunctions).toBe('number');
        expect(Array.isArray(f.symbols)).toBe(true);
      }
    });
  });

  // ── Format detection ─────────────────────────────────────────────────────────

  describe('format detection', () => {
    it('detects Istanbul format from an object-keyed JSON', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.format).toBe('istanbul');
    });

    it('detects V8 format from an array JSON', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: v8CoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.format).toBe('v8');
    });

    it('format override: format=istanbul forces Istanbul parsing', async () => {
      const result = await coverageMapHandler({
        repoId,
        coveragePath: istanbulCoveragePath,
        format: 'istanbul',
      });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.format).toBe('istanbul');
    });

    it('format override: format=v8 forces V8 parsing', async () => {
      const result = await coverageMapHandler({
        repoId,
        coveragePath: v8CoveragePath,
        format: 'v8',
      });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.format).toBe('v8');
    });
  });

  // ── Istanbul: file coverage metrics ─────────────────────────────────────────

  describe('Istanbul: file coverage metrics', () => {
    it('returns 3 files from the Istanbul report', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.files).toHaveLength(3);
    });

    it('user-service.ts: 3 functions, 2 covered (66.67%)', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const f = out.files.find((e) => e.filePath.includes('user-service'));
      expect(f).toBeDefined();
      expect(f!.totalFunctions).toBe(3);
      expect(f!.coveredFunctions).toBe(2);
      expect(f!.functionCoverage).toBeCloseTo(66.67, 0);
    });

    it('user-service.ts: 9 statements, 6 covered (66.67%)', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const f = out.files.find((e) => e.filePath.includes('user-service'));
      expect(f).toBeDefined();
      expect(f!.totalStatements).toBe(9);
      expect(f!.coveredStatements).toBe(6);
      expect(f!.statementCoverage).toBeCloseTo(66.67, 0);
    });

    it('user-service.ts: 3 branches, 3 covered sides out of 6 (50%)', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const f = out.files.find((e) => e.filePath.includes('user-service'));
      expect(f).toBeDefined();
      // b: { '0': [5, 2], '1': [3, 0], '2': [0, 0] } → 3 covered sides / 6 total = 50%
      expect(f!.totalBranches).toBe(3);
      expect(f!.coveredBranchSides).toBe(3);
      expect(f!.branchCoverage).toBeCloseTo(50, 0);
    });

    it('auth.ts: 2 functions, 1 covered (50%)', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const f = out.files.find((e) => e.filePath.includes('auth'));
      expect(f).toBeDefined();
      expect(f!.totalFunctions).toBe(2);
      expect(f!.coveredFunctions).toBe(1);
      expect(f!.functionCoverage).toBeCloseTo(50, 0);
    });

    it('auth.ts: no branches → branchCoverage is null', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const f = out.files.find((e) => e.filePath.includes('auth'));
      expect(f).toBeDefined();
      expect(f!.branchCoverage).toBeNull();
    });

    it('helpers.ts: 7 statements, 5 covered (~71%)', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const f = out.files.find((e) => e.filePath.includes('helpers'));
      expect(f).toBeDefined();
      expect(f!.totalStatements).toBe(7);
      expect(f!.coveredStatements).toBe(5);
      expect(f!.statementCoverage).toBeCloseTo(71.43, 0);
    });

    it('files are sorted by lineCoverage ascending (worst first)', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const coverages = out.files.map((f) => f.lineCoverage);
      for (let i = 1; i < coverages.length; i++) {
        expect(coverages[i]).toBeGreaterThanOrEqual(coverages[i - 1]);
      }
    });
  });

  // ── Istanbul: symbol coverage ────────────────────────────────────────────────

  describe('Istanbul: symbol coverage', () => {
    it('createUser is covered with callCount=5', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const f = out.files.find((e) => e.filePath.includes('user-service'));
      const sym = f?.symbols.find((s) => s.name === 'createUser');
      expect(sym).toBeDefined();
      expect(sym!.covered).toBe(true);
      expect(sym!.callCount).toBe(5);
    });

    it('findUser is covered with callCount=3', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const f = out.files.find((e) => e.filePath.includes('user-service'));
      const sym = f?.symbols.find((s) => s.name === 'findUser');
      expect(sym).toBeDefined();
      expect(sym!.covered).toBe(true);
      expect(sym!.callCount).toBe(3);
    });

    it('deleteUser is NOT covered (callCount=0)', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const f = out.files.find((e) => e.filePath.includes('user-service'));
      const sym = f?.symbols.find((s) => s.name === 'deleteUser');
      expect(sym).toBeDefined();
      expect(sym!.covered).toBe(false);
      expect(sym!.callCount).toBe(0);
    });

    it('hashPassword is covered with callCount=8', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const f = out.files.find((e) => e.filePath.includes('auth'));
      const sym = f?.symbols.find((s) => s.name === 'hashPassword');
      expect(sym).toBeDefined();
      expect(sym!.covered).toBe(true);
      expect(sym!.callCount).toBe(8);
    });

    it('generateToken is NOT covered (callCount=0)', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const f = out.files.find((e) => e.filePath.includes('auth'));
      const sym = f?.symbols.find((s) => s.name === 'generateToken');
      expect(sym).toBeDefined();
      expect(sym!.covered).toBe(false);
      expect(sym!.callCount).toBe(0);
    });

    it('formatDate is covered with callCount=4', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const f = out.files.find((e) => e.filePath.includes('helpers'));
      const sym = f?.symbols.find((s) => s.name === 'formatDate');
      expect(sym).toBeDefined();
      expect(sym!.covered).toBe(true);
      expect(sym!.callCount).toBe(4);
    });

    it('slugify is NOT covered (callCount=0)', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const f = out.files.find((e) => e.filePath.includes('helpers'));
      const sym = f?.symbols.find((s) => s.name === 'slugify');
      expect(sym).toBeDefined();
      expect(sym!.covered).toBe(false);
      expect(sym!.callCount).toBe(0);
    });

    it('each symbol entry has symbolId, startLine, kind', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      for (const f of out.files) {
        for (const sym of f.symbols) {
          expect(typeof sym.symbolId).toBe('string');
          expect(sym.symbolId.length).toBeGreaterThan(0);
          expect(typeof sym.startLine).toBe('number');
          expect(sym.startLine).toBeGreaterThanOrEqual(1);
          expect(typeof sym.kind).toBe('string');
        }
      }
    });
  });

  // ── Istanbul: uncovered lines ────────────────────────────────────────────────

  describe('Istanbul: uncovered lines', () => {
    it('uncoveredLines not included by default', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      for (const f of out.files) {
        expect(f.uncoveredLines).toBeUndefined();
      }
    });

    it('includeUncoveredLines=true adds uncoveredLines array to each file', async () => {
      const result = await coverageMapHandler({
        repoId,
        coveragePath: istanbulCoveragePath,
        includeUncoveredLines: true,
      });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      for (const f of out.files) {
        expect(Array.isArray(f.uncoveredLines)).toBe(true);
      }
    });

    it('user-service.ts uncoveredLines includes deleteUser lines (20-22)', async () => {
      const result = await coverageMapHandler({
        repoId,
        coveragePath: istanbulCoveragePath,
        includeUncoveredLines: true,
      });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const f = out.files.find((e) => e.filePath.includes('user-service'));
      expect(f).toBeDefined();
      expect(f!.uncoveredLines).toBeDefined();
      // Statements 6,7,8 are on lines 20,21,22 — all uncovered
      expect(f!.uncoveredLines).toContain(20);
      expect(f!.uncoveredLines).toContain(21);
      expect(f!.uncoveredLines).toContain(22);
    });

    it('uncoveredLines are sorted ascending', async () => {
      const result = await coverageMapHandler({
        repoId,
        coveragePath: istanbulCoveragePath,
        includeUncoveredLines: true,
      });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      for (const f of out.files) {
        const lines = f.uncoveredLines ?? [];
        for (let i = 1; i < lines.length; i++) {
          expect(lines[i]).toBeGreaterThanOrEqual(lines[i - 1]);
        }
      }
    });
  });

  // ── Summary ──────────────────────────────────────────────────────────────────

  describe('summary', () => {
    it('totalFiles equals number of matched files in coverage', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.summary.totalFiles).toBe(3);
    });

    it('coveredSymbols + uncoveredSymbols = totalSymbols', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.summary.coveredSymbols + out.summary.uncoveredSymbols).toBe(out.summary.totalSymbols);
    });

    it('avgFunctionCoverage is between 0 and 100', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.summary.avgFunctionCoverage).toBeGreaterThanOrEqual(0);
      expect(out.summary.avgFunctionCoverage).toBeLessThanOrEqual(100);
    });

    it('avgLineCoverage is computed and between 0 and 100', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: istanbulCoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.summary.avgLineCoverage).toBeGreaterThanOrEqual(0);
      expect(out.summary.avgLineCoverage).toBeLessThanOrEqual(100);
    });
  });

  // ── Filters ──────────────────────────────────────────────────────────────────

  describe('scope filter', () => {
    it('scope restricts results to matching directory', async () => {
      const result = await coverageMapHandler({
        repoId,
        coveragePath: istanbulCoveragePath,
        scope: 'src',
      });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      // All 3 fixture files are under src/
      expect(out.files).toHaveLength(3);
      for (const f of out.files) {
        expect(f.filePath).toMatch(/^src/);
      }
    });

    it('scope to nonexistent directory returns 0 files', async () => {
      const result = await coverageMapHandler({
        repoId,
        coveragePath: istanbulCoveragePath,
        scope: 'src/nonexistent',
      });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.files).toHaveLength(0);
    });
  });

  describe('filePath filter', () => {
    it('filePath restricts to a single file', async () => {
      const result = await coverageMapHandler({
        repoId,
        coveragePath: istanbulCoveragePath,
        filePath: 'src/auth.ts',
      });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.files).toHaveLength(1);
      expect(out.files[0].filePath).toContain('auth');
    });

    it('filePath for unknown file returns 0 files', async () => {
      const result = await coverageMapHandler({
        repoId,
        coveragePath: istanbulCoveragePath,
        filePath: 'src/nonexistent.ts',
      });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.files).toHaveLength(0);
    });
  });

  describe('minCoverage filter', () => {
    it('minCoverage=100 returns all files (all have <100% coverage)', async () => {
      const result = await coverageMapHandler({
        repoId,
        coveragePath: istanbulCoveragePath,
        minCoverage: 100,
      });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      // All 3 files have line coverage < 100%
      expect(out.files.length).toBeGreaterThan(0);
      for (const f of out.files) {
        expect(f.lineCoverage).toBeLessThan(100);
      }
    });

    it('minCoverage=0 returns no files (none have <0% coverage)', async () => {
      const result = await coverageMapHandler({
        repoId,
        coveragePath: istanbulCoveragePath,
        minCoverage: 0,
      });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.files).toHaveLength(0);
    });
  });

  // ── Limit and truncation ─────────────────────────────────────────────────────

  describe('limit and truncation', () => {
    it('limit=1 returns at most 1 file', async () => {
      const result = await coverageMapHandler({
        repoId,
        coveragePath: istanbulCoveragePath,
        limit: 1,
      });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.files).toHaveLength(1);
    });

    it('truncated=true when file count exceeds limit', async () => {
      const result = await coverageMapHandler({
        repoId,
        coveragePath: istanbulCoveragePath,
        limit: 1,
      });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      // 3 files > limit=1
      expect(out.truncated).toBe(true);
    });

    it('truncated=false when all files fit within limit', async () => {
      const result = await coverageMapHandler({
        repoId,
        coveragePath: istanbulCoveragePath,
        limit: 100,
      });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.truncated).toBe(false);
    });
  });

  // ── V8 format ────────────────────────────────────────────────────────────────

  describe('V8 format', () => {
    it('returns 1 file from V8 coverage (user-service.ts only)', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: v8CoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.files).toHaveLength(1);
    });

    it('V8: statementCoverage is null (not available in V8)', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: v8CoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.files[0].statementCoverage).toBeNull();
    });

    it('V8: branchCoverage is null (not available in basic V8)', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: v8CoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      expect(out.files[0].branchCoverage).toBeNull();
    });

    it('V8: 3 named functions (createUser, findUser, deleteUser); 2 covered', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: v8CoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const f = out.files[0];
      // top-level is excluded from function count
      expect(f.totalFunctions).toBe(3);
      expect(f.coveredFunctions).toBe(2);
      expect(f.functionCoverage).toBeCloseTo(66.67, 0);
    });

    it('V8: createUser symbol covered (callCount=5)', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: v8CoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const sym = out.files[0].symbols.find((s) => s.name === 'createUser');
      expect(sym).toBeDefined();
      expect(sym!.covered).toBe(true);
      expect(sym!.callCount).toBe(5);
    });

    it('V8: deleteUser symbol NOT covered (callCount=0)', async () => {
      const result = await coverageMapHandler({ repoId, coveragePath: v8CoveragePath });
      const out = parseOutput(result as { content: Array<{ text: string }> });
      const sym = out.files[0].symbols.find((s) => s.name === 'deleteUser');
      expect(sym).toBeDefined();
      expect(sym!.covered).toBe(false);
      expect(sym!.callCount).toBe(0);
    });
  });
});
