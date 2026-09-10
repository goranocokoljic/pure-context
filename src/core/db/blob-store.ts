/**
 * Shared content-addressed blob store (Phase 100, Task 621).
 *
 * Every index used to carry the full source text of every file it indexed
 * (`files.raw_content`) — 40–80% of each `.db`, and byte-identical across
 * worktrees of one repository, across re-indexes of one commit, and across
 * repos that vendor the same file. Here the bytes live ONCE, in
 * `<dataDir>/blobs.db`, keyed by the SHA-256 the indexer already computes
 * (`files.content_hash`); a `files` row whose `raw_content` is NULL reads
 * its bytes from here.
 *
 * Rules:
 * - Dedup by construction (`INSERT OR IGNORE` on the hash) — no refcounts on
 *   the hot path. Garbage is found by mark-and-sweep (`index-gc.ts`).
 * - Several indexers may write at once (git hooks fire per worktree): WAL +
 *   a busy timeout; a failed write makes the caller store that file INLINE
 *   (never a lost file — risk R1).
 * - The WASM SQLite tier loads whole databases into memory, so it never
 *   WRITES here (mode falls back to 'inline'); it can still READ rows other
 *   tiers wrote.
 * - One handle per process per store path, opened lazily; reads of a store
 *   that does not exist yet never create it.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { logger } from '../logger.js';
import { getConfig } from '../../config/config-loader.js';
import { getDataDir } from './schema.js';
import { getSqliteFactory } from './sqlite-loader.js';

export type ContentStoreMode = 'blob' | 'inline';

export const BLOB_DB_NAME = 'blobs.db';

/** `<dataDir>/blobs.db` — moves with `PCTX_DATA_DIR`, like the indexes. */
export function getBlobDbPath(dataDir: string = getDataDir()): string {
  return join(dataDir, BLOB_DB_NAME);
}

const BLOB_DDL = `
CREATE TABLE IF NOT EXISTS blobs (
  hash       TEXT    PRIMARY KEY,
  bytes      BLOB    NOT NULL,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export interface BlobEntry {
  hash: string;
  bytes: Buffer;
}

export interface BlobStats {
  /** Rows in the store. */
  count: number;
  /** Sum of stored byte lengths (logical). */
  bytes: number;
  /** `blobs.db` (+ WAL) size on disk. */
  fileBytes: number;
}

export interface BlobStore {
  readonly path: string;
  /** The raw handle — for `index-gc`'s single-transaction sweep only. */
  readonly db: Database.Database;
  /** Store one blob. Returns true when the hash is present afterwards. */
  put(hash: string, bytes: Buffer): boolean;
  /** Store many in one transaction. Returns the hashes present afterwards. */
  putMany(entries: BlobEntry[]): Set<string>;
  get(hash: string): Buffer | null;
  /** Batched lookup (chunked `IN (…)`); missing hashes are absent from the map. */
  getMany(hashes: Iterable<string>): Map<string, Buffer>;
  has(hash: string): boolean;
  sizeOf(hash: string): number | null;
  sizesOf(hashes: Iterable<string>): Map<string, number>;
  /** Every (hash, size, created_at) — the GC's sweep input. */
  list(): Array<{ hash: string; size: number; createdAt: number }>;
  deleteMany(hashes: Iterable<string>): number;
  vacuum(): void;
  stats(): BlobStats;
  close(): void;
}

const IN_CHUNK = 400;

const _open = new Map<string, BlobStore>();

/**
 * Open (memoized per path) the blob store. `createIfMissing: false` returns
 * null when the file does not exist — used by READ paths so a pre-1.33
 * machine that never wrote a blob never grows one.
 */
export function openBlobStore(
  options: { dataDir?: string; createIfMissing?: boolean } = {},
): BlobStore | null {
  const path = getBlobDbPath(options.dataDir);
  const cached = _open.get(path);
  if (cached) return cached;
  const create = options.createIfMissing ?? true;
  if (!create && !existsSync(path)) return null;
  mkdirSync(dirname(path), { recursive: true });
  const db = getSqliteFactory().open(path);
  for (const pragma of ['journal_mode = WAL', 'busy_timeout = 5000', 'synchronous = NORMAL']) {
    try {
      db.exec(`PRAGMA ${pragma}`);
    } catch {
      /* WASM tier: pragmas are no-ops */
    }
  }
  db.exec(BLOB_DDL);
  const store = createStore(path, db);
  _open.set(path, store);
  return store;
}

/** Close every memoized handle (tests; process shutdown). */
export function closeBlobStores(): void {
  for (const s of [..._open.values()]) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  _open.clear();
}

function createStore(path: string, db: Database.Database): BlobStore {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO blobs (hash, bytes, size, created_at) VALUES (?, ?, ?, ?)',
  );
  const selectOne = db.prepare<[string], { bytes: Buffer }>('SELECT bytes FROM blobs WHERE hash = ?');
  const selectSize = db.prepare<[string], { size: number }>('SELECT size FROM blobs WHERE hash = ?');
  const exists = db.prepare<[string], { one: number }>('SELECT 1 AS one FROM blobs WHERE hash = ?');

  const putManyTx = db.transaction((entries: BlobEntry[]) => {
    for (const e of entries) insert.run(e.hash, e.bytes, e.bytes.length, Date.now());
  });

  const store: BlobStore = {
    path,
    db,
    put(hash, bytes) {
      try {
        insert.run(hash, bytes, bytes.length, Date.now());
        return true;
      } catch (err) {
        logger.warn(`blob store: write failed for ${hash.slice(0, 12)} — storing inline: ${String(err)}`);
        return false;
      }
    },
    putMany(entries) {
      const present = new Set<string>();
      if (entries.length === 0) return present;
      try {
        putManyTx(entries);
        for (const e of entries) present.add(e.hash);
        return present;
      } catch (err) {
        logger.warn(`blob store: batch write failed (${entries.length} blobs) — storing inline: ${String(err)}`);
        // The transaction rolled back as a whole; report what is actually there.
        for (const e of entries) {
          try {
            if (exists.get(e.hash)) present.add(e.hash);
          } catch {
            /* store unreadable — treat as absent */
          }
        }
        return present;
      }
    },
    get(hash) {
      const row = selectOne.get(hash);
      return row ? toBuffer(row.bytes) : null;
    },
    getMany(hashes) {
      const out = new Map<string, Buffer>();
      const list = [...new Set(hashes)];
      for (let i = 0; i < list.length; i += IN_CHUNK) {
        const chunk = list.slice(i, i + IN_CHUNK);
        const rows = db
          .prepare<string[], { hash: string; bytes: Buffer }>(
            `SELECT hash, bytes FROM blobs WHERE hash IN (${chunk.map(() => '?').join(',')})`,
          )
          .all(...chunk);
        for (const r of rows) out.set(r.hash, toBuffer(r.bytes));
      }
      return out;
    },
    has(hash) {
      return exists.get(hash) !== undefined;
    },
    sizeOf(hash) {
      return selectSize.get(hash)?.size ?? null;
    },
    sizesOf(hashes) {
      const out = new Map<string, number>();
      const list = [...new Set(hashes)];
      for (let i = 0; i < list.length; i += IN_CHUNK) {
        const chunk = list.slice(i, i + IN_CHUNK);
        const rows = db
          .prepare<string[], { hash: string; size: number }>(
            `SELECT hash, size FROM blobs WHERE hash IN (${chunk.map(() => '?').join(',')})`,
          )
          .all(...chunk);
        for (const r of rows) out.set(r.hash, r.size);
      }
      return out;
    },
    list() {
      return db
        .prepare<[], { hash: string; size: number; created_at: number }>(
          'SELECT hash, size, created_at FROM blobs',
        )
        .all()
        .map((r) => ({ hash: r.hash, size: r.size, createdAt: r.created_at }));
    },
    deleteMany(hashes) {
      const list = [...new Set(hashes)];
      let n = 0;
      const del = db.transaction(() => {
        for (let i = 0; i < list.length; i += IN_CHUNK) {
          const chunk = list.slice(i, i + IN_CHUNK);
          n += db
            .prepare(`DELETE FROM blobs WHERE hash IN (${chunk.map(() => '?').join(',')})`)
            .run(...chunk).changes;
        }
      });
      del();
      return n;
    },
    vacuum() {
      try {
        db.exec('VACUUM');
        // In WAL mode VACUUM writes the rebuilt file into the WAL first; fold
        // it back so the on-disk figure reported afterwards is the real one.
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (err) {
        logger.debug(`blob store: VACUUM unavailable: ${String(err)}`);
      }
    },
    stats() {
      const row = db
        .prepare<[], { c: number; b: number | null }>('SELECT COUNT(*) AS c, SUM(size) AS b FROM blobs')
        .get();
      return { count: row?.c ?? 0, bytes: row?.b ?? 0, fileBytes: blobFileBytes(path) };
    },
    close() {
      _open.delete(path);
      db.close();
    },
  };
  return store;
}

/** `blobs.db` + its WAL on disk (0 when absent) — no handle needed. */
export function blobFileBytes(path: string = getBlobDbPath()): number {
  let n = 0;
  for (const suffix of ['', '-wal']) {
    try {
      n += statSync(path + suffix).size;
    } catch {
      /* absent */
    }
  }
  return n;
}

/** Row values may arrive as Uint8Array (WASM tier) or TEXT — normalize to Buffer. */
function toBuffer(v: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

// ─── Mode ─────────────────────────────────────────────────────────────────────

/**
 * Where NEW file content goes. `PCTX_CONTENT_STORE=inline|blob` overrides the
 * config (`storage.contentStore`, default 'blob'); the WASM tier is always
 * inline unless the env var forces blob (tests).
 */
export function contentStoreMode(): ContentStoreMode {
  const env = process.env['PCTX_CONTENT_STORE'];
  if (env === 'inline' || env === 'blob') return env;
  let configured: ContentStoreMode = 'blob';
  try {
    configured = getConfig().storage?.contentStore ?? 'blob';
  } catch {
    configured = 'blob';
  }
  if (configured === 'blob') {
    try {
      if (getSqliteFactory().backend === 'wasm') return 'inline';
    } catch {
      /* factory not initialised — native assumed */
    }
  }
  return configured;
}
