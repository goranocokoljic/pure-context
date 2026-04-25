import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StorageError } from '../errors.js';
import { REQUEST_LOG_DDL } from './request-log.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Permission = 'read' | 'write' | 'admin';

export interface ApiKeyRecord {
  keyHash: string;
  tenantId: string;
  permissions: Permission[];
  rateLimitTier: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface TenantRecord {
  id: string;
  name: string;
  createdAt: string;
}

// ─── DDL ──────────────────────────────────────────────────────────────────────

/**
 * DDL for the central auth database (~/.purecontext/auth.db).
 * Separate from per-repo index databases.
 *
 * Tenant columns added in auth schema v1:
 *   settings, storage_quota_bytes, storage_used_bytes
 */
export const AUTH_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id                   TEXT    PRIMARY KEY,
  name                 TEXT    NOT NULL,
  created_at           TEXT    NOT NULL,
  settings             TEXT,
  storage_quota_bytes  INTEGER,
  storage_used_bytes   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS api_keys (
  key_hash        TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  permissions     TEXT NOT NULL,
  rate_limit_tier TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_used_at    TEXT,
  revoked_at      TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);
`;

// ─── Database path + factory ──────────────────────────────────────────────────

let _authDbPathOverride: string | null = null;

/** Override the auth DB path — for testing only. */
export function _setAuthDbPathForTesting(path: string | null): void {
  _authDbPathOverride = path;
}

export function getAuthDbPath(): string {
  if (_authDbPathOverride !== null) return _authDbPathOverride;
  return join(homedir(), '.purecontext', 'auth.db');
}

/**
 * Open (or create) the central auth SQLite database.
 * Creates the auth directory if it does not exist.
 */
export function openAuthDatabase(): Database.Database {
  const path = getAuthDbPath();
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new Database(path);
  db.exec(AUTH_DDL);
  db.exec(REQUEST_LOG_DDL);
  runAuthMigrations(db);
  return db;
}

/**
 * Open an in-memory auth database.
 * Suitable for unit tests — no disk I/O.
 */
export function openInMemoryAuthDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(AUTH_DDL);
  db.exec(REQUEST_LOG_DDL);
  runAuthMigrations(db);
  return db;
}

/**
 * Migrate the auth DB schema to add tenant quota columns if they are missing.
 * Safe to call on any existing auth DB — checks for column existence before ALTER.
 */
export function runAuthMigrations(db: Database.Database): void {
  const cols = db
    .prepare("PRAGMA table_info(tenants)")
    .all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has('settings')) {
    db.exec('ALTER TABLE tenants ADD COLUMN settings TEXT');
  }
  if (!colNames.has('storage_quota_bytes')) {
    db.exec('ALTER TABLE tenants ADD COLUMN storage_quota_bytes INTEGER');
  }
  if (!colNames.has('storage_used_bytes')) {
    db.exec(
      'ALTER TABLE tenants ADD COLUMN storage_used_bytes INTEGER NOT NULL DEFAULT 0',
    );
  }
}

// ─── Key hash ─────────────────────────────────────────────────────────────────

/** One-way SHA-256 hash of a raw API key — stored in DB, never the raw key. */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

// ─── ApiKeyStore ──────────────────────────────────────────────────────────────

export class ApiKeyStore {
  constructor(private readonly db: Database.Database) {}

  insert(record: ApiKeyRecord): void {
    try {
      this.db
        .prepare(
          `INSERT INTO api_keys
             (key_hash, tenant_id, permissions, rate_limit_tier, created_at, last_used_at, revoked_at)
           VALUES
             (@keyHash, @tenantId, @permissions, @rateLimitTier, @createdAt, @lastUsedAt, @revokedAt)`,
        )
        .run({
          keyHash: record.keyHash,
          tenantId: record.tenantId,
          permissions: JSON.stringify(record.permissions),
          rateLimitTier: record.rateLimitTier,
          createdAt: record.createdAt,
          lastUsedAt: record.lastUsedAt ?? null,
          revokedAt: record.revokedAt ?? null,
        });
    } catch (err) {
      throw new StorageError('Failed to insert API key', 'insert', err);
    }
  }

  findByHash(keyHash: string): ApiKeyRecord | null {
    const row = this.db
      .prepare<[string], DbApiKeyRow>('SELECT * FROM api_keys WHERE key_hash = ?')
      .get(keyHash);
    return row ? rowToRecord(row) : null;
  }

  /** Mark the key as revoked (idempotent — only updates if not already revoked). */
  revoke(keyHash: string): void {
    this.db
      .prepare(
        "UPDATE api_keys SET revoked_at = ? WHERE key_hash = ? AND revoked_at IS NULL",
      )
      .run(new Date().toISOString(), keyHash);
  }

  /** Revoke all active keys whose hash starts with `hashPrefix`. */
  revokeByHashPrefix(hashPrefix: string): number {
    const result = this.db
      .prepare(
        "UPDATE api_keys SET revoked_at = ? WHERE key_hash LIKE ? AND revoked_at IS NULL",
      )
      .run(new Date().toISOString(), `${hashPrefix}%`);
    return result.changes;
  }

  updateLastUsed(keyHash: string): void {
    this.db
      .prepare('UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?')
      .run(new Date().toISOString(), keyHash);
  }

  listByTenant(tenantId: string): ApiKeyRecord[] {
    return this.db
      .prepare<[string], DbApiKeyRow>(
        'SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC',
      )
      .all(tenantId)
      .map(rowToRecord);
  }

  delete(keyHash: string): void {
    this.db.prepare('DELETE FROM api_keys WHERE key_hash = ?').run(keyHash);
  }
}

// ─── Tenant helpers ───────────────────────────────────────────────────────────

export function insertTenant(db: Database.Database, tenant: TenantRecord): void {
  db.prepare(
    'INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)',
  ).run(tenant.id, tenant.name, tenant.createdAt);
}

export function getTenant(db: Database.Database, id: string): TenantRecord | null {
  const row = db
    .prepare<[string], DbTenantRow>('SELECT * FROM tenants WHERE id = ?')
    .get(id);
  return row ? tenantRowToRecord(row) : null;
}

export function listTenants(db: Database.Database): TenantRecord[] {
  return db
    .prepare<[], DbTenantRow>('SELECT * FROM tenants ORDER BY created_at DESC')
    .all()
    .map(tenantRowToRecord);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface DbApiKeyRow {
  key_hash: string;
  tenant_id: string;
  permissions: string;
  rate_limit_tier: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface DbTenantRow {
  id: string;
  name: string;
  created_at: string;
}

function rowToRecord(row: DbApiKeyRow): ApiKeyRecord {
  return {
    keyHash: row.key_hash,
    tenantId: row.tenant_id,
    permissions: JSON.parse(row.permissions) as Permission[],
    rateLimitTier: row.rate_limit_tier,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function tenantRowToRecord(row: DbTenantRow): TenantRecord {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}
