import { describe, it, expect, beforeEach } from 'vitest';
import { openInMemoryDatabase } from '../../src/core/db/schema.js';
import {
  saveEmbeddings,
  loadEmbeddings,
  deleteEmbeddings,
  deleteAllEmbeddings,
  countEmbeddings,
} from '../../src/core/db/embedding-store.js';
import type Database from 'better-sqlite3';

function makeDb(): Database.Database {
  return openInMemoryDatabase();
}

// Insert a minimal repo row so FK constraints are satisfied
function insertRepo(db: Database.Database, repoId: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO repos (id, root_path, symbol_count, file_count, languages, indexed_at, schema_version)
    VALUES (?, ?, 0, 0, '[]', 0, 2)
  `).run(repoId, `/test/${repoId}`);
}

// Insert a minimal symbol row so FK constraints are satisfied
function insertSymbol(db: Database.Database, repoId: string, symbolId: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO symbols (id, repo_id, name, kind, file_path, start_byte, end_byte, signature, summary, indexed_at)
    VALUES (?, ?, 'testFn', 'function', 'src/test.ts', 0, 100, 'function testFn()', '', 0)
  `).run(symbolId, repoId);
}

function makeVec(dim: number, value: number): Float32Array {
  const v = new Float32Array(dim);
  v.fill(value);
  return v;
}

describe('embedding-store', () => {
  let db: Database.Database;
  const REPO = 'repo_abc';
  const DIM = 8;

  beforeEach(() => {
    db = makeDb();
    insertRepo(db, REPO);
  });

  // ─── saveEmbeddings ───────────────────────────────────────────────────────

  it('saveEmbeddings: persists vectors and loadEmbeddings retrieves them', () => {
    insertSymbol(db, REPO, 'sym1');
    insertSymbol(db, REPO, 'sym2');

    const embeddings = new Map<string, Float32Array>([
      ['sym1', makeVec(DIM, 0.5)],
      ['sym2', makeVec(DIM, 0.25)],
    ]);

    saveEmbeddings(db, REPO, 'openai', embeddings);

    const loaded = loadEmbeddings(db, REPO);
    expect(loaded.size).toBe(2);

    const v1 = loaded.get('sym1')!;
    expect(v1).toBeInstanceOf(Float32Array);
    expect(v1.length).toBe(DIM);
    expect(v1[0]).toBeCloseTo(0.5, 5);

    const v2 = loaded.get('sym2')!;
    expect(v2[0]).toBeCloseTo(0.25, 5);
  });

  it('saveEmbeddings: replaces existing embedding on re-save', () => {
    insertSymbol(db, REPO, 'sym1');

    const first = new Map([['sym1', makeVec(DIM, 0.1)]]);
    saveEmbeddings(db, REPO, 'openai', first);

    const second = new Map([['sym1', makeVec(DIM, 0.9)]]);
    saveEmbeddings(db, REPO, 'openai', second);

    const loaded = loadEmbeddings(db, REPO);
    expect(loaded.get('sym1')![0]).toBeCloseTo(0.9, 5);
  });

  it('saveEmbeddings: no-op for empty map', () => {
    saveEmbeddings(db, REPO, 'openai', new Map());
    expect(countEmbeddings(db, REPO)).toBe(0);
  });

  it('saveEmbeddings: stores different providers', () => {
    insertSymbol(db, REPO, 'sym1');
    saveEmbeddings(db, REPO, 'anthropic', new Map([['sym1', makeVec(DIM, 0.3)]]));
    expect(countEmbeddings(db, REPO)).toBe(1);
  });

  // ─── loadEmbeddings ───────────────────────────────────────────────────────

  it('loadEmbeddings: returns empty map when no embeddings exist', () => {
    const loaded = loadEmbeddings(db, REPO);
    expect(loaded.size).toBe(0);
  });

  it('loadEmbeddings: scoped to repoId', () => {
    const REPO2 = 'repo_xyz';
    insertRepo(db, REPO2);
    insertSymbol(db, REPO, 'sym1');
    insertSymbol(db, REPO2, 'sym2');

    saveEmbeddings(db, REPO, 'openai', new Map([['sym1', makeVec(DIM, 0.1)]]));
    saveEmbeddings(db, REPO2, 'openai', new Map([['sym2', makeVec(DIM, 0.2)]]));

    const r1 = loadEmbeddings(db, REPO);
    expect(r1.size).toBe(1);
    expect(r1.has('sym1')).toBe(true);
    expect(r1.has('sym2')).toBe(false);

    const r2 = loadEmbeddings(db, REPO2);
    expect(r2.size).toBe(1);
    expect(r2.has('sym2')).toBe(true);
  });

  it('loadEmbeddings: Float32Array round-trips exactly', () => {
    insertSymbol(db, REPO, 'sym1');
    const original = new Float32Array([0.1, 0.2, -0.3, 0.4, 0.0, 1.0, -1.0, 0.999]);
    saveEmbeddings(db, REPO, 'openai', new Map([['sym1', original]]));

    const loaded = loadEmbeddings(db, REPO);
    const restored = loaded.get('sym1')!;

    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      // Float32 precision — use 6 decimal places
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  // ─── deleteEmbeddings ────────────────────────────────────────────────────

  it('deleteEmbeddings: removes specified symbol IDs', () => {
    insertSymbol(db, REPO, 'sym1');
    insertSymbol(db, REPO, 'sym2');
    insertSymbol(db, REPO, 'sym3');

    saveEmbeddings(db, REPO, 'openai', new Map([
      ['sym1', makeVec(DIM, 0.1)],
      ['sym2', makeVec(DIM, 0.2)],
      ['sym3', makeVec(DIM, 0.3)],
    ]));

    deleteEmbeddings(db, ['sym1', 'sym3']);

    const loaded = loadEmbeddings(db, REPO);
    expect(loaded.size).toBe(1);
    expect(loaded.has('sym2')).toBe(true);
    expect(loaded.has('sym1')).toBe(false);
    expect(loaded.has('sym3')).toBe(false);
  });

  it('deleteEmbeddings: no-op for empty list', () => {
    insertSymbol(db, REPO, 'sym1');
    saveEmbeddings(db, REPO, 'openai', new Map([['sym1', makeVec(DIM, 0.1)]]));
    deleteEmbeddings(db, []);
    expect(countEmbeddings(db, REPO)).toBe(1);
  });

  it('deleteEmbeddings: safe for unknown IDs', () => {
    insertSymbol(db, REPO, 'sym1');
    saveEmbeddings(db, REPO, 'openai', new Map([['sym1', makeVec(DIM, 0.1)]]));
    expect(() => deleteEmbeddings(db, ['nonexistent'])).not.toThrow();
    expect(countEmbeddings(db, REPO)).toBe(1);
  });

  // ─── deleteAllEmbeddings ─────────────────────────────────────────────────

  it('deleteAllEmbeddings: clears all embeddings for repo', () => {
    insertSymbol(db, REPO, 'sym1');
    insertSymbol(db, REPO, 'sym2');
    saveEmbeddings(db, REPO, 'openai', new Map([
      ['sym1', makeVec(DIM, 0.1)],
      ['sym2', makeVec(DIM, 0.2)],
    ]));

    deleteAllEmbeddings(db, REPO);
    expect(countEmbeddings(db, REPO)).toBe(0);
  });

  it('deleteAllEmbeddings: does not affect other repos', () => {
    const REPO2 = 'repo_zzz';
    insertRepo(db, REPO2);
    insertSymbol(db, REPO, 'sym1');
    insertSymbol(db, REPO2, 'sym2');

    saveEmbeddings(db, REPO, 'openai', new Map([['sym1', makeVec(DIM, 0.1)]]));
    saveEmbeddings(db, REPO2, 'openai', new Map([['sym2', makeVec(DIM, 0.2)]]));

    deleteAllEmbeddings(db, REPO);

    expect(countEmbeddings(db, REPO)).toBe(0);
    expect(countEmbeddings(db, REPO2)).toBe(1);
  });

  // ─── countEmbeddings ─────────────────────────────────────────────────────

  it('countEmbeddings: returns correct count', () => {
    insertSymbol(db, REPO, 'sym1');
    insertSymbol(db, REPO, 'sym2');

    expect(countEmbeddings(db, REPO)).toBe(0);
    saveEmbeddings(db, REPO, 'openai', new Map([['sym1', makeVec(DIM, 0.1)]]));
    expect(countEmbeddings(db, REPO)).toBe(1);
    saveEmbeddings(db, REPO, 'openai', new Map([['sym2', makeVec(DIM, 0.2)]]));
    expect(countEmbeddings(db, REPO)).toBe(2);
  });
});
