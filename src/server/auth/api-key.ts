import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  ApiKeyStore,
  hashApiKey,
  insertTenant,
  getTenant,
  openAuthDatabase,
  type Permission,
} from '../../core/db/api-keys.js';

// Re-export Permission so callers can import it from here.
export type { Permission };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuthResult {
  valid: boolean;
  tenantId?: string;
  permissions?: Permission[];
  rateLimitTier?: string;
}

export interface GenerateOptions {
  /** Emit a test key (`cl_test_`) instead of a live key (`cl_live_`). Default: false. */
  isTest?: boolean;
  /** Rate-limit tier name (e.g. 'default', 'premium'). Default: 'default'. */
  rateLimitTier?: string;
  /** Human-readable tenant name. Defaults to `tenantId`. */
  tenantName?: string;
}

// ─── Key format constants ─────────────────────────────────────────────────────

export const LIVE_PREFIX = 'pctx_';
export const TEST_PREFIX = 'pctx_test_';

/** Tenant ID segment: 8 lowercase hex chars. */
const TENANT_ID_LEN = 8;
/** Random segment: 24 base62 chars (~143 bits of entropy). */
const RANDOM_LEN = 24;
/** Checksum segment: 4 hex chars derived from SHA-256 of the preceding body. */
const CHECKSUM_LEN = 4;

// base62 alphabet — digits + uppercase + lowercase
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// ─── ApiKeyValidator ──────────────────────────────────────────────────────────

/**
 * Issues, validates, and revokes API keys.
 *
 * API key format:
 *   `pctx_<TTTTTTTT>_<RRRRRRRRRRRRRRRRRRRRRRRR>_<CCCC>`
 *   `pctx_test_<TTTTTTTT>_<RRRRRRRRRRRRRRRRRRRRRRRR>_<CCCC>`
 *
 * Where:
 *   T = 8-char lowercase hex tenant ID
 *   R = 24-char base62 random segment
 *   C = 4-char hex checksum (SHA-256 of prefix+T+_+R)
 *
 * The checksum validates key format without a database round-trip.
 * Full security comes from SHA-256 hashing + database lookup.
 */
export class ApiKeyValidator {
  private readonly db: Database.Database;
  private readonly store: ApiKeyStore;
  private readonly ownDb: boolean;

  /**
   * @param db  Optional database to use. When omitted, opens the default auth DB.
   *            Pass an in-memory database for testing.
   */
  constructor(db?: Database.Database) {
    if (db !== undefined) {
      this.db = db;
      this.ownDb = false;
    } else {
      this.db = openAuthDatabase();
      this.ownDb = true;
    }
    this.store = new ApiKeyStore(this.db);
  }

  /**
   * Generate a new API key for `tenantId`.
   *
   * Ensures the tenant exists in the database.
   * Returns the raw key string — this is the only time it is visible.
   * Only the SHA-256 hash is stored.
   */
  generate(tenantId: string, permissions: Permission[], opts: GenerateOptions = {}): string {
    const { isTest = false, rateLimitTier = 'default', tenantName = tenantId } = opts;

    // Derive a deterministic 8-char lowercase hex segment from the tenantId.
    // If the caller provides exactly 8 lowercase hex chars, use them as-is.
    // Otherwise, hash the input so the embedded segment is always valid hex.
    const tidHex = deriveHexTenantId(tenantId);

    const prefix = isTest ? TEST_PREFIX : LIVE_PREFIX;
    const random = generateBase62(RANDOM_LEN);

    // Checksum covers everything before the final `_<CCCC>` segment
    const body = `${prefix}${tidHex}_${random}`;
    const checksum = computeChecksum(body);

    const rawKey = `${body}_${checksum}`;
    const keyHash = hashApiKey(rawKey);

    // Ensure tenant exists
    if (getTenant(this.db, tidHex) === null) {
      insertTenant(this.db, {
        id: tidHex,
        name: tenantName,
        createdAt: new Date().toISOString(),
      });
    }

    this.store.insert({
      keyHash,
      tenantId: tidHex,
      permissions,
      rateLimitTier,
      label: null,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    });

    return rawKey;
  }

  /**
   * Validate an API key.
   *
   * Two-phase validation:
   *   1. Fast checksum check — verifies key format without touching the DB.
   *   2. DB lookup — checks existence, revocation status, and loads metadata.
   *
   * Updates `last_used_at` on successful validation.
   */
  async validate(apiKey: string): Promise<AuthResult> {
    // Phase 1: format + checksum (no DB)
    if (!validateFormat(apiKey)) {
      return { valid: false };
    }

    // Phase 2: DB lookup
    const keyHash = hashApiKey(apiKey);
    const record = this.store.findByHash(keyHash);

    if (record === null) {
      return { valid: false };
    }

    if (record.revokedAt !== null) {
      return { valid: false };
    }

    // Record last-used timestamp (best-effort)
    this.store.updateLastUsed(keyHash);

    return {
      valid: true,
      tenantId: record.tenantId,
      permissions: record.permissions,
      rateLimitTier: record.rateLimitTier,
    };
  }

  /**
   * Revoke an API key.
   *
   * `keyOrPrefix` is interpreted as:
   *   - A full raw key (starts with `cl_live_` or `cl_test_`) — hashed before lookup.
   *   - A key-hash prefix (used by the CLI `keys revoke <prefix>`) — matched via LIKE.
   */
  revoke(keyOrPrefix: string): void {
    if (keyOrPrefix.startsWith(LIVE_PREFIX) || keyOrPrefix.startsWith(TEST_PREFIX)) {
      this.store.revoke(hashApiKey(keyOrPrefix));
    } else {
      this.store.revokeByHashPrefix(keyOrPrefix);
    }
  }

  /** Close the database if this validator owns it. */
  close(): void {
    if (this.ownDb) {
      this.db.close();
    }
  }

  /** Expose the underlying DB for CLI commands that need direct access. */
  get database(): Database.Database {
    return this.db;
  }
}

// ─── Format validation (exported for tests) ───────────────────────────────────

/**
 * Fast structural + checksum validation of an API key.
 * Returns false for any key that doesn't match the expected format or whose
 * checksum does not verify. Does NOT touch the database.
 */
export function validateFormat(key: string): boolean {
  // Check TEST_PREFIX before LIVE_PREFIX: 'pctx_test_' starts with 'pctx_'
  const prefix = key.startsWith(TEST_PREFIX)
    ? TEST_PREFIX
    : key.startsWith(LIVE_PREFIX)
      ? LIVE_PREFIX
      : null;

  if (prefix === null) return false;

  const rest = key.slice(prefix.length);
  const parts = rest.split('_');
  if (parts.length !== 3) return false;

  const [tid, random, checksum] = parts;

  if (tid.length !== TENANT_ID_LEN || !/^[0-9a-f]+$/i.test(tid)) return false;
  if (random.length !== RANDOM_LEN || !/^[0-9A-Za-z]+$/.test(random)) return false;
  if (checksum.length !== CHECKSUM_LEN || !/^[0-9a-f]+$/i.test(checksum)) return false;

  // Verify checksum
  const body = `${prefix}${tid}_${random}`;
  return computeChecksum(body) === checksum.toLowerCase();
}

// ─── HTTP header extraction ───────────────────────────────────────────────────

/**
 * Extract an API key from an HTTP request's headers.
 *
 * Checks, in order:
 *   1. `Authorization: Bearer <key>` (only when the value looks like an API key)
 *   2. `X-API-Key: <key>`
 *
 * Returns null when no API key is found.
 */
export function extractApiKeyFromHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  // Try Authorization: Bearer
  const authHeader = headers['authorization'];
  const authStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (authStr) {
    const bearer = 'Bearer ';
    if (authStr.startsWith(bearer)) {
      const token = authStr.slice(bearer.length);
      if (token.startsWith(LIVE_PREFIX) || token.startsWith(TEST_PREFIX)) {
        return token;
      }
    }
  }

  // Try X-API-Key header
  const xApiKey = headers['x-api-key'];
  const keyStr = Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
  if (keyStr) return keyStr;

  return null;
}

// ─── Permission helpers ───────────────────────────────────────────────────────

/**
 * Return the minimum permission required to call `toolName`.
 *
 *   'admin' — administrative or destructive operations (not exposed in Phase 12)
 *   'write' — operations that modify indexed data (indexing)
 *   'read'  — read-only queries (everything else)
 */
export function getRequiredPermission(toolName: string): Permission {
  const WRITE_TOOLS = new Set(['index_folder', 'index_repo']);
  if (WRITE_TOOLS.has(toolName)) return 'write';
  return 'read';
}

/**
 * Return true when `authResult` includes `required` or any higher permission.
 *
 * Permission hierarchy: admin > write > read
 */
export function hasPermission(authResult: AuthResult, required: Permission): boolean {
  if (!authResult.valid || !authResult.permissions) return false;
  const perms = new Set(authResult.permissions);
  if (perms.has('admin')) return true;
  if (required === 'admin') return false; // Only admin keys may perform admin operations
  if (required === 'write') return perms.has('write');
  // required === 'read'
  return perms.has('read') || perms.has('write');
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Derive a deterministic 8-char lowercase hex tenant segment from an arbitrary string.
 *
 * Rules:
 *   - If `input` is already exactly 8 lowercase hex chars, return it unchanged.
 *   - Otherwise, take the first 8 chars of SHA-256(input).
 *
 * This ensures every key always has a well-formed hex tenant segment, regardless
 * of how the caller spelled the tenant ID.
 */
function deriveHexTenantId(input: string): string {
  const lower = input.toLowerCase();
  if (lower.length === TENANT_ID_LEN && /^[0-9a-f]+$/.test(lower)) {
    return lower;
  }
  return createHash('sha256').update(input).digest('hex').slice(0, TENANT_ID_LEN);
}

function generateBase62(length: number): string {
  let result = '';
  // Use rejection sampling to avoid modulo bias.
  // Each byte gives ~6 bits; values 0–247 (248 = 62 × 4) are unbiased.
  while (result.length < length) {
    const bytes = randomBytes(length);
    for (const byte of bytes) {
      if (result.length >= length) break;
      if (byte < 248) {
        result += BASE62[byte % 62];
      }
    }
  }
  return result;
}

function computeChecksum(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, CHECKSUM_LEN);
}
