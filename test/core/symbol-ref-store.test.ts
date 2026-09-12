/**
 * Phase 101 (Task 629): schema v14 `symbol_refs` + its store.
 *
 * Pins: the table exists on a fresh DB AND on a pre-v14 DB opened for the
 * first time (additive, no migration body); local rows read `targetRepoId:
 * null`; the readers split local / cross; delete-by-source keeps incoming
 * rows; delete-by-file drops local incoming rows only; dangling cleanup drops
 * rows whose target id vanished from the re-parsed file; the join reader
 * skips a re-keyed source.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSqliteFactory } from '../../src/core/db/sqlite-loader.js';
import { openDatabase, openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import {
  insertSymbolRefs,
  countSymbolRefs,
  getForwardRefs,
  getReverseRefs,
  getCrossReverseRefs,
  getCrossSymbolRefs,
  getRefsBySourceFile,
  getAfferentSymbolCounts,
  getReferencingSymbols,
  deleteSymbolRefsBySource,
  deleteSymbolRefsByFile,
  deleteDanglingSymbolRefsInto,
  deleteAllSymbolRefs,
  type SymbolRef,
} from '../../src/core/db/symbol-ref-store.js';

const REPO = 'refs-test';

function db() {
  const d = openInMemoryDatabase();
  upsertRepo(d, {
    id: REPO, rootPath: '/tmp/refs', symbolCount: 0, fileCount: 0, languages: [],
    indexedAt: Date.now(), schemaVersion: SCHEMA_VERSION, clonePath: null, tenantId: 'local',
  });
  insertSymbols(d, REPO, [
    { id: 'a1', name: 'run', kind: 'function', filePath: 'a.ts', startByte: 0, endByte: 10, signature: 'run', summary: '' },
    { id: 'a2', name: 'other', kind: 'function', filePath: 'a.ts', startByte: 11, endByte: 20, signature: 'other', summary: '' },
    { id: 'b1', name: 'helper', kind: 'function', filePath: 'b.ts', startByte: 0, endByte: 10, signature: 'helper', summary: '' },
    { id: 'c1', name: 'thing', kind: 'class', filePath: 'c.ts', startByte: 0, endByte: 10, signature: 'thing', summary: '' },
  ]);
  return d;
}

function ref(over: Partial<SymbolRef>): SymbolRef {
  return {
    repoId: REPO, sourceFile: 'a.ts', sourceSymbolId: 'a1', targetFile: 'b.ts', targetSymbolId: 'b1',
    targetRepoId: null, name: 'helper', confidence: 'lexical', refCount: 1, ...over,
  };
}

describe('schema v14', () => {
  it('SCHEMA_VERSION is 15 (v14 symbol_refs + Phase 104 test_file_tokens) and a fresh DB has symbol_refs + its two indexes', () => {
    expect(SCHEMA_VERSION).toBe(15);
    const d = db();
    const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toContain('symbol_refs');
    const idx = (d.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(idx).toEqual(expect.arrayContaining(['idx_symbol_refs_target', 'idx_symbol_refs_source_file']));
    expect(idx).not.toContain('idx_symbol_refs_target_file'); // deliberately absent (size; scan is cheap)
    d.close();
  });

  it('a v13 database gains symbol_refs on open with zero rows; nothing else changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-v14-'));
    try {
      const raw = getSqliteFactory().open(join(dir, 'old.db'));
      raw.exec(`
        CREATE TABLE repos (
          id TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, symbol_count INTEGER NOT NULL DEFAULT 0,
          file_count INTEGER NOT NULL DEFAULT 0, languages TEXT NOT NULL DEFAULT '[]', indexed_at INTEGER NOT NULL,
          schema_version INTEGER NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'local', git_tree_sha TEXT,
          source TEXT NOT NULL DEFAULT 'local', clone_path TEXT
        );
        INSERT INTO repos (id, root_path, indexed_at, schema_version) VALUES ('old', '/tmp/old', 1, 13);
      `);
      raw.close();
      const d = openDatabase('old', dir);
      const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
      expect(tables).toContain('symbol_refs');
      expect(countSymbolRefs(d, 'old')).toBe(0);
      d.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('symbol-ref store', () => {
  it('round-trips local and cross rows; local rows read targetRepoId null; duplicate key adds counts', () => {
    const d = db();
    insertSymbolRefs(d, [
      ref({}),
      ref({ sourceSymbolId: 'a2', targetSymbolId: 'c1', targetFile: 'c.ts', name: 'thing', refCount: 2 }),
      ref({ targetRepoId: 'OTHER', targetFile: 'x.ts', targetSymbolId: 'x1', name: 'x' }),
      ref({}), // same key as the first → ref_count 2
    ]);
    expect(countSymbolRefs(d, REPO)).toBe(3);
    const fwd = getForwardRefs(d, REPO, 'a1');
    expect(fwd.map((r) => [r.targetSymbolId, r.targetRepoId, r.refCount])).toEqual([
      ['b1', null, 2],
      ['x1', 'OTHER', 1],
    ]);
    expect(getReverseRefs(d, REPO, 'b1').map((r) => r.sourceSymbolId)).toEqual(['a1']);
    expect(getReverseRefs(d, REPO, 'x1')).toEqual([]); // cross target: not a local reverse hit
    expect(getCrossReverseRefs(d, REPO, 'OTHER', 'x1').map((r) => r.sourceSymbolId)).toEqual(['a1']);
    expect(getCrossSymbolRefs(d, REPO)).toHaveLength(1);
    expect(getRefsBySourceFile(d, REPO, 'a.ts')).toHaveLength(3);
    expect(getAfferentSymbolCounts(d, REPO).get('b1')).toBe(1);
    expect(getAfferentSymbolCounts(d, REPO).has('x1')).toBe(false);
    d.close();
  });

  it('getReferencingSymbols joins the symbols table and skips a re-keyed source', () => {
    const d = db();
    insertSymbolRefs(d, [ref({}), ref({ sourceSymbolId: 'gone', name: 'helper' })]);
    const refs = getReferencingSymbols(d, REPO, 'b1');
    expect(refs.map((r) => r.symbol.id)).toEqual(['a1']);
    expect(refs[0]!.symbol.name).toBe('run');
    d.close();
  });

  it('deleteSymbolRefsBySource keeps incoming rows; deleteSymbolRefsByFile drops local incoming rows only', () => {
    const d = db();
    insertSymbolRefs(d, [
      ref({}),                                                                          // a → b (local)
      ref({ sourceFile: 'c.ts', sourceSymbolId: 'c1', name: 'helper' }),               // c → b (local)
      ref({ sourceFile: 'c.ts', sourceSymbolId: 'c1', targetRepoId: 'OTHER', targetFile: 'b.ts', targetSymbolId: 'b1' }), // c → OTHER/b.ts
    ]);
    deleteSymbolRefsBySource(d, REPO, 'a.ts');
    expect(getReverseRefs(d, REPO, 'b1').map((r) => r.sourceSymbolId)).toEqual(['c1']);
    deleteSymbolRefsByFile(d, REPO, 'b.ts');
    expect(getReverseRefs(d, REPO, 'b1')).toEqual([]);
    // the cross row aimed at a same-named file in ANOTHER index survives
    expect(getCrossReverseRefs(d, REPO, 'OTHER', 'b1')).toHaveLength(1);
    d.close();
  });

  it('deleteDanglingSymbolRefsInto drops rows whose target id vanished from the re-parsed file', () => {
    const d = db();
    insertSymbolRefs(d, [ref({}), ref({ sourceSymbolId: 'a2', targetSymbolId: 'b-old', name: 'gone' })]);
    expect(deleteDanglingSymbolRefsInto(d, REPO, 'b.ts')).toBe(1);
    expect(getRefsBySourceFile(d, REPO, 'a.ts').map((r) => r.targetSymbolId)).toEqual(['b1']);
    deleteAllSymbolRefs(d, REPO);
    expect(countSymbolRefs(d, REPO)).toBe(0);
    d.close();
  });
});
