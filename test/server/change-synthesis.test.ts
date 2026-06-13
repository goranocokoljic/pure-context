/**
 * change-synthesis.test.ts
 *
 * Tests synthesizeChange (Phase 77 change-impact core) against a fixture db:
 *   (a) two changed files historically co-change with a third UNTOUCHED file →
 *       it appears in missingCoChange,
 *   (b) a changed symbol with no test coverage → coverageGaps,
 *   (c) a changed file on a known import cycle → architecturalFlags.cyclesTouched,
 *   plus a thin-history fixture → signalQuality 'low' + empty missingCoChange,
 *   plus a layer-boundary crossing → architecturalFlags.layerViolations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { insertCommitFiles } from '../../src/core/db/co-change-store.js';
import { synthesizeChange } from '../../src/server/tools/change-synthesis.js';
import type { RepoCommit } from '../../src/core/git-log-reader.js';

const REPO = 'change-synthesis-repo';
const NOW = Math.floor(Date.now() / 1000);

function setupRepo(db: Database) {
  upsertRepo(db, {
    id: REPO,
    rootPath: '/tmp/change-synthesis',
    symbolCount: 0,
    fileCount: 0,
    languages: [],
    indexedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
  });
}

function insertFile(db: Database, path: string, content = '') {
  db.prepare(
    `INSERT OR REPLACE INTO files (repo_id, path, content_hash, raw_content, indexed_at)
     VALUES (?, ?, 'h', ?, ?)`,
  ).run(REPO, path, Buffer.from(content), NOW);
}

function insertSymbol(db: Database, id: string, name: string, file: string, cc = 1) {
  db.prepare(
    `INSERT OR REPLACE INTO symbols
       (id, repo_id, name, kind, file_path, start_byte, end_byte, signature, summary, indexed_at, cyclomatic_complexity, line_count)
     VALUES (?, ?, ?, 'function', ?, 0, 50, '', '', ?, ?, 20)`,
  ).run(id, REPO, name, file, NOW, cc);
}

function insertEdge(db: Database, sourceFile: string, targetFile: string) {
  db.prepare(
    `INSERT INTO dep_edges (repo_id, source_file, source_symbol_id, target_file, target_symbol_id, edge_type, specifier, tenant_id)
     VALUES (?, ?, NULL, ?, NULL, 'import', ?, 'local')`,
  ).run(REPO, sourceFile, targetFile, targetFile);
}

function insertCoverage(
  db: Database,
  symbolId: string,
  testFiles: string[],
  coverageStatus: 'tested' | 'untested' | 'unknown',
) {
  db.prepare(
    `INSERT OR REPLACE INTO provider_metadata (repo_id, provider_name, entity_key, metadata, updated_at)
     VALUES (?, 'test-mapper', ?, ?, ?)`,
  ).run(REPO, symbolId, JSON.stringify({ testFiles, testSymbolIds: [], coverageStatus }), NOW);
}

/** A healthy co-change window: target+partner share `n` commits, plus padding. */
function richCoChangeCommits(): RepoCommit[] {
  const commits: RepoCommit[] = [];
  // src/a.ts co-changes with the UNTOUCHED src/shared.ts 6 times (confidence 1.0).
  for (let i = 0; i < 6; i++) {
    commits.push({ sha: `pair${i}`, date: 1000 + i, files: ['src/a.ts', 'src/shared.ts'] });
  }
  // Padding so windowCommits >= 20 (signalQuality ok).
  for (let i = 0; i < 22; i++) {
    commits.push({ sha: `pad${i}`, date: 5000 + i, files: [`pad${i}.ts`] });
  }
  return commits;
}

describe('synthesizeChange', () => {
  let db: Database;

  beforeEach(() => {
    db = openInMemoryDatabase();
    setupRepo(db);

    // Changed files: src/a.ts, src/b.ts. Untouched co-change partner: src/shared.ts.
    insertFile(db, 'src/a.ts', 'export function alpha() { return 1; }');
    insertFile(db, 'src/b.ts', 'export function beta() { return 2; }');
    insertFile(db, 'src/shared.ts', 'export function shared() { return 3; }');
    insertSymbol(db, 'sym-alpha', 'alpha', 'src/a.ts');
    insertSymbol(db, 'sym-beta', 'beta', 'src/b.ts');

    // (c) a <-> b import cycle.
    insertEdge(db, 'src/a.ts', 'src/b.ts');
    insertEdge(db, 'src/b.ts', 'src/a.ts');

    // (b) sym-alpha is untested; sym-beta is tested by a test file.
    insertCoverage(db, 'sym-alpha', [], 'untested');
    insertCoverage(db, 'sym-beta', ['test/b.test.ts'], 'tested');

    insertCommitFiles(db, REPO, richCoChangeCommits());
  });

  afterEach(() => db.close());

  it('flags the untouched co-change partner, coverage gap, and cycle', () => {
    const out = synthesizeChange(db, REPO, {
      changedSymbolIds: ['sym-alpha', 'sym-beta'],
      changedFilePaths: ['src/a.ts', 'src/b.ts'],
    });

    // (a) the untouched historically-coupled file surfaces.
    expect(out.missingCoChange.map((m) => m.filePath)).toContain('src/shared.ts');
    expect(out.missingCoChange.find((m) => m.filePath === 'src/shared.ts')!.confidence).toBeGreaterThanOrEqual(0.4);

    // (b) the untested changed symbol is a coverage gap; recommended tests present.
    expect(out.coverageGaps.map((g) => g.symbolId)).toContain('sym-alpha');
    expect(out.recommendedTests.map((t) => t.testFilePath)).toContain('test/b.test.ts');

    // (c) the a<->b cycle is flagged.
    expect(out.architecturalFlags.cyclesTouched.length).toBeGreaterThan(0);
    const flat = out.architecturalFlags.cyclesTouched.flat();
    expect(flat).toContain('src/a.ts');

    expect(out.signalQuality).toBe('ok');
    expect(out.aggregateRisk.topRiskSymbols.length).toBeGreaterThan(0);
  });

  it('never invents co-change warnings on thin history', () => {
    const fresh = openInMemoryDatabase();
    setupRepo(fresh);
    fresh
      .prepare(
        `INSERT OR REPLACE INTO files (repo_id, path, content_hash, raw_content, indexed_at)
         VALUES (?, 'src/a.ts', 'h', ?, ?)`,
      )
      .run(REPO, Buffer.from(''), NOW);
    // Only 2 commits → windowCommits < 20 → low signal.
    insertCommitFiles(fresh, REPO, [
      { sha: 'x1', date: 1, files: ['src/a.ts', 'src/shared.ts'] },
      { sha: 'x2', date: 2, files: ['src/a.ts', 'src/shared.ts'] },
    ]);

    const out = synthesizeChange(fresh, REPO, {
      changedSymbolIds: [],
      changedFilePaths: ['src/a.ts'],
    });
    expect(out.signalQuality).toBe('low');
    expect(out.missingCoChange).toHaveLength(0);
    fresh.close();
  });

  it('detects layer-boundary crossings among changed files', () => {
    // Default layers: core must not import handlers.
    insertFile(db, 'src/core/x.ts', '');
    insertFile(db, 'src/handlers/y.ts', '');
    insertEdge(db, 'src/core/x.ts', 'src/handlers/y.ts');

    const out = synthesizeChange(db, REPO, {
      changedSymbolIds: [],
      changedFilePaths: ['src/core/x.ts'],
    });
    expect(out.architecturalFlags.layerViolations).toContainEqual({ from: 'core', to: 'handlers' });
  });

  it('honors section toggles (all off → empty sections)', () => {
    const out = synthesizeChange(db, REPO, {
      changedSymbolIds: ['sym-alpha', 'sym-beta'],
      changedFilePaths: ['src/a.ts', 'src/b.ts'],
      includeRisk: false,
      includeCoChangeGaps: false,
      includeTests: false,
      includeArchitectureFlags: false,
    });
    expect(out.aggregateRisk.topRiskSymbols).toHaveLength(0);
    expect(out.missingCoChange).toHaveLength(0);
    expect(out.recommendedTests).toHaveLength(0);
    expect(out.coverageGaps).toHaveLength(0);
    expect(out.architecturalFlags.cyclesTouched).toHaveLength(0);
    expect(out.architecturalFlags.layerViolations).toHaveLength(0);
  });
});
