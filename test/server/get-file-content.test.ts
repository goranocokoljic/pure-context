/**
 * Tests for the get_file_content tool (Task 132).
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
import { handler as getFileContentHandler } from '../../src/server/tools/get-file-content.js';
import { FileNotCachedError } from '../../src/core/errors.js';

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

interface FileContentResult {
  filePath: string;
  totalLines: number;
  returnedLines: number;
  content: string;
  _meta: {
    timing_ms: number;
    tokens_saved?: number;
    truncated?: boolean;
    truncated_at_line?: number;
  };
}

function parseResult(result: { content: { text: string }[] }): FileContentResult {
  return JSON.parse(result.content[0].text) as FileContentResult;
}

// ─── get_file_content ─────────────────────────────────────────────────────────

describe('get_file_content', () => {
  it('retrieves full file content', () => {
    const result = getFileContentHandler({ repoId, filePath: 'src/utils.ts' });
    const data = parseResult(result);

    expect(data.filePath).toBe('src/utils.ts');
    expect(data.totalLines).toBeGreaterThan(0);
    expect(data.returnedLines).toBe(data.totalLines);
    expect(data.content.length).toBeGreaterThan(0);
  });

  it('slices by startLine only', () => {
    const full = parseResult(getFileContentHandler({ repoId, filePath: 'src/utils.ts' }));
    const sliced = parseResult(
      getFileContentHandler({ repoId, filePath: 'src/utils.ts', startLine: 3 }),
    );

    expect(sliced.returnedLines).toBe(full.totalLines - 2);
  });

  it('slices by endLine only', () => {
    const sliced = parseResult(
      getFileContentHandler({ repoId, filePath: 'src/utils.ts', endLine: 5 }),
    );

    expect(sliced.returnedLines).toBe(5);
  });

  it('slices by both startLine and endLine', () => {
    const sliced = parseResult(
      getFileContentHandler({
        repoId,
        filePath: 'src/utils.ts',
        startLine: 2,
        endLine: 6,
      }),
    );

    expect(sliced.returnedLines).toBe(5);
  });

  it('adds line number prefixes when withLineNumbers is true (default)', () => {
    const result = getFileContentHandler({
      repoId,
      filePath: 'src/utils.ts',
      startLine: 1,
      endLine: 3,
    });
    const data = parseResult(result);

    // Each line should be prefixed with a number and │
    const lines = data.content.split('\n');
    for (const line of lines) {
      expect(line).toMatch(/^\s*\d+ │ /);
    }
  });

  it('omits line number prefixes when withLineNumbers is false', () => {
    const result = getFileContentHandler({
      repoId,
      filePath: 'src/utils.ts',
      startLine: 1,
      endLine: 3,
      withLineNumbers: false,
    });
    const data = parseResult(result);

    const lines = data.content.split('\n');
    for (const line of lines) {
      expect(line).not.toMatch(/^\s*\d+ │ /);
    }
  });

  it('line numbers correspond to correct position in full file', () => {
    const full = parseResult(
      getFileContentHandler({ repoId, filePath: 'src/utils.ts', withLineNumbers: false }),
    );
    const sliced = parseResult(
      getFileContentHandler({
        repoId,
        filePath: 'src/utils.ts',
        startLine: 2,
        endLine: 4,
        withLineNumbers: true,
      }),
    );

    const fullLines = full.content.split('\n');
    const slicedLines = sliced.content.split('\n');

    // Each sliced line should carry line numbers 2, 3, 4
    for (let i = 0; i < slicedLines.length; i++) {
      const expectedLineNum = i + 2;
      expect(slicedLines[i]).toContain(`${expectedLineNum} │ `);
      // The content after the prefix should match the corresponding full-file line
      const contentPart = slicedLines[i].replace(/^\s*\d+ │ /, '');
      expect(contentPart).toBe(fullLines[i + 1]);
    }
  });

  it('rejects path traversal attempts', () => {
    expect(() =>
      getFileContentHandler({ repoId, filePath: '../outside/secret.ts' }),
    ).toThrow(FileNotCachedError);
  });

  it('throws FileNotCachedError for an unindexed file', () => {
    expect(() =>
      getFileContentHandler({ repoId, filePath: 'src/does-not-exist.ts' }),
    ).toThrow(FileNotCachedError);
  });

  it('max-lines truncation sets truncated flag in _meta', () => {
    // Override limit to a very small number for this test
    const originalEnv = process.env['MAX_FILE_CONTENT_LINES'];
    process.env['MAX_FILE_CONTENT_LINES'] = '2';

    try {
      const result = getFileContentHandler({ repoId, filePath: 'src/utils.ts' });
      const data = parseResult(result);

      // Only 2 lines should be returned and truncation should be flagged
      expect(data.returnedLines).toBe(2);
      expect(data._meta.truncated).toBe(true);
      expect(data._meta.truncated_at_line).toBe(2);
    } finally {
      if (originalEnv === undefined) {
        delete process.env['MAX_FILE_CONTENT_LINES'];
      } else {
        process.env['MAX_FILE_CONTENT_LINES'] = originalEnv;
      }
    }
  });

  it('returns _meta with timing and token savings', () => {
    const result = getFileContentHandler({ repoId, filePath: 'src/utils.ts' });
    const data = parseResult(result);

    expect(typeof data._meta.timing_ms).toBe('number');
    expect(data._meta.timing_ms).toBeGreaterThanOrEqual(0);
    expect(typeof data._meta.tokens_saved).toBe('number');
  });
});
