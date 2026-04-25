import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import {
  insertSymbols,
  searchSymbols,
  getSymbolById,
  getSymbolsByFile,
  getSymbolsByRepo,
  deleteByFile,
} from '../../src/core/db/symbol-store.js';
import type { SymbolRecord } from '../../src/core/types.js';

const REPO_ID = 'test-repo-1';

function makeSymbol(overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    id: 'sym-001',
    name: 'myFunction',
    kind: 'function',
    filePath: 'src/utils.ts',
    startByte: 0,
    endByte: 100,
    signature: 'function myFunction(x: number): string',
    summary: 'Does something useful',
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

describe('symbol-store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it('inserts and retrieves a symbol by id', () => {
    const sym = makeSymbol();
    insertSymbols(db, REPO_ID, [sym]);
    const result = getSymbolById(db, REPO_ID, 'sym-001');
    expect(result).toMatchObject({
      id: 'sym-001',
      name: 'myFunction',
      kind: 'function',
      filePath: 'src/utils.ts',
    });
  });

  it('batch inserts multiple symbols in a transaction', () => {
    const symbols = [
      makeSymbol({ id: 's1', name: 'alpha' }),
      makeSymbol({ id: 's2', name: 'beta' }),
      makeSymbol({ id: 's3', name: 'gamma' }),
    ];
    insertSymbols(db, REPO_ID, symbols);
    expect(getSymbolsByRepo(db, REPO_ID)).toHaveLength(3);
  });

  it('upserts on conflict (INSERT OR REPLACE)', () => {
    insertSymbols(db, REPO_ID, [makeSymbol({ signature: 'old sig' })]);
    insertSymbols(db, REPO_ID, [makeSymbol({ signature: 'new sig' })]);
    const result = getSymbolById(db, REPO_ID, 'sym-001');
    expect(result?.signature).toBe('new sig');
  });

  it('handles empty insert without error', () => {
    expect(() => insertSymbols(db, REPO_ID, [])).not.toThrow();
  });

  it('round-trips frameworkMeta as JSON', () => {
    const meta = { component: 'MyComp', props: ['size', 'color'] };
    insertSymbols(db, REPO_ID, [makeSymbol({ frameworkMeta: meta })]);
    const result = getSymbolById(db, REPO_ID, 'sym-001');
    expect(result?.frameworkMeta).toEqual(meta);
  });

  it('searchSymbols matches by partial name', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 's1', name: 'getFoo' }),
      makeSymbol({ id: 's2', name: 'getBar' }),
      makeSymbol({ id: 's3', name: 'setFoo' }),
    ]);
    const results = searchSymbols(db, REPO_ID, 'get');
    expect(results.map((s) => s.name).sort()).toEqual(['getBar', 'getFoo']);
  });

  it('searchSymbols filters by kind', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 's1', name: 'MyClass', kind: 'class' }),
      makeSymbol({ id: 's2', name: 'myFn', kind: 'function' }),
    ]);
    const results = searchSymbols(db, REPO_ID, 'my', { kind: 'class' });
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('class');
  });

  it('searchSymbols filters by filePath', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 's1', name: 'a', filePath: 'src/foo.ts' }),
      makeSymbol({ id: 's2', name: 'b', filePath: 'src/bar.ts' }),
    ]);
    const results = searchSymbols(db, REPO_ID, '', { filePath: 'src/foo.ts' });
    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe('src/foo.ts');
  });

  it('getSymbolsByFile returns symbols ordered by startByte', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 's1', name: 'z', startByte: 200 }),
      makeSymbol({ id: 's2', name: 'a', startByte: 10 }),
    ]);
    const results = getSymbolsByFile(db, REPO_ID, 'src/utils.ts');
    expect(results[0].name).toBe('a');
    expect(results[1].name).toBe('z');
  });

  it('deleteByFile removes only symbols for that file', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 's1', filePath: 'src/a.ts' }),
      makeSymbol({ id: 's2', filePath: 'src/b.ts', name: 'other' }),
    ]);
    deleteByFile(db, REPO_ID, 'src/a.ts');
    expect(getSymbolsByFile(db, REPO_ID, 'src/a.ts')).toHaveLength(0);
    expect(getSymbolsByFile(db, REPO_ID, 'src/b.ts')).toHaveLength(1);
  });

  it('getSymbolById returns null for unknown id', () => {
    expect(getSymbolById(db, REPO_ID, 'nope')).toBeNull();
  });
});
