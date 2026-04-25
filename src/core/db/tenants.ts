/**
 * TenantStore — manages tenant records in the central auth database.
 *
 * Tenants are the top-level isolation boundary for multi-tenant deployments.
 * Each tenant owns a set of repos, API keys, and a storage quota.
 *
 * The tenants table lives in the auth DB (~/.purecontext/auth.db), separate from
 * the per-repo index databases.
 */

import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { StorageError, QuotaExceededError } from '../errors.js';
import { DEFAULT_TENANT_ID } from '../tenant-context.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Tenant {
  id: string;
  name: string;
  createdAt: string;
  /** Tenant-specific JSON config (e.g. custom rate-limit overrides). */
  settings: Record<string, unknown> | null;
  /** Max bytes the tenant may store across all repos. null = unlimited. */
  storageQuotaBytes: number | null;
  /** Current storage used by the tenant, in bytes. */
  storageUsedBytes: number;
}

// ─── DDL extension (migration adds these columns to an existing tenants table) ─

/**
 * SQL to extend the tenants table with quota fields.
 * Called as part of the auth DB migration (runAuthMigrations).
 * SQLite ADD COLUMN is idempotent-safe when called through the migration guard.
 */
export const TENANTS_QUOTA_MIGRATION = `
ALTER TABLE tenants ADD COLUMN settings TEXT;
ALTER TABLE tenants ADD COLUMN storage_quota_bytes INTEGER;
ALTER TABLE tenants ADD COLUMN storage_used_bytes INTEGER NOT NULL DEFAULT 0;
`;

// ─── TenantStore ──────────────────────────────────────────────────────────────

export class TenantStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Create a new tenant with a randomly generated 8-char hex ID.
   * Returns the created Tenant.
   */
  create(name: string, options: { storageQuotaBytes?: number; settings?: Record<string, unknown> } = {}): Tenant {
    const id = randomBytes(4).toString('hex'); // 8 hex chars
    const createdAt = new Date().toISOString();
    const tenant: Tenant = {
      id,
      name,
      createdAt,
      settings: options.settings ?? null,
      storageQuotaBytes: options.storageQuotaBytes ?? null,
      storageUsedBytes: 0,
    };

    try {
      this.db
        .prepare(
          `INSERT INTO tenants (id, name, created_at, settings, storage_quota_bytes, storage_used_bytes)
           VALUES (@id, @name, @createdAt, @settings, @storageQuotaBytes, @storageUsedBytes)`,
        )
        .run({
          id: tenant.id,
          name: tenant.name,
          createdAt: tenant.createdAt,
          settings: tenant.settings !== null ? JSON.stringify(tenant.settings) : null,
          storageQuotaBytes: tenant.storageQuotaBytes ?? null,
          storageUsedBytes: tenant.storageUsedBytes,
        });
    } catch (err) {
      throw new StorageError(`Failed to create tenant "${name}"`, 'create', err);
    }

    return tenant;
  }

  /** Retrieve a tenant by ID. Returns null when not found. */
  get(id: string): Tenant | null {
    const row = this.db
      .prepare<[string], DbTenantRow>('SELECT * FROM tenants WHERE id = ?')
      .get(id);
    return row ? rowToTenant(row) : null;
  }

  /** Update mutable tenant fields. Ignores unknown keys. */
  update(
    id: string,
    updates: Partial<Pick<Tenant, 'name' | 'settings' | 'storageQuotaBytes'>>,
  ): void {
    const current = this.get(id);
    if (current === null) {
      throw new StorageError(`Tenant "${id}" not found`, 'update');
    }

    const fields: string[] = [];
    const params: Record<string, unknown> = { id };

    if (updates.name !== undefined) {
      fields.push('name = @name');
      params['name'] = updates.name;
    }
    if (updates.settings !== undefined) {
      fields.push('settings = @settings');
      params['settings'] = updates.settings !== null ? JSON.stringify(updates.settings) : null;
    }
    if (updates.storageQuotaBytes !== undefined) {
      fields.push('storage_quota_bytes = @storageQuotaBytes');
      params['storageQuotaBytes'] = updates.storageQuotaBytes;
    }

    if (fields.length === 0) return;

    this.db
      .prepare(`UPDATE tenants SET ${fields.join(', ')} WHERE id = @id`)
      .run(params);
  }

  /**
   * Delete a tenant and all their data.
   * The ON DELETE CASCADE on api_keys ensures keys are removed automatically.
   * Repo data (per-repo DBs) must be cleaned up separately by the caller.
   */
  delete(id: string): void {
    this.db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
  }

  /** List all tenants, newest first. */
  list(): Tenant[] {
    return this.db
      .prepare<[], DbTenantRow>('SELECT * FROM tenants ORDER BY created_at DESC')
      .all()
      .map(rowToTenant);
  }

  /**
   * Atomically increment (or decrement with a negative delta) the tenant's
   * storage_used_bytes counter. Safe for concurrent updates in SQLite WAL mode.
   */
  updateStorageUsed(id: string, deltaBytes: number): void {
    this.db
      .prepare(
        `UPDATE tenants
         SET storage_used_bytes = MAX(0, storage_used_bytes + ?)
         WHERE id = ?`,
      )
      .run(deltaBytes, id);
  }

  /**
   * Check whether `additionalBytes` can be stored without exceeding the tenant's
   * quota. Throws `QuotaExceededError` when the quota would be exceeded.
   * Does nothing when quota is null (unlimited) or tenant not found.
   */
  checkQuota(id: string, additionalBytes: number): void {
    const tenant = this.get(id);
    if (tenant === null || tenant.storageQuotaBytes === null) return;

    const projected = tenant.storageUsedBytes + additionalBytes;
    if (projected > tenant.storageQuotaBytes) {
      throw new QuotaExceededError(
        id,
        tenant.storageQuotaBytes,
        tenant.storageUsedBytes,
        additionalBytes,
      );
    }
  }
}

// ─── Default-tenant bootstrap ─────────────────────────────────────────────────

/**
 * Ensure the default "local" tenant exists in the auth DB.
 * Called during single-tenant startup so stdio mode always has a valid tenant.
 */
export function ensureDefaultTenant(db: Database.Database): void {
  const exists = db
    .prepare<[string], { id: string }>('SELECT id FROM tenants WHERE id = ?')
    .get(DEFAULT_TENANT_ID);

  if (!exists) {
    try {
      db.prepare(
        `INSERT INTO tenants (id, name, created_at, settings, storage_quota_bytes, storage_used_bytes)
         VALUES (?, ?, ?, NULL, NULL, 0)`,
      ).run(DEFAULT_TENANT_ID, 'Local', new Date().toISOString());
    } catch {
      // Another process may have inserted concurrently — ignore duplicate
    }
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface DbTenantRow {
  id: string;
  name: string;
  created_at: string;
  settings: string | null;
  storage_quota_bytes: number | null;
  storage_used_bytes: number | null; // null on old rows before migration
}

function rowToTenant(row: DbTenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    settings: row.settings !== null ? (JSON.parse(row.settings) as Record<string, unknown>) : null,
    storageQuotaBytes: row.storage_quota_bytes ?? null,
    storageUsedBytes: row.storage_used_bytes ?? 0,
  };
}
