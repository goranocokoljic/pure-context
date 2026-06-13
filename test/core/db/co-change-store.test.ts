/**
 * co-change-store.test.ts
 *
 * Tests the commit_files store (Phase 76 co-change foundation): insert,
 * idempotency, delete, and the distinct-commit counters.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../../src/core/db/schema.js';
import {
  insertCommitFiles,
  deleteCommitFilesForRepo,
  countCommits,
  countCommitsForFile,
} from '../../../src/core/db/co-change-store.js';
import type { RepoCommit } from '../../../src/core/git-log-reader.js';

const REPO = 'co-change-repo';

function seedRepo(db: Database) {
  upsertRepo(db, {
    id: REPO,
    rootPath: '/tmp/co-change-repo',
    symbolCount: 0,
    fileCount: 0,
    languages: [],
    indexedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
  });
}

const COMMITS: RepoCommit[] = [
  { sha: 'c1', date: 1000, files: ['a.ts', 'b.ts'] },
  { sha: 'c2', date: 2000, files: ['a.ts', 'b.ts', 'c.ts'] },
  { sha: 'c3', date: 3000, files: ['a.ts'] },
];

describe('co-change-store', () => {
  let db: Database;

  beforeEach(() => {
    db = openInMemoryDatabase();
    seedRepo(db);
  });

  afterEach(() => db.close());

  it('creates the commit_files table via schema init', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='commit_files'")
      .get();
    expect(row).toBeTruthy();
  });

  it('inserts commits and counts distinct commits per repo and per file', () => {
    insertCommitFiles(db, REPO, COMMITS);
    expect(countCommits(db, REPO)).toBe(3);
    expect(countCommitsForFile(db, REPO, 'a.ts')).toBe(3);
    expect(countCommitsForFile(db, REPO, 'b.ts')).toBe(2);
    expect(countCommitsForFile(db, REPO, 'c.ts')).toBe(1);
    expect(countCommitsForFile(db, REPO, 'missing.ts')).toBe(0);
  });

  it('is idempotent (INSERT OR IGNORE on re-insert)', () => {
    insertCommitFiles(db, REPO, COMMITS);
    insertCommitFiles(db, REPO, COMMITS);
    expect(countCommits(db, REPO)).toBe(3);
    expect(countCommitsForFile(db, REPO, 'a.ts')).toBe(3);
  });

  it('deletes all rows for a repo', () => {
    insertCommitFiles(db, REPO, COMMITS);
    deleteCommitFilesForRepo(db, REPO);
    expect(countCommits(db, REPO)).toBe(0);
  });

  it('no-ops on empty commit list', () => {
    insertCommitFiles(db, REPO, []);
    expect(countCommits(db, REPO)).toBe(0);
  });
});
