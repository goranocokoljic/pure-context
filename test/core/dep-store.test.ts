import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import {
  insertEdges,
  getForwardDeps,
  getReverseDeps,
  getImportersOf,
  findDeadExports,
  deleteEdgesByFile,
} from '../../src/core/db/dep-store.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import type { DepEdge, SymbolRecord } from '../../src/core/types.js';

const REPO_ID = 'test-repo';

function makeEdge(overrides: Partial<DepEdge> = {}): DepEdge {
  return {
    repoId: REPO_ID,
    sourceFile: 'src/a.ts',
    sourceSymbolId: null,
    targetFile: 'src/b.ts',
    targetSymbolId: null,
    edgeType: 'import',
    specifier: './b',
    ...overrides,
  };
}

function makeSymbol(overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    id: 'sym-001',
    name: 'myFn',
    kind: 'function',
    filePath: 'src/a.ts',
    startByte: 0,
    endByte: 50,
    signature: 'function myFn(): void',
    summary: '',
    ...overrides,
  };
}

function setupDb(): Database.Database {
  const db = openInMemoryDatabase();
  upsertRepo(db, {
    id: REPO_ID,
    rootPath: '/test',
    symbolCount: 0,
    fileCount: 0,
    languages: [],
    indexedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
  });
  return db;
}

describe('dep-store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it('inserts edges and retrieves forward deps', () => {
    insertEdges(db, [makeEdge()]);
    const fwd = getForwardDeps(db, REPO_ID, 'src/a.ts');
    expect(fwd).toHaveLength(1);
    expect(fwd[0].targetFile).toBe('src/b.ts');
  });

  it('inserts edges and retrieves reverse deps', () => {
    insertEdges(db, [makeEdge()]);
    const rev = getReverseDeps(db, REPO_ID, 'src/b.ts');
    expect(rev).toHaveLength(1);
    expect(rev[0].sourceFile).toBe('src/a.ts');
  });

  it('handles empty insert without error', () => {
    expect(() => insertEdges(db, [])).not.toThrow();
  });

  it('batch inserts multiple edges in a transaction', () => {
    insertEdges(db, [
      makeEdge({ sourceFile: 'src/a.ts', targetFile: 'src/b.ts' }),
      makeEdge({ sourceFile: 'src/a.ts', targetFile: 'src/c.ts', specifier: './c' }),
    ]);
    expect(getForwardDeps(db, REPO_ID, 'src/a.ts')).toHaveLength(2);
  });

  it('getImportersOf returns distinct source files', () => {
    insertEdges(db, [
      makeEdge({ sourceFile: 'src/x.ts', targetFile: 'src/shared.ts' }),
      makeEdge({ sourceFile: 'src/y.ts', targetFile: 'src/shared.ts' }),
      // second edge from x to shared (named import) — should still count as one importer
      makeEdge({ sourceFile: 'src/x.ts', targetFile: 'src/shared.ts', specifier: './shared#2' }),
    ]);
    const importers = getImportersOf(db, REPO_ID, 'src/shared.ts');
    expect(importers.sort()).toEqual(['src/x.ts', 'src/y.ts']);
  });

  it('deleteEdgesByFile removes edges where file is source or target', () => {
    insertEdges(db, [
      makeEdge({ sourceFile: 'src/a.ts', targetFile: 'src/b.ts' }),
      makeEdge({ sourceFile: 'src/c.ts', targetFile: 'src/a.ts', specifier: './a' }),
      makeEdge({ sourceFile: 'src/c.ts', targetFile: 'src/b.ts', specifier: './b' }),
    ]);
    deleteEdgesByFile(db, REPO_ID, 'src/a.ts');
    expect(getForwardDeps(db, REPO_ID, 'src/a.ts')).toHaveLength(0);
    expect(getReverseDeps(db, REPO_ID, 'src/a.ts')).toHaveLength(0);
    // The c→b edge must survive
    expect(getForwardDeps(db, REPO_ID, 'src/c.ts')).toHaveLength(1);
  });

  it('stores and retrieves symbol-level edges', () => {
    const edge = makeEdge({ sourceSymbolId: 'sym-a', targetSymbolId: 'sym-b' });
    insertEdges(db, [edge]);
    const result = getForwardDeps(db, REPO_ID, 'src/a.ts');
    expect(result[0].sourceSymbolId).toBe('sym-a');
    expect(result[0].targetSymbolId).toBe('sym-b');
  });

  describe('findDeadExports', () => {
    it('returns symbols in files that are never imported', () => {
      // sym-1 lives in a.ts which nobody imports → dead
      insertSymbols(db, REPO_ID, [makeSymbol({ id: 'sym-1', filePath: 'src/a.ts' })]);
      const dead = findDeadExports(db, REPO_ID);
      expect(dead.map((s) => s.id)).toContain('sym-1');
    });

    it('excludes symbols in files that are imported by someone', () => {
      insertSymbols(db, REPO_ID, [makeSymbol({ id: 'sym-1', filePath: 'src/a.ts' })]);
      // b.ts imports a.ts → a.ts is "alive"
      insertEdges(db, [makeEdge({ sourceFile: 'src/b.ts', targetFile: 'src/a.ts' })]);
      const dead = findDeadExports(db, REPO_ID);
      expect(dead.map((s) => s.id)).not.toContain('sym-1');
    });

    it('returns empty array when all files are imported', () => {
      insertSymbols(db, REPO_ID, [makeSymbol()]);
      insertEdges(db, [makeEdge({ targetFile: 'src/a.ts' })]);
      expect(findDeadExports(db, REPO_ID)).toHaveLength(0);
    });
  });
});
