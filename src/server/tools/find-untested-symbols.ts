/**
 * find-untested-symbols.ts
 *
 * MCP tool: find_untested_symbols
 *
 * Identifies exported symbols (functions, methods, classes, etc.) in the
 * codebase that do not appear to have any test coverage — i.e. whose names
 * are not referenced in any test file.
 *
 * Detection strategy (static heuristic):
 *   1. Identify test files by path convention:
 *      - Path segment is "test", "tests", "spec", "specs", or "__tests__"
 *      - Filename ends with .test.*, .spec.*, _test.*, or _spec.*
 *   2. Extract all identifiers referenced in those test files.
 *   3. Any non-test symbol whose name does NOT appear in the test identifier
 *      set is considered "untested".
 *
 * Limitations:
 *   - Name-based matching only; dynamic dispatch, aliases, and indirect calls
 *     can produce false negatives (symbol appears tested when it is not) or
 *     false positives (common names like `get` match unrelated things).
 *   - Does not read coverage reports; for accurate coverage, pipe in a
 *     coverage JSON file via get_test_coverage_map instead.
 *
 * Priority rating (per untested symbol):
 *   high   — cyclomatic_complexity >= 5 OR line_count >= 20
 *   medium — cyclomatic_complexity >= 2 OR line_count >= 8
 *   low    — all other symbols
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SymbolKind } from '../../core/types.js';
import { isTestFilePath as isTestFile } from '../../core/test-paths.js';
import { byteOffsetToLine } from './symbol-lines.js';

export const name = 'find_untested_symbols';

export const description =
  'Identify symbols (functions, methods, classes) that do not appear to have ' +
  'test coverage by scanning test files for references to each symbol name. ' +
  'Returns a prioritised list of untested symbols ranked by cyclomatic ' +
  'complexity so you can focus testing effort where it matters most.' +
  '\n\nDetection strategy: static heuristic — symbol name must appear as an ' +
  'identifier in at least one test file (path-based detection). ' +
  'This is not a coverage-report parser; use get_test_coverage_map for ' +
  'line-level accuracy.' +
  '\n\nDiffers from related tools:' +
  '\n  find_dead_code        — exports with no importers (unused API)' +
  '\n  get_test_coverage_map — line-level coverage from a coverage JSON report' +
  '\n  get_complexity_hotspots — complexity ranking without test-coverage filter';

// ─── Default testable kinds ────────────────────────────────────────────────────

const DEFAULT_KINDS: SymbolKind[] = ['function', 'method', 'class', 'interface', 'middleware', 'route'];

// ─── Input schema ──────────────────────────────────────────────────────────────

export const inputSchema = {
  repoId: z.string().describe('Repository ID returned by index_folder or list_repos'),
  scope: z
    .string()
    .optional()
    .describe(
      'Restrict analysis to a directory prefix (e.g. "src/services/"). ' +
      'Omit to analyse the whole repo.',
    ),
  kinds: z
    .array(z.string())
    .optional()
    .describe(
      `Symbol kinds to include (default: ${DEFAULT_KINDS.join(', ')}). ` +
      'Narrow to e.g. ["function","method"] to focus on callable units.',
    ),
  filePath: z
    .string()
    .optional()
    .describe('Restrict to a specific source file path (relative to repo root).'),
  minLineCount: z
    .number().int().min(1)
    .optional()
    .describe(
      'Minimum symbol line count to include (default 3). ' +
      'Filters out trivial one-liners that are not worth testing individually.',
    ),
  includeTestRefs: z
    .boolean()
    .optional()
    .describe(
      'When true, include the list of test files that reference each ' +
      'symbol (the "testRefs" field). Increases response size. Default false.',
    ),
  limit: z
    .number().int().min(1).max(500)
    .optional()
    .describe('Maximum number of untested symbols to return (default 50).'),
};

// ─── Internal types ────────────────────────────────────────────────────────────

interface SymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  start_byte: number;
  signature: string;
  summary: string;
  line_count: number | null;
  cyclomatic_complexity: number | null;
}

interface FileRow {
  path: string;
  raw_content: Buffer | null;
}

interface UntestedSymbol {
  symbolId: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  startLine: number;
  signature: string;
  summary: string;
  lineCount: number;
  cyclomaticComplexity: number;
  priority: 'high' | 'medium' | 'low';
  testRefs?: string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

// Test-file classification: shared predicate (Task 549 — was one of five
// private copies). Imported at the top of the file.

/**
 * Extract all identifier tokens from source text.
 * Returns a Set for O(1) membership checks.
 */
function extractIdentifiers(text: string): Set<string> {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
    ids.add(m[1]);
  }
  return ids;
}

/**
 * Assign a priority to an untested symbol based on its complexity and size.
 */
function computePriority(cc: number, lineCount: number): 'high' | 'medium' | 'low' {
  if (cc >= 5 || lineCount >= 20) return 'high';
  if (cc >= 2 || lineCount >= 8) return 'medium';
  return 'low';
}

/** 1-based line number from a byte offset (consolidated impl, Phase 90). */
const lineOf = byteOffsetToLine;

// ─── Handler ───────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  scope?: string;
  kinds?: string[];
  filePath?: string;
  minLineCount?: number;
  includeTestRefs?: boolean;
  limit?: number;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    minLineCount = 3,
    includeTestRefs = false,
    limit = 50,
  } = args;

  const kinds: string[] = (args.kinds && args.kinds.length > 0)
    ? args.kinds
    : DEFAULT_KINDS;

  const db = openDatabase(repoId);
  try {
    // ── Validate repo ─────────────────────────────────────────────────────────
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: `Repo "${repoId}" not found. Run index_folder first.` }),
        }],
        isError: true,
      };
    }

    // ── Load all indexed files (with content) ─────────────────────────────────
    const allFiles = db
      .prepare<[string], FileRow>('SELECT path, raw_content FROM files WHERE repo_id = ?')
      .all(repoId);

    // ── Partition files: test vs source ───────────────────────────────────────
    const testFiles: FileRow[] = [];
    for (const f of allFiles) {
      if (isTestFile(f.path)) testFiles.push(f);
    }

    // ── Build identifier sets per test file ───────────────────────────────────
    // identifiersByTestFile[i] = Set of identifiers in testFiles[i]
    const identifiersByTestFile: Array<{ path: string; ids: Set<string> }> = [];
    // Global union for fast "is this symbol name referenced at all?" check
    const allTestIdentifiers = new Set<string>();

    for (const tf of testFiles) {
      if (!tf.raw_content) continue;
      const text = tf.raw_content.toString('utf8');
      const ids = extractIdentifiers(text);
      identifiersByTestFile.push({ path: tf.path, ids });
      for (const id of ids) allTestIdentifiers.add(id);
    }

    // ── Load candidate symbols ────────────────────────────────────────────────
    const kindPlaceholders = kinds.map(() => '?').join(', ');
    const conditions: string[] = [
      'repo_id = ?',
      `kind IN (${kindPlaceholders})`,
      'COALESCE(line_count, 1) >= ?',
    ];
    const params: unknown[] = [repoId, ...kinds, minLineCount];

    if (args.scope) {
      const prefix = args.scope.endsWith('/') ? args.scope : `${args.scope}/`;
      conditions.push('(file_path = ? OR file_path LIKE ?)');
      params.push(args.scope, `${prefix}%`);
    }

    if (args.filePath) {
      conditions.push('file_path = ?');
      params.push(args.filePath);
    }

    const sql = `
      SELECT id, name, kind, file_path, start_byte, signature, summary,
             COALESCE(line_count, 1)           AS line_count,
             COALESCE(cyclomatic_complexity, 1) AS cyclomatic_complexity
      FROM symbols
      WHERE ${conditions.join(' AND ')}
        AND file_path NOT IN (SELECT path FROM files WHERE repo_id = ? AND path IN (
          ${allFiles.filter(f => isTestFile(f.path)).map(() => '?').join(',') || 'SELECT NULL'}
        ))
      ORDER BY cyclomatic_complexity DESC, line_count DESC
    `;

    // Avoid building a huge IN clause for test-file exclusion — instead
    // filter in JS after the query (simpler and still fast for typical repos).
    const sqlSimple = `
      SELECT id, name, kind, file_path, start_byte, signature, summary,
             COALESCE(line_count, 1)           AS line_count,
             COALESCE(cyclomatic_complexity, 1) AS cyclomatic_complexity
      FROM symbols
      WHERE ${conditions.join(' AND ')}
      ORDER BY cyclomatic_complexity DESC, line_count DESC
    `;
    void sql; // suppress unused-variable warning for the filtered version above

    const allSymbols = db
      .prepare<unknown[], SymbolRow>(sqlSimple)
      .all(params);

    // Exclude symbols that live in test files
    const testFilePaths = new Set(testFiles.map((f) => f.path));
    const sourceSymbols = allSymbols.filter((s) => !testFilePaths.has(s.file_path));

    // ── Classify each symbol ──────────────────────────────────────────────────
    const untestedSymbols: UntestedSymbol[] = [];
    let testedCount = 0;

    // Cache file buffers for line computation
    const fileBufferCache = new Map<string, Buffer>();
    const getFileBuffer = (filePath: string): Buffer | null => {
      if (fileBufferCache.has(filePath)) return fileBufferCache.get(filePath) ?? null;
      const row = db
        .prepare<[string, string], { raw_content: Buffer | null }>(
          'SELECT raw_content FROM files WHERE repo_id = ? AND path = ?',
        )
        .get(repoId, filePath);
      const buf = row?.raw_content ?? null;
      if (buf) fileBufferCache.set(filePath, buf);
      return buf;
    };

    for (const sym of sourceSymbols) {
      const isTested = allTestIdentifiers.has(sym.name);

      if (isTested) {
        testedCount++;
        continue;
      }

      // Build start line
      const buf = getFileBuffer(sym.file_path);
      const startLine = buf ? lineOf(buf, sym.start_byte) : 1;

      const cc = sym.cyclomatic_complexity ?? 1;
      const lc = sym.line_count ?? 1;

      const entry: UntestedSymbol = {
        symbolId: sym.id,
        name: sym.name,
        kind: sym.kind as SymbolKind,
        filePath: sym.file_path,
        startLine,
        signature: sym.signature,
        summary: sym.summary,
        lineCount: lc,
        cyclomaticComplexity: cc,
        priority: computePriority(cc, lc),
      };

      if (includeTestRefs) {
        // For untested symbols, testRefs is empty (none reference it)
        entry.testRefs = [];
      }

      untestedSymbols.push(entry);
    }

    const truncated = untestedSymbols.length > limit;
    const visibleUntested = untestedSymbols.slice(0, limit);

    // ── Summary ───────────────────────────────────────────────────────────────
    const totalSymbols = sourceSymbols.length;
    const untestedCount = untestedSymbols.length;
    const testCoverageRate =
      totalSymbols > 0
        ? Math.round(((testedCount) / totalSymbols) * 1000) / 1000
        : 1;

    const highCount = untestedSymbols.filter((s) => s.priority === 'high').length;
    const mediumCount = untestedSymbols.filter((s) => s.priority === 'medium').length;
    const lowCount = untestedSymbols.filter((s) => s.priority === 'low').length;

    // ── Token estimate ─────────────────────────────────────────────────────────
    const tokenEstimate = Math.ceil(
      visibleUntested.reduce(
        (sum, s) => sum + s.signature.length + s.summary.length + s.filePath.length + 80,
        0,
      ) / 4,
    );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(
          {
            repoId,
            totalSymbols,
            testedCount,
            untestedCount,
            testCoverageRate,
            testFilesScanned: testFiles.length,
            truncated,
            untestedSymbols: visibleUntested,
            summary: {
              highPriority: highCount,
              mediumPriority: mediumCount,
              lowPriority: lowCount,
              kindsAnalyzed: kinds,
              minLineCount,
            },
            _tokenEstimate: tokenEstimate,
            _meta: buildMeta({ timingMs: Date.now() - t0 }),
          },
          null,
          2,
        ),
      }],
    };
  } finally {
    db.close();
  }
}
