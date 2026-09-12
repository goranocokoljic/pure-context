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
 *   1. Identify test files by path convention (`isTestFilePath`: test /
 *      tests / spec / specs / __tests__ segments, .test.* / .spec.* /
 *      _test.* / _spec.* suffixes, test_ / spec_ prefixes, .NET *.Tests/).
 *   2. Read the stored test mapping (Phase 104: `src/core/test-mapper.ts`,
 *      built incrementally at index time — one tokenizing pass per test
 *      file; `NAME` semantics). A repo indexed with `skipTestMapper`
 *      gets its mapping built here on first use (`coverage` rider).
 *   3. Any non-test symbol that no test file mentions is "untested".
 *
 * Before 1.37 this tool rescanned every test file per call (identifier
 * regex `[A-Za-z_$][A-Za-z0-9_$]*`); the store's word-boundary match
 * differs only for names with `$` or a separator (`Foo.bar` can now be
 * tested) and for names under 3 chars (never tested).
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
import { getAllFileHashes, getFileContent } from '../../core/db/file-store.js';
import { coverageRider, ensureTestMappings, getCoverageStatusMap } from '../../core/test-mapper.js';

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

    // ── Test mapping (stored; built on demand when absent / stale) ───────────
    const ensured = ensureTestMappings(repoId, db);
    const coverage = getCoverageStatusMap(repoId, db);
    const testFilePaths = new Set<string>();
    for (const path of getAllFileHashes(db, repoId).keys()) {
      if (isTestFile(path)) testFilePaths.add(path);
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

    // Test-file symbols are excluded in JS (no IN clause over every test
    // path — simpler and still fast for typical repos).
    const sqlSimple = `
      SELECT id, name, kind, file_path, start_byte, signature, summary,
             COALESCE(line_count, 1)           AS line_count,
             COALESCE(cyclomatic_complexity, 1) AS cyclomatic_complexity
      FROM symbols
      WHERE ${conditions.join(' AND ')}
      ORDER BY cyclomatic_complexity DESC, line_count DESC
    `;

    const allSymbols = db
      .prepare<unknown[], SymbolRow>(sqlSimple)
      .all(params);

    // Exclude symbols that live in test files
    const sourceSymbols = allSymbols.filter((s) => !testFilePaths.has(s.file_path));

    // ── Classify each symbol ──────────────────────────────────────────────────
    const untestedSymbols: UntestedSymbol[] = [];
    let testedCount = 0;

    // Cache file buffers for line computation
    const fileBufferCache = new Map<string, Buffer>();
    const getFileBuffer = (filePath: string): Buffer | null => {
      if (fileBufferCache.has(filePath)) return fileBufferCache.get(filePath) ?? null;
      const buf = getFileContent(db, repoId, filePath);
      if (buf) fileBufferCache.set(filePath, buf);
      return buf;
    };

    for (const sym of sourceSymbols) {
      // A structural kind (interface) is 'unknown' in the store but still
      // records the files that mention it — the tool's "tested" is "some
      // test file mentions the name", for every kind.
      const isTested = (coverage.get(sym.id)?.testFiles.length ?? 0) > 0;

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
            testFilesScanned: testFilePaths.size,
            ...coverageRider(ensured),
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
