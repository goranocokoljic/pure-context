/**
 * Tests for src/core/test-mapper.ts
 *
 * Strategy: open an in-memory (or temp-file) database, populate `symbols` and
 * `files` tables with representative rows, run `buildTestMappings`, and assert
 * on the stored mapping (Phase 107: `test_mappings` bitset rows) via
 * `getSymbolCoverage` / `getAllCoverageForRepo`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import {
  buildTestMappings,
  getSymbolCoverage,
  getAllCoverageForRepo,
  getCoverageStatusMap,
  getTestMapperFreshness,
  getTestMapperMeta,
  TEST_MAPPER_ALGO,
} from '../../src/core/test-mapper.js';
import { TEST_TOKEN_DDL } from '../../src/core/db/test-token-store.js';
import {
  TEST_MAPPING_DDL,
  bitsetCount,
  bitsetEquals,
  bitsetFrom,
  bitsetOrds,
  getTestFileOrds,
} from '../../src/core/db/test-mapping-store.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal DDL — only the tables test-mapper touches. */
const MINIMAL_DDL = `
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  file_count   INTEGER NOT NULL DEFAULT 0,
  languages    TEXT    NOT NULL DEFAULT '[]',
  indexed_at   INTEGER NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  clone_path   TEXT,
  tenant_id    TEXT    NOT NULL DEFAULT 'local'
);

CREATE TABLE IF NOT EXISTS symbols (
  id          TEXT NOT NULL,
  repo_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  start_byte  INTEGER NOT NULL DEFAULT 0,
  end_byte    INTEGER NOT NULL DEFAULT 0,
  signature   TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  framework_meta TEXT,
  indexed_at  INTEGER NOT NULL DEFAULT 0,
  tenant_id   TEXT NOT NULL DEFAULT 'local',
  PRIMARY KEY (id, repo_id)
);

CREATE TABLE IF NOT EXISTS files (
  repo_id      TEXT NOT NULL,
  path         TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  raw_content  TEXT,
  indexed_at   INTEGER NOT NULL DEFAULT 0,
  tenant_id    TEXT NOT NULL DEFAULT 'local',
  PRIMARY KEY (repo_id, path)
);

CREATE TABLE IF NOT EXISTS symbol_refs (
  repo_id          TEXT    NOT NULL,
  source_file      TEXT    NOT NULL,
  source_symbol_id TEXT    NOT NULL,
  target_file      TEXT    NOT NULL,
  target_symbol_id TEXT    NOT NULL,
  target_repo_id   TEXT    NOT NULL DEFAULT '',
  name             TEXT    NOT NULL,
  confidence       TEXT    NOT NULL DEFAULT 'lexical',
  ref_count        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (repo_id, source_symbol_id, target_repo_id, target_symbol_id)
);

CREATE TABLE IF NOT EXISTS provider_metadata (
  repo_id       TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  entity_key    TEXT NOT NULL,
  metadata      TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (repo_id, provider_name, entity_key),
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);
`;

function openTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(MINIMAL_DDL);
  db.exec(TEST_TOKEN_DDL);
  db.exec(TEST_MAPPING_DDL);
  return db;
}

const REPO_ID = 'testrepo01234567';

function insertRepo(db: InstanceType<typeof Database>) {
  db.prepare(`
    INSERT OR IGNORE INTO repos (id, root_path, indexed_at)
    VALUES (?, '/fake/root', ?)
  `).run(REPO_ID, Date.now());
}

function insertSymbol(
  db: InstanceType<typeof Database>,
  id: string,
  name: string,
  kind: string,
  filePath: string,
) {
  db.prepare(`
    INSERT OR REPLACE INTO symbols (id, repo_id, name, kind, file_path)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, REPO_ID, name, kind, filePath);
}

function insertFile(
  db: InstanceType<typeof Database>,
  path: string,
  content: string,
) {
  // Phase 104: token rows are keyed by content hash — a real one, so a
  // re-inserted file with new content is re-tokenized.
  const hash = createHash('sha256').update(content).digest('hex');
  db.prepare(`
    INSERT OR REPLACE INTO files (repo_id, path, content_hash, raw_content)
    VALUES (?, ?, ?, ?)
  `).run(REPO_ID, path, hash, content);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildTestMappings', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = openTestDb();
    insertRepo(db);
  });

  it('marks a production symbol as tested when its name appears in a test file', () => {
    insertSymbol(db, 'sym001', 'formatDiagnostic', 'function', 'src/utils.ts');
    insertSymbol(db, 'sym002', 'testFormatDiagnostic', 'function', 'test/utils.test.ts');
    insertFile(db, 'test/utils.test.ts', "import { formatDiagnostic } from '../src/utils.js';\nformatDiagnostic({ message: 'x', severity: 'error', file: 'f', line: 1 });");

    buildTestMappings(REPO_ID, db);

    const mapping = getSymbolCoverage(REPO_ID, 'sym001', db);
    expect(mapping).not.toBeNull();
    expect(mapping!.coverageStatus).toBe('tested');
    expect(mapping!.testFilePaths).toContain('test/utils.test.ts');
  });

  it('marks a production symbol as untested when no test file references it', () => {
    insertSymbol(db, 'sym003', 'orphanFunction', 'function', 'src/orphan.ts');
    insertSymbol(db, 'sym004', 'someTestHelper', 'function', 'test/utils.test.ts');
    insertFile(db, 'test/utils.test.ts', 'console.log("hello world");');

    buildTestMappings(REPO_ID, db);

    const mapping = getSymbolCoverage(REPO_ID, 'sym003', db);
    expect(mapping).not.toBeNull();
    expect(mapping!.coverageStatus).toBe('untested');
    expect(mapping!.testFilePaths).toHaveLength(0);
  });

  it('marks interface / type / enum symbols as unknown regardless of test references', () => {
    insertSymbol(db, 'sym005', 'MyInterface', 'interface', 'src/types.ts');
    insertSymbol(db, 'sym006', 'MyType',      'type',      'src/types.ts');
    insertSymbol(db, 'sym007', 'MyEnum',      'enum',      'src/types.ts');
    insertFile(db, 'test/types.test.ts', 'import type { MyInterface, MyType, MyEnum } from "../src/types.js";');

    buildTestMappings(REPO_ID, db);

    for (const id of ['sym005', 'sym006', 'sym007']) {
      const m = getSymbolCoverage(REPO_ID, id, db);
      expect(m).not.toBeNull();
      expect(m!.coverageStatus).toBe('unknown');
    }
  });

  it('does NOT create mapping rows for test-file symbols', () => {
    insertSymbol(db, 'sym008', 'prodFn', 'function', 'src/prod.ts');
    insertSymbol(db, 'sym009', 'testFn', 'function', 'test/prod.test.ts');
    insertFile(db, 'test/prod.test.ts', 'import { prodFn } from "../src/prod.js"; prodFn();');

    buildTestMappings(REPO_ID, db);

    // test-file symbols should not get a mapping row
    const testMapping = getSymbolCoverage(REPO_ID, 'sym009', db);
    expect(testMapping).toBeNull();
  });

  it('returns the correct count of mapped symbols', () => {
    insertSymbol(db, 'sym010', 'alpha', 'function', 'src/a.ts');
    insertSymbol(db, 'sym011', 'beta',  'function', 'src/b.ts');
    insertSymbol(db, 'sym012', 'gamma', 'function', 'test/a.test.ts');

    const count = buildTestMappings(REPO_ID, db).symbols;
    // Only 2 production symbols (sym010, sym011); sym012 is a test symbol.
    expect(count).toBe(2);
  });

  it('handles repos with no test files gracefully', () => {
    insertSymbol(db, 'sym013', 'noTests', 'function', 'src/lonely.ts');

    const count = buildTestMappings(REPO_ID, db).symbols;
    expect(count).toBe(1);

    const mapping = getSymbolCoverage(REPO_ID, 'sym013', db);
    expect(mapping!.coverageStatus).toBe('untested');
    expect(mapping!.testFilePaths).toHaveLength(0);
  });

  it('handles repos with no symbols gracefully', () => {
    const count = buildTestMappings(REPO_ID, db).symbols;
    expect(count).toBe(0);
  });

  it('re-running buildTestMappings replaces old data (idempotent)', () => {
    insertSymbol(db, 'sym014', 'myFunc', 'function', 'src/myFunc.ts');
    insertFile(db, 'test/myFunc.test.ts', 'myFunc is tested here');
    insertSymbol(db, 'sym015', 'testMyFunc', 'function', 'test/myFunc.test.ts');

    buildTestMappings(REPO_ID, db);
    buildTestMappings(REPO_ID, db);

    // Only one row should exist per symbol (ON CONFLICT REPLACE).
    const rows = db.prepare(
      "SELECT COUNT(*) AS c FROM test_mappings WHERE repo_id = ? AND symbol_id = 'sym014'",
    ).get(REPO_ID) as { c: number };
    expect(rows.c).toBe(1);
  });
});

describe('getAllCoverageForRepo', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = openTestDb();
    insertRepo(db);
  });

  it('returns all production symbols after mapping', () => {
    insertSymbol(db, 'sym020', 'funcA', 'function', 'src/a.ts');
    insertSymbol(db, 'sym021', 'funcB', 'function', 'src/b.ts');
    insertSymbol(db, 'sym022', 'testA', 'function', 'test/a.test.ts');
    insertFile(db, 'test/a.test.ts', 'funcA();');

    buildTestMappings(REPO_ID, db);

    const mappings = getAllCoverageForRepo(REPO_ID, db);
    // Only prod symbols (sym020, sym021) should appear.
    expect(mappings).toHaveLength(2);
    const ids = mappings.map((m) => m.symbolId);
    expect(ids).toContain('sym020');
    expect(ids).toContain('sym021');

    const a = mappings.find((m) => m.symbolId === 'sym020');
    expect(a!.coverageStatus).toBe('tested');

    const b = mappings.find((m) => m.symbolId === 'sym021');
    expect(b!.coverageStatus).toBe('untested');
  });

  it('returns empty array when no mappings exist', () => {
    const mappings = getAllCoverageForRepo(REPO_ID, db);
    expect(mappings).toHaveLength(0);
  });
});

// ─── Phase 107 ────────────────────────────────────────────────────────────────

/** The reader's view of every row, keyed by symbol id (files + derived ids + status). */
function view(db: InstanceType<typeof Database>): Map<string, string> {
  return new Map(
    getAllCoverageForRepo(REPO_ID, db).map((m) => [
      m.symbolId,
      JSON.stringify([m.testFilePaths, m.testSymbolIds, m.coverageStatus]),
    ]),
  );
}

function deleteFileRow(db: InstanceType<typeof Database>, path: string) {
  db.prepare('DELETE FROM files WHERE repo_id = ? AND path = ?').run(REPO_ID, path);
  db.prepare('DELETE FROM symbols WHERE repo_id = ? AND file_path = ?').run(REPO_ID, path);
}

describe('Task 665 — token-delta remap (compact store)', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = openTestDb();
    insertRepo(db);
    insertSymbol(db, 'p-alpha', 'alpha', 'function', 'src/a.ts');
    insertSymbol(db, 'p-beta', 'beta', 'function', 'src/a.ts');
    insertSymbol(db, 'p-gamma', 'gamma', 'function', 'src/b.ts');
    insertSymbol(db, 'p-comp', 'Widget.build', 'method', 'src/w.ts');
    insertSymbol(db, 'p-dots', '...', 'const', 'src/d.ts');
    insertSymbol(db, 't-a1', 'testAlpha', 'function', 'test/a.test.ts');
    insertSymbol(db, 't-b1', 'testBeta', 'function', 'test/b.test.ts');
    insertFile(db, 'test/a.test.ts', 'alpha(); Widget.build();');
    insertFile(db, 'test/b.test.ts', 'beta(); gamma(); ... spread');
    insertFile(db, 'test/c.test.ts', 'gamma();');
    expect(buildTestMappings(REPO_ID, db).mode).toBe('full');
  });

  it('an edited test file takes the delta path and yields the forced rebuild byte for byte', () => {
    // alpha leaves a.test.ts; beta arrives; Widget.build loses its `build` run.
    insertFile(db, 'test/a.test.ts', 'beta(); Widget.render();');
    const r = buildTestMappings(REPO_ID, db);
    expect(r.mode).toBe('delta');
    expect(r.symbols).toBeGreaterThan(0);
    expect(r.symbols).toBeLessThan(5); // gamma has no run in the delta → untouched
    const inc = view(db);
    expect(getSymbolCoverage(REPO_ID, 'p-alpha', db)!.testFilePaths).toEqual([]);
    expect(getSymbolCoverage(REPO_ID, 'p-beta', db)!.testFilePaths).toEqual(['test/a.test.ts', 'test/b.test.ts']);
    expect(getSymbolCoverage(REPO_ID, 'p-beta', db)!.testSymbolIds).toEqual(['t-a1', 't-b1']);
    expect(getSymbolCoverage(REPO_ID, 'p-comp', db)!.coverageStatus).toBe('untested');
    buildTestMappings(REPO_ID, db, { force: true });
    expect(view(db)).toEqual(inc);
  });

  it('a deleted test file clears its bit in every row that had it; the ordinal is retired', () => {
    const ordBefore = getTestFileOrds(db, REPO_ID).get('test/b.test.ts');
    deleteFileRow(db, 'test/b.test.ts');
    const r = buildTestMappings(REPO_ID, db);
    expect(r.mode).toBe('delta');
    expect(getSymbolCoverage(REPO_ID, 'p-beta', db)!.coverageStatus).toBe('untested');
    expect(getSymbolCoverage(REPO_ID, 'p-gamma', db)!.testFilePaths).toEqual(['test/c.test.ts']);
    expect(getSymbolCoverage(REPO_ID, 'p-dots', db)!.coverageStatus).toBe('untested'); // zero-run name re-derived
    expect(getTestFileOrds(db, REPO_ID).has('test/b.test.ts')).toBe(false);
    const inc = view(db);
    buildTestMappings(REPO_ID, db, { force: true });
    expect(view(db)).toEqual(inc);
    // A new test file takes a fresh ordinal (max + 1), never a compacted one.
    insertFile(db, 'test/d.test.ts', 'alpha();');
    expect(buildTestMappings(REPO_ID, db).mode).toBe('delta');
    const ords = getTestFileOrds(db, REPO_ID);
    expect(ords.get('test/d.test.ts')).toBe(Math.max(...[...ords.values()]));
    expect(ordBefore).toBeDefined();
  });

  it('an added spec with no symbols, then a rename, both keep parity with the forced rebuild', () => {
    insertFile(db, 'test/spec.test.ts', 'gamma(); alpha();');
    expect(buildTestMappings(REPO_ID, db).mode).toBe('delta');
    expect(getSymbolCoverage(REPO_ID, 'p-gamma', db)!.testFilePaths).toEqual([
      'test/b.test.ts',
      'test/c.test.ts',
      'test/spec.test.ts',
    ]);
    let inc = view(db);
    buildTestMappings(REPO_ID, db, { force: true });
    expect(view(db)).toEqual(inc);

    // rename c.test.ts → c2.test.ts (same content)
    deleteFileRow(db, 'test/c.test.ts');
    insertFile(db, 'test/c2.test.ts', 'gamma();');
    expect(buildTestMappings(REPO_ID, db).mode).toBe('delta');
    expect(getSymbolCoverage(REPO_ID, 'p-gamma', db)!.testFilePaths).toEqual([
      'test/b.test.ts',
      'test/c2.test.ts',
      'test/spec.test.ts',
    ]);
    inc = view(db);
    buildTestMappings(REPO_ID, db, { force: true });
    expect(view(db)).toEqual(inc);
  });

  it('a new production symbol maps incrementally; a removed one drops its row; a no-op skips', () => {
    insertSymbol(db, 'p-delta', 'gamma', 'function', 'src/c.ts');
    let r = buildTestMappings(REPO_ID, db);
    expect(r.mode).toBe('incremental');
    expect(r.symbols).toBe(1);
    expect(getSymbolCoverage(REPO_ID, 'p-delta', db)!.testFilePaths).toEqual(['test/b.test.ts', 'test/c.test.ts']);
    db.prepare('DELETE FROM symbols WHERE repo_id = ? AND id = ?').run(REPO_ID, 'p-delta');
    r = buildTestMappings(REPO_ID, db);
    expect(getSymbolCoverage(REPO_ID, 'p-delta', db)).toBeNull();
    expect(getTestMapperFreshness(REPO_ID, db)).toBe('fresh');
    expect(buildTestMappings(REPO_ID, db).mode).toBe('skipped');
  });

  it('many touched test files fall back to the full path', () => {
    for (let i = 0; i < 12; i++) insertFile(db, `test/many${i}.test.ts`, `alpha${i}();`);
    expect(buildTestMappings(REPO_ID, db).mode).toBe('full');
  });

  it('an algo-2 store (1.37–1.39 JSON rows) is rebuilt once and its rows are dropped', () => {
    const now = Date.now();
    db.prepare(
      `INSERT OR REPLACE INTO provider_metadata (repo_id, provider_name, entity_key, metadata, updated_at)
       VALUES (?, 'test-mapper', 'p-alpha', ?, ?)`,
    ).run(REPO_ID, JSON.stringify({ testFiles: ['x'], testSymbolIds: [], coverageStatus: 'tested' }), now);
    db.prepare(
      `INSERT OR REPLACE INTO provider_metadata (repo_id, provider_name, entity_key, metadata, updated_at)
       VALUES (?, 'test-mapper-meta', 'repo', ?, ?)`,
    ).run(REPO_ID, JSON.stringify({ algo: 2, builtAt: now, mode: 'full', testFiles: 3, symbols: 5, ms: 1, tokenBytes: 0 }), now);
    expect(getTestMapperFreshness(REPO_ID, db)).toBe('absent');
    expect(buildTestMappings(REPO_ID, db).mode).toBe('full');
    const legacy = db
      .prepare("SELECT COUNT(*) AS c FROM provider_metadata WHERE repo_id = ? AND provider_name = 'test-mapper'")
      .get(REPO_ID) as { c: number };
    expect(legacy.c).toBe(0);
    expect(getTestMapperMeta(REPO_ID, db)?.algo).toBe(TEST_MAPPER_ALGO);
    expect(getCoverageStatusMap(REPO_ID, db).get('p-alpha')).toEqual({ status: 'tested', testFileCount: 1 });
  });
});

describe('Task 666 — ref-narrowed coverage fields', () => {
  it('testSymbolIdsByRef is absent without refs and lists only ref-backed test symbols with them', () => {
    const db = openTestDb();
    insertRepo(db);
    insertSymbol(db, 'p-alpha', 'alpha', 'function', 'src/a.ts');
    insertSymbol(db, 't-a1', 'testAlpha', 'function', 'test/a.test.ts');
    insertSymbol(db, 't-b1', 'mentionsAlphaInString', 'function', 'test/b.test.ts');
    insertFile(db, 'test/a.test.ts', "import { alpha } from '../src/a'; alpha();");
    insertFile(db, 'test/b.test.ts', "console.log('alpha');");
    buildTestMappings(REPO_ID, db);
    const before = getSymbolCoverage(REPO_ID, 'p-alpha', db)!;
    expect(before.testFilePaths).toEqual(['test/a.test.ts', 'test/b.test.ts']);
    expect(before.testSymbolIdsByRef).toBeUndefined();
    db.prepare(
      `INSERT INTO symbol_refs (repo_id, source_file, source_symbol_id, target_file, target_symbol_id, name)
       VALUES (?, 'test/a.test.ts', 't-a1', 'src/a.ts', 'p-alpha', 'alpha')`,
    ).run(REPO_ID);
    const after = getSymbolCoverage(REPO_ID, 'p-alpha', db)!;
    expect(after.testSymbolIds).toEqual(['t-a1', 't-b1']);
    expect(after.testSymbolIdsByRef).toEqual(['t-a1']);
    expect(after.testFilePathsByRef).toEqual(['test/a.test.ts']);
  });
});

describe('bitset helpers', () => {
  it('round-trip, trim, equality, count', () => {
    expect(bitsetFrom([])).toBeNull();
    const b = bitsetFrom([0, 9, 17]);
    expect(bitsetOrds(b)).toEqual([0, 9, 17]);
    expect(bitsetCount(b)).toBe(3);
    expect(b!.length).toBe(3);
    const padded = Buffer.concat([b!, Buffer.alloc(4)]);
    expect(bitsetEquals(b, padded)).toBe(true);
    expect(bitsetEquals(b, bitsetFrom([0, 9]))).toBe(false);
    expect(bitsetEquals(null, bitsetFrom([]))).toBe(true);
  });
});
