import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import {
  upsertFile,
  getFileContent,
  getFileHash,
  deleteFile,
  getAllFileHashes,
} from '../../src/core/db/file-store.js';

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

describe('file-store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it('upserts and retrieves file hash', () => {
    upsertFile(db, REPO_ID, 'src/foo.ts', 'abc123');
    expect(getFileHash(db, REPO_ID, 'src/foo.ts')).toBe('abc123');
  });

  it('upserts and retrieves file content', () => {
    const content = Buffer.from('export const x = 1;');
    upsertFile(db, REPO_ID, 'src/foo.ts', 'abc123', content);
    const result = getFileContent(db, REPO_ID, 'src/foo.ts');
    expect(result).not.toBeNull();
    expect(result?.toString()).toBe('export const x = 1;');
  });

  it('updates hash and content on conflict', () => {
    upsertFile(db, REPO_ID, 'src/foo.ts', 'old-hash', Buffer.from('old'));
    upsertFile(db, REPO_ID, 'src/foo.ts', 'new-hash', Buffer.from('new'));
    expect(getFileHash(db, REPO_ID, 'src/foo.ts')).toBe('new-hash');
    expect(getFileContent(db, REPO_ID, 'src/foo.ts')?.toString()).toBe('new');
  });

  it('stores file without content (hash-only mode)', () => {
    upsertFile(db, REPO_ID, 'src/foo.ts', 'abc123');
    expect(getFileHash(db, REPO_ID, 'src/foo.ts')).toBe('abc123');
    expect(getFileContent(db, REPO_ID, 'src/foo.ts')).toBeNull();
  });

  it('returns null for unknown file hash', () => {
    expect(getFileHash(db, REPO_ID, 'nonexistent.ts')).toBeNull();
  });

  it('returns null for unknown file content', () => {
    expect(getFileContent(db, REPO_ID, 'nonexistent.ts')).toBeNull();
  });

  it('deleteFile removes the entry', () => {
    upsertFile(db, REPO_ID, 'src/foo.ts', 'abc123');
    deleteFile(db, REPO_ID, 'src/foo.ts');
    expect(getFileHash(db, REPO_ID, 'src/foo.ts')).toBeNull();
  });

  it('getAllFileHashes returns map of all files', () => {
    upsertFile(db, REPO_ID, 'src/a.ts', 'hash-a');
    upsertFile(db, REPO_ID, 'src/b.ts', 'hash-b');
    const map = getAllFileHashes(db, REPO_ID);
    expect(map.size).toBe(2);
    expect(map.get('src/a.ts')).toBe('hash-a');
    expect(map.get('src/b.ts')).toBe('hash-b');
  });
});
