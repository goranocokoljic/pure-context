import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  getBlastRadius,
  getContextBundle,
  findImporters,
  findDeadCode,
} from '../../src/graph/graph-traversal.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import { insertEdges } from '../../src/core/db/dep-store.js';
import type { SymbolRecord, DepEdge } from '../../src/core/types.js';

// ─── Test fixture ─────────────────────────────────────────────────────────────
//
//  Dependency chain:
//    entry.ts  →  utils.ts  →  helpers.ts
//                          →  types.ts
//    isolated.ts  (no imports, not imported)
//
// ─────────────────────────────────────────────────────────────────────────────

const REPO = 'test-repo';

function sym(id: string, name: string, file: string): SymbolRecord {
  return {
    id,
    name,
    kind: 'function',
    filePath: file,
    startByte: 0,
    endByte: 10,
    signature: `function ${name}()`,
    summary: '',
  };
}

function edge(src: string, tgt: string): DepEdge {
  return {
    repoId: REPO,
    sourceFile: src,
    sourceSymbolId: null,
    targetFile: tgt,
    targetSymbolId: null,
    edgeType: 'import',
    specifier: `./${tgt.split('/').pop()?.replace('.ts', '')}`,
  };
}

function setupDb(): Database.Database {
  const db = openInMemoryDatabase();
  upsertRepo(db, {
    id: REPO,
    rootPath: '/test',
    symbolCount: 0,
    fileCount: 0,
    languages: ['typescript'],
    indexedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
  });

  // Symbols
  insertSymbols(db, REPO, [
    sym('sym-entry', 'run', 'entry.ts'),
    sym('sym-utils-1', 'format', 'utils.ts'),
    sym('sym-utils-2', 'parse', 'utils.ts'),
    sym('sym-helpers', 'clamp', 'helpers.ts'),
    sym('sym-types', 'MyType', 'types.ts'),
    sym('sym-isolated', 'lonely', 'isolated.ts'),
  ]);

  // Edges: entry → utils → helpers, utils → types
  insertEdges(db, [
    edge('entry.ts', 'utils.ts'),
    edge('utils.ts', 'helpers.ts'),
    edge('utils.ts', 'types.ts'),
  ]);

  return db;
}

// ─── getContextBundle ─────────────────────────────────────────────────────────

describe('getContextBundle (forward walk)', () => {
  let db: Database.Database;
  beforeEach(() => { db = setupDb(); });

  it('returns the start file and all forward dependencies', () => {
    const result = getContextBundle('sym-entry', REPO, db);
    const files = result.files.sort();
    expect(files).toContain('entry.ts');
    expect(files).toContain('utils.ts');
    expect(files).toContain('helpers.ts');
    expect(files).toContain('types.ts');
  });

  it('does not include isolated files', () => {
    const result = getContextBundle('sym-entry', REPO, db);
    expect(result.files).not.toContain('isolated.ts');
  });

  it('includes symbols from all visited files', () => {
    const result = getContextBundle('sym-entry', REPO, db);
    const names = result.symbols.map((s) => s.name);
    expect(names).toContain('run');
    expect(names).toContain('format');
    expect(names).toContain('clamp');
  });

  it('respects depth limit — depth=1 stops at utils.ts', () => {
    const result = getContextBundle('sym-entry', REPO, db, 1);
    expect(result.files).toContain('entry.ts');
    expect(result.files).toContain('utils.ts');
    expect(result.files).not.toContain('helpers.ts');
  });

  it('returns empty result for unknown symbolId', () => {
    const result = getContextBundle('unknown-id', REPO, db);
    expect(result.symbols).toHaveLength(0);
    expect(result.files).toHaveLength(0);
  });

  it('tokenEstimate is a non-negative number', () => {
    const result = getContextBundle('sym-entry', REPO, db);
    expect(result.tokenEstimate).toBeGreaterThanOrEqual(0);
    expect(typeof result.tokenEstimate).toBe('number');
  });

  it('handles a leaf node (no forward deps)', () => {
    // helpers.ts imports nothing
    const result = getContextBundle('sym-helpers', REPO, db);
    expect(result.files).toEqual(['helpers.ts']);
    expect(result.symbols.some((s) => s.name === 'clamp')).toBe(true);
  });
});

// ─── getBlastRadius ───────────────────────────────────────────────────────────

describe('getBlastRadius (reverse walk)', () => {
  let db: Database.Database;
  beforeEach(() => { db = setupDb(); });

  it('returns all files that (transitively) import the start file', () => {
    // helpers.ts is imported by utils.ts, which is imported by entry.ts
    const result = getBlastRadius('sym-helpers', REPO, db);
    expect(result.files).toContain('helpers.ts');
    expect(result.files).toContain('utils.ts');
    expect(result.files).toContain('entry.ts');
  });

  it('a leaf-level change in types.ts also reaches entry.ts', () => {
    const result = getBlastRadius('sym-types', REPO, db);
    expect(result.files).toContain('types.ts');
    expect(result.files).toContain('utils.ts');
    expect(result.files).toContain('entry.ts');
  });

  it('entry.ts itself has no reverse deps', () => {
    const result = getBlastRadius('sym-entry', REPO, db);
    expect(result.files).toEqual(['entry.ts']);
  });

  it('respects depth limit', () => {
    // helpers.ts → utils.ts (depth 1), utils.ts → entry.ts (depth 2)
    const result = getBlastRadius('sym-helpers', REPO, db, 1);
    expect(result.files).toContain('helpers.ts');
    expect(result.files).toContain('utils.ts');
    expect(result.files).not.toContain('entry.ts');
  });

  it('does not include isolated.ts', () => {
    const result = getBlastRadius('sym-helpers', REPO, db);
    expect(result.files).not.toContain('isolated.ts');
  });

  it('returns empty for unknown symbolId', () => {
    expect(getBlastRadius('nope', REPO, db).symbols).toHaveLength(0);
  });
});

// ─── findImporters ────────────────────────────────────────────────────────────

describe('findImporters', () => {
  let db: Database.Database;
  beforeEach(() => { db = setupDb(); });

  it('returns files that directly import the given file', () => {
    const importers = findImporters('utils.ts', REPO, db);
    expect(importers.map((i) => i.file)).toEqual(['entry.ts']);
  });

  it('includes symbols from each importing file', () => {
    const importers = findImporters('utils.ts', REPO, db);
    const entryInfo = importers.find((i) => i.file === 'entry.ts')!;
    expect(entryInfo.symbols.some((s) => s.name === 'run')).toBe(true);
  });

  it('returns multiple importers when they exist', () => {
    // Make both entry.ts and a new file import helpers.ts
    insertEdges(db, [edge('entry.ts', 'helpers.ts')]);
    const importers = findImporters('helpers.ts', REPO, db);
    expect(importers.map((i) => i.file).sort()).toEqual(['entry.ts', 'utils.ts']);
  });

  it('returns empty array for a file with no importers', () => {
    expect(findImporters('entry.ts', REPO, db)).toHaveLength(0);
  });

  it('returns empty array for an unknown file', () => {
    expect(findImporters('nope.ts', REPO, db)).toHaveLength(0);
  });
});

// ─── findDeadCode ─────────────────────────────────────────────────────────────

describe('findDeadCode', () => {
  let db: Database.Database;
  beforeEach(() => { db = setupDb(); });

  it('isolated.ts symbols are dead (no file imports isolated.ts)', () => {
    const dead = findDeadCode(REPO, db);
    expect(dead.some((s) => s.filePath === 'isolated.ts')).toBe(true);
  });

  it('entry.ts symbols are dead (nothing imports entry.ts)', () => {
    const dead = findDeadCode(REPO, db);
    expect(dead.some((s) => s.filePath === 'entry.ts')).toBe(true);
  });

  it('utils.ts symbols are NOT dead (entry.ts imports utils.ts)', () => {
    const dead = findDeadCode(REPO, db);
    expect(dead.every((s) => s.filePath !== 'utils.ts')).toBe(true);
  });

  it('returns empty when all files are imported', () => {
    // Add import of isolated.ts and entry.ts to make everything "alive"
    insertEdges(db, [
      edge('entry.ts', 'isolated.ts'),
      edge('utils.ts', 'entry.ts'),
    ]);
    const dead = findDeadCode(REPO, db);
    expect(dead).toHaveLength(0);
  });
});

// ─── Cycle handling ───────────────────────────────────────────────────────────

describe('cycle handling', () => {
  it('does not infinite-loop on circular imports', () => {
    const db = openInMemoryDatabase();
    upsertRepo(db, {
      id: REPO,
      rootPath: '/test',
      symbolCount: 0,
      fileCount: 0,
      languages: [],
      indexedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
    });
    insertSymbols(db, REPO, [
      sym('s1', 'a', 'a.ts'),
      sym('s2', 'b', 'b.ts'),
    ]);
    // a.ts ↔ b.ts circular
    insertEdges(db, [edge('a.ts', 'b.ts'), edge('b.ts', 'a.ts')]);

    expect(() => getContextBundle('s1', REPO, db)).not.toThrow();
    expect(() => getBlastRadius('s1', REPO, db)).not.toThrow();

    const fwd = getContextBundle('s1', REPO, db);
    expect(fwd.files.sort()).toEqual(['a.ts', 'b.ts']);
  });
});

// ─── Truncation honesty (Task 550) ───────────────────────────────────────────

describe('depth-cap truncation flag', () => {
  let db: Database.Database;
  beforeEach(() => { db = setupDb(); });

  it('flags a reverse walk cut off by the depth cap', () => {
    // helpers.ts ← utils.ts ← entry.ts is a 2-hop reverse chain.
    const capped = getBlastRadius('sym-helpers', REPO, db, 1);
    expect(capped.truncated).toBe(true);
    expect(capped.files).not.toContain('entry.ts');
  });

  it('reports false when the walk was exhaustive', () => {
    const full = getBlastRadius('sym-helpers', REPO, db, 3);
    expect(full.truncated).toBe(false);
    expect(full.files.sort()).toEqual(['entry.ts', 'helpers.ts', 'utils.ts']);
  });

  it('flags a forward walk cut off by the depth cap', () => {
    const capped = getContextBundle('sym-entry', REPO, db, 1);
    expect(capped.truncated).toBe(true);
    const full = getContextBundle('sym-entry', REPO, db, 3);
    expect(full.truncated).toBe(false);
  });

  it('an isolated file is never marked truncated', () => {
    expect(getBlastRadius('sym-isolated', REPO, db, 1).truncated).toBe(false);
  });
});
