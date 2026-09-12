/**
 * Phase 104 (Tasks 648–650) — the tokenizing test mapper against the legacy
 * regex mapper (test/core/oracles/test-mapper-legacy.ts), plus the
 * incremental + freshness contract.
 *
 * Parity is on the VALUE of every mapping row (test files, test symbol ids,
 * status) — arrays compared as sorted sets, because the new mapper sorts
 * them and the legacy one emitted rowid order.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import {
  buildTestMappings,
  containsBounded,
  ensureTestMappings,
  getAllCoverageForRepo,
  getTestMapperFreshness,
  scanTestFile,
  wordRuns,
} from '../../src/core/test-mapper.js';
import { buildTestMappings as legacyBuild } from './oracles/test-mapper-legacy.js';
import { TEST_TOKEN_DDL } from '../../src/core/db/test-token-store.js';

const DDL = `
CREATE TABLE repos (
  id TEXT PRIMARY KEY, root_path TEXT NOT NULL, symbol_count INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0, languages TEXT NOT NULL DEFAULT '[]',
  indexed_at INTEGER NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, tenant_id TEXT NOT NULL DEFAULT 'local'
);
CREATE TABLE symbols (
  id TEXT NOT NULL, repo_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, file_path TEXT NOT NULL,
  start_byte INTEGER NOT NULL DEFAULT 0, end_byte INTEGER NOT NULL DEFAULT 0, signature TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '', framework_meta TEXT, indexed_at INTEGER NOT NULL DEFAULT 0,
  tenant_id TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (id, repo_id)
);
CREATE TABLE files (
  repo_id TEXT NOT NULL, path TEXT NOT NULL, content_hash TEXT NOT NULL DEFAULT '', raw_content BLOB,
  indexed_at INTEGER NOT NULL DEFAULT 0, tenant_id TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (repo_id, path)
);
CREATE TABLE provider_metadata (
  repo_id TEXT NOT NULL, provider_name TEXT NOT NULL, entity_key TEXT NOT NULL, metadata TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY (repo_id, provider_name, entity_key)
);
`;

const REPO = 'parityrepo0000001';

function openDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(DDL);
  db.exec(TEST_TOKEN_DDL);
  db.prepare('INSERT INTO repos (id, root_path, indexed_at) VALUES (?, ?, ?)').run(REPO, '/r', 1);
  return db;
}

let nextByte = 0;
function sym(db: InstanceType<typeof Database>, name: string, kind: string, file: string): string {
  const id = createHash('sha256').update(`${file}:${name}:${kind}`).digest('hex').slice(0, 16);
  db.prepare(
    'INSERT OR REPLACE INTO symbols (id, repo_id, name, kind, file_path, start_byte) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, REPO, name, kind, file, nextByte++);
  return id;
}

function file(db: InstanceType<typeof Database>, path: string, content: string): void {
  const hash = createHash('sha256').update(content).digest('hex');
  db.prepare(
    'INSERT OR REPLACE INTO files (repo_id, path, content_hash, raw_content) VALUES (?, ?, ?, ?)',
  ).run(REPO, path, hash, Buffer.from(content, 'utf8'));
}

function deleteFileRow(db: InstanceType<typeof Database>, path: string): void {
  db.prepare('DELETE FROM files WHERE repo_id = ? AND path = ?').run(REPO, path);
  db.prepare('DELETE FROM symbols WHERE repo_id = ? AND file_path = ?').run(REPO, path);
}

/** Canonical snapshot of the mapping rows: id → sorted value. */
function snapshot(db: InstanceType<typeof Database>): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of getAllCoverageForRepo(REPO, db)) {
    out.set(
      m.symbolId,
      JSON.stringify({
        f: [...m.testFilePaths].sort(),
        s: [...m.testSymbolIds].sort(),
        c: m.coverageStatus,
      }),
    );
  }
  return out;
}

function legacySnapshot(db: InstanceType<typeof Database>): Map<string, string> {
  db.prepare("DELETE FROM provider_metadata WHERE repo_id = ? AND provider_name LIKE 'test-mapper%'").run(REPO);
  legacyBuild(REPO, db);
  const snap = snapshot(db);
  db.prepare("DELETE FROM provider_metadata WHERE repo_id = ? AND provider_name LIKE 'test-mapper%'").run(REPO);
  return snap;
}

function expectParity(db: InstanceType<typeof Database>): void {
  const legacy = legacySnapshot(db);
  buildTestMappings(REPO, db, { force: true });
  const fresh = snapshot(db);
  expect(fresh.size).toBe(legacy.size);
  for (const [id, v] of legacy) expect(fresh.get(id), `row ${id}`).toBe(v);
}

// ─── Corpus: the name shapes the audit found (Task 647) ──────────────────────

const NAMES: Array<[string, string]> = [
  ['formatDiagnostic', 'function'],
  ['NuxtErrorBoundary.error', 'method'],
  ['MyApp::Model::Foo', 'class'],
  ['--assets', 'const'],
  ['Serializable#serialize', 'method'],
  ['$column-padding-width', 'const'],
  ['$hello', 'const'],
  ['@blue-hover', 'const'],
  ['ApplyDefaultConfigurationTest.`can apply defaults to configurations`', 'method'],
  ['App.$route', 'property'],
  ['(indexGroup)', 'function'],
  ['UploadHandler::$options', 'property'],
  ['User#valid_email?', 'method'],
  ['GET /new', 'route'],
  ['*ngIf', 'directive'],
  ['AboutController.init?', 'method'],
  ['glslang::TOutputTraverser::operator=', 'method'],
  ['Document cards', 'component'],
  ['...', 'const'],
  ['ab', 'function'],
  ['x', 'const'],
  ['größe', 'function'],
  ['Foo.bar', 'method'],
  ['Foo', 'class'],
  ['bar', 'function'],
  ['run', 'function'],
  ['SomeType', 'type'],
  ['SomeEnum', 'enum'],
  ['a.b', 'method'],
  ['_private_', 'function'],
  ['snake_case_fn', 'function'],
  ['123abc', 'const'],
];

const TEST_TEXTS: Array<[string, string]> = [
  ['test/a.test.ts', "import { formatDiagnostic, Foo } from '../src'; Foo.bar(); formatDiagnostic(1);\nSomeType; run(); x.$hello; a$hello"],
  ['test/b.spec.rb', 'MyApp::Model::Foo.new\nuser.valid_email? # User#valid_email?\nSerializable#serialize\nx.ab.y'],
  ['test/c.test.scss', '.a { width: $column-padding-width; color: @blue-hover; } --assets { }\n$hello: 1;'],
  ['test/d.test.kt', 'class ApplyDefaultConfigurationTest { fun `can apply defaults to configurations`() {} }\nApplyDefaultConfigurationTest.`can apply defaults to configurations`'],
  ['test/e.test.vue', '<template *ngIf="x">{{ App.$route }} (indexGroup) Document cards GET /new</template>\nAboutController.init?  ...  größe  Foo.bar.baz  a.b.c'],
  ['test/f.test.cpp', 'glslang::TOutputTraverser::operator=(x); UploadHandler::$options; snake_case_fn(); _private_(); 123abc'],
  ['test/g.test.js', ''],
  ['test/h.test.py', 'FooBar barfoo runner xFoo.bar Foo.barx'],
];

function populate(db: InstanceType<typeof Database>): void {
  for (const [name, kind] of NAMES) sym(db, name, kind, 'src/prod.ts');
  // A second file with the same names → distinct ids, same answer.
  for (const [name, kind] of NAMES.slice(0, 6)) sym(db, name, kind, 'src/other.ts');
  for (const [path, text] of TEST_TEXTS) {
    file(db, path, text);
    sym(db, `test_${path.replace(/\W/g, '_')}`, 'function', path);
    sym(db, `test2_${path.replace(/\W/g, '_')}`, 'function', path);
  }
  file(db, 'src/prod.ts', 'export function formatDiagnostic() {} Foo.bar');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Phase 104 — containsBounded is \\bNAME\\b', () => {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  it('agrees with the regex on the audit corpus × every test text', () => {
    for (const [name] of NAMES) {
      const re = new RegExp(`\\b${esc(name)}\\b`);
      for (const [, text] of TEST_TEXTS) {
        expect(containsBounded(text, name), `${name} in ${text.slice(0, 30)}`).toBe(re.test(text));
      }
    }
  });

  it('agrees with the regex under fuzz (random names over a small alphabet)', () => {
    const alphabet = 'ab_1.:$# \n@-?()';
    let seed = 104;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const rndStr = (max: number) => {
      const len = 1 + rnd(max);
      let s = '';
      for (let i = 0; i < len; i++) s += alphabet[rnd(alphabet.length)];
      return s;
    };
    for (let k = 0; k < 20000; k++) {
      const name = rndStr(5);
      const text = rndStr(24);
      const re = new RegExp(`\\b${esc(name)}\\b`);
      expect(containsBounded(text, name), JSON.stringify({ name, text })).toBe(re.test(text));
    }
  });

  it('word-run prefilter is sound: a regex match implies every run is a token', () => {
    for (const [name] of NAMES) {
      const re = new RegExp(`\\b${esc(name)}\\b`);
      for (const [, text] of TEST_TEXTS) {
        if (!re.test(text)) continue;
        const tokens = scanTestFile(text);
        for (const run of wordRuns(name)) expect(tokens.has(run), `${run} of ${name}`).toBe(true);
      }
    }
  });
});

describe('Phase 104 — mapper parity with the legacy oracle', () => {
  let db: InstanceType<typeof Database>;
  beforeEach(() => {
    db = openDb();
    nextByte = 0;
    populate(db);
  });

  it('every row is value-identical on the audit corpus', () => {
    expectParity(db);
    // And the corpus actually exercises both paths.
    const snap = snapshot(db);
    const tested = [...snap.values()].filter((v) => v.includes('"c":"tested"')).length;
    expect(tested).toBeGreaterThan(10);
  });

  it('holds with no test files at all', () => {
    for (const [path] of TEST_TEXTS) deleteFileRow(db, path);
    expectParity(db);
    expect(getAllCoverageForRepo(REPO, db).every((m) => m.coverageStatus !== 'tested')).toBe(true);
  });

  it('holds with no symbols at all', () => {
    db.prepare('DELETE FROM symbols WHERE repo_id = ?').run(REPO);
    expectParity(db);
  });
});

describe('Phase 104 — incremental build', () => {
  let db: InstanceType<typeof Database>;
  beforeEach(() => {
    db = openDb();
    nextByte = 0;
    populate(db);
  });

  it('first build is full; a no-change rerun is skipped and writes nothing', () => {
    const first = buildTestMappings(REPO, db);
    expect(first.mode).toBe('full');
    const before = snapshot(db);
    const second = buildTestMappings(REPO, db);
    expect(second.mode).toBe('skipped');
    expect(second.symbols).toBe(0);
    expect(snapshot(db)).toEqual(before);
    expect(getTestMapperFreshness(REPO, db)).toBe('fresh');
  });

  it('a new production symbol is mapped incrementally and matches a full rebuild', () => {
    buildTestMappings(REPO, db);
    sym(db, 'barfoo', 'function', 'src/new.ts');
    sym(db, 'xFoo.bar', 'method', 'src/new.ts');
    expect(getTestMapperFreshness(REPO, db)).toBe('stale');
    const inc = buildTestMappings(REPO, db);
    expect(inc.mode).toBe('incremental');
    expect(inc.symbols).toBe(2);
    const incremental = snapshot(db);
    buildTestMappings(REPO, db, { force: true });
    expect(snapshot(db)).toEqual(incremental);
    expectParity(db);
  });

  it('a changed test file re-tokenizes only that file and remaps', () => {
    buildTestMappings(REPO, db);
    const beforeRow = snapshot(db);
    file(db, 'test/g.test.js', 'runner(); run(); _private_();');
    expect(getTestMapperFreshness(REPO, db)).toBe('stale');
    const r = buildTestMappings(REPO, db);
    expect(r.mode).toBe('full');
    const after = snapshot(db);
    expect(after).not.toEqual(beforeRow);
    const tokenRows = db
      .prepare('SELECT file_path, token_count FROM test_file_tokens WHERE repo_id = ? ORDER BY file_path')
      .all(REPO) as Array<{ file_path: string; token_count: number }>;
    expect(tokenRows.find((t) => t.file_path === 'test/g.test.js')?.token_count).toBe(3);
    expectParity(db);
  });

  it('a deleted test file drops its token row and its mentions', () => {
    buildTestMappings(REPO, db);
    deleteFileRow(db, 'test/a.test.ts');
    const r = buildTestMappings(REPO, db);
    expect(r.mode).toBe('full');
    const rows = db
      .prepare('SELECT COUNT(*) AS c FROM test_file_tokens WHERE repo_id = ? AND file_path = ?')
      .get(REPO, 'test/a.test.ts') as { c: number };
    expect(rows.c).toBe(0);
    for (const m of getAllCoverageForRepo(REPO, db)) {
      expect(m.testFilePaths).not.toContain('test/a.test.ts');
    }
    expectParity(db);
  });

  it('a deleted production symbol loses its row', () => {
    buildTestMappings(REPO, db);
    const gone = db
      .prepare("SELECT id FROM symbols WHERE repo_id = ? AND name = 'formatDiagnostic' AND file_path = 'src/prod.ts'")
      .get(REPO) as { id: string };
    db.prepare('DELETE FROM symbols WHERE repo_id = ? AND id = ?').run(REPO, gone.id);
    const r = buildTestMappings(REPO, db);
    expect(r.mode).toBe('incremental');
    expect(snapshot(db).has(gone.id)).toBe(false);
  });

  it('a pre-1.37 index (rows, no meta) is rebuilt in full once', () => {
    legacyBuild(REPO, db);
    expect(getTestMapperFreshness(REPO, db)).toBe('absent');
    const r = buildTestMappings(REPO, db);
    expect(r.mode).toBe('full');
    expect(getTestMapperFreshness(REPO, db)).toBe('fresh');
  });
});

describe('Phase 104 — lazy build (Task 650)', () => {
  it('ensureTestMappings builds an absent mapping once, then reports fresh', () => {
    const db = openDb();
    nextByte = 0;
    populate(db);
    expect(getTestMapperFreshness(REPO, db)).toBe('absent');
    const first = ensureTestMappings(REPO, db);
    expect(first.built).toBe(true);
    expect(first.before).toBe('absent');
    expect(first.stats?.mode).toBe('full');
    const second = ensureTestMappings(REPO, db);
    expect(second.built).toBe(false);
    expect(second.before).toBe('fresh');
  });
});
