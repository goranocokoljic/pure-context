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
import type Database from 'better-sqlite3';
import type { AuthResult, Permission } from './auth/api-key.js';
import { ApiKeyValidator } from './auth/api-key.js';
import { TenantStore, type Tenant, type WorkspaceRole, type WorkspaceMember } from '../core/db/tenants.js';
import { ApiKeyStore, type ApiKeyRecord } from '../core/db/api-keys.js';
import { RequestLogStore, type RequestLogEntry } from '../core/db/request-log.js';
import { getIndexDir } from '../core/db/schema.js';
import { getSqliteFactory } from '../core/db/sqlite-loader.js';
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

  // Flat /admin/keys routes (Phase 18)
  if (method === 'POST' && path === '/admin/keys') {
    return { route: 'createKeyFlat', params: {} };
  }
  if (method === 'GET' && path === '/admin/keys') {
    return { route: 'listKeysFlat', params: {} };
  }

  // /admin/keys/:id (Phase 18 flat routes + legacy revoke)
  const keyMatch = /^\/admin\/keys\/([^/]+)$/.exec(path);
  if (keyMatch) {
    const id = keyMatch[1]!;
    if (method === 'GET') return { route: 'keyUsage', params: { id } };
    if (method === 'DELETE') return { route: 'revokeKey', params: { prefix: id } };
  }

  // /admin/keys/:id/usage (explicit usage route)
  const keyUsageMatch = /^\/admin\/keys\/([^/]+)\/usage$/.exec(path);
  if (keyUsageMatch && method === 'GET') {
    return { route: 'keyUsage', params: { id: keyUsageMatch[1]! } };
  }

  // /admin/workspaces routes
  if (method === 'POST' && path === '/admin/workspaces') {
    return { route: 'createWorkspace', params: {} };
  }
  if (method === 'GET' && path === '/admin/workspaces') {
    return { route: 'listWorkspaces', params: {} };
  }
  const wsMatch = /^\/admin\/workspaces\/([^/]+)$/.exec(path);
  if (wsMatch) {
    const id = wsMatch[1]!;
    if (method === 'GET') return { route: 'getWorkspace', params: { id } };
    if (method === 'PATCH') return { route: 'updateWorkspace', params: { id } };
  }
  const wsMembersMatch = /^\/admin\/workspaces\/([^/]+)\/members$/.exec(path);
  if (wsMembersMatch) {
    const id = wsMembersMatch[1]!;
    if (method === 'POST') return { route: 'addWorkspaceMember', params: { id } };
    if (method === 'GET') return { route: 'listWorkspaceMembers', params: { id } };
  }
  const wsMemberMatch = /^\/admin\/workspaces\/([^/]+)\/members\/([^/]+)$/.exec(path);
  if (wsMemberMatch && method === 'DELETE') {
    return { route: 'removeWorkspaceMember', params: { id: wsMemberMatch[1]!, userId: wsMemberMatch[2]! } };
  }
  const wsUsageMatch = /^\/admin\/workspaces\/([^/]+)\/usage$/.exec(path);
  if (wsUsageMatch && method === 'GET') {
    return { route: 'workspaceUsage', params: { id: wsUsageMatch[1]! } };
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

function workspaceToJson(t: Tenant): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    created_at: t.createdAt,
    plan: t.plan,
    member_count: t.memberCount ?? 0,
    settings: t.settings,
    storage_quota_bytes: t.storageQuotaBytes,
    storage_used_bytes: t.storageUsedBytes,
  };
}

function memberToJson(m: WorkspaceMember): Record<string, unknown> {
  return {
    workspace_id: m.workspaceId,
    user_id: m.userId,
    role: m.role,
    added_at: m.addedAt,
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
      // Phase 18 flat key routes
      case 'createKeyFlat':  return this.createKeyFlat(req, res);
      case 'listKeysFlat':   return this.listKeysFlat(res);
      case 'keyUsage':       return this.keyUsage(res, params['id']!);
      // Task 128 workspace routes
      case 'createWorkspace':        return this.createWorkspace(req, res);
      case 'listWorkspaces':         return this.listWorkspaces(res);
      case 'getWorkspace':           return this.getWorkspace(res, params['id']!);
      case 'updateWorkspace':        return this.updateWorkspace(req, res, params['id']!);
      case 'addWorkspaceMember':     return this.addWorkspaceMember(req, res, params['id']!);
      case 'listWorkspaceMembers':   return this.listWorkspaceMembers(res, params['id']!);
      case 'removeWorkspaceMember':  return this.removeWorkspaceMember(res, params['id']!, params['userId']!);
      case 'workspaceUsage':         return this.workspaceUsage(res, params['id']!);
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
        const db = getSqliteFactory().open(dbPath, { readonly: true });
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

  // ─── Phase 18 flat key routes ────────────────────────────────────────────────

  /**
   * POST /admin/keys
   * Create a new API key. Body: { tenant_id?, label?, permissions?, rate_limit_tier?, is_test? }
   * When tenant_id is omitted, creates or reuses a 'default' tenant.
   */
  private async createKeyFlat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseJsonBody(req);
    if (body === null) {
      jsonResponse(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const tenantId = typeof body['tenant_id'] === 'string' && body['tenant_id'].trim()
      ? body['tenant_id'].trim()
      : 'default';

    const label = typeof body['label'] === 'string' ? body['label'].trim() || null : null;

    const rawPerms = body['permissions'];
    const permissions: Permission[] = Array.isArray(rawPerms)
      ? rawPerms.filter((p): p is Permission => p === 'read' || p === 'write' || p === 'admin')
      : ['read'];
    if (permissions.length === 0) permissions.push('read');

    const rateLimitTier = typeof body['rate_limit_tier'] === 'string' ? body['rate_limit_tier'] : 'default';
    const isTest = body['is_test'] === true;

    const rawKey = this.validator.generate(tenantId, permissions, {
      rateLimitTier,
      isTest,
      tenantName: tenantId,
    });

    // Patch the label onto the stored record (validator.generate doesn't accept label yet)
    if (label !== null) {
      const { hashApiKey } = await import('../core/db/api-keys.js');
      this.keyStore.updateLabel(hashApiKey(rawKey), label);
    }

    jsonResponse(res, 201, {
      key: rawKey,
      tenant_id: tenantId,
      label,
      permissions,
      rate_limit_tier: rateLimitTier,
    });
  }

  /**
   * GET /admin/keys
   * List all API keys across all tenants (hashes only — never raw values).
   */
  private listKeysFlat(res: ServerResponse): void {
    const tenants = this.tenantStore.list();
    const allKeys: ReturnType<typeof keyToJson>[] = [];
    for (const t of tenants) {
      const keys = this.keyStore.listByTenant(t.id);
      for (const k of keys) {
        allKeys.push(keyToJson(k));
      }
    }
    allKeys.sort((a, b) =>
      String(b['created_at'] ?? '').localeCompare(String(a['created_at'] ?? '')),
    );
    jsonResponse(res, 200, allKeys);
  }

  /**
   * GET /admin/keys/:id
   * GET /admin/keys/:id/usage
   * Returns last_used_at and request count for a key, identified by its hash prefix.
   */
  private keyUsage(res: ServerResponse, hashPrefix: string): void {
    const tenants = this.tenantStore.list();
    for (const t of tenants) {
      const keys = this.keyStore.listByTenant(t.id);
      const match = keys.find((k) => k.keyHash.startsWith(hashPrefix));
      if (match) {
        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const logStats = this.logStore.getTenantStats(t.id, since24h);
        jsonResponse(res, 200, {
          key_hash_prefix: match.keyHash.slice(0, 8),
          tenant_id: match.tenantId,
          label: match.label,
          permissions: match.permissions,
          rate_limit_tier: match.rateLimitTier,
          created_at: match.createdAt,
          last_used_at: match.lastUsedAt,
          revoked: match.revokedAt !== null,
          requests_24h: logStats.requests,
        });
        return;
      }
    }
    jsonResponse(res, 404, { error: `No key found with hash prefix: ${hashPrefix}` });
  }

  // ─── Workspace management (Task 128) ────────────────────────────────────────

  private async createWorkspace(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

    const rawPlan = body['plan'];
    const plan: 'free' | 'team' | 'enterprise' =
      rawPlan === 'free' || rawPlan === 'team' || rawPlan === 'enterprise'
        ? rawPlan
        : 'team';

    const workspace = this.tenantStore.create(name.trim(), { plan });
    jsonResponse(res, 201, workspaceToJson(workspace));
  }

  private listWorkspaces(res: ServerResponse): void {
    const workspaces = this.tenantStore.list();
    jsonResponse(res, 200, workspaces.map(workspaceToJson));
  }

  private getWorkspace(res: ServerResponse, id: string): void {
    const workspace = this.tenantStore.get(id);
    if (workspace === null) {
      jsonResponse(res, 404, { error: 'Workspace not found' });
      return;
    }
    jsonResponse(res, 200, workspaceToJson(workspace));
  }

  private async updateWorkspace(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const existing = this.tenantStore.get(id);
    if (existing === null) {
      jsonResponse(res, 404, { error: 'Workspace not found' });
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
    const rawPlan = body['plan'];
    if (rawPlan === 'free' || rawPlan === 'team' || rawPlan === 'enterprise') {
      updates.plan = rawPlan;
    }

    this.tenantStore.update(id, updates);
    const updated = this.tenantStore.get(id)!;
    jsonResponse(res, 200, workspaceToJson(updated));
  }

  private async addWorkspaceMember(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const workspace = this.tenantStore.get(id);
    if (workspace === null) {
      jsonResponse(res, 404, { error: 'Workspace not found' });
      return;
    }

    const body = await parseJsonBody(req);
    if (body === null) {
      jsonResponse(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const userId = body['userId'] ?? body['user_id'];
    if (typeof userId !== 'string' || !userId.trim()) {
      jsonResponse(res, 400, { error: 'userId is required' });
      return;
    }

    const rawRole = body['role'];
    const role: WorkspaceRole =
      rawRole === 'owner' || rawRole === 'admin' || rawRole === 'member' || rawRole === 'readonly'
        ? rawRole
        : 'member';

    this.tenantStore.addMember(id, userId.trim(), role);
    jsonResponse(res, 201, { workspaceId: id, userId: userId.trim(), role });
  }

  private listWorkspaceMembers(res: ServerResponse, id: string): void {
    const workspace = this.tenantStore.get(id);
    if (workspace === null) {
      jsonResponse(res, 404, { error: 'Workspace not found' });
      return;
    }

    const members = this.tenantStore.listMembers(id);
    jsonResponse(res, 200, members.map(memberToJson));
  }

  private removeWorkspaceMember(res: ServerResponse, id: string, userId: string): void {
    const workspace = this.tenantStore.get(id);
    if (workspace === null) {
      jsonResponse(res, 404, { error: 'Workspace not found' });
      return;
    }

    this.tenantStore.removeMember(id, userId);
    jsonResponse(res, 200, { removed: true, workspaceId: id, userId });
  }

  private workspaceUsage(res: ServerResponse, id: string): void {
    const workspace = this.tenantStore.get(id);
    if (workspace === null) {
      jsonResponse(res, 404, { error: 'Workspace not found' });
      return;
    }

    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const logStats = this.logStore.getTenantStats(id, since30d);

    jsonResponse(res, 200, {
      workspace_id: id,
      file_count: 0,    // Requires scanning per-repo DBs — omitted for performance
      symbol_count: 0,  // Requires scanning per-repo DBs — omitted for performance
      storage_used_bytes: workspace.storageUsedBytes,
      api_calls_month: logStats.requests,
      plan: workspace.plan,
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
