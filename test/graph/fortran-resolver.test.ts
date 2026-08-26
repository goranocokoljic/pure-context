/**
 * Task 534 (Phase 86): Fortran import resolver.
 *
 * `USE module_name` → files whose symbol table declares that MODULE
 * (case-insensitive — Fortran is).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFortranResolver, isFortranSourceFile } from '../../src/graph/fortran-resolver.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { upsertFile } from '../../src/core/db/file-store.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import type { SymbolRecord } from '../../src/core/types.js';

const REPO = 'forttest01';

/** A Fortran MODULE symbol as the handler emits it (lowercase, MODULE sig). */
function modSym(name: string, filePath: string): SymbolRecord {
  return {
    id: `${name}-${filePath}`.replace(/[^a-z0-9]/gi, '').slice(0, 16).padEnd(16, '0'),
    name,
    kind: 'class',
    filePath,
    startByte: 0,
    endByte: 10,
    signature: `MODULE ${name}`,
    summary: `Fortran module: ${name}`,
  };
}

function seedDb() {
  const db = openInMemoryDatabase();
  upsertRepo(db, {
    id: REPO,
    rootPath: '/tmp/forttest',
    symbolCount: 0,
    fileCount: 0,
    languages: [],
    indexedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
    clonePath: null,
    tenantId: 'local',
  });
  return db;
}

function addFile(db: ReturnType<typeof seedDb>, path: string) {
  upsertFile(db, REPO, path, 'hash', undefined, 'local');
}

describe('isFortranSourceFile', () => {
  it('accepts Fortran extensions case-insensitively, rejects others', () => {
    expect(isFortranSourceFile('src/radiation.f90')).toBe(true);
    expect(isFortranSourceFile('src/RADIATION.F90')).toBe(true);
    expect(isFortranSourceFile('src/legacy.for')).toBe(true);
    expect(isFortranSourceFile('src/main.c')).toBe(false);
  });
});

describe('createFortranResolver', () => {
  let db: ReturnType<typeof seedDb>;

  beforeEach(() => {
    db = seedDb();
  });

  afterEach(() => {
    db.close();
  });

  it('resolves USE by declared module, case-insensitively', () => {
    addFile(db, 'src/math_utils.f90');
    addFile(db, 'src/main.f90');
    insertSymbols(db, REPO, [modSym('math_utils', 'src/math_utils.f90')]);
    const r = createFortranResolver(db, REPO);
    expect(r.resolve('math_utils', 'src/main.f90')).toEqual(['src/math_utils.f90']);
    expect(r.resolve('MATH_UTILS', 'src/main.f90')).toEqual(['src/math_utils.f90']);
  });

  it('does not match non-module class symbols (PROGRAM units)', () => {
    addFile(db, 'src/main.f90');
    addFile(db, 'src/other.f90');
    insertSymbols(db, REPO, [
      {
        ...modSym('driver', 'src/main.f90'),
        signature: 'PROGRAM driver',
      },
    ]);
    const r = createFortranResolver(db, REPO);
    expect(r.resolve('driver', 'src/other.f90')).toEqual([]);
  });

  it('drops intrinsic and external modules', () => {
    addFile(db, 'src/main.f90');
    const r = createFortranResolver(db, REPO);
    expect(r.resolve('iso_fortran_env', 'src/main.f90')).toEqual([]);
  });

  it('never emits a self-edge', () => {
    addFile(db, 'src/math_utils.f90');
    insertSymbols(db, REPO, [modSym('math_utils', 'src/math_utils.f90')]);
    const r = createFortranResolver(db, REPO);
    expect(r.resolve('math_utils', 'src/math_utils.f90')).toEqual([]);
  });
});
