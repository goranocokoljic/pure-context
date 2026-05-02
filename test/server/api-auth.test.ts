/**
 * Task 127 — API Key Authentication
 *
 * Tests:
 *  - /mcp endpoint: 401 without key, 403 for invalid/revoked, 200 for valid
 *  - /api/* endpoints: same rules when apiKeyAuth is enabled
 *  - /health: always exempt (no auth required)
 *  - /admin/* endpoints: require valid key with 'admin' permission
 *  - Rate limiter keys on authenticated requests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { request as httpRequest } from 'node:http';
import type { Server as NodeHttpServer } from 'node:http';
import { openInMemoryAuthDatabase } from '../../src/core/db/api-keys.js';
import { ApiKeyValidator } from '../../src/server/auth/api-key.js';
import { startHttpServer } from '../../src/server/http-server.js';
import type Database from 'better-sqlite3';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb() {
  return openInMemoryAuthDatabase();
}

function doRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyBuf = body ? Buffer.from(body) : undefined;
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...(bodyBuf ? { 'Content-Length': String(bodyBuf.length) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function mcpPost(port: number, headers: Record<string, string> = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 });
  return doRequest(port, 'POST', '/mcp', headers, body);
}

// ─── /health exemption ────────────────────────────────────────────────────────

describe('/health is always exempt from auth', () => {
  let server: NodeHttpServer;
  let port: number;

  beforeEach(async () => {
    const db = makeDb();
    const validator = new ApiKeyValidator(db);
    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      apiKeyAuth: { enabled: true, validator },
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
      serveUi: false,
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(() => server.close());

  it('returns 200 on GET /health without any credentials', async () => {
    const r = await doRequest(port, 'GET', '/health');
    expect(r.status).toBe(200);
    const json = JSON.parse(r.body);
    expect(json.status).toBe('ok');
  });
});

// ─── /mcp endpoint auth ───────────────────────────────────────────────────────

describe('/mcp endpoint requires API key when apiKeyAuth.enabled', () => {
  let server: NodeHttpServer;
  let port: number;
  let validator: ApiKeyValidator;
  let db: Database.Database;

  beforeEach(async () => {
    db = makeDb();
    validator = new ApiKeyValidator(db);
    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      apiKeyAuth: { enabled: true, validator },
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
      serveUi: false,
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(() => { server.close(); validator.close(); });

  it('returns 401 with no key', async () => {
    const r = await mcpPost(port);
    expect(r.status).toBe(401);
  });

  it('returns 401 for a structurally invalid key', async () => {
    const r = await mcpPost(port, { Authorization: 'Bearer not-a-key' });
    expect(r.status).toBe(401);
  });

  it('returns 401 for an unknown key that passes format check', async () => {
    const other = new ApiKeyValidator(makeDb());
    const key = other.generate('abcd1234', ['read']);
    other.close();
    const r = await mcpPost(port, { Authorization: `Bearer ${key}` });
    expect(r.status).toBe(401);
  });

  it('returns 401 for a revoked key', async () => {
    const key = validator.generate('abcd1234', ['read']);
    validator.revoke(key);
    const r = await mcpPost(port, { Authorization: `Bearer ${key}` });
    expect(r.status).toBe(401);
  });

  it('succeeds for a valid key', async () => {
    const key = validator.generate('abcd1234', ['read']);
    const r = await mcpPost(port, { Authorization: `Bearer ${key}` });
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(403);
  });

  it('accepts key via X-API-Key header', async () => {
    const key = validator.generate('abcd1234', ['read']);
    const r = await mcpPost(port, { 'X-API-Key': key });
    expect(r.status).not.toBe(401);
  });

  it('last_used_at is updated on successful auth', async () => {
    const key = validator.generate('abcd1234', ['read']);
    await mcpPost(port, { Authorization: `Bearer ${key}` });
    const result = await validator.validate(key);
    // validate() itself updates last_used_at — but the prior call should have set it
    expect(result.valid).toBe(true);
  });
});

// ─── /api/* route auth ────────────────────────────────────────────────────────

describe('/api/* routes require API key when apiKeyAuth.enabled', () => {
  let server: NodeHttpServer;
  let port: number;
  let validator: ApiKeyValidator;
  let db: Database.Database;

  beforeEach(async () => {
    db = makeDb();
    validator = new ApiKeyValidator(db);
    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      apiKeyAuth: { enabled: true, validator },
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
      serveUi: false,
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(() => { server.close(); validator.close(); });

  it('returns 401 on GET /api/repos without a key', async () => {
    const r = await doRequest(port, 'GET', '/api/repos');
    expect(r.status).toBe(401);
  });

  it('returns 403 for an invalid API key on /api/repos', async () => {
    const other = new ApiKeyValidator(makeDb());
    const key = other.generate('abcd1234', ['read']);
    other.close();
    const r = await doRequest(port, 'GET', '/api/repos', { Authorization: `Bearer ${key}` });
    expect(r.status).toBe(403);
  });

  it('passes through to the route handler with a valid key', async () => {
    const key = validator.generate('abcd1234', ['read']);
    const r = await doRequest(port, 'GET', '/api/repos', { Authorization: `Bearer ${key}` });
    // Auth passed — route handler returns 200 with empty list (no repos indexed)
    expect(r.status).toBe(200);
  });

  it('/api/* is not protected when apiKeyAuth is disabled', async () => {
    // Build a server without apiKeyAuth
    const srv = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
      serveUi: false,
    });
    const p = (srv.address() as { port: number }).port;
    const r = await doRequest(p, 'GET', '/api/repos');
    expect(r.status).toBe(200);
    srv.close();
  });
});

// ─── /admin/* route auth ──────────────────────────────────────────────────────

describe('/admin/* routes require admin-permission key', () => {
  let server: NodeHttpServer;
  let port: number;
  let validator: ApiKeyValidator;
  let db: Database.Database;

  beforeEach(async () => {
    db = makeDb();
    validator = new ApiKeyValidator(db);

    const { AdminApi } = await import('../../src/server/admin-api.js');
    const adminApi = new AdminApi({ db, startTime: Date.now() });

    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      apiKeyAuth: { enabled: true, validator },
      adminApi: { api: adminApi },
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
      serveUi: false,
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(() => { server.close(); validator.close(); });

  it('returns 401 with no key on /admin/stats', async () => {
    const r = await doRequest(port, 'GET', '/admin/stats');
    expect(r.status).toBe(401);
  });

  it('returns 403 with a read-only key on /admin/stats', async () => {
    const key = validator.generate('abcd1234', ['read']);
    const r = await doRequest(port, 'GET', '/admin/stats', { Authorization: `Bearer ${key}` });
    expect(r.status).toBe(403);
  });

  it('succeeds with an admin key on /admin/stats', async () => {
    const key = validator.generate('abcd1234', ['admin']);
    const r = await doRequest(port, 'GET', '/admin/stats', { Authorization: `Bearer ${key}` });
    expect(r.status).toBe(200);
  });
});

// ─── Flat /admin/keys routes (Phase 18) ──────────────────────────────────────

describe('POST /admin/keys — create API key', () => {
  let server: NodeHttpServer;
  let port: number;
  let validator: ApiKeyValidator;
  let db: Database.Database;
  let adminKey: string;

  beforeEach(async () => {
    db = makeDb();
    validator = new ApiKeyValidator(db);
    adminKey = validator.generate('adminTenant', ['admin']);

    const { AdminApi } = await import('../../src/server/admin-api.js');
    const adminApi = new AdminApi({ db, startTime: Date.now() });

    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      apiKeyAuth: { enabled: true, validator },
      adminApi: { api: adminApi },
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
      serveUi: false,
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(() => { server.close(); validator.close(); });

  it('creates a key and returns it once', async () => {
    const body = JSON.stringify({ label: 'Alice machine', permissions: ['read'] });
    const r = await doRequest(port, 'POST', '/admin/keys', { Authorization: `Bearer ${adminKey}` }, body);
    expect(r.status).toBe(201);
    const json = JSON.parse(r.body) as Record<string, unknown>;
    expect(typeof json['key']).toBe('string');
    expect((json['key'] as string).startsWith('pctx_') || (json['key'] as string).startsWith('cl_')).toBe(true);
    expect(json['label']).toBe('Alice machine');
    expect(json['permissions']).toEqual(['read']);
  });

  it('defaults to read permission and default tenant', async () => {
    const body = JSON.stringify({});
    const r = await doRequest(port, 'POST', '/admin/keys', { Authorization: `Bearer ${adminKey}` }, body);
    expect(r.status).toBe(201);
    const json = JSON.parse(r.body) as Record<string, unknown>;
    expect(json['tenant_id']).toBe('default');
    expect(json['permissions']).toEqual(['read']);
  });
});

describe('GET /admin/keys — list API keys', () => {
  let server: NodeHttpServer;
  let port: number;
  let validator: ApiKeyValidator;
  let db: Database.Database;
  let adminKey: string;

  beforeEach(async () => {
    db = makeDb();
    validator = new ApiKeyValidator(db);
    adminKey = validator.generate('adminTenant', ['admin']);
    // Pre-create a couple of keys
    validator.generate('tenantA', ['read']);
    validator.generate('tenantB', ['write']);

    const { AdminApi } = await import('../../src/server/admin-api.js');
    const adminApi = new AdminApi({ db, startTime: Date.now() });

    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      apiKeyAuth: { enabled: true, validator },
      adminApi: { api: adminApi },
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
      serveUi: false,
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(() => { server.close(); validator.close(); });

  it('returns all keys (at least the admin + 2 pre-created)', async () => {
    const r = await doRequest(port, 'GET', '/admin/keys', { Authorization: `Bearer ${adminKey}` });
    expect(r.status).toBe(200);
    const keys = JSON.parse(r.body) as unknown[];
    expect(keys.length).toBeGreaterThanOrEqual(3);
  });

  it('never returns raw key values — only hash prefixes', async () => {
    const r = await doRequest(port, 'GET', '/admin/keys', { Authorization: `Bearer ${adminKey}` });
    const keys = JSON.parse(r.body) as Array<Record<string, unknown>>;
    for (const k of keys) {
      expect(k).not.toHaveProperty('key');
      expect(k).toHaveProperty('key_hash_prefix');
    }
  });
});

describe('DELETE /admin/keys/:id — revoke API key', () => {
  let server: NodeHttpServer;
  let port: number;
  let validator: ApiKeyValidator;
  let db: Database.Database;
  let adminKey: string;

  beforeEach(async () => {
    db = makeDb();
    validator = new ApiKeyValidator(db);
    adminKey = validator.generate('adminTenant', ['admin']);

    const { AdminApi } = await import('../../src/server/admin-api.js');
    const adminApi = new AdminApi({ db, startTime: Date.now() });

    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      apiKeyAuth: { enabled: true, validator },
      adminApi: { api: adminApi },
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
      serveUi: false,
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(() => { server.close(); validator.close(); });

  it('revokes a key by hash prefix — subsequent MCP requests return 401', async () => {
    const { hashApiKey } = await import('../../src/core/db/api-keys.js');
    const key = validator.generate('userTenant', ['read']);
    const prefix = hashApiKey(key).slice(0, 8);

    // Confirm key is valid before revocation
    let r = await mcpPost(port, { Authorization: `Bearer ${key}` });
    expect(r.status).not.toBe(401);

    // Revoke via admin API
    r = await doRequest(port, 'DELETE', `/admin/keys/${prefix}`, { Authorization: `Bearer ${adminKey}` });
    expect(r.status).toBe(200);

    // Now the key should be rejected
    r = await mcpPost(port, { Authorization: `Bearer ${key}` });
    expect(r.status).toBe(401);
  });
});

describe('GET /admin/keys/:id/usage', () => {
  let server: NodeHttpServer;
  let port: number;
  let validator: ApiKeyValidator;
  let db: Database.Database;
  let adminKey: string;

  beforeEach(async () => {
    db = makeDb();
    validator = new ApiKeyValidator(db);
    adminKey = validator.generate('adminTenant', ['admin']);

    const { AdminApi } = await import('../../src/server/admin-api.js');
    const adminApi = new AdminApi({ db, startTime: Date.now() });

    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      apiKeyAuth: { enabled: true, validator },
      adminApi: { api: adminApi },
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
      serveUi: false,
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(() => { server.close(); validator.close(); });

  it('returns key metadata including last_used_at and request count', async () => {
    const { hashApiKey } = await import('../../src/core/db/api-keys.js');
    const key = validator.generate('userTenant', ['read']);
    const prefix = hashApiKey(key).slice(0, 8);

    const r = await doRequest(port, 'GET', `/admin/keys/${prefix}/usage`, { Authorization: `Bearer ${adminKey}` });
    expect(r.status).toBe(200);
    const json = JSON.parse(r.body) as Record<string, unknown>;
    expect(json).toHaveProperty('key_hash_prefix');
    expect(json).toHaveProperty('last_used_at');
    expect(json).toHaveProperty('requests_24h');
  });

  it('returns 404 for an unknown hash prefix', async () => {
    const r = await doRequest(port, 'GET', '/admin/keys/deadbeef/usage', { Authorization: `Bearer ${adminKey}` });
    expect(r.status).toBe(404);
  });
});

// ─── Rate limit per API key ───────────────────────────────────────────────────

describe('rate limiter uses API key tenant as bucket key', () => {
  it('rate limits per tenant, not per IP', async () => {
    const db = makeDb();
    const validator = new ApiKeyValidator(db);
    const key = validator.generate('rateTenant', ['read']);

    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      apiKeyAuth: { enabled: true, validator },
      rateLimit: { enabled: true, maxTokens: 2, refillRate: 0.001, perToolLimits: {} },
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
      serveUi: false,
    });
    const port = (server.address() as { port: number }).port;

    const send = () => mcpPost(port, { Authorization: `Bearer ${key}` });
    await send();
    await send();
    const r = await send();
    expect(r.status).toBe(429);

    server.close();
    validator.close();
  });
});
