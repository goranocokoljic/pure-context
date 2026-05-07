/**
 * Tests for the find_references tool (Task 131).
 *
 * Strategy: index the basic-ts-project fixture once in beforeAll,
 * then run all assertions against the resulting DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as findReferencesHandler } from '../../src/server/tools/find-references.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

// ─── Setup ────────────────────────────────────────────────────────────────────

let repoId: string;

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  const result = await indexFolder(FIXTURE, { fileLimit: 50 });
  repoId = result.repoId;

  expect(result.symbolsFound).toBeGreaterThan(0);
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseResult(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text) as {
    identifier: string;
    totalFiles: number;
    references: {
      filePath: string;
      lineNumber: number;
      lineContent: string;
      symbolContext?: string;
    }[];
    _meta: { timing_ms: number; tokens_saved?: number };
  };
}

// ─── find_references ──────────────────────────────────────────────────────────

describe('find_references', () => {
  it('finds references in multiple files', () => {
    // formatDiagnostic is defined in src/utils.ts and used in src/index.ts
    const result = findReferencesHandler({
      repoId,
      identifier: 'formatDiagnostic',
      includeDefinition: true,
    });
    const data = parseResult(result);

    expect(data.identifier).toBe('formatDiagnostic');
    // Should appear in at least 2 files: definition (utils.ts) + usage (index.ts)
    expect(data.totalFiles).toBeGreaterThanOrEqual(2);
    expect(data.references.length).toBeGreaterThanOrEqual(2);
  });

  it('excludes definition file when includeDefinition is false (default)', () => {
    const result = findReferencesHandler({
      repoId,
      identifier: 'formatDiagnostic',
      includeDefinition: false,
    });
    const data = parseResult(result);

    // utils.ts defines formatDiagnostic — should be excluded
    const defFile = data.references.find((r) => r.filePath.endsWith('utils.ts'));
    expect(defFile).toBeUndefined();

    // index.ts uses it — should still appear
    const usageFile = data.references.find((r) => r.filePath.endsWith('index.ts'));
    expect(usageFile).toBeDefined();
  });

  it('defaults to includeDefinition: false when omitted', () => {
    const result = findReferencesHandler({ repoId, identifier: 'formatDiagnostic' });
    const data = parseResult(result);

    const defFile = data.references.find((r) => r.filePath.endsWith('utils.ts'));
    expect(defFile).toBeUndefined();
  });

  it('word-boundary matching — does not match partial names', () => {
    // Searching for 'format' should NOT match 'formatDiagnostic'
    const result = findReferencesHandler({
      repoId,
      identifier: 'format',
      includeDefinition: true,
    });
    const data = parseResult(result);

    const hasPartialMatch = data.references.some((r) =>
      r.lineContent.includes('formatDiagnostic') && !r.lineContent.includes(' format '),
    );
    expect(hasPartialMatch).toBe(false);
  });

  it('kind filter affects definition exclusion', () => {
    // filterBySeverity is a function; with kind: 'function' it should be excluded from results
    const withKind = findReferencesHandler({
      repoId,
      identifier: 'filterBySeverity',
      kind: 'function',
      includeDefinition: false,
    });
    const withKindData = parseResult(withKind);
    const defFileWithKind = withKindData.references.find((r) => r.filePath.endsWith('utils.ts'));
    expect(defFileWithKind).toBeUndefined();

    // With a wrong kind (e.g. 'class'), the utils.ts definition is NOT excluded
    // because the symbol is a 'function', not a 'class'
    const wrongKind = findReferencesHandler({
      repoId,
      identifier: 'filterBySeverity',
      kind: 'class',
      includeDefinition: false,
    });
    const wrongKindData = parseResult(wrongKind);
    const defFileWrongKind = wrongKindData.references.find((r) => r.filePath.endsWith('utils.ts'));
    expect(defFileWrongKind).toBeDefined();
  });

  it('returns _meta with timing and token savings', () => {
    const result = findReferencesHandler({ repoId, identifier: 'formatDiagnostic' });
    const data = parseResult(result);

    expect(typeof data._meta.timing_ms).toBe('number');
    expect(data._meta.timing_ms).toBeGreaterThanOrEqual(0);
    expect(typeof data._meta.tokens_saved).toBe('number');
  });

  it('reference includes lineNumber and lineContent', () => {
    const result = findReferencesHandler({
      repoId,
      identifier: 'formatDiagnostic',
      includeDefinition: false,
    });
    const data = parseResult(result);

    for (const ref of data.references) {
      expect(typeof ref.lineNumber).toBe('number');
      expect(ref.lineNumber).toBeGreaterThan(0);
      expect(typeof ref.lineContent).toBe('string');
      expect(ref.lineContent.length).toBeGreaterThan(0);
      // lineContent must contain the identifier
      expect(ref.lineContent).toMatch(/formatDiagnostic/);
    }
  });

  it('symbolContext identifies the enclosing function or method', () => {
    const result = findReferencesHandler({
      repoId,
      identifier: 'formatDiagnostic',
      includeDefinition: false,
    });
    const data = parseResult(result);

    // In index.ts, formatDiagnostic is used inside DiagnosticRunner.getReport
    // (TypeScript handler stores method symbols with qualified names)
    const inGetReport = data.references.find(
      (r) =>
        r.filePath.endsWith('index.ts') &&
        r.symbolContext !== undefined &&
        r.symbolContext.includes('getReport'),
    );
    expect(inGetReport).toBeDefined();
  });

  it('returns empty references for an unknown identifier', () => {
    const result = findReferencesHandler({
      repoId,
      identifier: 'xyzNotDefinedAnywhere123',
    });
    const data = parseResult(result);

    expect(data.totalFiles).toBe(0);
    expect(data.references).toHaveLength(0);
  });
});
