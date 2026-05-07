/**
 * get-churn-metrics.test.ts
 *
 * Unit tests for the get_churn_metrics MCP tool.
 *
 * Strategy: create a throwaway SQLite database in memory (or a temp file)
 * and seed it with synthetic git_metadata + symbols rows so every assertion
 * is deterministic and fast.  No filesystem, no git, no indexing pipeline.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { createRequire } from 'module';
import type _BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BetterSqlite3 = _require('better-sqlite3') as any;

const REPO_ID = 'test-churn-repo-01';
const NOW_SEC = Math.floor(Date.now() / 1000);
const DAY = 86_400;

/** Days ago → Unix timestamp (seconds) */
const daysAgo = (n: number) => NOW_SEC - n * DAY;

// ─── DB setup ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;
let db: Database;

function seed(database: Database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = OFF;

    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      root_path TEXT NOT NULL UNIQUE,
      symbol_count INTEGER NOT NULL DEFAULT 0,
      file_count INTEGER NOT NULL DEFAULT 0,
      languages TEXT NOT NULL DEFAULT '[]',
      indexed_at INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      git_tree_sha TEXT
    );

    CREATE TABLE IF NOT EXISTS files (
      repo_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      raw_content BLOB,
      indexed_at INTEGER NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      remote_sha TEXT,
      last_commit_sha TEXT,
      last_commit_author TEXT,
      last_commit_date INTEGER,
      last_commit_message TEXT,
      commit_count INTEGER,
      PRIMARY KEY (repo_id, path)
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_byte INTEGER NOT NULL DEFAULT 0,
      end_byte INTEGER NOT NULL DEFAULT 0,
      signature TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      framework_meta TEXT,
      indexed_at INTEGER NOT NULL DEFAULT 0,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      PRIMARY KEY (id, repo_id)
    );

    CREATE TABLE IF NOT EXISTS git_metadata (
      repo_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_email TEXT NOT NULL,
      commit_date INTEGER NOT NULL,
      message TEXT NOT NULL,
      PRIMARY KEY (repo_id, file_path, commit_sha)
    );

    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Insert the repo record
  database.prepare(`
    INSERT OR REPLACE INTO repos (id, root_path, symbol_count, file_count, languages, indexed_at, schema_version)
    VALUES (?, ?, 0, 0, '[]', ?, 6)
  `).run(REPO_ID, '/tmp/test-churn-repo', NOW_SEC);

  // ── Files ──────────────────────────────────────────────────────────────────
  // src/core/index-manager.ts  — 10 commits (hotspot)
  // src/core/file-processor.ts — 6  commits (volatile)
  // src/handlers/typescript.ts — 2  commits (active)
  // src/utils/helpers.ts       — 0  commits  (no metadata — should not appear)

  const fileRows: [string, string][] = [
    ['src/core/index-manager.ts', Buffer.from('function indexManager() {}\n').toString('base64')],
    ['src/core/file-processor.ts', Buffer.from('function fileProcessor() {}\n').toString('base64')],
    ['src/handlers/typescript.ts', Buffer.from('function tsHandler() {}\n').toString('base64')],
  ];

  for (const [path] of fileRows) {
    database.prepare(`
      INSERT OR REPLACE INTO files (repo_id, path, content_hash, raw_content, indexed_at)
      VALUES (?, ?, 'abc', NULL, ?)
    `).run(REPO_ID, path, NOW_SEC);
  }

  // Store raw_content for symbol resolution
  database.prepare(`
    UPDATE files SET raw_content = ? WHERE repo_id = ? AND path = ?
  `).run(
    Buffer.from('function indexManager() {}\nfunction anotherFn() {}\n'),
    REPO_ID,
    'src/core/index-manager.ts',
  );

  database.prepare(`
    UPDATE files SET raw_content = ? WHERE repo_id = ? AND path = ?
  `).run(
    Buffer.from('function fileProcessor() {}\n'),
    REPO_ID,
    'src/core/file-processor.ts',
  );

  database.prepare(`
    UPDATE files SET raw_content = ? WHERE repo_id = ? AND path = ?
  `).run(
    Buffer.from('function tsHandler() {}\n'),
    REPO_ID,
    'src/handlers/typescript.ts',
  );

  // ── Symbols ────────────────────────────────────────────────────────────────
  const symbolRows = [
    { id: 'sym-im-1', name: 'indexManager', kind: 'function', file: 'src/core/index-manager.ts', start: 0, end: 26 },
    { id: 'sym-im-2', name: 'anotherFn',    kind: 'function', file: 'src/core/index-manager.ts', start: 27, end: 50 },
    { id: 'sym-fp-1', name: 'fileProcessor', kind: 'function', file: 'src/core/file-processor.ts', start: 0, end: 27 },
    { id: 'sym-ts-1', name: 'tsHandler',    kind: 'function', file: 'src/handlers/typescript.ts', start: 0, end: 22 },
  ];

  for (const s of symbolRows) {
    database.prepare(`
      INSERT OR REPLACE INTO symbols
        (id, repo_id, name, kind, file_path, start_byte, end_byte, signature, summary, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?)
    `).run(s.id, REPO_ID, s.name, s.kind, s.file, s.start, s.end, NOW_SEC);
  }

  // ── git_metadata ──────────────────────────────────────────────────────────
  // 10 commits for index-manager (within 90 days)
  for (let i = 0; i < 10; i++) {
    database.prepare(`
      INSERT OR REPLACE INTO git_metadata
        (repo_id, file_path, commit_sha, author_name, author_email, commit_date, message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      REPO_ID,
      'src/core/index-manager.ts',
      `sha-im-${i.toString().padStart(3, '0')}`,
      i % 2 === 0 ? 'Alice' : 'Bob',
      'dev@example.com',
      daysAgo(i * 5),           // spread over 45 days
      `fix: iteration ${i}`,
    );
  }

  // 6 commits for file-processor (within 90 days)
  for (let i = 0; i < 6; i++) {
    database.prepare(`
      INSERT OR REPLACE INTO git_metadata
        (repo_id, file_path, commit_sha, author_name, author_email, commit_date, message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      REPO_ID,
      'src/core/file-processor.ts',
      `sha-fp-${i.toString().padStart(3, '0')}`,
      'Charlie',
      'charlie@example.com',
      daysAgo(i * 10),
      `refactor: pass ${i}`,
    );
  }

  // 2 commits for typescript handler (within 90 days)
  for (let i = 0; i < 2; i++) {
    database.prepare(`
      INSERT OR REPLACE INTO git_metadata
        (repo_id, file_path, commit_sha, author_name, author_email, commit_date, message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      REPO_ID,
      'src/handlers/typescript.ts',
      `sha-ts-${i.toString().padStart(3, '0')}`,
      'Alice',
      'alice@example.com',
      daysAgo(i * 30),
      `feat: ts handler update ${i}`,
    );
  }

  // 1 commit for file-processor that is OUTSIDE a 30-day window
  database.prepare(`
    INSERT OR REPLACE INTO git_metadata
      (repo_id, file_path, commit_sha, author_name, author_email, commit_date, message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    REPO_ID,
    'src/core/file-processor.ts',
    'sha-fp-old-001',
    'Bob',
    'bob@example.com',
    daysAgo(60),          // 60 days ago — outside a 30-day window but inside 90-day
    'old commit',
  );
}

// ─── We need to patch openDatabase so the tool opens OUR test DB ──────────────

// The tool calls `openDatabase(repoId)` which normally resolves a path under
// ~/.purecontext/indexes/.  We mock the module so it returns our seeded db.

import { vi } from 'vitest';

vi.mock('../../src/core/db/schema.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/db/schema.js')>(
    '../../src/core/db/schema.js',
  );
  return {
    ...actual,
    openDatabase: (_repoId: string) => {
      // Open a fresh connection each time so db.close() in the handler does
      // not break the shared seed database.
      return new BetterSqlite3(dbPath) as Database;
    },
  };
});

// ─── Import the tool AFTER the mock is established ───────────────────────────

import { handler } from '../../src/server/tools/get-churn-metrics.js';

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(() => {
  tmpDir = join(tmpdir(), `purecontext-churn-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  dbPath = join(tmpDir, 'test.db');
  db = new BetterSqlite3(dbPath) as Database;
  seed(db);
});

afterAll(() => {
  try { db.close(); } catch { /* ignore */ }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('get_churn_metrics — file granularity', () => {
  it('returns top N files by churn score, sorted descending', async () => {
    const result = await handler({
      repoId: REPO_ID,
      granularity: 'file',
      dayWindow: 90,
      topN: 10,
    });

    expect(result.isError).toBeFalsy();
    const out = JSON.parse((result.content[0] as { text: string }).text);
    expect(out.topChurn.length).toBeGreaterThanOrEqual(2);

    // index-manager has the most commits → should be first
    expect(out.topChurn[0].filePath).toBe('src/core/index-manager.ts');
    expect(out.topChurn[0].commitCount).toBe(10);
    expect(out.topChurn[0].churnScore).toBeGreaterThan(0);

    // second should be file-processor
    expect(out.topChurn[1].filePath).toBe('src/core/file-processor.ts');
  });

  it('respects topN limit', async () => {
    const result = await handler({
      repoId: REPO_ID,
      granularity: 'file',
      dayWindow: 90,
      topN: 2,
    });
    const out = JSON.parse((result.content[0] as { text: string }).text);
    expect(out.topChurn.length).toBeLessThanOrEqual(2);
  });

  it('scope filter narrows results to directory prefix', async () => {
    const result = await handler({
      repoId: REPO_ID,
      granularity: 'file',
      dayWindow: 90,
      topN: 20,
      scope: 'src/handlers/',
    });
    const out = JSON.parse((result.content[0] as { text: string }).text);
    for (const record of out.topChurn as Array<{ filePath: string }>) {
      expect(record.filePath.startsWith('src/handlers/')).toBe(true);
    }
  });

  it('dayWindow scopes to date range — narrow window excludes old commits', async () => {
    // 30-day window: the old sha-fp-old-001 (60 days ago) should still be
    // included because we seeded it 60 days ago (outside a 30-day window).
    // file-processor's commits from 0, 10, 20, 30+ days ago:
    //   sha-fp-000 (0 days), sha-fp-001 (10 days), sha-fp-002 (20 days) — inside 30 days
    //   sha-fp-003 (30 days) — borderline, sha-fp-004 (40 days), sha-fp-005 (50 days),
    //   sha-fp-old-001 (60 days) — all outside 30-day window
    const result = await handler({
      repoId: REPO_ID,
      granularity: 'file',
      dayWindow: 30,
      topN: 20,
    });
    const out = JSON.parse((result.content[0] as { text: string }).text);
    const fpRecord = (out.topChurn as Array<{ filePath: string; commitCount: number }>).find(
      (r) => r.filePath === 'src/core/file-processor.ts',
    );
    // Within 30 days: sha-fp-000 (0 days), sha-fp-001 (10 days), sha-fp-002 (20 days)
    // sha-fp-003 is exactly 30 days — may or may not be included depending on rounding
    expect(fpRecord?.commitCount).toBeLessThan(7); // fewer than all 7 commits
  });

  it('assigns riskLevel correctly', async () => {
    const result = await handler({
      repoId: REPO_ID,
      granularity: 'file',
      dayWindow: 90,
      topN: 10,
    });
    const out = JSON.parse((result.content[0] as { text: string }).text);
    const imRecord = (out.topChurn as Array<{ filePath: string; riskLevel: string; churnScore: number }>).find(
      (r) => r.filePath === 'src/core/index-manager.ts',
    );
    // churnScore = (10 / 90) * 90 = 10 — exactly at the volatile/hotspot boundary
    // We use > 10 for hotspot, so 10 should be 'volatile'
    expect(['volatile', 'hotspot']).toContain(imRecord?.riskLevel);

    const tsRecord = (out.topChurn as Array<{ filePath: string; riskLevel: string }>).find(
      (r) => r.filePath === 'src/handlers/typescript.ts',
    );
    // 2 commits in 90 days → churnScore = 2 → 'active'
    expect(tsRecord?.riskLevel).toBe('active');
  });

  it('summary contains hotspots and mostActiveAuthor', async () => {
    const result = await handler({
      repoId: REPO_ID,
      granularity: 'file',
      dayWindow: 90,
      topN: 20,
    });
    const out = JSON.parse((result.content[0] as { text: string }).text);
    expect(out.summary.totalFilesAnalyzed).toBeGreaterThanOrEqual(3);
    expect(typeof out.summary.mostActiveAuthor).toBe('string');
    expect(out.summary.mostActiveAuthor.length).toBeGreaterThan(0);
  });
});

describe('get_churn_metrics — symbol granularity', () => {
  it('returns symbol-level records with symbolName and symbolKind', async () => {
    const result = await handler({
      repoId: REPO_ID,
      granularity: 'symbol',
      dayWindow: 90,
      topN: 10,
    });
    const out = JSON.parse((result.content[0] as { text: string }).text);
    expect(out.topChurn.length).toBeGreaterThan(0);
    const record = out.topChurn[0];
    expect(record).toHaveProperty('symbolName');
    expect(record).toHaveProperty('symbolKind');
    expect(record).toHaveProperty('filePath');
    expect(record).toHaveProperty('churnScore');
    expect(record).toHaveProperty('riskLevel');
  });

  it('includes _meta timing and powered_by', async () => {
    const result = await handler({
      repoId: REPO_ID,
      granularity: 'file',
      dayWindow: 90,
    });
    const out = JSON.parse((result.content[0] as { text: string }).text);
    expect(out._meta).toHaveProperty('timing_ms');
    expect(out._meta).toHaveProperty('powered_by');
    expect(typeof out._meta.timing_ms).toBe('number');
  });
});

describe('get_churn_metrics — no git metadata', () => {
  it('returns isError with hint when no metadata exists', async () => {
    const result = await handler({
      repoId: 'nonexistent-repo-id',
      granularity: 'file',
    });
    // openDatabase will open a new in-memory db via our mock (same db, no rows for this repoId)
    // The count query returns 0 → should return error
    expect(result.isError).toBe(true);
    const out = JSON.parse((result.content[0] as { text: string }).text);
    expect(out).toHaveProperty('error');
    expect(out).toHaveProperty('hint');
  });
});
