import { describe, it, expect, beforeEach } from 'vitest';
import { createHashCache, computeHash } from '../../src/core/hash-cache.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { getFileHash } from '../../src/core/db/file-store.js';
import type Database from 'better-sqlite3';

const REPO_ID = 'test-repo';

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

describe('computeHash (standalone)', () => {
  it('produces a 64-char hex string', () => {
    const hash = computeHash(Buffer.from('hello'));
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic', () => {
    const a = computeHash(Buffer.from('hello'));
    const b = computeHash(Buffer.from('hello'));
    expect(a).toBe(b);
  });

  it('differs for different content', () => {
    expect(computeHash(Buffer.from('a'))).not.toBe(computeHash(Buffer.from('b')));
  });
});

describe('createHashCache', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it('hasChanged returns true when file is not cached', () => {
    const cache = createHashCache();
    expect(cache.hasChanged('src/foo.ts', 'abc123')).toBe(true);
  });

  it('hasChanged returns false when hash matches cache', () => {
    const cache = createHashCache();
    cache.set('src/foo.ts', 'abc123');
    expect(cache.hasChanged('src/foo.ts', 'abc123')).toBe(false);
  });

  it('hasChanged returns true when hash differs from cache', () => {
    const cache = createHashCache();
    cache.set('src/foo.ts', 'old-hash');
    expect(cache.hasChanged('src/foo.ts', 'new-hash')).toBe(true);
  });

  it('size reflects number of entries', () => {
    const cache = createHashCache();
    expect(cache.size()).toBe(0);
    cache.set('a.ts', 'h1');
    cache.set('b.ts', 'h2');
    expect(cache.size()).toBe(2);
  });

  it('sync persists entries to the DB', () => {
    const cache = createHashCache();
    cache.set('src/foo.ts', 'hash-foo');
    cache.set('src/bar.ts', 'hash-bar');
    cache.sync(db, REPO_ID);

    expect(getFileHash(db, REPO_ID, 'src/foo.ts')).toBe('hash-foo');
    expect(getFileHash(db, REPO_ID, 'src/bar.ts')).toBe('hash-bar');
  });

  it('loadFromDb hydrates the cache from DB', () => {
    // Pre-populate DB via another cache instance
    const writer = createHashCache();
    writer.set('src/foo.ts', 'hash-foo');
    writer.sync(db, REPO_ID);

    // New cache should load it
    const reader = createHashCache();
    reader.loadFromDb(db, REPO_ID);
    expect(reader.hasChanged('src/foo.ts', 'hash-foo')).toBe(false);
    expect(reader.size()).toBe(1);
  });

  it('set overwrites an existing entry', () => {
    const cache = createHashCache();
    cache.set('src/foo.ts', 'old');
    cache.set('src/foo.ts', 'new');
    expect(cache.hasChanged('src/foo.ts', 'new')).toBe(false);
    expect(cache.hasChanged('src/foo.ts', 'old')).toBe(true);
  });

  it('computeHash method matches standalone function', () => {
    const cache = createHashCache();
    const content = Buffer.from('export const x = 1;');
    expect(cache.computeHash(content)).toBe(computeHash(content));
  });
});
