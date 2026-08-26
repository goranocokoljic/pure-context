/**
 * Test Coverage Mapper — heuristic mapping of production symbols to the test
 * symbols / files that reference them.
 *
 * Strategy: string-presence search.  For each test file, scan its raw content
 * for occurrences of each production symbol's name (word-boundary anchored).
 * Results are stored in `provider_metadata` with provider_name = 'test-mapper'.
 *
 * This is intentionally a heuristic — it detects "a test file references this
 * symbol name" rather than instrumented execution coverage.  The UI labels it
 * clearly so users are not misled.
 *
 * Accuracy notes (TypeScript projects with co-located tests):
 *  - ~85% recall at the symbol level
 *  - Types / interfaces / enums → coverageStatus = 'unknown' (structural, not callable)
 *  - Short or generic names (≤ 2 chars) are skipped to avoid noise
 */

import type Database from 'better-sqlite3';
import { logger } from './logger.js';
import { isTestFilePath } from './test-paths.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CoverageStatus = 'tested' | 'untested' | 'unknown';

export interface TestMapping {
  symbolId: string;
  testSymbolIds: string[];
  testFilePaths: string[];
  coverageStatus: CoverageStatus;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Symbol kinds where coverage is not meaningful (structural declarations).
const STRUCTURAL_KINDS = new Set(['type', 'interface', 'enum']);

// Minimum symbol name length to avoid false positives on very short names.
const MIN_NAME_LENGTH = 3;

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Test-file classification lives in the shared predicate (Task 549) — this was
// one of five private copies.

/** Escape a string so it can be used safely inside a RegExp literal. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a word-boundary RegExp for the symbol name. */
function namePattern(name: string): RegExp {
  return new RegExp(`\\b${escapeRegex(name)}\\b`);
}

// ─── Database row shapes ──────────────────────────────────────────────────────

interface SymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
}

interface FileContentRow {
  path: string;
  raw_content: string | null;
}

// ─── Core function ────────────────────────────────────────────────────────────

/**
 * Build test coverage mappings for all production symbols in a repo and
 * persist them to the `provider_metadata` table.
 *
 * Returns the number of production symbol mappings written.
 */
export function buildTestMappings(repoId: string, db: Database.Database): number {
  const t0 = Date.now();

  // ── 1. Load all symbols ───────────────────────────────────────────────────
  const allSymbols = db
    .prepare<[string], SymbolRow>(
      'SELECT id, name, kind, file_path FROM symbols WHERE repo_id = ?',
    )
    .all(repoId);

  if (allSymbols.length === 0) {
    logger.debug(`test-mapper: no symbols for repo ${repoId}`);
    return 0;
  }

  const prodSymbols = allSymbols.filter((s) => !isTestFilePath(s.file_path));
  const testSymbols = allSymbols.filter((s) => isTestFilePath(s.file_path));

  const testFilePaths = [...new Set(testSymbols.map((s) => s.file_path))];

  if (testFilePaths.length === 0) {
    logger.debug(`test-mapper: no test files found for repo ${repoId}`);
    // Still write 'untested'/'unknown' entries for all prod symbols.
  }

  // ── 2. Load test file contents from the files table ───────────────────────
  const fileContents = new Map<string, string>(); // filePath → raw content
  for (const fp of testFilePaths) {
    const row = db
      .prepare<[string, string], FileContentRow>(
        'SELECT path, raw_content FROM files WHERE repo_id = ? AND path = ?',
      )
      .get(repoId, fp);
    if (row?.raw_content) {
      fileContents.set(fp, row.raw_content);
    }
  }

  // ── 3. Build per-test-file symbol sets ────────────────────────────────────
  // testSymbolsByFile: filePath → Set of test symbol ids in that file
  const testSymbolsByFile = new Map<string, Set<string>>();
  for (const ts of testSymbols) {
    let set = testSymbolsByFile.get(ts.file_path);
    if (!set) {
      set = new Set();
      testSymbolsByFile.set(ts.file_path, set);
    }
    set.add(ts.id);
  }

  // ── 4. For each production symbol, find which test files reference it ──────
  // symbolId → { testFiles: string[], testSymbolIds: string[] }
  const coverageBySymbol = new Map<
    string,
    { testFiles: Set<string>; testSymbolIds: Set<string> }
  >();

  for (const prod of prodSymbols) {
    coverageBySymbol.set(prod.id, { testFiles: new Set(), testSymbolIds: new Set() });
  }

  if (testFilePaths.length > 0) {
    // Pre-compile patterns for prod symbols that are long enough to be useful.
    const patterns: Array<{ sym: SymbolRow; re: RegExp }> = prodSymbols
      .filter((s) => s.name.length >= MIN_NAME_LENGTH)
      .map((s) => ({ sym: s, re: namePattern(s.name) }));

    for (const fp of testFilePaths) {
      const content = fileContents.get(fp);
      if (!content) continue;

      const testSymIds = testSymbolsByFile.get(fp) ?? new Set<string>();

      for (const { sym, re } of patterns) {
        if (!re.test(content)) continue;

        const cov = coverageBySymbol.get(sym.id);
        if (!cov) continue;

        cov.testFiles.add(fp);
        for (const tsId of testSymIds) {
          cov.testSymbolIds.add(tsId);
        }
      }
    }
  }

  // ── 5. Write to provider_metadata ─────────────────────────────────────────
  const upsert = db.prepare(`
    INSERT INTO provider_metadata (repo_id, provider_name, entity_key, metadata, updated_at)
    VALUES (?, 'test-mapper', ?, ?, ?)
    ON CONFLICT (repo_id, provider_name, entity_key) DO UPDATE SET
      metadata   = excluded.metadata,
      updated_at = excluded.updated_at
  `);

  const deleteOld = db.prepare(
    "DELETE FROM provider_metadata WHERE repo_id = ? AND provider_name = 'test-mapper'",
  );

  const now = Date.now();

  const writeAll = db.transaction(() => {
    deleteOld.run(repoId);

    for (const prod of prodSymbols) {
      const cov = coverageBySymbol.get(prod.id);
      const testFiles = cov ? [...cov.testFiles] : [];
      const testSymbolIds = cov ? [...cov.testSymbolIds] : [];

      let coverageStatus: CoverageStatus;
      if (STRUCTURAL_KINDS.has(prod.kind)) {
        coverageStatus = 'unknown';
      } else if (testFiles.length > 0) {
        coverageStatus = 'tested';
      } else {
        coverageStatus = 'untested';
      }

      const metadata = JSON.stringify({ testFiles, testSymbolIds, coverageStatus });
      upsert.run(repoId, prod.id, metadata, now);
    }
  });

  try {
    writeAll();
  } catch (err) {
    logger.warn(`test-mapper: writeAll transaction failed (${err}), coverage data not stored`);
    return 0;
  }

  const elapsed = Date.now() - t0;
  logger.info(
    `test-mapper: ${prodSymbols.length} symbols mapped in ${elapsed}ms ` +
      `(${testFilePaths.length} test files scanned)`,
  );

  return prodSymbols.length;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

interface StoredCoverage {
  testFiles: string[];
  testSymbolIds: string[];
  coverageStatus: CoverageStatus;
}

/**
 * Retrieve the stored test mapping for a single production symbol.
 * Returns null if no mapping exists (symbol not yet mapped or is a test symbol).
 */
export function getSymbolCoverage(
  repoId: string,
  symbolId: string,
  db: Database.Database,
): TestMapping | null {
  const row = db
    .prepare<[string, string], { metadata: string }>(
      "SELECT metadata FROM provider_metadata WHERE repo_id = ? AND provider_name = 'test-mapper' AND entity_key = ?",
    )
    .get(repoId, symbolId);

  if (!row) return null;

  const stored = JSON.parse(row.metadata) as StoredCoverage;
  return {
    symbolId,
    testFilePaths: stored.testFiles,
    testSymbolIds: stored.testSymbolIds,
    coverageStatus: stored.coverageStatus,
  };
}

/**
 * Retrieve all test mappings for a repo.
 * Returns an array of TestMapping, one per production symbol.
 */
export function getAllCoverageForRepo(
  repoId: string,
  db: Database.Database,
): TestMapping[] {
  const rows = db
    .prepare<[string], { entity_key: string; metadata: string }>(
      "SELECT entity_key, metadata FROM provider_metadata WHERE repo_id = ? AND provider_name = 'test-mapper'",
    )
    .all(repoId);

  return rows.map((row) => {
    const stored = JSON.parse(row.metadata) as StoredCoverage;
    return {
      symbolId: row.entity_key,
      testFilePaths: stored.testFiles,
      testSymbolIds: stored.testSymbolIds,
      coverageStatus: stored.coverageStatus,
    };
  });
}
