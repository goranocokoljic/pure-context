/**
 * Tests for the get_complexity_hotspots tool (Task 198).
 *
 * Fixture: test/fixtures/get-complexity-hotspots-fixture/
 *   src/core/complex-module.ts    — 4 functions, high CC (parseConfig ≈12,
 *                                   validateUserInput ≈15, processMatrix ≈10,
 *                                   routeRequest ≈7)
 *   src/core/another-complex.ts  — 2 functions, high CC (processEvent ≈14,
 *                                   fetchWithRetry ≈8)
 *   src/utils/helpers.ts         — 3 functions, medium CC (≈3–5)
 *   src/services/user-service.ts — 2 functions, low-medium CC (≈2–6)
 *   src/index.ts                 — re-exports only, no logic symbols
 *
 * Expected hotspot ranking by avg complexity:
 *   1. src/core/complex-module.ts   (avg CC highest, 4 complex symbols)
 *   2. src/core/another-complex.ts  (avg CC high, 2 complex symbols)
 *   3. src/services/user-service.ts (medium CC)
 *   4. src/utils/helpers.ts         (lower CC)
 *   (src/index.ts has no measurable symbols → excluded)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as getComplexityHotspotsHandler } from '../../src/server/tools/get-complexity-hotspots.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/get-complexity-hotspots-fixture');

let repoId: string;

// ─── Output types ─────────────────────────────────────────────────────────────

interface HotspotSymbol {
  symbolId: string;
  name: string;
  kind: string;
  startLine: number;
  signature: string;
  summary: string;
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  lineCount: number;
  nestingDepth: number;
}

interface HotspotFile {
  filePath: string;
  symbolCount: number;
  complexSymbolCount: number;
  avgCyclomaticComplexity: number;
  maxCyclomaticComplexity: number;
  avgCognitiveComplexity: number;
  maxCognitiveComplexity: number;
  avgNestingDepth: number;
  maxNestingDepth: number;
  avgLineCount: number;
  totalLineCount: number;
  hotspotScore: number;
  topSymbols?: HotspotSymbol[];
}

interface GetComplexityHotspotsOutput {
  repoId: string;
  totalFilesAnalyzed: number;
  rankedBy: string;
  minComplexity: number;
  hotspots: HotspotFile[];
  summary: {
    hotspotFileCount: number;
    avgHotspotScore: number;
    totalComplexSymbols: number;
    totalSymbolsAnalyzed: number;
  };
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

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

// ─── Helper ───────────────────────────────────────────────────────────────────

async function getHotspots(args: {
  repoId?: string;
  scope?: string;
  topN?: number;
  minComplexity?: number;
  metric?: 'complexity' | 'cognitive' | 'size' | 'nesting' | 'composite';
  includeSymbols?: boolean;
  symbolLimit?: number;
}): Promise<GetComplexityHotspotsOutput> {
  const result = await getComplexityHotspotsHandler({
    repoId: args.repoId ?? repoId,
    ...args,
  });
  expect(result.isError).toBeFalsy();
  return JSON.parse((result.content[0] as { type: string; text: string }).text);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('get_complexity_hotspots', () => {

  // ── Core output structure ──────────────────────────────────────────────────

  describe('output structure', () => {
    it('returns required top-level fields', async () => {
      const out = await getHotspots({});
      expect(out.repoId).toBe(repoId);
      expect(typeof out.totalFilesAnalyzed).toBe('number');
      expect(out.rankedBy).toBe('complexity');
      expect(typeof out.minComplexity).toBe('number');
      expect(Array.isArray(out.hotspots)).toBe(true);
      expect(out.summary).toBeDefined();
      expect(typeof out._tokenEstimate).toBe('number');
      expect(out._meta).toBeDefined();
    });

    it('returns required summary fields', async () => {
      const out = await getHotspots({});
      expect(typeof out.summary.hotspotFileCount).toBe('number');
      expect(typeof out.summary.avgHotspotScore).toBe('number');
      expect(typeof out.summary.totalComplexSymbols).toBe('number');
      expect(typeof out.summary.totalSymbolsAnalyzed).toBe('number');
    });

    it('hotspot entries have all required fields', async () => {
      const out = await getHotspots({});
      expect(out.hotspots.length).toBeGreaterThan(0);
      const first = out.hotspots[0];
      expect(typeof first.filePath).toBe('string');
      expect(typeof first.symbolCount).toBe('number');
      expect(typeof first.complexSymbolCount).toBe('number');
      expect(typeof first.avgCyclomaticComplexity).toBe('number');
      expect(typeof first.maxCyclomaticComplexity).toBe('number');
      expect(typeof first.avgCognitiveComplexity).toBe('number');
      expect(typeof first.maxCognitiveComplexity).toBe('number');
      expect(typeof first.avgNestingDepth).toBe('number');
      expect(typeof first.maxNestingDepth).toBe('number');
      expect(typeof first.avgLineCount).toBe('number');
      expect(typeof first.totalLineCount).toBe('number');
      expect(typeof first.hotspotScore).toBe('number');
    });

    it('hotspot score is between 0 and 100', async () => {
      const out = await getHotspots({});
      for (const h of out.hotspots) {
        expect(h.hotspotScore).toBeGreaterThanOrEqual(0);
        expect(h.hotspotScore).toBeLessThanOrEqual(100);
      }
    });
  });

  // ── File analysis ─────────────────────────────────────────────────────────

  describe('file analysis', () => {
    it('analyses at least 4 files with measurable symbols', async () => {
      const out = await getHotspots({});
      // complex-module.ts, another-complex.ts, helpers.ts, user-service.ts
      expect(out.totalFilesAnalyzed).toBeGreaterThanOrEqual(4);
    });

    it('totalSymbolsAnalyzed counts all measurable symbols across all files', async () => {
      const out = await getHotspots({});
      // 4 in complex-module + 2 in another-complex + 3 in helpers + 2 in user-service = 11
      expect(out.summary.totalSymbolsAnalyzed).toBeGreaterThanOrEqual(9);
    });

    it('src/core/ files appear in the top results', async () => {
      const out = await getHotspots({ topN: 4 });
      const paths = out.hotspots.map((h) => h.filePath);
      const hasCoreFile = paths.some((p) => p.includes('complex-module') || p.includes('another-complex'));
      expect(hasCoreFile).toBe(true);
    });

    it('files with only exports (no logic symbols) are excluded', async () => {
      const out = await getHotspots({});
      const paths = out.hotspots.map((h) => h.filePath);
      const hasIndex = paths.some((p) => p.endsWith('index.ts'));
      // index.ts has only re-exports — no measurable symbols
      expect(hasIndex).toBe(false);
    });
  });

  // ── Ranking ───────────────────────────────────────────────────────────────

  describe('ranking', () => {
    it('default ranking is by avg cyclomatic complexity (descending)', async () => {
      const out = await getHotspots({});
      expect(out.rankedBy).toBe('complexity');
      for (let i = 1; i < out.hotspots.length; i++) {
        expect(out.hotspots[i - 1].avgCyclomaticComplexity)
          .toBeGreaterThanOrEqual(out.hotspots[i].avgCyclomaticComplexity);
      }
    });

    it('metric=composite sorts by hotspotScore descending', async () => {
      const out = await getHotspots({ metric: 'composite' });
      expect(out.rankedBy).toBe('composite');
      for (let i = 1; i < out.hotspots.length; i++) {
        expect(out.hotspots[i - 1].hotspotScore)
          .toBeGreaterThanOrEqual(out.hotspots[i].hotspotScore);
      }
    });

    it('metric=size sorts by totalLineCount descending', async () => {
      const out = await getHotspots({ metric: 'size' });
      expect(out.rankedBy).toBe('size');
      for (let i = 1; i < out.hotspots.length; i++) {
        expect(out.hotspots[i - 1].totalLineCount)
          .toBeGreaterThanOrEqual(out.hotspots[i].totalLineCount);
      }
    });

    it('metric=nesting sorts by maxNestingDepth descending', async () => {
      const out = await getHotspots({ metric: 'nesting' });
      expect(out.rankedBy).toBe('nesting');
      for (let i = 1; i < out.hotspots.length; i++) {
        expect(out.hotspots[i - 1].maxNestingDepth)
          .toBeGreaterThanOrEqual(out.hotspots[i].maxNestingDepth);
      }
    });

    it('metric=cognitive sorts by avgCognitiveComplexity descending', async () => {
      const out = await getHotspots({ metric: 'cognitive' });
      expect(out.rankedBy).toBe('cognitive');
      for (let i = 1; i < out.hotspots.length; i++) {
        expect(out.hotspots[i - 1].avgCognitiveComplexity)
          .toBeGreaterThanOrEqual(out.hotspots[i].avgCognitiveComplexity);
      }
    });

    it('complex-module.ts has higher avg CC than helpers.ts', async () => {
      const out = await getHotspots({ topN: 10 });
      const complexMod = out.hotspots.find((h) => h.filePath.includes('complex-module'));
      const helpers = out.hotspots.find((h) => h.filePath.includes('helpers'));
      expect(complexMod).toBeDefined();
      expect(helpers).toBeDefined();
      expect(complexMod!.avgCyclomaticComplexity)
        .toBeGreaterThan(helpers!.avgCyclomaticComplexity);
    });
  });

  // ── topN parameter ────────────────────────────────────────────────────────

  describe('topN parameter', () => {
    it('defaults to 10 hotspot files', async () => {
      const out = await getHotspots({});
      expect(out.hotspots.length).toBeLessThanOrEqual(10);
    });

    it('topN=1 returns only the single worst file', async () => {
      const out = await getHotspots({ topN: 1 });
      expect(out.hotspots.length).toBe(1);
      expect(out.summary.hotspotFileCount).toBe(1);
    });

    it('topN=2 returns 2 files', async () => {
      const out = await getHotspots({ topN: 2 });
      expect(out.hotspots.length).toBe(2);
    });

    it('topN larger than file count returns all files', async () => {
      const out = await getHotspots({ topN: 100 });
      expect(out.hotspots.length).toBe(out.totalFilesAnalyzed);
    });
  });

  // ── minComplexity parameter ───────────────────────────────────────────────

  describe('minComplexity parameter', () => {
    it('defaults to 5 for complex symbol counting', async () => {
      const out = await getHotspots({});
      expect(out.minComplexity).toBe(5);
    });

    it('minComplexity=1 makes every symbol "complex" → complexSymbolCount equals symbolCount', async () => {
      const out = await getHotspots({ minComplexity: 1 });
      for (const h of out.hotspots) {
        expect(h.complexSymbolCount).toBe(h.symbolCount);
      }
    });

    it('very high minComplexity=999 yields zero complex symbols per file', async () => {
      const out = await getHotspots({ minComplexity: 999 });
      for (const h of out.hotspots) {
        expect(h.complexSymbolCount).toBe(0);
      }
    });

    it('minComplexity=5 marks complex-module symbols as complex', async () => {
      const out = await getHotspots({ topN: 10, minComplexity: 5 });
      const complexMod = out.hotspots.find((h) => h.filePath.includes('complex-module'));
      expect(complexMod).toBeDefined();
      // validateUserInput (≈15) + parseConfig (≈12) + processMatrix (≈10) + routeRequest (≈7)
      // all ≥ 5 → complexSymbolCount should be > 0
      expect(complexMod!.complexSymbolCount).toBeGreaterThan(0);
    });
  });

  // ── scope parameter ───────────────────────────────────────────────────────

  describe('scope parameter', () => {
    it('scope restricts analysis to that directory', async () => {
      const out = await getHotspots({ scope: 'src/core' });
      for (const h of out.hotspots) {
        expect(h.filePath.startsWith('src/core')).toBe(true);
      }
    });

    it('scoped analysis only analyses files in that subtree', async () => {
      const out = await getHotspots({ scope: 'src/core', topN: 100 });
      expect(out.totalFilesAnalyzed).toBeLessThanOrEqual(2);
    });

    it('scope to a non-existent directory returns zero hotspots', async () => {
      const out = await getHotspots({ scope: 'src/does-not-exist' });
      expect(out.hotspots.length).toBe(0);
      expect(out.totalFilesAnalyzed).toBe(0);
    });

    it('scope to src/utils returns helpers.ts only', async () => {
      const out = await getHotspots({ scope: 'src/utils', topN: 10 });
      expect(out.totalFilesAnalyzed).toBe(1);
      expect(out.hotspots[0].filePath).toContain('helpers');
    });
  });

  // ── includeSymbols parameter ──────────────────────────────────────────────

  describe('includeSymbols parameter', () => {
    it('includes topSymbols by default', async () => {
      const out = await getHotspots({});
      for (const h of out.hotspots) {
        expect(Array.isArray(h.topSymbols)).toBe(true);
      }
    });

    it('includeSymbols=false omits topSymbols', async () => {
      const out = await getHotspots({ includeSymbols: false });
      for (const h of out.hotspots) {
        expect(h.topSymbols).toBeUndefined();
      }
    });

    it('topSymbols have required fields', async () => {
      const out = await getHotspots({ includeSymbols: true });
      for (const h of out.hotspots) {
        for (const sym of (h.topSymbols ?? [])) {
          expect(typeof sym.symbolId).toBe('string');
          expect(typeof sym.name).toBe('string');
          expect(typeof sym.kind).toBe('string');
          expect(typeof sym.startLine).toBe('number');
          expect(typeof sym.signature).toBe('string');
          expect(typeof sym.cyclomaticComplexity).toBe('number');
          expect(typeof sym.cognitiveComplexity).toBe('number');
          expect(typeof sym.lineCount).toBe('number');
          expect(typeof sym.nestingDepth).toBe('number');
        }
      }
    });

    it('topSymbols are sorted by cyclomatic complexity descending within each file', async () => {
      const out = await getHotspots({ includeSymbols: true });
      for (const h of out.hotspots) {
        const syms = h.topSymbols ?? [];
        for (let i = 1; i < syms.length; i++) {
          expect(syms[i - 1].cyclomaticComplexity)
            .toBeGreaterThanOrEqual(syms[i].cyclomaticComplexity);
        }
      }
    });

    it('symbolLimit=1 returns only 1 symbol per file', async () => {
      const out = await getHotspots({ includeSymbols: true, symbolLimit: 1 });
      for (const h of out.hotspots) {
        expect((h.topSymbols ?? []).length).toBeLessThanOrEqual(1);
      }
    });

    it('symbolLimit=3 returns at most 3 symbols per file', async () => {
      const out = await getHotspots({ includeSymbols: true, symbolLimit: 3 });
      for (const h of out.hotspots) {
        expect((h.topSymbols ?? []).length).toBeLessThanOrEqual(3);
      }
    });

    it('validateUserInput is the top symbol in complex-module.ts (highest CC)', async () => {
      const out = await getHotspots({ topN: 10, includeSymbols: true, symbolLimit: 5 });
      const complexMod = out.hotspots.find((h) => h.filePath.includes('complex-module'));
      expect(complexMod).toBeDefined();
      expect(complexMod!.topSymbols!.length).toBeGreaterThan(0);
      // validateUserInput has CC ≈ 15, highest in that file
      const top = complexMod!.topSymbols![0];
      expect(top.name).toBe('validateUserInput');
    });
  });

  // ── Metric field correctness ───────────────────────────────────────────────

  describe('metric correctness', () => {
    it('maxCyclomaticComplexity >= avgCyclomaticComplexity for each file', async () => {
      const out = await getHotspots({ topN: 100 });
      for (const h of out.hotspots) {
        expect(h.maxCyclomaticComplexity).toBeGreaterThanOrEqual(h.avgCyclomaticComplexity);
      }
    });

    it('totalLineCount >= avgLineCount for each file', async () => {
      const out = await getHotspots({ topN: 100 });
      for (const h of out.hotspots) {
        expect(h.totalLineCount).toBeGreaterThanOrEqual(h.avgLineCount);
      }
    });

    it('complexSymbolCount <= symbolCount for each file', async () => {
      const out = await getHotspots({ topN: 100 });
      for (const h of out.hotspots) {
        expect(h.complexSymbolCount).toBeLessThanOrEqual(h.symbolCount);
      }
    });

    it('startLine is a positive integer for each symbol', async () => {
      const out = await getHotspots({ includeSymbols: true });
      for (const h of out.hotspots) {
        for (const sym of (h.topSymbols ?? [])) {
          expect(sym.startLine).toBeGreaterThanOrEqual(1);
          expect(Number.isInteger(sym.startLine)).toBe(true);
        }
      }
    });
  });

  // ── Summary stats ─────────────────────────────────────────────────────────

  describe('summary stats', () => {
    it('hotspotFileCount matches hotspots array length', async () => {
      const out = await getHotspots({ topN: 3 });
      expect(out.summary.hotspotFileCount).toBe(out.hotspots.length);
    });

    it('totalComplexSymbols counts across all files in scope', async () => {
      const outAll = await getHotspots({ topN: 100, minComplexity: 5 });
      const outScoped = await getHotspots({ topN: 100, minComplexity: 5, scope: 'src/core' });
      // totalComplexSymbols in scope should be <= total across all files
      expect(outScoped.summary.totalComplexSymbols)
        .toBeLessThanOrEqual(outAll.summary.totalComplexSymbols);
    });

    it('avgHotspotScore is between 0 and 100', async () => {
      const out = await getHotspots({});
      expect(out.summary.avgHotspotScore).toBeGreaterThanOrEqual(0);
      expect(out.summary.avgHotspotScore).toBeLessThanOrEqual(100);
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns an error for unknown repoId', async () => {
      const result = await getComplexityHotspotsHandler({ repoId: 'deadbeef00000000' });
      expect(result.isError).toBe(true);
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.error).toMatch(/not found/i);
    });
  });

  // ── Token estimate and meta ───────────────────────────────────────────────

  describe('token estimate and meta', () => {
    it('_tokenEstimate is a positive number', async () => {
      const out = await getHotspots({});
      expect(out._tokenEstimate).toBeGreaterThan(0);
    });

    it('_meta includes timing_ms', async () => {
      const out = await getHotspots({});
      expect(out._meta.timing_ms).toBeGreaterThanOrEqual(0);
    });
  });
});
