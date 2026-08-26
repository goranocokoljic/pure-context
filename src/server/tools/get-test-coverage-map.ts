/**
 * get-test-coverage-map.ts
 *
 * MCP tool: get_test_coverage_map
 *
 * Parses a coverage JSON report (Istanbul/NYC or V8/c8 format) and maps
 * line-level coverage data to symbols in the indexed codebase. Returns
 * per-file coverage metrics and per-symbol covered/uncovered status.
 *
 * Supported formats:
 *   Istanbul/NYC — coverage-final.json produced by nyc, jest --coverage,
 *                  vitest --coverage.reporter=json, c8 (json reporter).
 *                  Keys are absolute file paths; values have statementMap,
 *                  fnMap, branchMap, s, f, b counters.
 *
 *   V8           — coverage produced by Node --experimental-vm-modules or
 *                  c8 json-summary. An array of {url, functions} objects
 *                  where url is a file:// URI and functions carry byte-range
 *                  hit counts.
 *
 * Detection strategy:
 *   - Top-level object → Istanbul
 *   - Top-level array  → V8
 *   Auto-detected by default; override with the `format` parameter.
 *
 * Symbol coverage:
 *   Symbols are matched to coverage functions by exact name. If no name
 *   match is found, line-range overlap is used as a fallback.
 *   This is a static heuristic — minified or transpiled code may reduce
 *   accuracy. For precise coverage, ensure the coverage report was generated
 *   from the same (or source-mapped) code that was indexed.
 *
 * Differs from related tools:
 *   find_untested_symbols — name-based heuristic, no coverage file needed
 *   get_complexity_hotspots — complexity ranking without coverage data
 *   get_quality_metrics — per-symbol quality scoring, not coverage
 */

import { z } from 'zod';
import { readFileSync } from 'fs';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { buildMeta } from './_meta.js';
import { byteOffsetToLine } from './symbol-lines.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SymbolKind } from '../../core/types.js';

export const name = 'get_test_coverage_map';

export const description =
  'Parse a coverage JSON report (Istanbul/NYC or V8/c8 format) and map ' +
  'line-level coverage to symbols in the indexed codebase. Returns per-file ' +
  'statement, function, branch, and line coverage metrics together with ' +
  'per-symbol covered/uncovered status and call counts. ' +
  'Use this to answer "which functions are untested?" with line-accuracy, ' +
  'or to build a coverage heat map across the codebase.' +
  '\n\nSupported report formats: Istanbul/NYC (coverage-final.json), ' +
  'V8/c8 (json reporter). Format is auto-detected.' +
  '\n\nDiffers from related tools:' +
  '\n  find_untested_symbols — name-based heuristic, no coverage file needed' +
  '\n  get_complexity_hotspots — complexity ranking without coverage data' +
  '\n  get_quality_metrics — per-symbol quality scoring, not coverage';

// ─── Input schema ──────────────────────────────────────────────────────────────

export const inputSchema = {
  repoId: z.string().describe('Repository ID returned by index_folder or list_repos'),
  coveragePath: z
    .string()
    .describe(
      'Absolute path to the coverage JSON file ' +
      '(e.g. "/project/coverage/coverage-final.json"). ' +
      'Supports Istanbul/NYC and V8/c8 formats.',
    ),
  scope: z
    .string()
    .optional()
    .describe(
      'Restrict to a directory prefix (e.g. "src/services/"). ' +
      'Omit to analyse the whole repo.',
    ),
  filePath: z
    .string()
    .optional()
    .describe('Restrict to a specific source file (relative to repo root).'),
  minCoverage: z
    .number().min(0).max(100)
    .optional()
    .describe(
      'Return only files whose line coverage is BELOW this threshold (0–100). ' +
      'Omit to return all covered files.',
    ),
  includeUncoveredLines: z
    .boolean()
    .optional()
    .describe(
      'When true, include the list of uncovered line numbers per file. ' +
      'Default false (keeps response size small).',
    ),
  limit: z
    .number().int().min(1).max(100)
    .optional()
    .describe('Maximum number of files to return (default 20).'),
  format: z
    .enum(['auto', 'istanbul', 'v8'])
    .optional()
    .describe('Coverage format. Default "auto" (detect from JSON structure).'),
};

// ─── Istanbul types ────────────────────────────────────────────────────────────

interface IstanbulLoc { line: number; column: number; }
interface IstanbulRange { start: IstanbulLoc; end: IstanbulLoc; }
interface IstanbulFn {
  name: string;
  loc: IstanbulRange;
  decl?: IstanbulRange;
}
interface IstanbulBranch {
  type: string;
  loc: IstanbulRange;
  locations: Array<{ start: IstanbulLoc }>;
}
interface IstanbulFileCov {
  path: string;
  statementMap: Record<string, IstanbulRange>;
  s: Record<string, number>;
  fnMap: Record<string, IstanbulFn>;
  f: Record<string, number>;
  branchMap: Record<string, IstanbulBranch>;
  b: Record<string, number[]>;
}
type IstanbulCoverage = Record<string, IstanbulFileCov>;

// ─── V8 types ─────────────────────────────────────────────────────────────────

interface V8Range { startOffset: number; endOffset: number; count: number; }
interface V8FnCov {
  functionName: string;
  ranges: V8Range[];
  isBlockCoverage: boolean;
}
interface V8Script {
  url: string;
  scriptId?: string;
  functions: V8FnCov[];
}
type V8Coverage = V8Script[];

// ─── Internal types ────────────────────────────────────────────────────────────

interface SymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  start_byte: number;
  end_byte: number;
  signature: string;
  summary: string;
  line_count: number | null;
}

interface SymbolCoverageEntry {
  symbolId: string;
  name: string;
  kind: SymbolKind;
  startLine: number;
  covered: boolean;
  callCount: number;
}

interface FileCoverageEntry {
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
  symbols: SymbolCoverageEntry[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Detect the coverage format from the parsed JSON value.
 */
function detectFormat(parsed: unknown): 'istanbul' | 'v8' | null {
  if (Array.isArray(parsed)) {
    // V8: array of { url, functions } objects
    return 'v8';
  }
  if (parsed !== null && typeof parsed === 'object') {
    // Istanbul: keys are file paths; values have statementMap, s, fnMap, f
    return 'istanbul';
  }
  return null;
}

/**
 * Normalise a path to forward-slash form for cross-platform comparison.
 */
function normSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Convert a `file://` URL to an absolute path string.
 * Handles Windows drive letters (file:///D:/path → D:/path).
 */
function fileUrlToPath(url: string): string {
  if (url.startsWith('file:///')) {
    const p = decodeURIComponent(url.slice(8));
    // Windows: starts with drive letter
    if (/^[A-Za-z]:/.test(p)) return p;
    return '/' + p;
  }
  if (url.startsWith('file://')) {
    return decodeURIComponent(url.slice(7));
  }
  return url;
}

/**
 * Try to resolve an absolute coverage path to a path relative to repoRoot.
 * Returns null if the file is outside the repo.
 */
function toRelativePath(absPath: string, repoRoot: string): string | null {
  const norm = normSlashes(absPath);
  const root = normSlashes(repoRoot).replace(/\/$/, '');
  if (norm.startsWith(root + '/')) {
    return norm.slice(root.length + 1);
  }
  return null;
}

/** 1-based line number from a byte offset (consolidated impl, Phase 90). */
const lineOf = byteOffsetToLine;

/**
 * Compute covered and uncovered line sets from an Istanbul statementMap + s.
 */
function computeIstanbulLines(
  statementMap: Record<string, IstanbulRange>,
  s: Record<string, number>,
): { covered: Set<number>; uncovered: Set<number> } {
  // line → whether any statement on this line was executed
  const lineAny = new Map<number, boolean>();

  for (const [idx, range] of Object.entries(statementMap)) {
    const count = s[idx] ?? 0;
    const line = range.start.line;
    const prev = lineAny.get(line) ?? false;
    lineAny.set(line, prev || count > 0);
  }

  const covered = new Set<number>();
  const uncovered = new Set<number>();
  for (const [line, isCovered] of lineAny) {
    if (isCovered) covered.add(line);
    else uncovered.add(line);
  }
  return { covered, uncovered };
}

/**
 * From an Istanbul fnMap + f, find the call count for a symbol name.
 * Falls back to line-range overlap.
 */
function istanbulFnCallCount(
  symbolName: string,
  symbolStartLine: number,
  symbolEndLine: number,
  fnMap: Record<string, IstanbulFn>,
  f: Record<string, number>,
): number | null {
  // 1. Exact name match
  for (const [idx, fn] of Object.entries(fnMap)) {
    if (fn.name === symbolName) {
      return f[idx] ?? 0;
    }
  }
  // 2. Line-range overlap: function's start line inside symbol's lines
  for (const [idx, fn] of Object.entries(fnMap)) {
    const fnLine = fn.loc.start.line;
    if (fnLine >= symbolStartLine && fnLine <= symbolEndLine) {
      return f[idx] ?? 0;
    }
  }
  return null;
}

/**
 * From a V8 script's functions, find the call count for a symbol name.
 * Returns null when no match found.
 */
function v8FnCallCount(
  symbolName: string,
  functions: V8FnCov[],
): number | null {
  for (const fn of functions) {
    if (fn.functionName === symbolName) {
      // Max count across ranges indicates the function was called
      return fn.ranges.reduce((max, r) => Math.max(max, r.count), 0);
    }
  }
  return null;
}

/**
 * Compute V8 function coverage metrics for a script.
 */
function computeV8FunctionCoverage(functions: V8FnCov[]): {
  totalFunctions: number;
  coveredFunctions: number;
} {
  // Skip "(top-level)" / "(anonymous)" entries that wrap the module
  const named = functions.filter(
    (fn) =>
      fn.functionName !== '' &&
      fn.functionName !== '(top-level)' &&
      !fn.functionName.startsWith('(anonymous'),
  );
  const total = named.length;
  const covered = named.filter((fn) =>
    fn.ranges.some((r) => r.count > 0),
  ).length;
  return { totalFunctions: total, coveredFunctions: covered };
}

/**
 * Compute line coverage from V8 byte ranges + file content.
 * Returns the set of covered lines and uncovered lines.
 */
function computeV8Lines(
  content: Buffer,
  functions: V8FnCov[],
): { covered: Set<number>; uncovered: Set<number> } {
  if (content.length === 0) return { covered: new Set(), uncovered: new Set() };

  // Build a per-byte coverage map using function ranges
  const coveredBytes = new Uint8Array(content.length);
  for (const fn of functions) {
    for (const range of fn.ranges) {
      if (range.count > 0) {
        const end = Math.min(range.endOffset, content.length);
        for (let i = range.startOffset; i < end; i++) {
          coveredBytes[i] = 1;
        }
      }
    }
  }

  // Convert to line coverage: a line is covered if any byte on it is covered
  const covered = new Set<number>();
  const uncovered = new Set<number>();
  let line = 1;
  let lineHasCoveredByte = false;
  let lineHasCode = false;

  for (let i = 0; i < content.length; i++) {
    const byte = content[i];
    if (byte !== 0x0a && byte !== 0x0d && byte !== 0x20 && byte !== 0x09) {
      lineHasCode = true;
    }
    if (coveredBytes[i]) lineHasCoveredByte = true;

    if (byte === 0x0a) {
      if (lineHasCode) {
        if (lineHasCoveredByte) covered.add(line);
        else uncovered.add(line);
      }
      line++;
      lineHasCoveredByte = false;
      lineHasCode = false;
    }
  }
  // Last line (no trailing newline)
  if (lineHasCode) {
    if (lineHasCoveredByte) covered.add(line);
    else uncovered.add(line);
  }

  return { covered, uncovered };
}

// ─── Istanbul file processing ──────────────────────────────────────────────────

function processIstanbulFile(
  relPath: string,
  fileCov: IstanbulFileCov,
  symbols: SymbolRow[],
  fileContent: Buffer | null,
  includeUncoveredLines: boolean,
): FileCoverageEntry {
  // Statement coverage
  const totalStatements = Object.keys(fileCov.statementMap).length;
  const coveredStatements = Object.values(fileCov.s).filter((c) => c > 0).length;
  const statementCoverage =
    totalStatements > 0
      ? Math.round((coveredStatements / totalStatements) * 10000) / 100
      : null;

  // Function coverage
  const totalFunctions = Object.keys(fileCov.fnMap).length;
  const coveredFunctions = Object.values(fileCov.f).filter((c) => c > 0).length;
  const functionCoverage =
    totalFunctions > 0
      ? Math.round((coveredFunctions / totalFunctions) * 10000) / 100
      : 100;

  // Branch coverage
  const totalBranchSides = Object.values(fileCov.b).reduce(
    (sum, arr) => sum + arr.length, 0,
  );
  const coveredBranchSides = Object.values(fileCov.b).reduce(
    (sum, arr) => sum + arr.filter((c) => c > 0).length, 0,
  );
  const branchCoverage =
    totalBranchSides > 0
      ? Math.round((coveredBranchSides / totalBranchSides) * 10000) / 100
      : null;

  // Line coverage (from statements)
  const { covered: coveredLines, uncovered: uncoveredLines } =
    computeIstanbulLines(fileCov.statementMap, fileCov.s);
  const totalLines = coveredLines.size + uncoveredLines.size;
  const lineCoverage =
    totalLines > 0
      ? Math.round((coveredLines.size / totalLines) * 10000) / 100
      : 100;

  // Symbol coverage
  const symbolEntries: SymbolCoverageEntry[] = [];
  for (const sym of symbols) {
    const startLine = fileContent ? lineOf(fileContent, sym.start_byte) : 1;
    const endByteClamped = Math.min(sym.end_byte, fileContent ? fileContent.length : sym.end_byte);
    const endLine = fileContent ? lineOf(fileContent, endByteClamped) : startLine + (sym.line_count ?? 1) - 1;

    const callCount = istanbulFnCallCount(
      sym.name,
      startLine,
      endLine,
      fileCov.fnMap,
      fileCov.f,
    );

    symbolEntries.push({
      symbolId: sym.id,
      name: sym.name,
      kind: sym.kind as SymbolKind,
      startLine,
      covered: callCount !== null ? callCount > 0 : false,
      callCount: callCount ?? 0,
    });
  }

  const entry: FileCoverageEntry = {
    filePath: relPath,
    lineCoverage,
    statementCoverage,
    functionCoverage,
    branchCoverage,
    totalStatements,
    coveredStatements,
    totalFunctions,
    coveredFunctions,
    totalBranches: Object.keys(fileCov.branchMap).length,
    coveredBranchSides,
    symbols: symbolEntries,
  };

  if (includeUncoveredLines) {
    entry.uncoveredLines = [...uncoveredLines].sort((a, b) => a - b);
  }

  return entry;
}

// ─── V8 file processing ────────────────────────────────────────────────────────

function processV8File(
  relPath: string,
  script: V8Script,
  symbols: SymbolRow[],
  fileContent: Buffer | null,
  includeUncoveredLines: boolean,
): FileCoverageEntry {
  const { totalFunctions, coveredFunctions } = computeV8FunctionCoverage(
    script.functions,
  );

  const functionCoverage =
    totalFunctions > 0
      ? Math.round((coveredFunctions / totalFunctions) * 10000) / 100
      : 100;

  // Line coverage from V8 byte ranges (requires file content)
  let lineCoverage = 100;
  let coveredLineCount = 0;
  let uncoveredLineArr: number[] = [];
  const coveredLinesSet = new Set<number>();
  const uncoveredLinesSet = new Set<number>();

  if (fileContent && fileContent.length > 0) {
    const { covered, uncovered } = computeV8Lines(fileContent, script.functions);
    coveredLinesSet.entries();
    const totalLinesWithCode = covered.size + uncovered.size;
    lineCoverage =
      totalLinesWithCode > 0
        ? Math.round((covered.size / totalLinesWithCode) * 10000) / 100
        : 100;
    coveredLineCount = covered.size;
    for (const l of covered) coveredLinesSet.add(l);
    for (const l of uncovered) uncoveredLinesSet.add(l);
    if (includeUncoveredLines) {
      uncoveredLineArr = [...uncovered].sort((a, b) => a - b);
    }
  }

  // Symbol coverage
  const symbolEntries: SymbolCoverageEntry[] = [];
  for (const sym of symbols) {
    const startLine = fileContent ? lineOf(fileContent, sym.start_byte) : 1;

    const callCount = v8FnCallCount(sym.name, script.functions);

    symbolEntries.push({
      symbolId: sym.id,
      name: sym.name,
      kind: sym.kind as SymbolKind,
      startLine,
      covered: callCount !== null ? callCount > 0 : false,
      callCount: callCount ?? 0,
    });
  }

  const entry: FileCoverageEntry = {
    filePath: relPath,
    lineCoverage,
    statementCoverage: null, // V8 doesn't have statement-level data
    functionCoverage,
    branchCoverage: null, // V8 basic format doesn't expose branch data
    totalStatements: 0,
    coveredStatements: 0,
    totalFunctions,
    coveredFunctions,
    totalBranches: 0,
    coveredBranchSides: 0,
    symbols: symbolEntries,
  };

  if (includeUncoveredLines) {
    entry.uncoveredLines = uncoveredLineArr;
  }

  void coveredLineCount; // used above

  return entry;
}

// ─── Handler ───────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  coveragePath: string;
  scope?: string;
  filePath?: string;
  minCoverage?: number;
  includeUncoveredLines?: boolean;
  limit?: number;
  format?: 'auto' | 'istanbul' | 'v8';
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    coveragePath,
    includeUncoveredLines = false,
    limit = 20,
    format = 'auto',
  } = args;

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

    // ── Read coverage file ────────────────────────────────────────────────────
    let rawJson: string;
    try {
      rawJson = readFileSync(coveragePath, 'utf8');
    } catch {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `Cannot read coverage file: "${coveragePath}". Check the path and permissions.`,
          }),
        }],
        isError: true,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `Coverage file is not valid JSON: "${coveragePath}".`,
          }),
        }],
        isError: true,
      };
    }

    // ── Detect format ─────────────────────────────────────────────────────────
    const detectedFormat =
      format !== 'auto' ? format : detectFormat(parsed);

    if (!detectedFormat) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `Unrecognised coverage format in "${coveragePath}". ` +
              'Expected Istanbul (object with file paths as keys) or V8 (array of script objects).',
          }),
        }],
        isError: true,
      };
    }

    const repoRoot = repo.rootPath;

    // ── Build coverage entry map: relPath → FileCoverageEntry ─────────────────

    const fileEntries: FileCoverageEntry[] = [];

    if (detectedFormat === 'istanbul') {
      const istanbul = parsed as IstanbulCoverage;

      for (const [absPath, fileCov] of Object.entries(istanbul)) {
        const relPath = toRelativePath(absPath, repoRoot);
        if (!relPath) continue;

        // Scope / filePath filters
        if (args.scope) {
          const prefix = args.scope.endsWith('/') ? args.scope : `${args.scope}/`;
          if (relPath !== args.scope && !relPath.startsWith(prefix)) continue;
        }
        if (args.filePath && relPath !== args.filePath) continue;

        // Load symbols for this file from DB
        const symbols = db
          .prepare<[string, string], SymbolRow>(
            `SELECT id, name, kind, file_path, start_byte, end_byte,
                    signature, summary, COALESCE(line_count, 1) AS line_count
             FROM symbols
             WHERE repo_id = ? AND file_path = ?`,
          )
          .all(repoId, relPath);

        // Load file content for line number computation
        const row = db
          .prepare<[string, string], { raw_content: Buffer | null }>(
            'SELECT raw_content FROM files WHERE repo_id = ? AND path = ?',
          )
          .get(repoId, relPath);
        const fileContent = row?.raw_content ?? null;

        const entry = processIstanbulFile(
          relPath,
          fileCov,
          symbols,
          fileContent,
          includeUncoveredLines,
        );
        fileEntries.push(entry);
      }
    } else {
      // V8
      const v8 = parsed as V8Coverage;

      for (const script of v8) {
        const absPath = fileUrlToPath(script.url);
        const relPath = toRelativePath(absPath, repoRoot);
        if (!relPath) continue;

        // Scope / filePath filters
        if (args.scope) {
          const prefix = args.scope.endsWith('/') ? args.scope : `${args.scope}/`;
          if (relPath !== args.scope && !relPath.startsWith(prefix)) continue;
        }
        if (args.filePath && relPath !== args.filePath) continue;

        const symbols = db
          .prepare<[string, string], SymbolRow>(
            `SELECT id, name, kind, file_path, start_byte, end_byte,
                    signature, summary, COALESCE(line_count, 1) AS line_count
             FROM symbols
             WHERE repo_id = ? AND file_path = ?`,
          )
          .all(repoId, relPath);

        const row = db
          .prepare<[string, string], { raw_content: Buffer | null }>(
            'SELECT raw_content FROM files WHERE repo_id = ? AND path = ?',
          )
          .get(repoId, relPath);
        const fileContent = row?.raw_content ?? null;

        const entry = processV8File(
          relPath,
          script,
          symbols,
          fileContent,
          includeUncoveredLines,
        );
        fileEntries.push(entry);
      }
    }

    // ── minCoverage filter ────────────────────────────────────────────────────
    const filteredEntries = args.minCoverage !== undefined
      ? fileEntries.filter((e) => e.lineCoverage < args.minCoverage!)
      : fileEntries;

    // ── Sort by lineCoverage ascending (worst coverage first) ─────────────────
    filteredEntries.sort((a, b) => a.lineCoverage - b.lineCoverage);

    // ── Truncation ────────────────────────────────────────────────────────────
    const truncated = filteredEntries.length > limit;
    const visible = filteredEntries.slice(0, limit);

    // ── Summary ───────────────────────────────────────────────────────────────
    const allEntries = filteredEntries; // before truncation

    const avgLineCoverage =
      allEntries.length > 0
        ? Math.round(
            (allEntries.reduce((s, e) => s + e.lineCoverage, 0) / allEntries.length) * 100,
          ) / 100
        : 0;

    const avgFunctionCoverage =
      allEntries.length > 0
        ? Math.round(
            (allEntries.reduce((s, e) => s + e.functionCoverage, 0) / allEntries.length) * 100,
          ) / 100
        : 0;

    const stmtFiles = allEntries.filter((e) => e.statementCoverage !== null);
    const avgStatementCoverage =
      stmtFiles.length > 0
        ? Math.round(
            (stmtFiles.reduce((s, e) => s + (e.statementCoverage ?? 0), 0) / stmtFiles.length) *
              100,
          ) / 100
        : null;

    const branchFiles = allEntries.filter((e) => e.branchCoverage !== null);
    const avgBranchCoverage =
      branchFiles.length > 0
        ? Math.round(
            (branchFiles.reduce((s, e) => s + (e.branchCoverage ?? 0), 0) / branchFiles.length) *
              100,
          ) / 100
        : null;

    // Aggregate symbol counts across all entries (not just visible)
    const allSymbols = allEntries.flatMap((e) => e.symbols);
    const totalSymbols = allSymbols.length;
    const coveredSymbols = allSymbols.filter((s) => s.covered).length;

    // ── Token estimate ─────────────────────────────────────────────────────────
    const tokenEstimate = Math.ceil(
      visible.reduce(
        (sum, e) =>
          sum +
          e.filePath.length +
          e.symbols.reduce((s2, sym) => s2 + sym.name.length + 30, 0) +
          (e.uncoveredLines ? e.uncoveredLines.length * 5 : 0) +
          120,
        0,
      ) / 4,
    );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(
          {
            repoId,
            coveragePath,
            format: detectedFormat,
            summary: {
              totalFiles: allEntries.length,
              avgLineCoverage,
              avgStatementCoverage,
              avgFunctionCoverage,
              avgBranchCoverage,
              totalSymbols,
              coveredSymbols,
              uncoveredSymbols: totalSymbols - coveredSymbols,
            },
            files: visible,
            truncated,
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
