/**
 * AdminApi — REST endpoints for managing tenants, API keys, and monitoring.
 *
 * All /admin/* routes require a valid API key with `admin` permission.
 * This is enforced by the HTTP server before delegating to AdminApi.handle().
 *
 * Routes:
 *   POST   /admin/tenants              — create tenant
 *   GET    /admin/tenants              — list tenants
 *   GET    /admin/tenants/:id          — get tenant
 *   PATCH  /admin/tenants/:id          — update tenant
 *   DELETE /admin/tenants/:id          — delete tenant + data
 *   POST   /admin/tenants/:id/keys     — create API key
 *   GET    /admin/tenants/:id/keys     — list API keys
 *   DELETE /admin/keys/:prefix         — revoke API key
 *   GET    /admin/stats                — global stats
 *   GET    /admin/tenants/:id/stats    — per-tenant stats
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { AuthResult, Permission } from './auth/api-key.js';
import { ApiKeyValidator } from './auth/api-key.js';
import { TenantStore, type Tenant } from '../core/db/tenants.js';
import { ApiKeyStore, type ApiKeyRecord } from '../core/db/api-keys.js';
import { RequestLogStore, type RequestLogEntry } from '../core/db/request-log.js';
import { getIndexDir } from '../core/db/schema.js';
import { logger } from '../core/logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ADMIN_BODY_BYTES = 65_536; // 64 KB — admin bodies are small

// ─── Options ──────────────────────────────────────────────────────────────────

export interface AdminApiOptions {
  /** Central auth database (shared with TenantStore, ApiKeyStore, RequestLogStore). */
  db: Database.Database;
  /** Server start timestamp (epoch ms) — used to compute uptime. */
  startTime: number;
  /** Override the repo index directory. Defaults to ~/.purecontext/indexes. */
  indexDir?: string;
}

// ─── Route matching ───────────────────────────────────────────────────────────

interface RouteMatch {
  route: string;
  params: Record<string, string>;
}

function matchRoute(method: string, path: string): RouteMatch | null {
  if (method === 'GET' && path === '/admin/stats') {
    return { route: 'globalStats', params: {} };
  }
  if (method === 'POST' && path === '/admin/tenants') {
    return { route: 'createTenant', params: {} };
  }
  if (method === 'GET' && path === '/admin/tenants') {
    return { route: 'listTenants', params: {} };
  }

  // /admin/tenants/:id/keys
  const keysMatch = /^\/admin\/tenants\/([^/]+)\/keys$/.exec(path);
  if (keysMatch) {
    const id = keysMatch[1]!;
    if (method === 'POST') return { route: 'createKey', params: { id } };
    if (method === 'GET') return { route: 'listKeys', params: { id } };
  }

  // /admin/tenants/:id/stats
  const tenantStatsMatch = /^\/admin\/tenants\/([^/]+)\/stats$/.exec(path);
  if (tenantStatsMatch && method === 'GET') {
    return { route: 'tenantStats', params: { id: tenantStatsMatch[1]! } };
  }

  // /admin/tenants/:id
  const tenantMatch = /^\/admin\/tenants\/([^/]+)$/.exec(path);
  if (tenantMatch) {
    const id = tenantMatch[1]!;
    if (method === 'GET') return { route: 'getTenant', params: { id } };
    if (method === 'PATCH') return { route: 'updateTenant', params: { id } };
    if (method === 'DELETE') return { route: 'deleteTenant', params: { id } };
  }

  // /admin/keys/:prefix
  const keyRevokeMatch = /^\/admin\/keys\/([^/]+)$/.exec(path);
  if (keyRevokeMatch && method === 'DELETE') {
    return { route: 'revokeKey', params: { prefix: keyRevokeMatch[1]! } };
  }

  return null;
}

// ─── Body reader ──────────────────────────────────────────────────────────────

function readAdminBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_ADMIN_BODY_BYTES) {
        req.destroy(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readAdminBody(req);
    if (raw.length === 0) return {};
    return JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// ─── Serialisers ──────────────────────────────────────────────────────────────

function tenantToJson(t: Tenant): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    created_at: t.createdAt,
    settings: t.settings,
    storage_quota_bytes: t.storageQuotaBytes,
    storage_used_bytes: t.storageUsedBytes,
  };
}

function keyToJson(k: ApiKeyRecord): Record<string, unknown> {
  return {
    key_hash_prefix: k.keyHash.slice(0, 8),
    tenant_id: k.tenantId,
    permissions: k.permissions,
    rate_limit_tier: k.rateLimitTier,
    created_at: k.createdAt,
    last_used_at: k.lastUsedAt,
    revoked: k.revokedAt !== null,
  };
}

// ─── AdminApi ─────────────────────────────────────────────────────────────────

export class AdminApi {
  private readonly tenantStore: TenantStore;
  private readonly keyStore: ApiKeyStore;
  private readonly validator: ApiKeyValidator;
  private readonly logStore: RequestLogStore;
  private readonly startTime: number;
  private readonly indexDir: string;

  constructor(opts: AdminApiOptions) {
    this.tenantStore = new TenantStore(opts.db);
    this.keyStore = new ApiKeyStore(opts.db);
    this.validator = new ApiKeyValidator(opts.db);
    this.logStore = new RequestLogStore(opts.db);
    this.startTime = opts.startTime;
    this.indexDir = opts.indexDir ?? getIndexDir();
  }

  /**
   * Log a request to the request_log table.
   * Called by the HTTP server after each MCP tool call.
   */
  logRequest(entry: RequestLogEntry): void {
    this.logStore.log(entry);
  }

  /**
   * Handle an /admin/* request.
   * Caller is responsible for verifying admin permission before calling this.
   */
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    _authResult: AuthResult,
  ): Promise<void> {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    const path = url.split('?')[0]!;

    const match = matchRoute(method, path);
    if (match === null) {
      jsonResponse(res, 404, { error: 'Not found' });
      return;
    }

    try {
      await this.dispatch(req, res, match.route, match.params);
    } catch (err) {
      logger.warn(`Admin API error [${method} ${path}]: ${err}`);
      if (!res.headersSent) {
        jsonResponse(res, 500, { error: 'Internal server error' });
      }
    }
  }

  // ─── Dispatcher ─────────────────────────────────────────────────────────────

  private async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    route: string,
    params: Record<string, string>,
  ): Promise<void> {
    switch (route) {
      case 'createTenant':   return this.createTenant(req, res);
      case 'listTenants':    return this.listTenants(res);
      case 'getTenant':      return this.getTenant(res, params['id']!);
      case 'updateTenant':   return this.updateTenant(req, res, params['id']!);
      case 'deleteTenant':   return this.deleteTenant(res, params['id']!);
      case 'createKey':      return this.createKey(req, res, params['id']!);
      case 'listKeys':       return this.listKeys(res, params['id']!);
      case 'revokeKey':      return this.revokeKey(res, params['prefix']!);
      case 'globalStats':    return this.globalStats(res);
      case 'tenantStats':    return this.tenantStats(res, params['id']!);
      default:
        jsonResponse(res, 404, { error: 'Not found' });
    }
  }

  // ─── Tenant CRUD ────────────────────────────────────────────────────────────

  private async createTenant(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseJsonBody(req);
    if (body === null) {
      jsonResponse(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const name = body['name'];
    if (typeof name !== 'string' || !name.trim()) {
      jsonResponse(res, 400, { error: 'name is required and must be a non-empty string' });
      return;
    }

    const storageQuotaBytes = body['storage_quota_bytes'];
    const settings = body['settings'];

    const tenant = this.tenantStore.create(name.trim(), {
      storageQuotaBytes: typeof storageQuotaBytes === 'number' ? storageQuotaBytes : undefined,
      settings:
        typeof settings === 'object' && settings !== null && !Array.isArray(settings)
          ? (settings as Record<string, unknown>)
          : undefined,
    });

    jsonResponse(res, 201, tenantToJson(tenant));
  }

  private listTenants(res: ServerResponse): void {
    const tenants = this.tenantStore.list();
    jsonResponse(res, 200, tenants.map(tenantToJson));
  }

  private getTenant(res: ServerResponse, id: string): void {
    const tenant = this.tenantStore.get(id);
    if (tenant === null) {
      jsonResponse(res, 404, { error: 'Tenant not found' });
      return;
    }
    jsonResponse(res, 200, tenantToJson(tenant));
  }

  private async updateTenant(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const existing = this.tenantStore.get(id);
    if (existing === null) {
      jsonResponse(res, 404, { error: 'Tenant not found' });
      return;
    }

    const body = await parseJsonBody(req);
    if (body === null) {
      jsonResponse(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const updates: Parameters<TenantStore['update']>[1] = {};

    if (typeof body['name'] === 'string' && body['name'].trim()) {
      updates.name = body['name'].trim();
    }
    if (typeof body['storage_quota_bytes'] === 'number') {
      updates.storageQuotaBytes = body['storage_quota_bytes'];
    }
    if (
      body['settings'] !== undefined &&
      typeof body['settings'] === 'object' &&
      !Array.isArray(body['settings'])
    ) {
      updates.settings = body['settings'] as Record<string, unknown>;
    }

    this.tenantStore.update(id, updates);
    const updated = this.tenantStore.get(id)!;
    jsonResponse(res, 200, tenantToJson(updated));
  }

  private deleteTenant(res: ServerResponse, id: string): void {
    const existing = this.tenantStore.get(id);
    if (existing === null) {
      jsonResponse(res, 404, { error: 'Tenant not found' });
      return;
    }

    // Remove per-repo index databases belonging to this tenant
    this.deleteTenantRepoDatabases(id);

    // Delete from auth DB — cascades to api_keys rows
    this.tenantStore.delete(id);

    jsonResponse(res, 200, { deleted: true, tenant_id: id });
  }

  private deleteTenantRepoDatabases(tenantId: string): void {
    if (!existsSync(this.indexDir)) return;

    let files: string[];
    try {
      files = readdirSync(this.indexDir).filter((f) => f.endsWith('.db'));
    } catch {
      return;
    }

    for (const file of files) {
      const dbPath = join(this.indexDir, file);
      try {
        const db = new Database(dbPath, { readonly: true });
        const row = db
          .prepare<[string], { id: string }>('SELECT id FROM repos WHERE tenant_id = ? LIMIT 1')
          .get(tenantId);
        db.close();
        if (row !== undefined) {
          unlinkSync(dbPath);
        }
      } catch {
        // Skip unreadable / corrupted databases
      }
    }
  }

  // ─── API key management ──────────────────────────────────────────────────────

  private async createKey(req: IncomingMessage, res: ServerResponse, tenantId: string): Promise<void> {
    const existing = this.tenantStore.get(tenantId);
    if (existing === null) {
      jsonResponse(res, 404, { error: 'Tenant not found' });
      return;
    }

    const body = await parseJsonBody(req);
    if (body === null) {
      jsonResponse(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const rawPerms = body['permissions'];
    const permissions: Permission[] = Array.isArray(rawPerms)
      ? (rawPerms.filter((p): p is Permission =>
          p === 'read' || p === 'write' || p === 'admin',
        ))
      : ['read'];

    if (permissions.length === 0) permissions.push('read');

    const rateLimitTier =
      typeof body['rate_limit_tier'] === 'string' ? body['rate_limit_tier'] : 'default';
    const isTest = body['is_test'] === true;

    const rawKey = this.validator.generate(tenantId, permissions, {
      rateLimitTier,
      isTest,
      tenantName: existing.name,
    });

    jsonResponse(res, 201, {
      key: rawKey,
      tenant_id: tenantId,
      permissions,
      rate_limit_tier: rateLimitTier,
    });
  }

  private listKeys(res: ServerResponse, tenantId: string): void {
    const existing = this.tenantStore.get(tenantId);
    if (existing === null) {
      jsonResponse(res, 404, { error: 'Tenant not found' });
      return;
    }

    const keys = this.keyStore.listByTenant(tenantId);
    jsonResponse(res, 200, keys.map(keyToJson));
  }

  private revokeKey(res: ServerResponse, prefix: string): void {
    this.validator.revoke(prefix);
    jsonResponse(res, 200, { revoked: true, prefix });
  }

  // ─── Stats ──────────────────────────────────────────────────────────────────

  private globalStats(res: ServerResponse): void {
    const tenants = this.tenantStore.list();
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const logStats = this.logStore.getStats(since24h);
    const storageUsedBytes = tenants.reduce((sum, t) => sum + t.storageUsedBytes, 0);

    jsonResponse(res, 200, {
      tenants: tenants.length,
      total_repos: this.countRepoFiles(),
      total_symbols: 0, // Requires scanning all per-repo DBs — omitted for performance
      storage_used_bytes: storageUsedBytes,
      requests_24h: logStats.requests,
      rate_limit_hits_24h: logStats.rateLimited,
      uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
    });
  }

  private tenantStats(res: ServerResponse, tenantId: string): void {
    const tenant = this.tenantStore.get(tenantId);
    if (tenant === null) {
      jsonResponse(res, 404, { error: 'Tenant not found' });
      return;
    }

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const logStats = this.logStore.getTenantStats(tenantId, since24h);

    jsonResponse(res, 200, {
      repos: 0, // Requires scanning per-repo DBs — omitted for performance
      symbols: 0,
      storage_used_bytes: tenant.storageUsedBytes,
      requests_24h: logStats.requests,
      rate_limit_hits_24h: logStats.rateLimited,
    });
  }

  private countRepoFiles(): number {
    if (!existsSync(this.indexDir)) return 0;
    try {
      return readdirSync(this.indexDir).filter((f) => f.endsWith('.db')).length;
    } catch {
      return 0;
    }
  }
}
