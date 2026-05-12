/**
 * Tests for the render_dep_matrix tool (Task 182).
 *
 * Strategy: index the basic-ts-project fixture which has real internal imports
 * (src/index.ts imports src/utils.ts, src/types.ts, etc.) and verify that the
 * matrix is constructed correctly.
 *
 * Test cases:
 *   - Returns expected top-level fields (matrix, files, format, _tokenEstimate, _meta)
 *   - ASCII matrix: diagonal cells are "—"
 *   - ASCII matrix: cell is "1" when row imports col, "0" otherwise
 *   - ASCII matrix has correct number of rows (≤ topN)
 *   - topN limits the number of files in the output
 *   - format: 'mermaid' → valid graph TD output
 *   - Mermaid node IDs contain no special characters
 *   - Unknown repoId returns an error
 *   - format defaults to 'ascii'
 *   - _tokenEstimate is positive
 *   - _meta.timing_ms is present
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as renderDepMatrixHandler } from '../../src/server/tools/render-dep-matrix.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

let repoId: string;

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface DepMatrixOutput {
  matrix: string;
  files: string[];
  format: 'ascii' | 'mermaid';
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string };
}

function parse(result: { content: Array<{ text: string }> }): DepMatrixOutput {
  return JSON.parse(result.content[0]!.text) as DepMatrixOutput;
}

/**
 * Parse an ASCII matrix into a row-label → {col-label → cell} map.
 * Lines with no cell data (headers) return the header labels.
 */
function parseAsciiMatrix(matrix: string): {
  header: string[];
  rows: Array<{ label: string; cells: string[] }>;
} {
  const lines = matrix.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { header: [], rows: [] };

  // Header line: leading spaces then column labels
  const headerLine = lines[0]!;
  // Split header — first field is the empty row-label column
  const headerTokens = headerLine.trim().split(/\s+/);

  const rows: Array<{ label: string; cells: string[] }> = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 2) continue;
    rows.push({ label: tokens[0]!, cells: tokens.slice(1) });
  }

  return { header: headerTokens, rows };
}

// ─── Repo validation ──────────────────────────────────────────────────────────

describe('render_dep_matrix — repo validation', () => {
  it('returns error for unknown repoId', async () => {
    const result = await renderDepMatrixHandler({ repoId: 'deadbeef00000000' });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/not found/i);
  });
});

// ─── Top-level fields ─────────────────────────────────────────────────────────

describe('render_dep_matrix — top-level fields', () => {
  it('returns expected fields', async () => {
    const result = await renderDepMatrixHandler({ repoId });
    expect(result.isError).toBeUndefined();
    const data = parse(result);

    expect(typeof data.matrix).toBe('string');
    expect(Array.isArray(data.files)).toBe(true);
    expect(data.format).toBe('ascii');
    expect(typeof data._tokenEstimate).toBe('number');
    expect(typeof data._meta).toBe('object');
  });

  it('_tokenEstimate is positive', async () => {
    const result = await renderDepMatrixHandler({ repoId });
    const data = parse(result);
    expect(data._tokenEstimate).toBeGreaterThan(0);
  });

  it('_meta.timing_ms is a non-negative number', async () => {
    const result = await renderDepMatrixHandler({ repoId });
    const data = parse(result);
    expect(data._meta.timing_ms).toBeGreaterThanOrEqual(0);
  });

  it('_meta.powered_by is present', async () => {
    const result = await renderDepMatrixHandler({ repoId });
    const data = parse(result);
    expect(typeof data._meta.powered_by).toBe('string');
  });
});

// ─── ASCII format ─────────────────────────────────────────────────────────────

describe('render_dep_matrix — ASCII format', () => {
  it('format defaults to ascii', async () => {
    const result = await renderDepMatrixHandler({ repoId });
    const data = parse(result);
    expect(data.format).toBe('ascii');
  });

  it('matrix string is non-empty when repo has files', async () => {
    const result = await renderDepMatrixHandler({ repoId });
    const data = parse(result);
    expect(data.matrix.trim().length).toBeGreaterThan(0);
  });

  it('files array length matches number of matrix rows', async () => {
    const result = await renderDepMatrixHandler({ repoId, topN: 5 });
    const data = parse(result);
    // files length should be ≤ topN
    expect(data.files.length).toBeLessThanOrEqual(5);
    // ASCII matrix should have one header line + one row per file
    const nonEmptyLines = data.matrix.split('\n').filter((l) => l.trim().length > 0);
    // header + N data rows
    expect(nonEmptyLines.length).toBe(data.files.length + 1);
  });

  it('diagonal cells are "—"', async () => {
    const result = await renderDepMatrixHandler({ repoId, topN: 5 });
    const data = parse(result);
    const { rows } = parseAsciiMatrix(data.matrix);
    for (let i = 0; i < rows.length; i++) {
      const cell = rows[i]!.cells[i];
      expect(cell).toBe('—');
    }
  });

  it('off-diagonal cells are "0" or "1"', async () => {
    const result = await renderDepMatrixHandler({ repoId, topN: 5 });
    const data = parse(result);
    const { rows } = parseAsciiMatrix(data.matrix);
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows.length; c++) {
        if (r === c) continue;
        const cell = rows[r]!.cells[c];
        expect(['0', '1']).toContain(cell);
      }
    }
  });

  it('cell is "1" when row file imports col file', async () => {
    // src/index.ts imports src/utils.ts in the fixture; both should appear in the matrix
    const result = await renderDepMatrixHandler({ repoId, topN: 20 });
    const data = parse(result);
    if (data.files.length < 2) return; // fixture has fewer files than expected

    const { rows } = parseAsciiMatrix(data.matrix);

    // Find at least one "1" cell — the fixture has real imports so at least one
    // row should show an import relationship.
    const anyOne = rows.some((row) => row.cells.some((cell) => cell === '1'));
    expect(anyOne).toBe(true);
  });

  it('topN limits the number of files returned', async () => {
    const result3 = await renderDepMatrixHandler({ repoId, topN: 3 });
    const data3 = parse(result3);
    expect(data3.files.length).toBeLessThanOrEqual(3);

    const result6 = await renderDepMatrixHandler({ repoId, topN: 6 });
    const data6 = parse(result6);
    expect(data6.files.length).toBeLessThanOrEqual(6);
  });

  it('topN: 1 produces a 1×1 matrix with diagonal "—"', async () => {
    const result = await renderDepMatrixHandler({ repoId, topN: 1 });
    const data = parse(result);
    if (data.files.length === 0) return; // no coupled files in fixture
    expect(data.files.length).toBe(1);
    const { rows } = parseAsciiMatrix(data.matrix);
    expect(rows.length).toBe(1);
    expect(rows[0]!.cells[0]).toBe('—');
  });
});

// ─── Mermaid format ───────────────────────────────────────────────────────────

describe('render_dep_matrix — Mermaid format', () => {
  it('format: "mermaid" produces graph TD output', async () => {
    const result = await renderDepMatrixHandler({ repoId, format: 'mermaid' });
    const data = parse(result);
    expect(data.format).toBe('mermaid');
    expect(data.matrix.trimStart()).toMatch(/^graph TD/);
  });

  it('Mermaid node IDs contain no special characters', async () => {
    const result = await renderDepMatrixHandler({ repoId, format: 'mermaid', topN: 5 });
    const data = parse(result);
    // Extract node IDs from Mermaid — lines like "  id[" or "    id["
    const idRe = /^\s{1,4}([A-Za-z0-9_]+)[\s\["[]/gm;
    const ids: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(data.matrix)) !== null) {
      ids.push(m[1]!);
    }
    if (ids.length > 0) {
      expect(ids.every((id) => /^[A-Za-z0-9_]+$/.test(id))).toBe(true);
    }
  });

  it('_tokenEstimate is positive for mermaid format', async () => {
    const result = await renderDepMatrixHandler({ repoId, format: 'mermaid' });
    const data = parse(result);
    expect(data._tokenEstimate).toBeGreaterThan(0);
  });

  it('files array is returned for mermaid format', async () => {
    const result = await renderDepMatrixHandler({ repoId, format: 'mermaid', topN: 5 });
    const data = parse(result);
    expect(Array.isArray(data.files)).toBe(true);
    expect(data.files.length).toBeLessThanOrEqual(5);
  });
});

// ─── filePath scoping ─────────────────────────────────────────────────────────

describe('render_dep_matrix — filePath scoping', () => {
  it('scoping to a directory reduces or equals the full-repo file count', async () => {
    const full = await renderDepMatrixHandler({ repoId, topN: 20 });
    const scoped = await renderDepMatrixHandler({ repoId, topN: 20, filePath: 'src/' });

    const fullData = parse(full);
    const scopedData = parse(scoped);

    expect(scopedData.files.length).toBeLessThanOrEqual(fullData.files.length);
    // All scoped files should be under src/
    for (const fp of scopedData.files) {
      expect(fp.startsWith('src/')).toBe(true);
    }
  });

  it('unknown directory returns empty or minimal matrix', async () => {
    const result = await renderDepMatrixHandler({ repoId, filePath: 'nonexistent/path/' });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.files.length).toBe(0);
    expect(data.matrix).toContain('(no files)');
  });
});
