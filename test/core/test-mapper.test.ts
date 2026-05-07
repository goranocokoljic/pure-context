/**
 * Tests for src/core/test-mapper.ts
 *
 * Strategy: open an in-memory (or temp-file) database, populate `symbols` and
 * `files` tables with representative rows, run `buildTestMappings`, and assert
 * on the stored `provider_metadata` via `getSymbolCoverage` /
 * `getAllCoverageForRepo`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { buildTestMappings, getSymbolCoverage, getAllCoverageForRepo } from '../../src/core/test-mapper.js';

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
  db.prepare(`
    INSERT OR REPLACE INTO files (repo_id, path, content_hash, raw_content)
    VALUES (?, ?, 'hash', ?)
  `).run(REPO_ID, path, content);
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

  it('does NOT create provider_metadata entries for test-file symbols', () => {
    insertSymbol(db, 'sym008', 'prodFn', 'function', 'src/prod.ts');
    insertSymbol(db, 'sym009', 'testFn', 'function', 'test/prod.test.ts');
    insertFile(db, 'test/prod.test.ts', 'import { prodFn } from "../src/prod.js"; prodFn();');

    buildTestMappings(REPO_ID, db);

    // test-file symbols should not appear as entity_key in provider_metadata
    const testMapping = getSymbolCoverage(REPO_ID, 'sym009', db);
    expect(testMapping).toBeNull();
  });

  it('returns the correct count of mapped symbols', () => {
    insertSymbol(db, 'sym010', 'alpha', 'function', 'src/a.ts');
    insertSymbol(db, 'sym011', 'beta',  'function', 'src/b.ts');
    insertSymbol(db, 'sym012', 'gamma', 'function', 'test/a.test.ts');

    const count = buildTestMappings(REPO_ID, db);
    // Only 2 production symbols (sym010, sym011); sym012 is a test symbol.
    expect(count).toBe(2);
  });

  it('handles repos with no test files gracefully', () => {
    insertSymbol(db, 'sym013', 'noTests', 'function', 'src/lonely.ts');

    const count = buildTestMappings(REPO_ID, db);
    expect(count).toBe(1);

    const mapping = getSymbolCoverage(REPO_ID, 'sym013', db);
    expect(mapping!.coverageStatus).toBe('untested');
    expect(mapping!.testFilePaths).toHaveLength(0);
  });

  it('handles repos with no symbols gracefully', () => {
    const count = buildTestMappings(REPO_ID, db);
    expect(count).toBe(0);
  });

  it('re-running buildTestMappings replaces old data (idempotent)', () => {
    insertSymbol(db, 'sym014', 'myFunc', 'function', 'src/myFunc.ts');
    insertFile(db, 'test/myFunc.test.ts', 'myFunc is tested here');
    insertSymbol(db, 'sym015', 'testMyFunc', 'function', 'test/myFunc.test.ts');

    buildTestMappings(REPO_ID, db);
    buildTestMappings(REPO_ID, db);

    // Only one entry should exist per symbol (ON CONFLICT REPLACE).
    const rows = db.prepare(
      "SELECT COUNT(*) AS c FROM provider_metadata WHERE repo_id = ? AND provider_name = 'test-mapper' AND entity_key = 'sym014'",
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
