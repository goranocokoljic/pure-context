import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
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
  label: string | null;
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
  label           TEXT,
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
  const dataDir = process.env['PCTX_DATA_DIR'];
  if (dataDir) return join(dataDir, 'auth.db');
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

  // plan column on tenants
  if (!colNames.has('plan')) {
    db.exec("ALTER TABLE tenants ADD COLUMN plan TEXT NOT NULL DEFAULT 'team'");
  }

  // workspace_members table
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL,
  added_at     TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id) REFERENCES tenants(id) ON DELETE CASCADE
)`);

  // api_keys migrations
  const keyCols = db
    .prepare("PRAGMA table_info(api_keys)")
    .all() as Array<{ name: string }>;
  const keyColNames = new Set(keyCols.map((c) => c.name));
  if (!keyColNames.has('label')) {
    db.exec('ALTER TABLE api_keys ADD COLUMN label TEXT');
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
             (key_hash, tenant_id, permissions, rate_limit_tier, label, created_at, last_used_at, revoked_at)
           VALUES
             (@keyHash, @tenantId, @permissions, @rateLimitTier, @label, @createdAt, @lastUsedAt, @revokedAt)`,
        )
        .run({
          keyHash: record.keyHash,
          tenantId: record.tenantId,
          permissions: JSON.stringify(record.permissions),
          rateLimitTier: record.rateLimitTier,
          label: record.label ?? null,
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

  updateLabel(keyHash: string, label: string): void {
    this.db
      .prepare('UPDATE api_keys SET label = ? WHERE key_hash = ?')
      .run(label, keyHash);
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
  label: string | null;
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
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function tenantRowToRecord(row: DbTenantRow): TenantRecord {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

// ─── Convenience helpers (Phase 18) ──────────────────────────────────────────

/**
 * Create and store a new API key for the given tenant.
 * Returns the plaintext key (`pctx_` + 32 random hex chars) — shown once only.
 * Only the SHA-256 hash is stored in the database.
 *
 * Automatically creates the tenant record if it doesn't exist.
 */
export function createApiKey(
  db: Database.Database,
  tenantId: string,
  label: string | null,
  permissions: Permission[],
  opts: { rateLimitTier?: string } = {},
): string {
  const rateLimitTier = opts.rateLimitTier ?? 'default';

  // pctx_ + 32 random hex chars (16 bytes → 32 hex)
  const rawKey = `pctx_${randomBytes(16).toString('hex')}`;
  const keyHash = hashApiKey(rawKey);

  if (getTenant(db, tenantId) === null) {
    insertTenant(db, { id: tenantId, name: tenantId, createdAt: new Date().toISOString() });
  }

  new ApiKeyStore(db).insert({
    keyHash,
    tenantId,
    permissions,
    rateLimitTier,
    label,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revokedAt: null,
  });

  return rawKey;
}

/**
 * Validate a raw API key. Returns `{ tenantId, permissions }` when valid, or null.
 * Updates `last_used_at` on success.
 */
export function validateApiKey(
  db: Database.Database,
  rawKey: string,
): { tenantId: string; permissions: Permission[] } | null {
  const store = new ApiKeyStore(db);
  const record = store.findByHash(hashApiKey(rawKey));
  if (record === null || record.revokedAt !== null) return null;
  store.updateLastUsed(hashApiKey(rawKey));
  return { tenantId: record.tenantId, permissions: record.permissions };
}

/**
 * Revoke an API key by its plaintext value or hash prefix.
 */
export function revokeApiKey(db: Database.Database, keyOrHashPrefix: string): void {
  const store = new ApiKeyStore(db);
  if (keyOrHashPrefix.startsWith('pctx_')) {
    store.revoke(hashApiKey(keyOrHashPrefix));
  } else {
    store.revokeByHashPrefix(keyOrHashPrefix);
  }
}

/**
 * List all non-revoked API keys for a tenant, newest first.
 * Never returns the raw key — only metadata.
 */
export function listApiKeys(db: Database.Database, tenantId: string): ApiKeyRecord[] {
  return new ApiKeyStore(db)
    .listByTenant(tenantId)
    .filter((k) => k.revokedAt === null);
}

/**
 * Look up the workspace (tenant) ID for a non-revoked API key hash.
 * Returns null when the key is not found or has been revoked.
 */
export function getWorkspaceForKey(db: Database.Database, keyHash: string): string | null {
  const row = db.prepare<[string], { tenant_id: string }>(
    'SELECT tenant_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL'
  ).get(keyHash);
  return row?.tenant_id ?? null;
}
