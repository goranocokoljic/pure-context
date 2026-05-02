import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { Server as NodeHttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openInMemoryAuthDatabase } from '../../src/core/db/api-keys.js';
import { ApiKeyValidator, LIVE_PREFIX } from '../../src/server/auth/api-key.js';
import { AdminApi } from '../../src/server/admin-api.js';
import { RequestLogStore } from '../../src/core/db/request-log.js';
import { startHttpServer } from '../../src/server/http-server.js';
import type Database from 'better-sqlite3';

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface TestContext {
  server: NodeHttpServer;
  port: number;
  db: Database.Database;
  validator: ApiKeyValidator;
  adminKey: string;
  readKey: string;
}

function makeServerFactory(): () => McpServer {
  return () => new McpServer({ name: 'test', version: '0.0.0' });
}

async function startAdminTestServer(): Promise<TestContext> {
  const db = openInMemoryAuthDatabase();
  const validator = new ApiKeyValidator(db);
  const startTime = Date.now();

  // Create a tenant and admin key for authentication
  const adminKey = validator.generate('admin001', ['admin'], { tenantName: 'Admin' });
  const readKey = validator.generate('reader01', ['read'], { tenantName: 'Reader' });

  const adminApi = new AdminApi({ db, startTime, indexDir: '/nonexistent/path' });

  const server = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    corsOrigins: [],
    auth: { enabled: false, token: '' },
    apiKeyAuth: { enabled: true, validator },
    adminApi: { api: adminApi },
    serverFactory: makeServerFactory(),
  });

  const port = (server.address() as { port: number }).port;
  return { server, port, db, validator, adminKey, readKey };
}

function doRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; body: string; json: () => unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload).toString() } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const bodyStr = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            body: bodyStr,
            json: () => JSON.parse(bodyStr) as unknown,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function authHeader(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

// ─── Admin permission enforcement ─────────────────────────────────────────────

describe('admin permission enforcement', () => {
  let ctx: TestContext;
  afterEach(() => ctx.server.close());

  beforeEach(async () => { ctx = await startAdminTestServer(); });

  it('returns 401 when no API key is provided', async () => {
    const { status } = await doRequest(ctx.port, 'GET', '/admin/tenants');
    expect(status).toBe(401);
  });

  it('returns 401 for an invalid/malformed API key', async () => {
    const { status } = await doRequest(ctx.port, 'GET', '/admin/tenants', {
      Authorization: 'Bearer not-a-real-key',
    });
    expect(status).toBe(401);
  });

  it('returns 403 when key has only read permission', async () => {
    const { status } = await doRequest(
      ctx.port, 'GET', '/admin/tenants', authHeader(ctx.readKey),
    );
    expect(status).toBe(403);
  });

  it('returns 404 for unrecognised /admin/* path with admin key', async () => {
    const { status } = await doRequest(
      ctx.port, 'GET', '/admin/nonexistent', authHeader(ctx.adminKey),
    );
    expect(status).toBe(404);
  });

  it('returns 403 for /admin/* when apiKeyAuth is disabled', async () => {
    // Start a server with no apiKeyAuth but with adminApi
    const db2 = openInMemoryAuthDatabase();
    const v2 = new ApiKeyValidator(db2);
    const adminApi2 = new AdminApi({ db: db2, startTime: Date.now(), indexDir: '/nonexistent' });
    const srv = await startHttpServer({
      port: 0, host: '127.0.0.1', corsOrigins: [],
      auth: { enabled: false, token: '' },
      // apiKeyAuth intentionally omitted
      adminApi: { api: adminApi2 },
      serverFactory: makeServerFactory(),
    });
    const port2 = (srv.address() as { port: number }).port;
    try {
      const { status } = await doRequest(port2, 'GET', '/admin/tenants');
      expect(status).toBe(403);
    } finally {
      srv.close();
      v2.close();
    }
  });
});

// ─── Tenant CRUD ──────────────────────────────────────────────────────────────

describe('POST /admin/tenants — create tenant', () => {
  let ctx: TestContext;
  afterEach(() => ctx.server.close());
  beforeEach(async () => { ctx = await startAdminTestServer(); });

  it('creates a tenant and returns 201 with the tenant object', async () => {
    const { status, json } = await doRequest(
      ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey),
      { name: 'Acme Corp' },
    );
    expect(status).toBe(201);
    const body = json() as Record<string, unknown>;
    expect(typeof body['id']).toBe('string');
    expect((body['id'] as string).length).toBe(8);
    expect(body['name']).toBe('Acme Corp');
    expect(typeof body['created_at']).toBe('string');
    expect(body['storage_used_bytes']).toBe(0);
  });

  it('creates tenant with optional quota', async () => {
    const { status, json } = await doRequest(
      ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey),
      { name: 'Quota Corp', storage_quota_bytes: 1_000_000 },
    );
    expect(status).toBe(201);
    const body = json() as Record<string, unknown>;
    expect(body['storage_quota_bytes']).toBe(1_000_000);
  });

  it('returns 400 when name is missing', async () => {
    const { status } = await doRequest(
      ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey),
      {},
    );
    expect(status).toBe(400);
  });

  it('returns 400 when name is empty string', async () => {
    const { status } = await doRequest(
      ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey),
      { name: '  ' },
    );
    expect(status).toBe(400);
  });
});

describe('GET /admin/tenants — list tenants', () => {
  let ctx: TestContext;
  afterEach(() => ctx.server.close());
  beforeEach(async () => { ctx = await startAdminTestServer(); });

  it('returns an array of tenants', async () => {
    // Create two tenants
    await doRequest(ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey), { name: 'A' });
    await doRequest(ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey), { name: 'B' });

    const { status, json } = await doRequest(ctx.port, 'GET', '/admin/tenants', authHeader(ctx.adminKey));
    expect(status).toBe(200);
    const list = json() as unknown[];
    // admin001 and reader01 tenants were created at startup + 2 more
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(list)).toBe(true);
  });
});

describe('GET /admin/tenants/:id', () => {
  let ctx: TestContext;
  afterEach(() => ctx.server.close());
  beforeEach(async () => { ctx = await startAdminTestServer(); });

  it('returns tenant details for an existing tenant', async () => {
    const createRes = await doRequest(
      ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey), { name: 'XYZ' },
    );
    const created = createRes.json() as Record<string, unknown>;
    const id = created['id'] as string;

    const { status, json } = await doRequest(
      ctx.port, 'GET', `/admin/tenants/${id}`, authHeader(ctx.adminKey),
    );
    expect(status).toBe(200);
    expect((json() as Record<string, unknown>)['id']).toBe(id);
  });

  it('returns 404 for an unknown tenant ID', async () => {
    const { status } = await doRequest(
      ctx.port, 'GET', '/admin/tenants/00000000', authHeader(ctx.adminKey),
    );
    expect(status).toBe(404);
  });
});

describe('PATCH /admin/tenants/:id — update tenant', () => {
  let ctx: TestContext;
  afterEach(() => ctx.server.close());
  beforeEach(async () => { ctx = await startAdminTestServer(); });

  it('updates tenant name', async () => {
    const createRes = await doRequest(
      ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey), { name: 'Old Name' },
    );
    const id = (createRes.json() as Record<string, unknown>)['id'] as string;

    const { status, json } = await doRequest(
      ctx.port, 'PATCH', `/admin/tenants/${id}`, authHeader(ctx.adminKey),
      { name: 'New Name' },
    );
    expect(status).toBe(200);
    expect((json() as Record<string, unknown>)['name']).toBe('New Name');
  });

  it('updates storage quota', async () => {
    const createRes = await doRequest(
      ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey), { name: 'Quota T' },
    );
    const id = (createRes.json() as Record<string, unknown>)['id'] as string;

    const { status, json } = await doRequest(
      ctx.port, 'PATCH', `/admin/tenants/${id}`, authHeader(ctx.adminKey),
      { storage_quota_bytes: 5_000_000 },
    );
    expect(status).toBe(200);
    expect((json() as Record<string, unknown>)['storage_quota_bytes']).toBe(5_000_000);
  });

  it('returns 404 for an unknown tenant', async () => {
    const { status } = await doRequest(
      ctx.port, 'PATCH', '/admin/tenants/00000000', authHeader(ctx.adminKey),
      { name: 'X' },
    );
    expect(status).toBe(404);
  });
});

describe('DELETE /admin/tenants/:id — delete tenant', () => {
  let ctx: TestContext;
  afterEach(() => ctx.server.close());
  beforeEach(async () => { ctx = await startAdminTestServer(); });

  it('deletes a tenant and returns { deleted: true }', async () => {
    const createRes = await doRequest(
      ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey), { name: 'To Delete' },
    );
    const id = (createRes.json() as Record<string, unknown>)['id'] as string;

    const { status, json } = await doRequest(
      ctx.port, 'DELETE', `/admin/tenants/${id}`, authHeader(ctx.adminKey),
    );
    expect(status).toBe(200);
    expect((json() as Record<string, unknown>)['deleted']).toBe(true);
    expect((json() as Record<string, unknown>)['tenant_id']).toBe(id);
  });

  it('tenant is no longer accessible after deletion', async () => {
    const createRes = await doRequest(
      ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey), { name: 'Gone' },
    );
    const id = (createRes.json() as Record<string, unknown>)['id'] as string;

    await doRequest(ctx.port, 'DELETE', `/admin/tenants/${id}`, authHeader(ctx.adminKey));

    const { status } = await doRequest(
      ctx.port, 'GET', `/admin/tenants/${id}`, authHeader(ctx.adminKey),
    );
    expect(status).toBe(404);
  });

  it('returns 404 when deleting a non-existent tenant', async () => {
    const { status } = await doRequest(
      ctx.port, 'DELETE', '/admin/tenants/00000000', authHeader(ctx.adminKey),
    );
    expect(status).toBe(404);
  });
});

// ─── API key lifecycle ─────────────────────────────────────────────────────────

describe('POST /admin/tenants/:id/keys — create API key', () => {
  let ctx: TestContext;
  afterEach(() => ctx.server.close());
  beforeEach(async () => { ctx = await startAdminTestServer(); });

  it('creates a key and returns it in the response body', async () => {
    const createRes = await doRequest(
      ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey), { name: 'KeyTenant' },
    );
    const tenantId = (createRes.json() as Record<string, unknown>)['id'] as string;

    const { status, json } = await doRequest(
      ctx.port, `POST`, `/admin/tenants/${tenantId}/keys`, authHeader(ctx.adminKey),
      { permissions: ['read', 'write'] },
    );
    expect(status).toBe(201);
    const body = json() as Record<string, unknown>;
    expect(typeof body['key']).toBe('string');
    expect((body['key'] as string).startsWith(LIVE_PREFIX)).toBe(true);
    expect(body['tenant_id']).toBe(tenantId);
    expect(body['permissions']).toEqual(['read', 'write']);
  });

  it('defaults to read permission when permissions is omitted', async () => {
    const createRes = await doRequest(
      ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey), { name: 'DefaultPerm' },
    );
    const tenantId = (createRes.json() as Record<string, unknown>)['id'] as string;

    const { status, json } = await doRequest(
      ctx.port, 'POST', `/admin/tenants/${tenantId}/keys`, authHeader(ctx.adminKey),
      {},
    );
    expect(status).toBe(201);
    expect((json() as Record<string, unknown>)['permissions']).toEqual(['read']);
  });

  it('returns 404 when tenant does not exist', async () => {
    const { status } = await doRequest(
      ctx.port, 'POST', '/admin/tenants/00000000/keys', authHeader(ctx.adminKey),
      { permissions: ['read'] },
    );
    expect(status).toBe(404);
  });

  it('generates a test key when is_test: true', async () => {
    const createRes = await doRequest(
      ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey), { name: 'TestKeyTenant' },
    );
    const tenantId = (createRes.json() as Record<string, unknown>)['id'] as string;

    const { json } = await doRequest(
      ctx.port, 'POST', `/admin/tenants/${tenantId}/keys`, authHeader(ctx.adminKey),
      { permissions: ['read'], is_test: true },
    );
    const key = (json() as Record<string, unknown>)['key'] as string;
    expect(key.startsWith('pctx_test_')).toBe(true);
  });
});

describe('GET /admin/tenants/:id/keys — list API keys', () => {
  let ctx: TestContext;
  afterEach(() => ctx.server.close());
  beforeEach(async () => { ctx = await startAdminTestServer(); });

  it('lists keys for a tenant', async () => {
    const createRes = await doRequest(
      ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey), { name: 'ListKeyTenant' },
    );
    const tenantId = (createRes.json() as Record<string, unknown>)['id'] as string;

    // Create two keys
    await doRequest(ctx.port, 'POST', `/admin/tenants/${tenantId}/keys`, authHeader(ctx.adminKey), { permissions: ['read'] });
    await doRequest(ctx.port, 'POST', `/admin/tenants/${tenantId}/keys`, authHeader(ctx.adminKey), { permissions: ['write'] });

    const { status, json } = await doRequest(
      ctx.port, 'GET', `/admin/tenants/${tenantId}/keys`, authHeader(ctx.adminKey),
    );
    expect(status).toBe(200);
    const keys = json() as unknown[];
    expect(keys.length).toBe(2);
    // Keys expose only the hash prefix, not the full hash
    const k = keys[0] as Record<string, unknown>;
    expect(typeof k['key_hash_prefix']).toBe('string');
    expect((k['key_hash_prefix'] as string).length).toBe(8);
    expect(k['revoked']).toBe(false);
  });

  it('returns 404 when tenant does not exist', async () => {
    const { status } = await doRequest(
      ctx.port, 'GET', '/admin/tenants/00000000/keys', authHeader(ctx.adminKey),
    );
    expect(status).toBe(404);
  });
});

describe('DELETE /admin/keys/:prefix — revoke API key', () => {
  let ctx: TestContext;
  afterEach(() => ctx.server.close());
  beforeEach(async () => { ctx = await startAdminTestServer(); });

  it('revokes a key by full key value and returns { revoked: true }', async () => {
    const createRes = await doRequest(
      ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey), { name: 'RevokeTenant' },
    );
    const tenantId = (createRes.json() as Record<string, unknown>)['id'] as string;

    const keyRes = await doRequest(
      ctx.port, 'POST', `/admin/tenants/${tenantId}/keys`, authHeader(ctx.adminKey),
      { permissions: ['read'] },
    );
    const rawKey = (keyRes.json() as Record<string, unknown>)['key'] as string;
    // URL-encode the key since it contains underscores (which are safe, but slashes aren't)
    const { status, json } = await doRequest(
      ctx.port, 'DELETE', `/admin/keys/${encodeURIComponent(rawKey)}`, authHeader(ctx.adminKey),
    );
    expect(status).toBe(200);
    expect((json() as Record<string, unknown>)['revoked']).toBe(true);
  });

  it('revoked key shows revoked:true in key listing', async () => {
    const createRes = await doRequest(
      ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey), { name: 'RevokeCheckTenant' },
    );
    const tenantId = (createRes.json() as Record<string, unknown>)['id'] as string;

    const keyRes = await doRequest(
      ctx.port, 'POST', `/admin/tenants/${tenantId}/keys`, authHeader(ctx.adminKey),
      { permissions: ['read'] },
    );
    const rawKey = (keyRes.json() as Record<string, unknown>)['key'] as string;

    // Revoke
    await doRequest(
      ctx.port, 'DELETE', `/admin/keys/${encodeURIComponent(rawKey)}`, authHeader(ctx.adminKey),
    );

    // List keys — should show revoked: true
    const listRes = await doRequest(
      ctx.port, 'GET', `/admin/tenants/${tenantId}/keys`, authHeader(ctx.adminKey),
    );
    const keys = listRes.json() as Array<Record<string, unknown>>;
    expect(keys[0]?.['revoked']).toBe(true);
  });
});

// ─── Stats ─────────────────────────────────────────────────────────────────────

describe('GET /admin/stats — global stats', () => {
  let ctx: TestContext;
  afterEach(() => ctx.server.close());
  beforeEach(async () => { ctx = await startAdminTestServer(); });

  it('returns the expected stats shape', async () => {
    const { status, json } = await doRequest(
      ctx.port, 'GET', '/admin/stats', authHeader(ctx.adminKey),
    );
    expect(status).toBe(200);
    const body = json() as Record<string, unknown>;
    expect(typeof body['tenants']).toBe('number');
    expect(typeof body['total_repos']).toBe('number');
    expect(typeof body['storage_used_bytes']).toBe('number');
    expect(typeof body['requests_24h']).toBe('number');
    expect(typeof body['rate_limit_hits_24h']).toBe('number');
    expect(typeof body['uptime_seconds']).toBe('number');
    expect(body['uptime_seconds']).toBeGreaterThanOrEqual(0);
  });

  it('reflects the number of tenants', async () => {
    const before = (await doRequest(ctx.port, 'GET', '/admin/stats', authHeader(ctx.adminKey))).json() as Record<string, unknown>;
    const beforeCount = before['tenants'] as number;

    await doRequest(ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey), { name: 'StatsT' });

    const after = (await doRequest(ctx.port, 'GET', '/admin/stats', authHeader(ctx.adminKey))).json() as Record<string, unknown>;
    expect(after['tenants'] as number).toBe(beforeCount + 1);
  });
});

describe('GET /admin/tenants/:id/stats — per-tenant stats', () => {
  let ctx: TestContext;
  afterEach(() => ctx.server.close());
  beforeEach(async () => { ctx = await startAdminTestServer(); });

  it('returns the expected tenant stats shape', async () => {
    const createRes = await doRequest(
      ctx.port, 'POST', '/admin/tenants', authHeader(ctx.adminKey), { name: 'StatsTenant' },
    );
    const tenantId = (createRes.json() as Record<string, unknown>)['id'] as string;

    const { status, json } = await doRequest(
      ctx.port, 'GET', `/admin/tenants/${tenantId}/stats`, authHeader(ctx.adminKey),
    );
    expect(status).toBe(200);
    const body = json() as Record<string, unknown>;
    expect(typeof body['storage_used_bytes']).toBe('number');
    expect(typeof body['requests_24h']).toBe('number');
    expect(typeof body['rate_limit_hits_24h']).toBe('number');
  });

  it('returns 404 for an unknown tenant', async () => {
    const { status } = await doRequest(
      ctx.port, 'GET', '/admin/tenants/00000000/stats', authHeader(ctx.adminKey),
    );
    expect(status).toBe(404);
  });
});

// ─── Request logging & stats aggregation ──────────────────────────────────────

describe('RequestLogStore — stats aggregation', () => {
  it('counts requests correctly after logging entries', () => {
    const db = openInMemoryAuthDatabase();
    const store = new RequestLogStore(db);
    const since = new Date(Date.now() - 1000).toISOString();

    store.log({ timestamp: new Date().toISOString(), tenantId: 'aaa', tool: 'search_symbols', durationMs: 10, status: 'success', errorMessage: null });
    store.log({ timestamp: new Date().toISOString(), tenantId: 'aaa', tool: 'search_symbols', durationMs: 5, status: 'success', errorMessage: null });
    store.log({ timestamp: new Date().toISOString(), tenantId: 'aaa', tool: 'index_folder', durationMs: 0, status: 'rate_limited', errorMessage: null });

    const stats = store.getStats(since);
    expect(stats.requests).toBe(3);
    expect(stats.rateLimited).toBe(1);
  });

  it('tenant stats only count that tenant\'s requests', () => {
    const db = openInMemoryAuthDatabase();
    const store = new RequestLogStore(db);
    const since = new Date(Date.now() - 1000).toISOString();

    store.log({ timestamp: new Date().toISOString(), tenantId: 'tenant1', tool: 'search', durationMs: 5, status: 'success', errorMessage: null });
    store.log({ timestamp: new Date().toISOString(), tenantId: 'tenant2', tool: 'search', durationMs: 5, status: 'success', errorMessage: null });
    store.log({ timestamp: new Date().toISOString(), tenantId: 'tenant1', tool: 'index', durationMs: 0, status: 'rate_limited', errorMessage: null });

    const t1 = store.getTenantStats('tenant1', since);
    expect(t1.requests).toBe(2);
    expect(t1.rateLimited).toBe(1);

    const t2 = store.getTenantStats('tenant2', since);
    expect(t2.requests).toBe(1);
    expect(t2.rateLimited).toBe(0);
  });

  it('excludes entries before the since cutoff', () => {
    const db = openInMemoryAuthDatabase();
    const store = new RequestLogStore(db);

    // Log an old entry (1 hour ago)
    const oldTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    store.log({ timestamp: oldTs, tenantId: 'x', tool: 'search', durationMs: 5, status: 'success', errorMessage: null });

    // Stats from "now - 30 minutes" should not include the old entry
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const stats = store.getStats(since);
    expect(stats.requests).toBe(0);
  });
});

// ─── Log pruning ──────────────────────────────────────────────────────────────

describe('RequestLogStore.pruneOld', () => {
  it('removes entries older than the specified days', () => {
    const db = openInMemoryAuthDatabase();
    const store = new RequestLogStore(db);

    // Insert an old entry (40 days ago)
    const oldTs = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    store.log({ timestamp: oldTs, tenantId: null, tool: 'test', durationMs: 0, status: 'success', errorMessage: null });

    // Insert a recent entry
    store.log({ timestamp: new Date().toISOString(), tenantId: null, tool: 'test', durationMs: 0, status: 'success', errorMessage: null });

    const deleted = store.pruneOld(30);
    expect(deleted).toBe(1);

    // Recent entry should still be there
    const since = new Date(Date.now() - 1000).toISOString();
    const stats = store.getStats(since);
    expect(stats.requests).toBe(1);
  });

  it('returns 0 when no old entries exist', () => {
    const db = openInMemoryAuthDatabase();
    const store = new RequestLogStore(db);
    store.log({ timestamp: new Date().toISOString(), tenantId: null, tool: 'test', durationMs: 0, status: 'success', errorMessage: null });

    const deleted = store.pruneOld(30);
    expect(deleted).toBe(0);
  });
});
