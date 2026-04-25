import { describe, it, expect } from 'vitest';
import {
  openInMemoryDatabase,
  computeRepoId,
  upsertRepo,
  getRepo,
  listRepos,
  SCHEMA_VERSION,
} from '../../src/core/db/schema.js';

describe('schema', () => {
  it('creates tables without error', () => {
    const db = openInMemoryDatabase();
    expect(() => db.prepare('SELECT * FROM repos').all()).not.toThrow();
    expect(() => db.prepare('SELECT * FROM files').all()).not.toThrow();
    expect(() => db.prepare('SELECT * FROM symbols').all()).not.toThrow();
    expect(() => db.prepare('SELECT * FROM dep_edges').all()).not.toThrow();
  });

  it('computeRepoId produces a 16-char hex string', () => {
    const id = computeRepoId('/home/user/project');
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  it('computeRepoId is deterministic', () => {
    expect(computeRepoId('/home/user/project')).toBe(computeRepoId('/home/user/project'));
  });

  it('computeRepoId differs for different paths', () => {
    expect(computeRepoId('/a')).not.toBe(computeRepoId('/b'));
  });

  it('upsertRepo and getRepo round-trip', () => {
    const db = openInMemoryDatabase();
    const meta = {
      id: 'abc123',
      rootPath: '/home/user/project',
      symbolCount: 42,
      fileCount: 5,
      languages: ['typescript'],
      indexedAt: 1000,
      schemaVersion: SCHEMA_VERSION,
      clonePath: null,
      tenantId: 'local',
    };
    upsertRepo(db, meta);
    const result = getRepo(db, 'abc123');
    expect(result).toEqual(meta);
  });

  it('upsertRepo updates existing repo', () => {
    const db = openInMemoryDatabase();
    const base = {
      id: 'abc',
      rootPath: '/proj',
      symbolCount: 1,
      fileCount: 1,
      languages: [],
      indexedAt: 1,
      schemaVersion: SCHEMA_VERSION,
    };
    upsertRepo(db, base);
    upsertRepo(db, { ...base, symbolCount: 99, fileCount: 10 });
    const result = getRepo(db, 'abc');
    expect(result?.symbolCount).toBe(99);
    expect(result?.fileCount).toBe(10);
  });

  it('listRepos returns all repos ordered by indexed_at DESC', () => {
    const db = openInMemoryDatabase();
    const base = {
      symbolCount: 0,
      fileCount: 0,
      languages: [],
      schemaVersion: SCHEMA_VERSION,
    };
    upsertRepo(db, { ...base, id: 'r1', rootPath: '/r1', indexedAt: 100 });
    upsertRepo(db, { ...base, id: 'r2', rootPath: '/r2', indexedAt: 200 });
    const repos = listRepos(db);
    expect(repos).toHaveLength(2);
    expect(repos[0].id).toBe('r2');
    expect(repos[1].id).toBe('r1');
  });

  it('getRepo returns null for unknown id', () => {
    const db = openInMemoryDatabase();
    expect(getRepo(db, 'nope')).toBeNull();
  });
});
