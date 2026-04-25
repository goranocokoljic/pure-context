import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { request as httpRequest } from 'node:http';
import type { Server as NodeHttpServer } from 'node:http';
import { openInMemoryAuthDatabase } from '../../src/core/db/api-keys.js';
import {
  ApiKeyValidator,
  validateFormat,
  extractApiKeyFromHeaders,
  getRequiredPermission,
  hasPermission,
  LIVE_PREFIX,
  TEST_PREFIX,
} from '../../src/server/auth/api-key.js';
import { startHttpServer } from '../../src/server/http-server.js';
import type Database from 'better-sqlite3';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeValidator(): { validator: ApiKeyValidator; db: Database.Database } {
  const db = openInMemoryAuthDatabase();
  const validator = new ApiKeyValidator(db);
  return { validator, db };
}

// ─── Key generation ───────────────────────────────────────────────────────────

describe('ApiKeyValidator.generate', () => {
  it('returns a key with cl_live_ prefix by default', () => {
    const { validator } = makeValidator();
    const key = validator.generate('abcd1234', ['read']);
    expect(key.startsWith(LIVE_PREFIX)).toBe(true);
  });

  it('returns a key with cl_test_ prefix when isTest is true', () => {
    const { validator } = makeValidator();
    const key = validator.generate('abcd1234', ['read'], { isTest: true });
    expect(key.startsWith(TEST_PREFIX)).toBe(true);
  });

  it('produces a key that passes validateFormat', () => {
    const { validator } = makeValidator();
    const key = validator.generate('abcd1234', ['read']);
    expect(validateFormat(key)).toBe(true);
  });

  it('derives a valid 8-char hex tenant segment (hashes non-hex input)', () => {
    const { validator } = makeValidator();
    // 'acme' contains non-hex chars — must be hashed to produce valid hex
    const key = validator.generate('acme', ['read']);
    // key structure: cl_live_<8hex>_<24b62>_<4hex>
    // Split off prefix, then the first segment is the tenant hex
    const rest = key.slice(LIVE_PREFIX.length); // "<tid>_<random>_<checksum>"
    const firstUnderscore = rest.indexOf('_');
    const tid = rest.slice(0, firstUnderscore);
    expect(tid).toHaveLength(8);
    expect(/^[0-9a-f]+$/.test(tid)).toBe(true);
  });

  it('each generated key is unique', () => {
    const { validator } = makeValidator();
    const k1 = validator.generate('abcd1234', ['read']);
    const k2 = validator.generate('abcd1234', ['read']);
    expect(k1).not.toBe(k2);
  });

  it('stores the key so validate() finds it', async () => {
    const { validator } = makeValidator();
    const key = validator.generate('abcd1234', ['read', 'write']);
    const result = await validator.validate(key);
    expect(result.valid).toBe(true);
    expect(result.permissions).toContain('read');
    expect(result.permissions).toContain('write');
  });

  it('stores the correct rateLimitTier', async () => {
    const { validator } = makeValidator();
    const key = validator.generate('abcd1234', ['read'], { rateLimitTier: 'premium' });
    const result = await validator.validate(key);
    expect(result.rateLimitTier).toBe('premium');
  });
});

// ─── validateFormat ───────────────────────────────────────────────────────────

describe('validateFormat', () => {
  it('accepts a freshly-generated live key', () => {
    const { validator } = makeValidator();
    const key = validator.generate('abcd1234', ['read']);
    expect(validateFormat(key)).toBe(true);
  });

  it('accepts a freshly-generated test key', () => {
    const { validator } = makeValidator();
    const key = validator.generate('abcd1234', ['read'], { isTest: true });
    expect(validateFormat(key)).toBe(true);
  });

  it('rejects a key with the wrong prefix', () => {
    expect(validateFormat('cl_prod_abcd1234_ABCDEFGHIJKLMNOPQRSTUVWxy_ab12')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(validateFormat('')).toBe(false);
  });

  it('rejects a key with tenant segment that is too short', () => {
    // Manufacture a key with a 7-char tenant segment
    expect(validateFormat('cl_live_abc123_ABCDEFGHIJKLMNOPQRSTUVWxy_ab12')).toBe(false);
  });

  it('rejects a key with random segment that is too short', () => {
    expect(validateFormat('cl_live_abcd1234_ABCDEFGHIJKLMNOPQRSTUV_ab12')).toBe(false);
  });

  it('rejects a key with an invalid checksum', () => {
    const { validator } = makeValidator();
    const key = validator.generate('abcd1234', ['read']);
    // Replace checksum with 'xxxx'
    const tampered = key.slice(0, -4) + 'xxxx';
    expect(validateFormat(tampered)).toBe(false);
  });

  it('rejects a key whose checksum covers tampered content', () => {
    const { validator } = makeValidator();
    const key = validator.generate('abcd1234', ['read']);
    // Change one char in the random segment
    const parts = key.split('_');
    // parts: ['cl', 'live', '<tid>', '<random>', '<checksum>']
    // Reconstruct with a modified tenant ID
    const chars = [...parts[2]];
    chars[3] = chars[3] === 'a' ? 'b' : 'a';
    parts[2] = chars.join('');
    const tampered = parts.join('_');
    expect(validateFormat(tampered)).toBe(false);
  });
});

// ─── validate (DB round-trip) ─────────────────────────────────────────────────

describe('ApiKeyValidator.validate', () => {
  it('returns valid: true for a fresh key', async () => {
    const { validator } = makeValidator();
    const key = validator.generate('abcd1234', ['read']);
    const result = await validator.validate(key);
    expect(result.valid).toBe(true);
  });

  it('returns tenantId in the result (8-char hex)', async () => {
    const { validator } = makeValidator();
    // 'abcd1234' is valid 8-char hex — stored as-is
    const key = validator.generate('abcd1234', ['read']);
    const result = await validator.validate(key);
    expect(result.tenantId).toBe('abcd1234');
  });

  it('returns valid: false for an unknown key that passes format check', async () => {
    const { validator } = makeValidator();
    // Generate a key with one validator, validate with a different (empty) DB
    const key = validator.generate('abcd1234', ['read']);
    const { validator: other } = makeValidator();
    const result = await other.validate(key);
    expect(result.valid).toBe(false);
  });

  it('returns valid: false for a revoked key', async () => {
    const { validator } = makeValidator();
    const key = validator.generate('abcd1234', ['read']);
    validator.revoke(key);
    const result = await validator.validate(key);
    expect(result.valid).toBe(false);
  });

  it('returns valid: false for a structurally invalid key', async () => {
    const { validator } = makeValidator();
    const result = await validator.validate('not-a-key');
    expect(result.valid).toBe(false);
  });

  it('returns valid: false for a tampered key with bad checksum', async () => {
    const { validator } = makeValidator();
    const key = validator.generate('abcd1234', ['read']);
    const tampered = key.slice(0, -4) + '0000';
    const result = await validator.validate(tampered);
    expect(result.valid).toBe(false);
  });
});

// ─── revoke ───────────────────────────────────────────────────────────────────

describe('ApiKeyValidator.revoke', () => {
  it('revokes by full raw key', async () => {
    const { validator } = makeValidator();
    const key = validator.generate('abcd1234', ['read']);
    expect((await validator.validate(key)).valid).toBe(true);
    validator.revoke(key);
    expect((await validator.validate(key)).valid).toBe(false);
  });

  it('revokes by hash prefix', async () => {
    const { validator } = makeValidator();
    const key = validator.generate('abcd1234', ['read']);

    // Get the hash prefix from the database
    const { hashApiKey } = await import('../../src/core/db/api-keys.js');
    const hash = hashApiKey(key);
    const prefix = hash.slice(0, 8);

    validator.revoke(prefix);
    expect((await validator.validate(key)).valid).toBe(false);
  });

  it('revoking a non-existent key is a no-op', () => {
    const { validator } = makeValidator();
    expect(() => validator.revoke('cl_live_abcd1234_ABCDEFGHIJKLMNOPQRSTUVWxy_ab12')).not.toThrow();
  });
});

// ─── extractApiKeyFromHeaders ─────────────────────────────────────────────────

describe('extractApiKeyFromHeaders', () => {
  it('extracts from Authorization: Bearer cl_live_... header', () => {
    const key = 'cl_live_abcd1234_ABCDEFGHIJKLMNOPQRSTUVWxy_1234';
    const headers = { authorization: `Bearer ${key}` };
    expect(extractApiKeyFromHeaders(headers)).toBe(key);
  });

  it('extracts from X-API-Key header', () => {
    const key = 'cl_live_abcd1234_ABCDEFGHIJKLMNOPQRSTUVWxy_1234';
    const headers = { 'x-api-key': key };
    expect(extractApiKeyFromHeaders(headers)).toBe(key);
  });

  it('prefers Authorization over X-API-Key', () => {
    const authKey = 'cl_live_abcd1234_ABCDEFGHIJKLMNOPQRSTUVWxy_1234';
    const xKey = 'cl_test_abcd1234_ABCDEFGHIJKLMNOPQRSTUVWxy_5678';
    const headers = { authorization: `Bearer ${authKey}`, 'x-api-key': xKey };
    expect(extractApiKeyFromHeaders(headers)).toBe(authKey);
  });

  it('ignores Authorization: Bearer when value is not an API key format', () => {
    // Falls through to X-API-Key
    const xKey = 'cl_live_abcd1234_ABCDEFGHIJKLMNOPQRSTUVWxy_1234';
    const headers = { authorization: 'Bearer some-other-token', 'x-api-key': xKey };
    expect(extractApiKeyFromHeaders(headers)).toBe(xKey);
  });

  it('returns null when no API key is present', () => {
    expect(extractApiKeyFromHeaders({})).toBeNull();
    expect(extractApiKeyFromHeaders({ authorization: 'Bearer some-static-token' })).toBeNull();
  });

  it('handles array header values', () => {
    const key = 'cl_live_abcd1234_ABCDEFGHIJKLMNOPQRSTUVWxy_1234';
    expect(extractApiKeyFromHeaders({ 'x-api-key': [key, 'extra'] })).toBe(key);
  });
});

// ─── Permission helpers ───────────────────────────────────────────────────────

describe('getRequiredPermission', () => {
  it('returns write for index_folder', () => {
    expect(getRequiredPermission('index_folder')).toBe('write');
  });

  it('returns write for index_repo', () => {
    expect(getRequiredPermission('index_repo')).toBe('write');
  });

  it('returns read for search_symbols', () => {
    expect(getRequiredPermission('search_symbols')).toBe('read');
  });

  it('returns read for get_symbol_source', () => {
    expect(getRequiredPermission('get_symbol_source')).toBe('read');
  });

  it('returns read for unknown tools', () => {
    expect(getRequiredPermission('unknown_tool')).toBe('read');
  });
});

describe('hasPermission', () => {
  it('read permission satisfies read requirement', () => {
    const auth = { valid: true, permissions: ['read'] as const };
    expect(hasPermission(auth, 'read')).toBe(true);
  });

  it('read permission does NOT satisfy write requirement', () => {
    const auth = { valid: true, permissions: ['read'] as const };
    expect(hasPermission(auth, 'write')).toBe(false);
  });

  it('write permission satisfies both read and write requirements', () => {
    const auth = { valid: true, permissions: ['write'] as const };
    expect(hasPermission(auth, 'read')).toBe(true);
    expect(hasPermission(auth, 'write')).toBe(true);
  });

  it('admin permission satisfies all requirements', () => {
    const auth = { valid: true, permissions: ['admin'] as const };
    expect(hasPermission(auth, 'read')).toBe(true);
    expect(hasPermission(auth, 'write')).toBe(true);
    expect(hasPermission(auth, 'admin')).toBe(true);
  });

  it('returns false for invalid auth result', () => {
    expect(hasPermission({ valid: false }, 'read')).toBe(false);
  });

  it('returns false when permissions array is missing', () => {
    expect(hasPermission({ valid: true }, 'read')).toBe(false);
  });
});

// ─── HTTP integration ─────────────────────────────────────────────────────────

describe('HTTP API key auth integration', () => {
  let server: NodeHttpServer;
  let port: number;
  let validator: ApiKeyValidator;

  beforeEach(async () => {
    const db = openInMemoryAuthDatabase();
    validator = new ApiKeyValidator(db);

    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      apiKeyAuth: { enabled: true, validator },
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(() => {
    server.close();
    validator.close();
  });

  function sendMcpRequest(headers: Record<string, string> = {}) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const bodyStr = JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
        id: 1,
      });
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/mcp',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr).toString(),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
          });
        },
      );
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    });
  }

  it('returns 401 when no API key is provided', async () => {
    const r = await sendMcpRequest();
    expect(r.status).toBe(401);
  });

  it('returns 401 for a well-formed but unknown API key', async () => {
    // Generate in a different (empty) validator
    const { validator: other } = makeValidator();
    const key = other.generate('abcd1234', ['read']);
    const r = await sendMcpRequest({ Authorization: `Bearer ${key}` });
    expect(r.status).toBe(401);
  });

  it('returns 401 for a structurally invalid API key', async () => {
    const r = await sendMcpRequest({ Authorization: 'Bearer cl_live_bad_format' });
    expect(r.status).toBe(401);
  });

  it('returns 401 for a revoked API key', async () => {
    const key = validator.generate('abcd1234', ['read']);
    validator.revoke(key);
    const r = await sendMcpRequest({ Authorization: `Bearer ${key}` });
    expect(r.status).toBe(401);
  });

  it('succeeds (non-401/403) for a valid read key calling tools/list', async () => {
    const key = validator.generate('abcd1234', ['read']);
    const r = await sendMcpRequest({ Authorization: `Bearer ${key}` });
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(403);
  });

  it('accepts key via X-API-Key header', async () => {
    const key = validator.generate('abcd1234', ['read']);
    const r = await sendMcpRequest({ 'X-API-Key': key });
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(403);
  });

  it('returns 403 when a read-only key calls an index (write) tool', async () => {
    const key = validator.generate('abcd1234', ['read']);

    const bodyStr = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'index_folder', arguments: { path: '/tmp/test' } },
      id: 1,
    });

    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/mcp',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr).toString(),
            Authorization: `Bearer ${key}`,
          },
        },
        (r) => { r.resume(); resolve({ status: r.statusCode ?? 0 }); },
      );
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    });

    expect(res.status).toBe(403);
  });

  it('allows a write key to call index_folder', async () => {
    const key = validator.generate('abcd1234', ['read', 'write']);

    const bodyStr = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'index_folder', arguments: { path: '/tmp/test' } },
      id: 1,
    });

    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/mcp',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr).toString(),
            Authorization: `Bearer ${key}`,
          },
        },
        (r) => { r.resume(); resolve({ status: r.statusCode ?? 0 }); },
      );
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    });

    // Should not get 401 or 403 (MCP may return 200 or even an error for a bad path, but auth passed)
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ─── Rate limit key uses tenant ID ────────────────────────────────────────────

describe('rate limiting with API key auth', () => {
  it('uses tenant ID as rate limit key (not IP) when authenticated', async () => {
    const db = openInMemoryAuthDatabase();
    const validator = new ApiKeyValidator(db);
    const key = validator.generate('abcd1234', ['read', 'write']);

    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      apiKeyAuth: { enabled: true, validator },
      rateLimit: {
        enabled: true,
        maxTokens: 2,
        refillRate: 0.01,
        perToolLimits: {},
      },
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
    });
    const port = (server.address() as { port: number }).port;

    const send = () =>
      new Promise<number>((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 });
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/mcp',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body).toString(),
              Authorization: `Bearer ${key}`,
            },
          },
          (res) => { res.resume(); resolve(res.statusCode ?? 0); },
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });

    // Drain the bucket
    await send();
    await send();
    const r = await send();
    // Third request should be rate limited
    expect(r).toBe(429);

    server.close();
    validator.close();
  });
});
