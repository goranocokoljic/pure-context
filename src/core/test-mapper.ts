/**
 * Test Coverage Mapper — heuristic mapping of production symbols to the test
 * files / test symbols that mention them. Phase 104 redesign (Tasks 648–650):
 * incremental by construction, one tokenizing pass per test file, lazy
 * fallback for indexes built with `skipTestMapper`.
 *
 * Matching semantics are UNCHANGED from the pre-1.37 mapper (the legacy
 * oracle in test/core/oracles/): a production symbol is "tested" when some
 * test file contains its name with a word boundary on both sides
 * (`\bNAME\b`, ASCII word chars). Names shorter than 3 chars are never
 * matched; types / interfaces / enums are 'unknown' (structural, not
 * callable). ONE deliberate change: the test-file universe is every indexed
 * test file (`isTestFilePath`), not only test files that happen to carry an
 * indexed symbol — the legacy mapper derived its file list from the symbols
 * table, so a spec file with no extracted symbol was never scanned (novu:
 * 1,027 of 33,392 rows gained a file). `find_untested_symbols` and
 * `get_symbol_risk` already scanned every test file; the store now agrees
 * with them. The parity script proves the wide universe explains every
 * difference (benchmarks/harness/phase104_parity.mts).
 *
 * How the product cost went away (P2):
 *  - A test file is tokenized ONCE into its set of `[A-Za-z0-9_]+` runs and
 *    the set is stored (`test_file_tokens`, keyed by content hash). A name
 *    made only of word chars matches `\bNAME\b` exactly when it is one of
 *    those maximal runs — a set lookup.
 *  - A composite name (`Foo.bar`, `A::B::c`, `User#valid?`, `$col-width` —
 *    42% of all names across the benchmark corpus) can only match a file
 *    whose token set holds EVERY word run of the name (each run is bounded
 *    by a non-word char inside the name or by the outer `\b`). The token
 *    sets prefilter the candidate files; only those files' content is read
 *    and checked with an exact boundary-aware `indexOf` walk.
 *
 * How the no-op cost went away (P1):
 *  - Token rows are keyed by content hash: an unchanged test file is never
 *    re-read. A run whose test tokens did not change re-maps only the
 *    production symbols that have no mapping row yet, and rewrites only the
 *    rows whose value changed. `index_file` takes the same path.
 *
 * Output rows live in `provider_metadata` under provider 'test-mapper'
 * exactly as before (entity_key = production symbol id, metadata =
 * `{ testFiles, testSymbolIds, coverageStatus }`). Arrays are now sorted
 * (files by path; test symbol ids by file, then start byte) so a full and an
 * incremental build produce the same bytes. A meta row under provider
 * 'test-mapper-meta' records the last build.
 */

import type Database from 'better-sqlite3';
import { logger } from './logger.js';
import { isTestFilePath } from './test-paths.js';
import { getAllFileHashes, getFileContent } from './db/file-store.js';
import {
  deleteTestTokens,
  getAllTestTokens,
  getTestTokenHashes,
  testTokenBytes,
  upsertTestTokens,
} from './db/test-token-store.js';
import type { TestMapperStats } from './types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CoverageStatus = 'tested' | 'untested' | 'unknown';

export interface TestMapping {
  symbolId: string;
  testSymbolIds: string[];
  testFilePaths: string[];
  coverageStatus: CoverageStatus;
}

/** How the stored mapping relates to the index right now (Task 650). */
export type TestMapperFreshness = 'fresh' | 'stale' | 'absent';

export interface TestMapperMeta {
  /** Bump when the matching semantics change: a stale algo forces a rebuild. */
  algo: number;
  builtAt: number;
  mode: TestMapperStats['mode'];
  testFiles: number;
  symbols: number;
  ms: number;
  /** Stored size of the token rows after this build (R2). */
  tokenBytes: number;
}

export interface BuildTestMappingsOptions {
  /** Drop every stored row (tokens + mappings) and rebuild from scratch. */
  force?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Symbol kinds where coverage is not meaningful (structural declarations).
const STRUCTURAL_KINDS = new Set(['type', 'interface', 'enum']);

// Minimum symbol name length to avoid false positives on very short names.
const MIN_NAME_LENGTH = 3;

const PROVIDER = 'test-mapper';
const META_PROVIDER = 'test-mapper-meta';
const META_KEY = 'repo';
/** Matching semantics version (see TestMapperMeta.algo). */
export const TEST_MAPPER_ALGO = 2;

/** Above this many symbols to map, build an inverted token index first. */
const INVERTED_INDEX_THRESHOLD = 512;

// ─── Tokenizer + matcher (pure; exported for the parity tests) ────────────────

const WORD_RUN = /[A-Za-z0-9_]+/g;

/** The set of maximal `[A-Za-z0-9_]+` runs in a test file (Task 648). */
export function scanTestFile(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(WORD_RUN)) out.add(m[0]);
  return out;
}

/** True when `name` is made only of ASCII word chars (a single token). */
export function isWordName(name: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(name);
}

/** The word runs inside a composite name (`Foo.bar` → ['Foo', 'bar']). */
export function wordRuns(name: string): string[] {
  return name.match(WORD_RUN) ?? [];
}

function isWordCode(c: number): boolean {
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 95 // _
  );
}

/**
 * Exact equivalent of `new RegExp('\\b' + escape(name) + '\\b').test(content)`
 * (non-unicode mode: word chars are `[A-Za-z0-9_]`; string ends count as
 * non-word). Used for composite names after the token prefilter, and for
 * the rare name with no word run at all.
 */
export function containsBounded(content: string, name: string): boolean {
  if (name.length === 0) return false;
  const firstIsWord = isWordCode(name.charCodeAt(0));
  const lastIsWord = isWordCode(name.charCodeAt(name.length - 1));
  let from = 0;
  for (;;) {
    const i = content.indexOf(name, from);
    if (i < 0) return false;
    const end = i + name.length;
    const beforeIsWord = i > 0 && isWordCode(content.charCodeAt(i - 1));
    const afterIsWord = end < content.length && isWordCode(content.charCodeAt(end));
    if (beforeIsWord !== firstIsWord && afterIsWord !== lastIsWord) return true;
    from = i + 1;
  }
}

// ─── Database row shapes ──────────────────────────────────────────────────────

interface SymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
}

interface StoredCoverage {
  testFiles: string[];
  testSymbolIds: string[];
  coverageStatus: CoverageStatus;
}

// ─── Meta row ─────────────────────────────────────────────────────────────────

export function getTestMapperMeta(repoId: string, db: Database.Database): TestMapperMeta | null {
  const row = db
    .prepare<[string, string, string], { metadata: string }>(
      'SELECT metadata FROM provider_metadata WHERE repo_id = ? AND provider_name = ? AND entity_key = ?',
    )
    .get(repoId, META_PROVIDER, META_KEY);
  if (!row) return null;
  try {
    return JSON.parse(row.metadata) as TestMapperMeta;
  } catch {
    return null;
  }
}

function writeMeta(repoId: string, db: Database.Database, meta: TestMapperMeta): void {
  db.prepare(
    `INSERT INTO provider_metadata (repo_id, provider_name, entity_key, metadata, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, provider_name, entity_key) DO UPDATE SET
       metadata = excluded.metadata, updated_at = excluded.updated_at`,
  ).run(repoId, META_PROVIDER, META_KEY, JSON.stringify(meta), meta.builtAt);
}

// ─── Freshness (Task 650) ─────────────────────────────────────────────────────

/** Test files of the index, sorted by path, with their content hashes. */
function currentTestFiles(db: Database.Database, repoId: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [path, hash] of getAllFileHashes(db, repoId)) {
    if (isTestFilePath(path)) out.push([path, hash]);
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

/** Production symbols with no mapping row (the symbol-side delta). */
function unmappedProdSymbols(db: Database.Database, repoId: string): SymbolRow[] {
  const rows = db
    .prepare<[string, string], SymbolRow>(
      `SELECT s.id, s.name, s.kind, s.file_path FROM symbols s
       WHERE s.repo_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM provider_metadata p
           WHERE p.repo_id = s.repo_id AND p.provider_name = ? AND p.entity_key = s.id
         )`,
    )
    .all(repoId, PROVIDER);
  return rows.filter((s) => !isTestFilePath(s.file_path));
}

/** Mapping rows whose symbol no longer exists (deleted / re-keyed). */
function orphanMappingRows(db: Database.Database, repoId: string): string[] {
  return db
    .prepare<[string, string], { entity_key: string }>(
      `SELECT p.entity_key FROM provider_metadata p
       WHERE p.repo_id = ? AND p.provider_name = ?
         AND NOT EXISTS (SELECT 1 FROM symbols s WHERE s.repo_id = p.repo_id AND s.id = p.entity_key)`,
    )
    .all(repoId, PROVIDER)
    .map((r) => r.entity_key);
}

/**
 * Is the stored mapping current? 'absent' = never built (or built by a
 * pre-1.37 mapper, which left no meta row); 'stale' = a test file changed,
 * appeared or vanished since the last build, or a production symbol has no
 * row. Cheap: hashes + one anti-join, no content read.
 */
export function getTestMapperFreshness(repoId: string, db: Database.Database): TestMapperFreshness {
  const meta = getTestMapperMeta(repoId, db);
  if (!meta || meta.algo !== TEST_MAPPER_ALGO) return 'absent';
  const stored = getTestTokenHashes(db, repoId);
  const current = currentTestFiles(db, repoId);
  if (current.length !== stored.size) return 'stale';
  for (const [path, hash] of current) {
    if (stored.get(path) !== hash) return 'stale';
  }
  if (unmappedProdSymbols(db, repoId).length > 0) return 'stale';
  return 'fresh';
}

/**
 * Lazy build (Task 650, P4): bring the mapping up to date if it is not.
 * Returns what happened so the caller can say `coverage: 'built on demand
 * (N ms)'` in its response. Never throws — a failed build leaves the
 * (possibly stale) rows in place and reports `built: false`.
 */
export function ensureTestMappings(
  repoId: string,
  db: Database.Database,
): { built: boolean; before: TestMapperFreshness; stats?: TestMapperStats } {
  const before = getTestMapperFreshness(repoId, db);
  if (before === 'fresh') return { built: false, before };
  try {
    const stats = buildTestMappings(repoId, db);
    return { built: stats.mode !== 'skipped', before, stats };
  } catch (err) {
    logger.warn(`test-mapper: on-demand build failed (${String(err)})`);
    return { built: false, before };
  }
}

/** One-line rider for tool responses (absent when nothing was built). */
export function coverageRider(
  ensured: ReturnType<typeof ensureTestMappings>,
): { coverage?: string } {
  if (!ensured.built || !ensured.stats) return {};
  const why = ensured.before === 'absent' ? 'index had no test mapping' : 'test mapping was stale';
  return {
    coverage: `built on demand (${ensured.stats.ms} ms, ${ensured.stats.mode}; ${why})`,
  };
}

// ─── Core build ───────────────────────────────────────────────────────────────

/**
 * Bring the test mapping of a repo up to date and persist it.
 *
 *  1. Token side: re-tokenize test files whose content hash moved (or are
 *     new); drop rows for test files that vanished.
 *  2. Symbol side: if any token row changed (or `force`, or no meta row),
 *     re-map EVERY production symbol; otherwise only the ones without a row.
 *  3. Write only the mapping rows whose value changed; delete rows of
 *     symbols that no longer exist.
 *
 * `mode` reports 'full' (every symbol mapped), 'incremental' (a subset), or
 * 'skipped' (nothing to do — the P1 no-op).
 */
export function buildTestMappings(
  repoId: string,
  db: Database.Database,
  options: BuildTestMappingsOptions = {},
): TestMapperStats {
  const t0 = Date.now();
  const meta = getTestMapperMeta(repoId, db);
  const force = options.force === true || !meta || meta.algo !== TEST_MAPPER_ALGO;

  // ── 1. Token side ─────────────────────────────────────────────────────────
  const current = currentTestFiles(db, repoId); // sorted by path
  const stored = force ? new Map<string, string>() : getTestTokenHashes(db, repoId);
  const currentPaths = new Set(current.map(([p]) => p));

  const staleRows: string[] = [];
  if (force) {
    for (const p of getTestTokenHashes(db, repoId).keys()) staleRows.push(p);
  } else {
    for (const p of stored.keys()) if (!currentPaths.has(p)) staleRows.push(p);
  }
  const changed: Array<[string, string]> = current.filter(([p, h]) => stored.get(p) !== h);

  const tokensChanged = staleRows.length > 0 || changed.length > 0;
  if (tokensChanged) {
    const writeTokens = db.transaction(() => {
      for (const p of staleRows) deleteTestTokens(db, repoId, p);
      for (const [path, hash] of changed) {
        const buf = getFileContent(db, repoId, path);
        const tokens = buf ? scanTestFile(buf.toString('utf8')) : new Set<string>();
        upsertTestTokens(db, repoId, path, hash, tokens);
      }
    });
    writeTokens();
  }

  // ── 2. Symbol side: which production symbols need (re)mapping? ────────────
  const remapAll = force || tokensChanged;

  // Cheap delta first (two anti-joins, no row payload): the P1 no-op exits
  // here without loading a single symbol or mapping row.
  let orphans: string[] = [];
  let unmapped: SymbolRow[] = [];
  if (!remapAll) {
    unmapped = unmappedProdSymbols(db, repoId);
    orphans = orphanMappingRows(db, repoId);
    if (unmapped.length === 0 && orphans.length === 0) {
      return { ms: Date.now() - t0, testFiles: current.length, symbols: 0, mode: 'skipped' };
    }
  }

  const allSymbols = db
    .prepare<[string], SymbolRow>(
      'SELECT id, name, kind, file_path FROM symbols WHERE repo_id = ? ORDER BY file_path, start_byte, id',
    )
    .all(repoId);
  const prodSymbols: SymbolRow[] = [];
  const testSymbolsByFile = new Map<string, string[]>();
  for (const s of allSymbols) {
    if (isTestFilePath(s.file_path)) {
      let ids = testSymbolsByFile.get(s.file_path);
      if (!ids) testSymbolsByFile.set(s.file_path, (ids = []));
      ids.push(s.id);
    } else {
      prodSymbols.push(s);
    }
  }

  // Existing rows: on a token-side change every symbol is re-mapped but
  // only rows whose value moved are written (and orphans dropped). Skipped
  // on a forced rebuild (everything is deleted first) and on the symbol-side
  // path (the targets have no row by definition).
  const existing = new Map<string, string>();
  if (remapAll && !force) {
    const prodIds = new Set(prodSymbols.map((s) => s.id));
    for (const r of db
      .prepare<[string, string], { entity_key: string; metadata: string }>(
        'SELECT entity_key, metadata FROM provider_metadata WHERE repo_id = ? AND provider_name = ?',
      )
      .all(repoId, PROVIDER)) {
      if (prodIds.has(r.entity_key)) existing.set(r.entity_key, r.metadata);
      else orphans.push(r.entity_key);
    }
  }

  const targets = remapAll ? prodSymbols : unmapped;

  // ── 3. Match ──────────────────────────────────────────────────────────────
  const filesFor: Map<string, string[]> =
    targets.length > 0 ? matchTargets(db, repoId, targets, current) : new Map<string, string[]>();

  // ── 4. Write ──────────────────────────────────────────────────────────────
  const upsert = db.prepare(
    `INSERT INTO provider_metadata (repo_id, provider_name, entity_key, metadata, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, provider_name, entity_key) DO UPDATE SET
       metadata = excluded.metadata, updated_at = excluded.updated_at`,
  );
  const del = db.prepare(
    'DELETE FROM provider_metadata WHERE repo_id = ? AND provider_name = ? AND entity_key = ?',
  );
  const now = Date.now();
  let written = 0;
  const writeAll = db.transaction(() => {
    if (force) {
      db.prepare('DELETE FROM provider_metadata WHERE repo_id = ? AND provider_name = ?').run(
        repoId,
        PROVIDER,
      );
    } else {
      for (const id of orphans) del.run(repoId, PROVIDER, id);
    }
    for (const sym of targets) {
      const testFiles = filesFor.get(sym.id) ?? [];
      const testSymbolIds: string[] = [];
      for (const f of testFiles) {
        const ids = testSymbolsByFile.get(f);
        if (ids) testSymbolIds.push(...ids);
      }
      let coverageStatus: CoverageStatus;
      if (STRUCTURAL_KINDS.has(sym.kind)) coverageStatus = 'unknown';
      else if (testFiles.length > 0) coverageStatus = 'tested';
      else coverageStatus = 'untested';
      const metadata = JSON.stringify({ testFiles, testSymbolIds, coverageStatus });
      if (existing.size > 0 && existing.get(sym.id) === metadata) continue;
      upsert.run(repoId, PROVIDER, sym.id, metadata, now);
      written++;
    }
    const mode: TestMapperStats['mode'] = remapAll ? 'full' : 'incremental';
    writeMeta(repoId, db, {
      algo: TEST_MAPPER_ALGO,
      builtAt: now,
      mode,
      testFiles: current.length,
      symbols: prodSymbols.length,
      ms: Date.now() - t0,
      tokenBytes: testTokenBytes(db, repoId),
    });
  });

  try {
    writeAll();
  } catch (err) {
    logger.warn(`test-mapper: write transaction failed (${String(err)}), coverage data not stored`);
    return { ms: Date.now() - t0, testFiles: current.length, symbols: 0, mode: 'full' };
  }

  const ms = Date.now() - t0;
  const mode: TestMapperStats['mode'] = remapAll ? 'full' : 'incremental';
  logger.info(
    `test-mapper: ${targets.length} symbols mapped (${written} rows written, ${orphans.length} removed) ` +
      `in ${ms}ms — ${current.length} test files, ${changed.length} re-tokenized, mode ${mode}`,
  );
  return { ms, testFiles: current.length, symbols: targets.length, mode };
}

// ─── Matching ─────────────────────────────────────────────────────────────────

/**
 * symbol id → sorted test file paths that mention the symbol's name.
 * Word names: token-set lookup. Composite names: token prefilter on every
 * word run, then the exact boundary check on the candidate files' content.
 * Names with no word run at all (`...`): exact check on every test file.
 */
function matchTargets(
  db: Database.Database,
  repoId: string,
  targets: SymbolRow[],
  testFiles: Array<[string, string]>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (testFiles.length === 0) return out;

  const tokensByFile = getAllTestTokens(db, repoId);
  const paths = testFiles.map(([p]) => p); // sorted by path

  // Content cache for the composite verification (read once per file per run).
  const contentCache = new Map<string, string | null>();
  const contentOf = (path: string): string | null => {
    let c = contentCache.get(path);
    if (c === undefined) {
      const buf = getFileContent(db, repoId, path);
      c = buf ? buf.toString('utf8') : null;
      contentCache.set(path, c);
    }
    return c;
  };

  // Inverted index token → file ordinals, only worth building for many targets.
  let posting: Map<string, number[]> | null = null;
  if (targets.length >= INVERTED_INDEX_THRESHOLD) {
    posting = new Map();
    for (let i = 0; i < paths.length; i++) {
      const set = tokensByFile.get(paths[i] ?? '');
      if (!set) continue;
      for (const t of set) {
        let list = posting.get(t);
        if (!list) posting.set(t, (list = []));
        list.push(i);
      }
    }
  }

  /** Files (ordinals, ascending) whose token set contains every run. */
  const filesWithAllRuns = (runs: string[]): number[] => {
    if (posting) {
      // Intersect posting lists, rarest first.
      const lists: number[][] = [];
      for (const r of runs) {
        const l = posting.get(r);
        if (!l) return [];
        lists.push(l);
      }
      lists.sort((a, b) => a.length - b.length);
      let acc = lists[0] ?? [];
      for (let k = 1; k < lists.length && acc.length > 0; k++) {
        const other = new Set(lists[k]);
        acc = acc.filter((i) => other.has(i));
      }
      return acc;
    }
    const hits: number[] = [];
    for (let i = 0; i < paths.length; i++) {
      const set = tokensByFile.get(paths[i] ?? '');
      if (!set) continue;
      let all = true;
      for (const r of runs) {
        if (!set.has(r)) {
          all = false;
          break;
        }
      }
      if (all) hits.push(i);
    }
    return hits;
  };

  // Memoize per distinct name — overloads / same-named members share the work.
  const byName = new Map<string, string[]>();
  for (const sym of targets) {
    const name = sym.name;
    if (name.length < MIN_NAME_LENGTH) continue;
    let files = byName.get(name);
    if (files === undefined) {
      const runs = wordRuns(name);
      let ordinals: number[];
      if (runs.length === 1 && runs[0] === name) {
        ordinals = filesWithAllRuns(runs); // word name: the lookup IS the answer
      } else if (runs.length > 0) {
        ordinals = filesWithAllRuns(runs).filter((i) => {
          const c = contentOf(paths[i] ?? '');
          return c !== null && containsBounded(c, name);
        });
      } else {
        ordinals = [];
        for (let i = 0; i < paths.length; i++) {
          const c = contentOf(paths[i] ?? '');
          if (c !== null && containsBounded(c, name)) ordinals.push(i);
        }
      }
      files = ordinals.map((i) => paths[i] ?? '');
      byName.set(name, files);
    }
    if (files.length > 0) out.set(sym.id, files);
  }
  return out;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

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
    .prepare<[string, string, string], { metadata: string }>(
      'SELECT metadata FROM provider_metadata WHERE repo_id = ? AND provider_name = ? AND entity_key = ?',
    )
    .get(repoId, PROVIDER, symbolId);

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
    .prepare<[string, string], { entity_key: string; metadata: string }>(
      'SELECT entity_key, metadata FROM provider_metadata WHERE repo_id = ? AND provider_name = ?',
    )
    .all(repoId, PROVIDER);

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

/**
 * symbol id → coverage status for every mapped production symbol. The cheap
 * form for the tools that only need tested / untested (risk, untested list).
 */
export function getCoverageStatusMap(
  repoId: string,
  db: Database.Database,
): Map<string, { status: CoverageStatus; testFiles: string[] }> {
  const out = new Map<string, { status: CoverageStatus; testFiles: string[] }>();
  for (const m of getAllCoverageForRepo(repoId, db)) {
    out.set(m.symbolId, { status: m.coverageStatus, testFiles: m.testFilePaths });
  }
  return out;
}
