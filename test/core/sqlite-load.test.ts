import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync } from 'fs';

/**
 * Canary test for the better-sqlite3 native binary.
 * If this test fails in CI, the prebuilt binary is broken for that platform/Node version.
 */
describe('better-sqlite3 binary', () => {
  let db: Database.Database;

  afterAll(() => {
    db?.close();
  });

  it('opens an in-memory database without error', () => {
    expect(() => {
      db = new Database(':memory:');
    }).not.toThrow();
  });

  it('creates a table and round-trips a row', () => {
    db.exec(`
      CREATE TABLE canary (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL
      )
    `);

    const insert = db.prepare('INSERT INTO canary (name) VALUES (?)');
    const { lastInsertRowid } = insert.run('purecontext');

    const row = db.prepare('SELECT id, name FROM canary WHERE id = ?').get(lastInsertRowid) as {
      id: number;
      name: string;
    };

    expect(row.id).toBe(Number(lastInsertRowid));
    expect(row.name).toBe('purecontext');
  });

  it('supports WAL mode (used by the index manager)', () => {
    // WAL requires a file-backed database; in-memory always returns 'memory'.
    const dbPath = join(tmpdir(), `purecontext-sqlite-wal-check-${Date.now()}.db`);
    let fileDb: Database.Database | undefined;
    try {
      fileDb = new Database(dbPath);
      const result = fileDb.pragma('journal_mode = WAL', { simple: true });
      expect(result).toBe('wal');
    } finally {
      fileDb?.close();
      try { unlinkSync(dbPath); } catch { /* ignore */ }
      try { unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
      try { unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
    }
  });
});
