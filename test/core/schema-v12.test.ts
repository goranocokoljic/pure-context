/**
 * Phase 99 (Task 614): schema v12 is ADDITIVE.
 *
 * A database whose repo row says v11 (and whose dep_edges table has no
 * `target_repo_id` column) must open, gain the column with NULL for every
 * existing row, gain `repo_links`, and keep answering the pre-99 queries
 * unchanged. Also pins the local-only read discipline (P3): a cross row is
 * invisible to every pre-99 reader and visible to the explicit cross readers.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSqliteFactory } from '../../src/core/db/sqlite-loader.js';
import { openDatabase, openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import {
  insertEdges,
  getAllDepEdges,
  getForwardDeps,
  getReverseDeps,
  getImportersOf,
  getCrossDepEdges,
  getCrossImportersOf,
  getCrossAfferentCounts,
  getCouplingMap,
  deleteEdgesByFile,
  findDeadExports,
} from '../../src/core/db/dep-store.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import { getRepoLinks, replaceRepoLinks, recordReverseLink } from '../../src/core/db/link-store.js';

const REPO = 'v12test';

function repoRow(db: ReturnType<typeof openInMemoryDatabase>, version = SCHEMA_VERSION) {
  upsertRepo(db, {
    id: REPO,
    rootPath: '/tmp/v12',
    symbolCount: 0,
    fileCount: 0,
    languages: [],
    indexedAt: Date.now(),
    schemaVersion: version,
    clonePath: null,
    tenantId: 'local',
  });
}

describe('schema v12 migration', () => {
  it('SCHEMA_VERSION is 12', () => {
    expect(SCHEMA_VERSION).toBe(12);
  });

  it('a v11 database gains target_repo_id (NULL on old rows) and repo_links; old rows read as local edges', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-v12-'));
    try {
      // Hand-build a pre-v12 dep_edges table + a v11 repo row.
      const raw = getSqliteFactory().open(join(dir, 'old.db'));
      raw.exec(`
        CREATE TABLE repos (
          id TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, symbol_count INTEGER NOT NULL DEFAULT 0,
          file_count INTEGER NOT NULL DEFAULT 0, languages TEXT NOT NULL DEFAULT '[]', indexed_at INTEGER NOT NULL,
          schema_version INTEGER NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'local', git_tree_sha TEXT,
          source TEXT NOT NULL DEFAULT 'local', clone_path TEXT
        );
        CREATE TABLE dep_edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id TEXT NOT NULL, source_file TEXT NOT NULL,
          source_symbol_id TEXT, target_file TEXT NOT NULL, target_symbol_id TEXT, edge_type TEXT NOT NULL,
          specifier TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'local'
        );
        INSERT INTO repos (id, root_path, indexed_at, schema_version) VALUES ('old', '/tmp/old', 1, 11);
        INSERT INTO dep_edges (repo_id, source_file, target_file, edge_type, specifier) VALUES ('old', 'a.ts', 'b.ts', 'import', './b');
      `);
      raw.close();

      const db = openDatabase('old', dir);
      const cols = (db.prepare('PRAGMA table_info(dep_edges)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('target_repo_id');
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
      expect(tables).toContain('repo_links');
      const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map((t) => t.name);
      expect(idx).toContain('idx_dep_edges_target_repo');

      const edges = getAllDepEdges(db, 'old');
      expect(edges).toHaveLength(1);
      expect(edges[0].targetRepoId).toBeNull();
      expect(getImportersOf(db, 'old', 'b.ts')).toEqual(['a.ts']);
      expect(getRepoLinks(db, 'old')).toEqual([]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('P3 — local-only readers never see cross rows; cross readers do', () => {
  it('reads, deletes, coupling and dead-code all honour target_repo_id', () => {
    const db = openInMemoryDatabase();
    repoRow(db);
    insertSymbols(db, REPO, [
      { id: 's1', name: 'a', kind: 'function', filePath: 'a.ts', startByte: 0, endByte: 1, signature: 'a', summary: '' },
      { id: 's2', name: 'b', kind: 'function', filePath: 'b.ts', startByte: 0, endByte: 1, signature: 'b', summary: '' },
    ]);
    insertEdges(db, [
      { repoId: REPO, sourceFile: 'a.ts', sourceSymbolId: null, targetFile: 'b.ts', targetSymbolId: null, edgeType: 'import', specifier: './b' },
      // cross edge: a.ts imports OTHER's `b.ts` (same relative path on purpose)
      { repoId: REPO, sourceFile: 'a.ts', sourceSymbolId: null, targetFile: 'b.ts', targetSymbolId: null, edgeType: 'import', specifier: 'other/b', targetRepoId: 'OTHER' },
    ]);

    expect(getAllDepEdges(db, REPO)).toHaveLength(1);
    expect(getForwardDeps(db, REPO, 'a.ts')).toHaveLength(1);
    expect(getForwardDeps(db, REPO, 'a.ts', undefined, true)).toHaveLength(2);
    expect(getReverseDeps(db, REPO, 'b.ts')).toHaveLength(1);
    expect(getImportersOf(db, REPO, 'b.ts')).toEqual(['a.ts']);
    expect(getCrossDepEdges(db, REPO).map((e) => e.targetRepoId)).toEqual(['OTHER']);
    expect(getCrossImportersOf(db, REPO, 'OTHER', 'b.ts')).toEqual(['a.ts']);
    expect(getCrossAfferentCounts(db, REPO, 'OTHER').get('b.ts')).toBe(1);
    const coupling = getCouplingMap(db, REPO, 'a.ts');
    expect(coupling[0].efferentCoupling).toBe(1);
    // b.ts is imported locally → not dead; a.ts is dead.
    expect(findDeadExports(db, REPO).map((s) => s.filePath)).toEqual(['a.ts']);

    // Deleting local b.ts removes the LOCAL incoming edge only; the cross row
    // (a different index's b.ts) survives.
    deleteEdgesByFile(db, REPO, 'b.ts');
    expect(getAllDepEdges(db, REPO)).toHaveLength(0);
    expect(getCrossDepEdges(db, REPO)).toHaveLength(1);
  });

  it('repo_links: replace (built), reverse rows insert-if-absent (pending), order', () => {
    const db = openInMemoryDatabase();
    repoRow(db);
    replaceRepoLinks(db, REPO, [
      { linkedRepoId: 'B', linkedRootPath: '/x/b', linkedSha: 'sha-b', source: 'auto', relation: 'sibling' },
      { linkedRepoId: 'A', linkedRootPath: '/x/a', linkedSha: null, source: 'config', relation: 'config' },
    ]);
    expect(getRepoLinks(db, REPO).map((l) => [l.linkedRepoId, l.built])).toEqual([['A', true], ['B', true]]);
    // The other side re-recording an existing link must NOT clobber our sha / built flag.
    recordReverseLink(db, REPO, { linkedRepoId: 'B', linkedRootPath: '/x/b2', linkedSha: 'sha-b2', source: 'auto', relation: 'sibling' });
    // A brand-new reverse row is pending (built = false).
    recordReverseLink(db, REPO, { linkedRepoId: 'C', linkedRootPath: '/x/c', linkedSha: 'sha-c', source: 'auto', relation: 'sibling' });
    const links = getRepoLinks(db, REPO);
    expect(links.map((l) => l.linkedRepoId)).toEqual(['A', 'B', 'C']);
    const b = links.find((l) => l.linkedRepoId === 'B')!;
    expect(b.linkedSha).toBe('sha-b');
    expect(b.built).toBe(true);
    expect(b.linkedRootPath).toBe('/x/b2');
    expect(links.find((l) => l.linkedRepoId === 'C')?.built).toBe(false);
    replaceRepoLinks(db, REPO, []);
    expect(getRepoLinks(db, REPO)).toEqual([]);
  });
});
