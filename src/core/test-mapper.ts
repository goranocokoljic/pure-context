/**
 * Test Coverage Mapper — heuristic mapping of production symbols to the test
 * files / test symbols that mention them. Phase 104 redesign (Tasks 648–650):
 * incremental by construction, one tokenizing pass per test file, lazy
 * fallback for indexes built with `skipTestMapper`. Phase 107 (Task 665):
 * token-delta remap + the compact bitset store (`db/test-mapping-store.ts`).
 *
 * Matching semantics are UNCHANGED since the pre-1.37 mapper: a production
 * symbol is "tested" when some test file contains its name with a word
 * boundary on both sides (`\bNAME\b`, ASCII word chars). Names shorter than
 * 3 chars are never matched; types / interfaces / enums are 'unknown'
 * (structural, not callable). The test-file universe is every indexed test
 * file (`isTestFilePath`), the one deliberate 1.37 change (DECISION-LOG
 * 2026-09-12).
 *
 * How the product cost went away (P2, 1.37):
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
 * How the incremental cost went away (1.40, Task 665):
 *  - A run in which a FEW test files moved forms the token delta (old ∪ new
 *    tokens of the touched files) and re-derives only the names with a word
 *    run in it: a name with no run in the delta matched the touched files
 *    neither before nor after, so its row cannot have changed. Files outside
 *    the touched set are kept from the stored row; the touched files are
 *    re-checked against their new tokens / content. Names with no word run
 *    at all (`...`) are always re-derived; a composite name when EVERY run
 *    is in the delta (a match needs every run — risk R1 is covered by the
 *    same proof). Which names carry a run is answered by
 *    `test_name_runs` + `idx_symbols_repo_name`, not by reading every symbol.
 *  - Rows are bitsets over stable test-file ordinals (a few hundred bytes),
 *    so patching a row is a handful of bit operations and the "did it
 *    change" check is a byte compare. `index_file` takes this path.
 *
 * Output: `test_mappings` (status + bitset) per production symbol; a meta
 * row under provider 'test-mapper-meta' in `provider_metadata` records the
 * last build. Readers return the same shape as before (`TestMapping`); test
 * SYMBOL ids are derived from the symbols table on read.
 */

import type Database from 'better-sqlite3';
import { logger } from './logger.js';
import { isTestFilePath } from './test-paths.js';
import { getAllFileHashes, getFileContent } from './db/file-store.js';
import {
  deleteTestTokens,
  getAllTestTokens,
  getTestTokenHashes,
  getTestTokensFor,
  testTokenBytes,
  upsertTestTokens,
} from './db/test-token-store.js';
import {
  addTestFileOrd,
  bitsetCount,
  bitsetEquals,
  bitsetFrom,
  bitsetOrds,
  deleteAllMappings,
  deleteMappingRows,
  deleteNameRunsFor,
  deleteTestFileOrd,
  getAllMappingRows,
  getMappingRow,
  getMappingRowsFor,
  getMappingStatuses,
  getTestFileOrds,
  mappingBytes,
  mappingCount,
  mappingWriter,
  nameRunWriter,
  orphanMappingIds,
  replaceTestFileOrds,
  symbolIdsWithRuns,
  type CoverageStatus,
  type MappingRow,
} from './db/test-mapping-store.js';
import { countSymbolRefs, getReverseRefs } from './db/symbol-ref-store.js';
import type { TestMapperStats } from './types.js';

export type { CoverageStatus } from './db/test-mapping-store.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TestMapping {
  symbolId: string;
  testSymbolIds: string[];
  testFilePaths: string[];
  coverageStatus: CoverageStatus;
  /**
   * Phase 107 (Task 666): the test symbols that carry a Phase-101 `ref` edge
   * to this symbol — tests whose body RESOLVES to it, not ones that merely
   * mention the name in a string or comment. Normally a subset of
   * `testSymbolIds` (a ref through an import alias is the exception). Present
   * only when the index has symbol refs (`list_repos.symbolRefs > 0`);
   * absent (not empty) otherwise.
   */
  testSymbolIdsByRef?: string[];
  /** Files of `testSymbolIdsByRef`, sorted. Same presence rule. */
  testFilePathsByRef?: string[];
}

/**
 * What counts as "tested" (Task 666). 'mention' — some test file contains the
 * name with word boundaries (the store's answer, the default since 1.0).
 * 'ref' — some test SYMBOL references the production symbol through a
 * Phase-101 `ref` edge. Both are reported where they differ; the caller picks.
 */
export type CoverageStrictness = 'mention' | 'ref';

/** How the stored mapping relates to the index right now (Task 650). */
export type TestMapperFreshness = 'fresh' | 'stale' | 'absent';

export interface TestMapperMeta {
  /** Bump when the matching semantics or the store change: a stale algo forces a rebuild. */
  algo: number;
  builtAt: number;
  mode: TestMapperStats['mode'];
  testFiles: number;
  symbols: number;
  ms: number;
  /** Stored size of the token rows after this build (R2). */
  tokenBytes: number;
  /** Stored size of the mapping + run rows after this build (Phase 107). */
  mappingBytes?: number;
  /**
   * `MAX(rowid)` of the symbols table when this row was written (Phase 107).
   * Every insert / replace takes a fresh rowid, so an unchanged maximum plus
   * agreeing counts means the symbol side did not move and the two anti-joins
   * are skipped (a VACUUM may renumber → one false positive, still correct).
   */
  symbolsMaxRowid?: number;
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

const LEGACY_PROVIDER = 'test-mapper';
const META_PROVIDER = 'test-mapper-meta';
const META_KEY = 'repo';
/**
 * Matching semantics / store version (see TestMapperMeta.algo). 2 = the 1.37
 * JSON rows in provider_metadata; 3 = the 1.40 compact store. A stale algo
 * forces a rebuild, which also deletes the old rows.
 */
export const TEST_MAPPER_ALGO = 3;

/** Above this many symbols to map, build an inverted token index first. */
const INVERTED_INDEX_THRESHOLD = 512;

/**
 * Delta remap (Task 665) runs when at most this share of the test files
 * moved (floor `DELTA_MIN_TOUCHED`): its cost is |touched names| x
 * |touched files|, the full path's is |all names| + one posting index, so a
 * branch switch that rewrote most test files takes the full path.
 */
const DELTA_MAX_TOUCHED_SHARE = 0.1;
const DELTA_MIN_TOUCHED = 8;

const CHUNK = 500;
const PATH_ORDER = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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

/** Does one test file (its token set + content) mention the name? The predicate every path shares. */
function fileMatches(name: string, tokens: Set<string>, content: () => string | null): boolean {
  if (name.length < MIN_NAME_LENGTH) return false;
  const runs = wordRuns(name);
  if (runs.length === 1 && runs[0] === name) return tokens.has(name);
  for (const r of runs) if (!tokens.has(r)) return false;
  const c = content();
  return c !== null && containsBounded(c, name);
}

// ─── Database row shapes ──────────────────────────────────────────────────────

interface SymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
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
  out.sort((a, b) => PATH_ORDER(a[0], b[0]));
  return out;
}

/**
 * Production symbols with no mapping row (the symbol-side delta). Test-file
 * symbols are excluded in SQL through the token table (every current test
 * file has a token row once step 1 of a build has run) and again in JS.
 */
function unmappedProdSymbols(db: Database.Database, repoId: string): SymbolRow[] {
  const rows = db
    .prepare<[string, string], SymbolRow>(
      `SELECT s.id, s.name, s.kind, s.file_path FROM symbols s
       WHERE s.repo_id = ?
         AND s.file_path NOT IN (SELECT t.file_path FROM test_file_tokens t WHERE t.repo_id = ?)
         AND NOT EXISTS (
           SELECT 1 FROM test_mappings m WHERE m.repo_id = s.repo_id AND m.symbol_id = s.id
         )`,
    )
    .all(repoId, repoId);
  return rows.filter((s) => !isTestFilePath(s.file_path));
}

/**
 * Is the stored mapping current? 'absent' = never built (or built by an
 * older mapper, whose meta row carries another algo); 'stale' = a test file
 * changed, appeared or vanished since the last build, or a production symbol
 * has no row. Cheap: hashes + one anti-join, no content read.
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
  const side = symbolSideDelta(db, repoId, meta);
  if (side.unmapped.length > 0 || side.orphans.length > 0) return 'stale';
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
 *     new); drop rows for test files that vanished. Keep the ordinal table
 *     in step (new file → `max + 1`, deleted file → its row goes and its
 *     bit is cleared below; a forced rebuild compacts).
 *  2. Symbol side: which production symbols need (re)mapping —
 *     'full'        every one (forced, first build, or many test files moved);
 *     'delta'       the names whose word runs meet the touched files' old ∪
 *                   new tokens, plus new symbols (Task 665);
 *     'incremental' only the symbols without a row (tokens unchanged);
 *     'skipped'     nothing to do — the P1 no-op.
 *  3. Write only the rows whose bitset or status changed; delete rows of
 *     symbols that no longer exist; keep `test_name_runs` in step.
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

  // Delta decision (Task 665): a previous build exists and few files moved.
  const touched = [...staleRows, ...changed.map(([p]) => p)];
  const deltaCap = Math.max(DELTA_MIN_TOUCHED, Math.floor(current.length * DELTA_MAX_TOUCHED_SHARE));
  const useDelta = !force && tokensChanged && stored.size > 0 && touched.length <= deltaCap;
  // Old token sets of the touched files, read BEFORE the rows are rewritten.
  const oldTokens = useDelta ? getTestTokensFor(db, repoId, touched) : new Map<string, Set<string>>();
  const newTokens = new Map<string, Set<string>>(); // changed path → new token set
  const newContent = new Map<string, string>(); // changed path → content (composite re-check)

  if (tokensChanged) {
    db.transaction(() => {
      for (const p of staleRows) deleteTestTokens(db, repoId, p);
      for (const [path, hash] of changed) {
        const buf = getFileContent(db, repoId, path);
        const text = buf ? buf.toString('utf8') : '';
        const tokens = scanTestFile(text);
        upsertTestTokens(db, repoId, path, hash, tokens);
        if (useDelta) {
          newTokens.set(path, tokens);
          newContent.set(path, text);
        }
      }
    })();
  }

  // Ordinals: compact on force (done inside the write transaction below);
  // otherwise stable — drop deleted files (their old ordinals are bits to
  // clear), append new ones.
  let ords = force ? new Map<string, number>() : getTestFileOrds(db, repoId);
  const touchedOrds: number[] = [];
  let ordsBroken = false;
  if (!force) {
    db.transaction(() => {
      for (const p of staleRows) {
        const o = ords.get(p);
        if (o !== undefined) touchedOrds.push(o);
        deleteTestFileOrd(db, repoId, p);
        ords.delete(p);
      }
      for (const [p] of current) {
        const known = ords.get(p);
        if (known !== undefined) {
          if (newTokens.has(p)) touchedOrds.push(known);
          continue;
        }
        // No ordinal: a new test file, or a stored one the store lost track
        // of (no row can carry its bit → every row must be re-derived).
        if (stored.has(p)) ordsBroken = true;
        const o = addTestFileOrd(db, repoId, p);
        ords.set(p, o);
        touchedOrds.push(o);
      }
    })();
  }

  // ── 2. Symbol side: which production symbols need (re)mapping? ────────────
  const remapAll = force || ordsBroken || (tokensChanged && !useDelta);

  // Cheap delta first (two anti-joins, no row payload): the P1 no-op exits
  // here without loading a single symbol or mapping row.
  let orphans: string[] = [];
  let unmapped: SymbolRow[] = [];
  if (!remapAll) {
    ({ orphans, unmapped } = symbolSideDelta(db, repoId, meta));
    if (!useDelta && unmapped.length === 0 && orphans.length === 0) {
      return { ms: Date.now() - t0, testFiles: current.length, symbols: 0, mode: 'skipped' };
    }
  }

  // ── 3. Match ──────────────────────────────────────────────────────────────
  const existing = new Map<string, MappingRow>();
  let targets: SymbolRow[];
  const bitsFor = new Map<string, Buffer | null>(); // symbol id → new bitset
  const toBits = (files: readonly string[]): Buffer | null => {
    const out: number[] = [];
    for (const f of files) {
      const o = ords.get(f);
      if (o !== undefined) out.push(o);
    }
    return bitsetFrom(out);
  };

  if (force) {
    // Compact ordinals first so the bitsets below are in the new space.
    ords = new Map(current.map(([p], i) => [p, i]));
  }

  if (remapAll) {
    targets = prodSymbols(db, repoId);
    if (!force) {
      const prodIds = new Set(targets.map((s) => s.id));
      for (const r of getAllMappingRows(db, repoId)) {
        if (prodIds.has(r.symbolId)) existing.set(r.symbolId, r);
        else orphans.push(r.symbolId);
      }
    }
    for (const [id, files] of matchTargets(db, repoId, targets, current)) bitsFor.set(id, toBits(files));
  } else if (useDelta) {
    const delta = new Set<string>();
    for (const set of oldTokens.values()) for (const t of set) delta.add(t);
    for (const set of newTokens.values()) for (const t of set) delta.add(t);
    const unmappedIds = new Set(unmapped.map((s) => s.id));
    const deltaTargets = deltaTargetSymbols(db, repoId, delta).filter((s) => !unmappedIds.has(s.id));
    for (const r of getMappingRowsFor(db, repoId, deltaTargets.map((s) => s.id)).values()) {
      existing.set(r.symbolId, r);
    }
    patchTargets(deltaTargets, existing, touchedOrds, ords, newTokens, newContent, bitsFor);
    if (unmapped.length > 0) {
      for (const [id, files] of matchTargets(db, repoId, unmapped, current)) bitsFor.set(id, toBits(files));
    }
    targets = deltaTargets.concat(unmapped);
  } else {
    targets = unmapped;
    for (const [id, files] of matchTargets(db, repoId, targets, current)) bitsFor.set(id, toBits(files));
  }

  // ── 4. Write ──────────────────────────────────────────────────────────────
  const now = Date.now();
  let written = 0;
  const mode: TestMapperStats['mode'] = useDelta ? 'delta' : remapAll ? 'full' : 'incremental';
  const writeAll = db.transaction(() => {
    const put = mappingWriter(db, repoId);
    const putRun = nameRunWriter(db, repoId);
    if (force) {
      deleteAllMappings(db, repoId);
      // The 1.37–1.39 JSON rows (algo 2) — dropped once, here.
      db.prepare('DELETE FROM provider_metadata WHERE repo_id = ? AND provider_name = ?').run(
        repoId,
        LEGACY_PROVIDER,
      );
      replaceTestFileOrds(db, repoId, current.map(([p]) => p));
    } else if (orphans.length > 0) {
      deleteMappingRows(db, repoId, orphans);
      deleteNameRunsFor(db, repoId, orphans);
    }
    if (remapAll && !force) {
      // Runs are re-derived for every production symbol on a full pass.
      db.prepare('DELETE FROM test_name_runs WHERE repo_id = ?').run(repoId);
    }
    for (const sym of targets) {
      const files = bitsFor.get(sym.id) ?? null;
      const fileCount = bitsetCount(files);
      let status: CoverageStatus;
      if (STRUCTURAL_KINDS.has(sym.kind)) status = 'unknown';
      else if (fileCount > 0) status = 'tested';
      else status = 'untested';
      const prev = existing.get(sym.id);
      if (prev && prev.status === status && bitsetEquals(prev.files, files)) continue;
      put({ symbolId: sym.id, status, fileCount, files });
      written++;
    }
    // Composite-name runs: every target on a full pass, the new symbols otherwise.
    for (const sym of remapAll ? targets : unmapped) {
      const runs = wordRuns(sym.name);
      if (runs.length === 1 && runs[0] === sym.name) continue; // plain word name: idx_symbols_repo_name answers
      if (runs.length === 0) putRun('', sym.id);
      else for (const r of new Set(runs)) putRun(r, sym.id);
    }
    writeMeta(repoId, db, {
      algo: TEST_MAPPER_ALGO,
      builtAt: now,
      mode,
      testFiles: current.length,
      symbols: remapAll ? targets.length : Math.max(0, (meta?.symbols ?? 0) + unmapped.length - orphans.length),
      ms: Date.now() - t0,
      tokenBytes: testTokenBytes(db, repoId),
      // A SUM over every row (flutter ~100 ms): measured on full passes, carried otherwise.
      mappingBytes: remapAll ? mappingBytes(db, repoId) : meta?.mappingBytes,
      symbolsMaxRowid: symbolsMaxRowid(db),
    });
  });

  try {
    writeAll();
  } catch (err) {
    logger.warn(`test-mapper: write transaction failed (${String(err)}), coverage data not stored`);
    return { ms: Date.now() - t0, testFiles: current.length, symbols: 0, mode: 'full' };
  }

  const ms = Date.now() - t0;
  logger.info(
    `test-mapper: ${targets.length} symbols mapped (${written} rows written, ${orphans.length} removed) ` +
      `in ${ms}ms — ${current.length} test files, ${changed.length} re-tokenized, mode ${mode}`,
  );
  return { ms, testFiles: current.length, symbols: targets.length, mode };
}

// ─── Symbol reads ─────────────────────────────────────────────────────────────

/** Production symbols = every symbol minus those in files with a token row (see unmappedProdSymbols). */
function prodSymbolCount(db: Database.Database, repoId: string): number {
  const all = db.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM symbols WHERE repo_id = ?').get(repoId)?.c ?? 0;
  const inTests =
    db
      .prepare<[string, string], { c: number }>(
        `SELECT COUNT(*) AS c FROM symbols s
         WHERE s.repo_id = ? AND s.file_path IN (SELECT t.file_path FROM test_file_tokens t WHERE t.repo_id = ?)`,
      )
      .get(repoId, repoId)?.c ?? 0;
  return all - inTests;
}

/**
 * The cheap "did the symbol side move" probe: `MAX(rowid)` over the whole
 * table (O(log n); one repo per index file, another repo's writes only cost
 * a false positive). Every INSERT OR REPLACE takes a fresh rowid.
 */
function symbolsMaxRowid(db: Database.Database): number {
  return db.prepare<[], { m: number | null }>('SELECT MAX(rowid) AS m FROM symbols').get()?.m ?? -1;
}

/**
 * The symbol-side delta: mapping rows without a symbol (orphans) and
 * production symbols without a row (unmapped). Two anti-joins over the whole
 * symbol table (flutter: ~300 ms) — skipped when nothing can have moved: the
 * symbols table's MAX(rowid) is what the last build saw and the production
 * and mapping counts agree (mapping ids ⊆ production ids without orphans,
 * so equal counts mean equal sets).
 */
function symbolSideDelta(
  db: Database.Database,
  repoId: string,
  meta: TestMapperMeta | null,
): { orphans: string[]; unmapped: SymbolRow[] } {
  if (
    meta?.symbolsMaxRowid !== undefined &&
    symbolsMaxRowid(db) === meta.symbolsMaxRowid &&
    prodSymbolCount(db, repoId) === mappingCount(db, repoId)
  ) {
    return { orphans: [], unmapped: [] };
  }
  const orphans = orphanMappingIds(db, repoId);
  const unmapped =
    orphans.length > 0 || prodSymbolCount(db, repoId) !== mappingCount(db, repoId)
      ? unmappedProdSymbols(db, repoId)
      : [];
  return { orphans, unmapped };
}

/** Every production symbol (test-file symbols excluded), in a deterministic order. */
function prodSymbols(db: Database.Database, repoId: string): SymbolRow[] {
  return db
    .prepare<[string, string], SymbolRow>(
      `SELECT id, name, kind, file_path FROM symbols
       WHERE repo_id = ?
         AND file_path NOT IN (SELECT t.file_path FROM test_file_tokens t WHERE t.repo_id = ?)
       ORDER BY file_path, start_byte, id`,
    )
    .all(repoId, repoId)
    .filter((s) => !isTestFilePath(s.file_path));
}

/** Symbols by id (chunked IN); test-file symbols dropped; ordered by id. */
function symbolsById(db: Database.Database, repoId: string, ids: readonly string[]): SymbolRow[] {
  const out: SymbolRow[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    out.push(
      ...db
        .prepare<string[], SymbolRow>(
          `SELECT id, name, kind, file_path FROM symbols
           WHERE repo_id = ? AND id IN (${slice.map(() => '?').join(',')})`,
        )
        .all(repoId, ...slice),
    );
  }
  return out.filter((s) => !isTestFilePath(s.file_path)).sort((a, b) => PATH_ORDER(a.id, b.id));
}

/**
 * The production symbols a token delta can touch (Task 665): plain word
 * names through `name IN (delta)` on the symbols index, composite names
 * through their stored runs, zero-run names always (run '').
 */
function deltaTargetSymbols(db: Database.Database, repoId: string, delta: Set<string>): SymbolRow[] {
  const tokens = [...delta];
  const seen = new Set<string>();
  const out: SymbolRow[] = [];
  for (let i = 0; i < tokens.length; i += CHUNK) {
    const slice = tokens.slice(i, i + CHUNK);
    for (const s of db
      .prepare<string[], SymbolRow>(
        `SELECT id, name, kind, file_path FROM symbols
         WHERE repo_id = ? AND name IN (${slice.map(() => '?').join(',')})`,
      )
      .all(repoId, ...slice)) {
      if (seen.has(s.id) || isTestFilePath(s.file_path)) continue;
      seen.add(s.id);
      out.push(s);
    }
  }
  const composite = [...symbolIdsWithRuns(db, repoId, [...tokens, ''])].filter((id) => !seen.has(id));
  // A composite name matches a file only when EVERY run is a token of it, so
  // it can have moved only when every run is in the delta (`Foo.build` stays
  // put when the touched file never held `Foo`). Zero-run names always qualify.
  for (const s of symbolsById(db, repoId, composite)) {
    if (wordRuns(s.name).every((r) => delta.has(r))) out.push(s);
  }
  return out;
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
  if (testFiles.length === 0 || targets.length === 0) return out;

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

/**
 * Delta patch (Task 665): for each target, start from its stored bitset,
 * clear every touched ordinal (deleted files, and changed files before their
 * re-check), then set the ordinals of the changed files whose NEW tokens /
 * content match the name. Writes into `bitsFor`.
 */
function patchTargets(
  targets: SymbolRow[],
  existing: Map<string, MappingRow>,
  touchedOrds: readonly number[],
  ords: Map<string, number>,
  newTokens: Map<string, Set<string>>,
  newContent: Map<string, string>,
  bitsFor: Map<string, Buffer | null>,
): void {
  const changedPaths = [...newTokens.keys()];
  // Memoize per distinct name — overloads / same-named members share the work.
  const hitOrdsByName = new Map<string, number[]>();
  const hitOrdsFor = (name: string): number[] => {
    let hits = hitOrdsByName.get(name);
    if (hits !== undefined) return hits;
    hits = [];
    for (const p of changedPaths) {
      const tokens = newTokens.get(p);
      if (tokens && fileMatches(name, tokens, () => newContent.get(p) ?? null)) {
        hits.push(ords.get(p) as number);
      }
    }
    hitOrdsByName.set(name, hits);
    return hits;
  };

  for (const sym of targets) {
    bitsFor.set(sym.id, patchBitset(existing.get(sym.id)?.files ?? null, touchedOrds, hitOrdsFor(sym.name)));
  }
}

/** Copy of `prev` with `clear` bits off and `set` bits on, trimmed; null when empty. */
function patchBitset(prev: Buffer | null, clear: readonly number[], set: readonly number[]): Buffer | null {
  let max = prev ? prev.length * 8 - 1 : -1;
  for (const o of set) if (o > max) max = o;
  if (max < 0) return null;
  const buf = Buffer.alloc((max >> 3) + 1);
  if (prev) prev.copy(buf);
  for (const o of clear) if (o <= max) buf[o >> 3] &= ~(1 << (o & 7));
  for (const o of set) buf[o >> 3] |= 1 << (o & 7);
  let n = buf.length;
  while (n > 0 && buf[n - 1] === 0) n--;
  return n === 0 ? null : n === buf.length ? buf : buf.subarray(0, n);
}

// ─── Ref-narrowed coverage (Task 666) ─────────────────────────────────────────

/**
 * Production symbol ids that at least one TEST symbol references through a
 * `ref` edge (local rows only — the test lives in this index). Null when the
 * index stores no refs at all, so callers can say "unavailable" rather than
 * "nothing is tested".
 */
export function getRefTestedSymbolIds(repoId: string, db: Database.Database): Set<string> | null {
  if (countSymbolRefs(db, repoId) === 0) return null;
  const rows = db
    .prepare<[string, string], { target_symbol_id: string; source_file: string }>(
      `SELECT target_symbol_id, source_file FROM symbol_refs
       WHERE repo_id = ? AND target_repo_id = ''
         AND source_file IN (SELECT t.file_path FROM test_file_tokens t WHERE t.repo_id = ?)`,
    )
    .all(repoId, repoId);
  const out = new Set<string>();
  for (const r of rows) if (isTestFilePath(r.source_file)) out.add(r.target_symbol_id);
  return out;
}

/** The test symbols (and their files) that reference `symbolId`; null when the index has no refs. */
export function getRefTestSymbols(
  repoId: string,
  symbolId: string,
  db: Database.Database,
): { symbolIds: string[]; files: string[] } | null {
  if (countSymbolRefs(db, repoId) === 0) return null;
  const symbolIds: string[] = [];
  const files = new Set<string>();
  for (const r of getReverseRefs(db, repoId, symbolId)) {
    if (!isTestFilePath(r.sourceFile)) continue;
    symbolIds.push(r.sourceSymbolId);
    files.add(r.sourceFile);
  }
  return { symbolIds, files: [...files].sort(PATH_ORDER) };
}

// ─── Query helpers ────────────────────────────────────────────────────────────

/** ordinal → path, for expanding bitsets on read. */
function pathsByOrd(db: Database.Database, repoId: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const [p, o] of getTestFileOrds(db, repoId)) out.set(o, p);
  return out;
}

/** The sorted test file paths of a row. */
function filesOf(row: MappingRow, byOrd: Map<number, string>): string[] {
  const files: string[] = [];
  for (const o of bitsetOrds(row.files)) {
    const p = byOrd.get(o);
    if (p !== undefined) files.push(p);
  }
  return files.sort(PATH_ORDER);
}

/** file → its symbol ids ordered by start byte, for the given files (chunked IN). */
function symbolIdsByFile(db: Database.Database, repoId: string, files: readonly string[]): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (let i = 0; i < files.length; i += CHUNK) {
    const slice = files.slice(i, i + CHUNK);
    for (const r of db
      .prepare<string[], { id: string; file_path: string }>(
        `SELECT id, file_path FROM symbols
         WHERE repo_id = ? AND file_path IN (${slice.map(() => '?').join(',')})
         ORDER BY file_path, start_byte, id`,
      )
      .all(repoId, ...slice)) {
      let ids = byFile.get(r.file_path);
      if (!ids) byFile.set(r.file_path, (ids = []));
      ids.push(r.id);
    }
  }
  return byFile;
}

/** Test symbol ids of `files` in file order (the pre-1.40 `testSymbolIds` shape, derived). */
function flattenIds(files: readonly string[], byFile: Map<string, string[]>): string[] {
  const out: string[] = [];
  for (const f of files) {
    const ids = byFile.get(f);
    if (ids) out.push(...ids);
  }
  return out;
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
  const row = getMappingRow(db, repoId, symbolId);
  if (!row) return null;
  const files = row.fileCount > 0 ? filesOf(row, pathsByOrd(db, repoId)) : [];
  const out: TestMapping = {
    symbolId,
    testFilePaths: files,
    testSymbolIds: flattenIds(files, symbolIdsByFile(db, repoId, files)),
    coverageStatus: row.status,
  };
  const byRef = getRefTestSymbols(repoId, symbolId, db);
  if (byRef) {
    out.testSymbolIdsByRef = byRef.symbolIds; // ordered by file, then symbol id
    out.testFilePathsByRef = byRef.files;
  }
  return out;
}

/**
 * Retrieve all test mappings for a repo.
 * Returns an array of TestMapping, one per production symbol.
 */
export function getAllCoverageForRepo(
  repoId: string,
  db: Database.Database,
): TestMapping[] {
  const rows = getAllMappingRows(db, repoId);
  const byOrd = pathsByOrd(db, repoId);
  const idsByFile = symbolIdsByFile(db, repoId, [...byOrd.values()]);
  return rows.map((row) => {
    const files = row.fileCount > 0 ? filesOf(row, byOrd) : [];
    return {
      symbolId: row.symbolId,
      testFilePaths: files,
      testSymbolIds: flattenIds(files, idsByFile),
      coverageStatus: row.status,
    };
  });
}

/**
 * symbol id → coverage status + matched-file count for every mapped
 * production symbol. The cheap form for the tools that only need tested /
 * untested (risk, untested list): no bitset is expanded.
 */
export function getCoverageStatusMap(
  repoId: string,
  db: Database.Database,
): Map<string, { status: CoverageStatus; testFileCount: number }> {
  const out = new Map<string, { status: CoverageStatus; testFileCount: number }>();
  for (const r of getMappingStatuses(db, repoId)) {
    out.set(r.symbolId, { status: r.status, testFileCount: r.fileCount });
  }
  return out;
}

/**
 * Write one symbol's mapping directly (test fixtures, and any provider that
 * knows the answer). Paths without an ordinal get one. The meta row is NOT
 * touched — a fixture that wants the lazy build to stay away writes it too.
 */
export function writeSymbolCoverage(
  repoId: string,
  db: Database.Database,
  symbolId: string,
  testFilePaths: readonly string[],
  coverageStatus: CoverageStatus,
): void {
  db.transaction(() => {
    const ords = getTestFileOrds(db, repoId);
    const set = new Set<number>();
    for (const p of testFilePaths) {
      let o = ords.get(p);
      if (o === undefined) {
        o = addTestFileOrd(db, repoId, p);
        ords.set(p, o);
      }
      set.add(o);
    }
    mappingWriter(db, repoId)({ symbolId, status: coverageStatus, fileCount: set.size, files: bitsetFrom(set) });
  })();
}
