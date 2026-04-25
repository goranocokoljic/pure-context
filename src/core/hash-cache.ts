import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import { getAllFileHashes, upsertFile } from './db/file-store.js';

// ─── Public API ───────────────────────────────────────────────────────────────

export interface HashCache {
  /** Compute SHA-256 hash of file content. */
  computeHash(content: Buffer): string;
  /** Returns true if there is no cached hash for filePath, or if it differs from newHash. */
  hasChanged(filePath: string, newHash: string): boolean;
  /** Store a hash in the in-memory cache (does not write to DB). */
  set(filePath: string, hash: string): void;
  /** Persist all in-memory hashes to the files table (hash-only, no content). */
  sync(db: Database.Database, repoId: string): void;
  /** Hydrate the in-memory cache from the files table. */
  loadFromDb(db: Database.Database, repoId: string): void;
  /** Number of entries in the cache. */
  size(): number;
}

export function createHashCache(): HashCache {
  const cache = new Map<string, string>();

  return {
    computeHash(content: Buffer): string {
      return createHash('sha256').update(content).digest('hex');
    },

    hasChanged(filePath: string, newHash: string): boolean {
      const cached = cache.get(filePath);
      return cached === undefined || cached !== newHash;
    },

    set(filePath: string, hash: string): void {
      cache.set(filePath, hash);
    },

    sync(db: Database.Database, repoId: string): void {
      for (const [filePath, hash] of cache) {
        upsertFile(db, repoId, filePath, hash);
      }
    },

    loadFromDb(db: Database.Database, repoId: string): void {
      const stored = getAllFileHashes(db, repoId);
      for (const [filePath, hash] of stored) {
        cache.set(filePath, hash);
      }
    },

    size(): number {
      return cache.size;
    },
  };
}

export function computeHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
