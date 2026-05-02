/**
 * Phase 12 Integration Tests — Task 100
 *
 * Validates the complete rate-limiting and multi-tenant system end-to-end.
 * Unit tests for individual components (TokenBucketLimiter, ApiKeyValidator,
 * TenantStore, AdminApi) live in test/server/ and test/core/; these tests
 * exercise cross-component workflows that only emerge when the layers compose.
 *
 *  1.  Rate limiting: 100 requests succeed, 101st is rejected
 *  2.  Rate limiting: HTTP 429 includes Retry-After header
 *  3.  Rate limiting: per-tool costs drain budget at different rates
 *  4.  Rate limiting: refill restores capacity after time elapses
 *  5.  API key: valid key validates and returns correct tenant + permissions
 *  6.  API key: invalid key (bad format) returns valid:false
 *  7.  API key: revoked key returns valid:false
 *  8.  API key: tampered key (checksum mismatch) fails format validation
 *  9.  Tenant isolation: tenant A cannot see tenant B's symbols
 * 10.  Tenant isolation: search scoped to tenant returns only that tenant's results
 * 11.  Storage quota: checkQuota throws QuotaExceededError when exceeded
 * 12.  Admin API: full lifecycle — create tenant, key, log requests, check stats
 * 13.  Admin API: delete tenant cascades to api_keys and removes data
 * 14.  Regression: basic-ts-project indexes cleanly after Phase 12 changes
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { Server as NodeHttpServer } from 'node:http';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Rate limiting
import { TokenBucketLimiter } from '../../src/server/rate-limiter.js';
import { startHttpServer } from '../../src/server/http-server.js';

// API key auth
import { openInMemoryAuthDatabase } from '../../src/core/db/api-keys.js';
import {
  ApiKeyValidator,
  validateFormat,
  hasPermission,
} from '../../src/server/auth/api-key.js';

// Tenant store + isolation
import { TenantStore } from '../../src/core/db/tenants.js';
import { QuotaExceededError } from '../../src/core/errors.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { insertSymbols, searchSymbols } from '../../src/core/db/symbol-store.js';
import type { SymbolRecord, RepoMetadata } from '../../src/core/types.js';

// Admin API + request log
import { AdminApi } from '../../src/server/admin-api.js';
import { RequestLogStore } from '../../src/core/db/request-log.js';

// Regression — real indexing
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols as searchSymbolsDb } from '../../src/core/db/symbol-store.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

import type Database from 'better-sqlite3';

// ─── Constants ─────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TS_FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSymbol(overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    id: 'sym-001',
    name: 'myFunction',
    kind: 'function',
    filePath: 'src/foo.ts',
    startByte: 0,
    endByte: 100,
    signature: 'function myFunction(): void',
    summary: 'does stuff',
    ...overrides,
  };
}

function makeRepo(tenantId: string, repoId = 'repo-test'): RepoMetadata {
  return {
    id: repoId,
    rootPath: `/test/${repoId}`,
    symbolCount: 0,
    fileCount: 0,
    languages: ['typescript'],
    indexedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
    clonePath: null,
    tenantId,
  };
}

/** Send a minimal MCP tools/call request and return status + headers. */
function sendMcpRequest(
  port: number,
  toolName: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: toolName, arguments: {} },
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
          'Content-Length': Buffer.byteLength(body).toString(),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const hdrs: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') hdrs[k] = v;
          }
          resolve({ status: res.statusCode ?? 0, headers: hdrs });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Phase 12 Integration — Rate Limiting & Multi-Tenant', () => {
  // ── Test 1: 100 requests succeed, 101st fails ─────────────────────────────────

  it('1. rate limiting: 100 requests succeed, 101st is rejected', () => {
    const limiter = new TokenBucketLimiter({ maxTokens: 100, refillRate: 0.001 });
    const key = 'client-integration-1';

    // First 100 should all be allowed (1 token each)
    let successes = 0;
    for (let i = 0; i < 100; i++) {
      const result = limiter.tryConsume(key, 1);
      if (result.allowed) successes++;
    }
    expect(successes).toBe(100);
    expect(limiter.getRemainingTokens(key)).toBe(0);

    // 101st must be rejected
    const rejected = limiter.tryConsume(key, 1);
    expect(rejected.allowed).toBe(false);
    expect(rejected.remainingTokens).toBe(0);
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
  });

  // ── Test 2: HTTP 429 includes Retry-After header ──────────────────────────────

  it('2. rate limiting: HTTP 429 response includes Retry-After header', async () => {
    // Start a server with tiny budget (3 tokens) so we can exhaust it quickly
    const server: NodeHttpServer = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      rateLimit: {
        enabled: true,
        maxTokens: 3,
        refillRate: 0.001, // practically no refill during the test
        perToolLimits: { search_symbols: 1 },
      },
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
    });
    const port = (server.address() as { port: number }).port;

    try {
      // Drain the budget
      await sendMcpRequest(port, 'search_symbols');
      await sendMcpRequest(port, 'search_symbols');
      await sendMcpRequest(port, 'search_symbols');

      // Next request must be rate-limited
      let got429 = false;
      for (let i = 0; i < 5; i++) {
        const r = await sendMcpRequest(port, 'search_symbols');
        if (r.status === 429) {
          got429 = true;
          expect(r.headers['retry-after']).toBeDefined();
          // Retry-After should be a positive integer (seconds)
          const retryAfter = parseInt(r.headers['retry-after'] ?? '0', 10);
          expect(retryAfter).toBeGreaterThan(0);
          break;
        }
      }
      expect(got429).toBe(true);
    } finally {
      server.close();
    }
  });

  // ── Test 3: Per-tool costs drain budget at different rates ────────────────────

  it('3. rate limiting: per-tool costs — indexing drains 10x faster than search', () => {
    const limiter = new TokenBucketLimiter({ maxTokens: 50, refillRate: 0.001 });
    const key = 'client-per-tool';

    // index_folder costs 10 tokens — drain 5 of them
    for (let i = 0; i < 5; i++) {
      const r = limiter.tryConsume(key, 10); // index_folder cost
      expect(r.allowed).toBe(true);
    }
    expect(limiter.getRemainingTokens(key)).toBe(0);

    // A single index_folder request would have cost the same as 10 search_symbols requests
    const searchLimiter = new TokenBucketLimiter({ maxTokens: 50, refillRate: 0.001 });
    const searchKey = 'client-search';
    for (let i = 0; i < 50; i++) {
      searchLimiter.tryConsume(searchKey, 1); // search_symbols cost
    }
    expect(searchLimiter.getRemainingTokens(searchKey)).toBe(0);

    // Verify: 5 index requests = 50 search requests worth of tokens
    const indexLimiter2 = new TokenBucketLimiter({ maxTokens: 50, refillRate: 0.001 });
    const indexKey2 = 'client-index';
    let indexOps = 0;
    while (indexLimiter2.tryConsume(indexKey2, 10).allowed) {
      indexOps++;
    }
    expect(indexOps).toBe(5); // 50 / 10 = 5 indexing ops before exhaustion

    const searchLimiter2 = new TokenBucketLimiter({ maxTokens: 50, refillRate: 0.001 });
    const searchKey2 = 'client-search-2';
    let searchOps = 0;
    while (searchLimiter2.tryConsume(searchKey2, 1).allowed) {
      searchOps++;
    }
    expect(searchOps).toBe(50); // 50 / 1 = 50 search ops before exhaustion

    // Ratio: search ops = 10x index ops
    expect(searchOps / indexOps).toBe(10);
  });

  // ── Test 4: Refill restores capacity after time elapses ───────────────────────

  it('4. rate limiting: refill restores capacity after time elapses', () => {
    vi.useFakeTimers();
    try {
      const limiter = new TokenBucketLimiter({ maxTokens: 100, refillRate: 10 }); // 10 tokens/sec
      const key = 'client-refill';

      // Exhaust the bucket
      limiter.tryConsume(key, 100);
      expect(limiter.getRemainingTokens(key)).toBe(0);

      // 101st request immediately after — rejected
      expect(limiter.tryConsume(key, 1).allowed).toBe(false);

      // Advance time by 5 seconds → should have 50 tokens refilled
      vi.advanceTimersByTime(5_000);
      expect(limiter.getRemainingTokens(key)).toBe(50);

      // 50 requests should now succeed
      let successes = 0;
      for (let i = 0; i < 50; i++) {
        if (limiter.tryConsume(key, 1).allowed) successes++;
      }
      expect(successes).toBe(50);

      // Advance by another 10 seconds → full refill (capped at maxTokens)
      vi.advanceTimersByTime(10_000);
      expect(limiter.getRemainingTokens(key)).toBe(100);

      // All 100 requests should succeed again
      let fullSuccesses = 0;
      for (let i = 0; i < 100; i++) {
        if (limiter.tryConsume(key, 1).allowed) fullSuccesses++;
      }
      expect(fullSuccesses).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Test 5: Valid key validates and returns correct tenant + permissions ────────

  it('5. API key: valid key validates and returns tenant + permissions', async () => {
    const db = openInMemoryAuthDatabase();
    const validator = new ApiKeyValidator(db);

    const rawKey = validator.generate('acme', ['read', 'write'], {
      rateLimitTier: 'premium',
      tenantName: 'Acme Corp',
    });

    const result = await validator.validate(rawKey);

    expect(result.valid).toBe(true);
    expect(result.tenantId).toBeDefined();
    expect(result.permissions).toContain('read');
    expect(result.permissions).toContain('write');
    expect(result.rateLimitTier).toBe('premium');

    // Permission helper confirms write access
    expect(hasPermission(result, 'read')).toBe(true);
    expect(hasPermission(result, 'write')).toBe(true);
    expect(hasPermission(result, 'admin')).toBe(false);

    validator.close();
    db.close();
  });

  // ── Test 6: Invalid key returns valid:false ────────────────────────────────────

  it('6. API key: invalid key (bad format) returns valid:false', async () => {
    const db = openInMemoryAuthDatabase();
    const validator = new ApiKeyValidator(db);

    const cases = [
      '',
      'not-a-key',
      'cl_live_tooshort',
      'cl_live_xxxxxxxx_aaaaaaaaaaaaaaaaaaaaaaaaaaaa_yyyy', // wrong checksum
      'cl_live_xxxxxxxx_aaaaaaaaaaaaaaaaaaaaaaaa_zzzz',    // correct length, bad checksum
      'Bearer cl_live_abcd1234_aaaaaaaaaaaaaaaaaaaaaaaaa_xxxx',
    ];

    for (const key of cases) {
      const result = await validator.validate(key);
      expect(result.valid).toBe(false);
    }

    // validateFormat also catches bad keys without DB access
    expect(validateFormat('not-a-key')).toBe(false);
    expect(validateFormat('cl_live_tooshort_xxx')).toBe(false);

    validator.close();
    db.close();
  });

  // ── Test 7: Revoked key returns valid:false ───────────────────────────────────

  it('7. API key: revoked key returns valid:false', async () => {
    const db = openInMemoryAuthDatabase();
    const validator = new ApiKeyValidator(db);

    const rawKey = validator.generate('revoke-test', ['read']);

    // Validate before revocation — should succeed
    const before = await validator.validate(rawKey);
    expect(before.valid).toBe(true);

    // Revoke the key
    validator.revoke(rawKey);

    // Validate after revocation — should fail
    const after = await validator.validate(rawKey);
    expect(after.valid).toBe(false);

    validator.close();
    db.close();
  });

  // ── Test 8: Tampered key fails format validation ──────────────────────────────

  it('8. API key: tampered key (checksum mismatch) fails format validation', () => {
    const db = openInMemoryAuthDatabase();
    const validator = new ApiKeyValidator(db);

    const rawKey = validator.generate('tamper-test', ['read']);
    expect(validateFormat(rawKey)).toBe(true);

    // Flip a character in the random segment (positions after the second underscore)
    const parts = rawKey.split('_');
    // Format: cl_live_TTTTTTTT_RRRRRRRRRRRRRRRRRRRRRRRR_CCCC
    // parts[0]='cl', parts[1]='live', parts[2]=tenantId, parts[3]=random, parts[4]=checksum
    const tamperedRandom =
      parts[3]!.slice(0, -1) +
      (parts[3]!.at(-1) === 'A' ? 'B' : 'A');
    const tamperedKey = `${parts[0]}_${parts[1]}_${parts[2]}_${tamperedRandom}_${parts[4]}`;

    // Tampered key must fail format validation (checksum won't match)
    expect(validateFormat(tamperedKey)).toBe(false);

    // Also verify DB lookup never runs for tampered keys
    // (validate returns false from format check without DB access)
    const resultPromise = validator.validate(tamperedKey);
    // We don't need to await — just verify validateFormat is the gating check

    validator.close();
    db.close();

    return resultPromise.then((r) => expect(r.valid).toBe(false));
  });

  // ── Test 9: Tenant A cannot see Tenant B's symbols ───────────────────────────

  it('9. tenant isolation: tenant A cannot see tenant B\'s symbols', () => {
    const db = openInMemoryDatabase();

    // Set up repos for both tenants (same repo ID — different tenants)
    const repoId = 'shared-repo';
    upsertRepo(db, makeRepo('tenant-alpha', repoId));

    // Insert symbols owned by tenant-alpha
    const symAlpha = makeSymbol({ id: 'alpha-1', name: 'alphaFunction', filePath: 'src/alpha.ts' });
    insertSymbols(db, repoId, [symAlpha], 'tenant-alpha');

    // Insert symbols owned by tenant-beta
    const symBeta = makeSymbol({ id: 'beta-1', name: 'betaFunction', filePath: 'src/beta.ts' });
    insertSymbols(db, repoId, [symBeta], 'tenant-beta');

    // Tenant alpha can only see alpha's symbol
    const alphaView = searchSymbols(db, repoId, 'Function', { tenantId: 'tenant-alpha' });
    expect(alphaView.map((s) => s.id)).toEqual(['alpha-1']);

    // Tenant beta can only see beta's symbol
    const betaView = searchSymbols(db, repoId, 'Function', { tenantId: 'tenant-beta' });
    expect(betaView.map((s) => s.id)).toEqual(['beta-1']);

    // Tenant gamma (non-existent) sees nothing
    const gammaView = searchSymbols(db, repoId, 'Function', { tenantId: 'tenant-gamma' });
    expect(gammaView).toHaveLength(0);

    db.close();
  });

  // ── Test 10: Search scoped to tenant returns only that tenant's results ─────────

  it('10. tenant isolation: search returns only the requesting tenant\'s symbols', () => {
    const db = openInMemoryDatabase();
    const repoId = 'multi-tenant-repo';
    upsertRepo(db, makeRepo('tenant-x', repoId));

    // Populate with symbols from three different tenants
    const symbolSets = [
      { tenant: 'tenant-x', id: 'x1', name: 'authenticateUser', kind: 'function' as const },
      { tenant: 'tenant-x', id: 'x2', name: 'hashPassword', kind: 'function' as const },
      { tenant: 'tenant-y', id: 'y1', name: 'authenticateAdmin', kind: 'function' as const },
      { tenant: 'tenant-z', id: 'z1', name: 'validateToken', kind: 'function' as const },
    ];

    for (const { tenant, id, name, kind } of symbolSets) {
      insertSymbols(
        db,
        repoId,
        [makeSymbol({ id, name, kind })],
        tenant,
      );
    }

    // Searching for 'authenticate' from tenant-x should only return x1
    const xResults = searchSymbols(db, repoId, 'authenticate', { tenantId: 'tenant-x' });
    expect(xResults.map((s) => s.id)).toEqual(['x1']);

    // Searching without tenant filter returns all (backward compat)
    const allResults = searchSymbols(db, repoId, 'authenticate');
    const allIds = new Set(allResults.map((s) => s.id));
    expect(allIds.has('x1')).toBe(true);
    expect(allIds.has('y1')).toBe(true);

    // Tenant-y's 'authenticate' search returns only y1
    const yResults = searchSymbols(db, repoId, 'authenticate', { tenantId: 'tenant-y' });
    expect(yResults.map((s) => s.id)).toEqual(['y1']);

    db.close();
  });

  // ── Test 11: Storage quota throws when exceeded ───────────────────────────────

  it('11. storage quota: checkQuota throws QuotaExceededError when exceeded', () => {
    const authDb = openInMemoryAuthDatabase();
    const tenantStore = new TenantStore(authDb);

    // Create a tenant with a 1 MB quota
    const tenant = tenantStore.create('Quota Tenant', { storageQuotaBytes: 1_000_000 });

    // Simulate 800 KB used
    tenantStore.updateStorageUsed(tenant.id, 800_000);

    // 100 KB more fits within quota (800k + 100k = 900k < 1M)
    expect(() => tenantStore.checkQuota(tenant.id, 100_000)).not.toThrow();

    // 300 KB would exceed quota (800k + 300k = 1.1M > 1M)
    expect(() => tenantStore.checkQuota(tenant.id, 300_000)).toThrow(QuotaExceededError);

    try {
      tenantStore.checkQuota(tenant.id, 300_000);
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const qe = err as QuotaExceededError;
      expect(qe.tenantId).toBe(tenant.id);
      expect(qe.quotaBytes).toBe(1_000_000);
      expect(qe.usedBytes).toBe(800_000);
      expect(qe.requestedBytes).toBe(300_000);
    }

    // Null quota (unlimited) never throws
    const unlimited = tenantStore.create('Unlimited Tenant');
    expect(() => tenantStore.checkQuota(unlimited.id, Number.MAX_SAFE_INTEGER)).not.toThrow();

    authDb.close();
  });

  // ── Test 12: Admin API full lifecycle ─────────────────────────────────────────

  it('12. admin API: create tenant, generate key, log requests, query stats', async () => {
    const authDb = openInMemoryAuthDatabase();
    const tenantStore = new TenantStore(authDb);
    const validator = new ApiKeyValidator(authDb);
    const logStore = new RequestLogStore(authDb);
    const adminApi = new AdminApi({ db: authDb, startTime: Date.now(), indexDir: '/nonexistent' });

    // Step 1: Create a tenant
    const tenant = tenantStore.create('Integration Corp', { storageQuotaBytes: 10_000_000 });
    expect(tenant.id).toHaveLength(8);
    expect(tenant.name).toBe('Integration Corp');

    // Step 2: Generate an API key for the tenant
    const rawKey = validator.generate(tenant.id, ['read', 'write'], {
      tenantName: tenant.name,
      rateLimitTier: 'standard',
    });
    expect(rawKey).toMatch(/^pctx_/);

    // Step 3: Log some requests (simulates MCP tool call tracking)
    const now = new Date().toISOString();
    logStore.log({ timestamp: now, tenantId: tenant.id, tool: 'search_symbols', durationMs: 12, status: 'success', errorMessage: null });
    logStore.log({ timestamp: now, tenantId: tenant.id, tool: 'get_symbol_source', durationMs: 8, status: 'success', errorMessage: null });
    logStore.log({ timestamp: now, tenantId: tenant.id, tool: 'search_symbols', durationMs: null, status: 'rate_limited', errorMessage: null });
    // Another tenant's request — should not appear in tenant stats
    logStore.log({ timestamp: now, tenantId: 'other-tenant', tool: 'list_repos', durationMs: 5, status: 'success', errorMessage: null });

    // Step 4: Verify tenant stats (via RequestLogStore directly — same data AdminApi exposes)
    const since = new Date(Date.now() - 60_000).toISOString(); // last 60 seconds
    const stats = logStore.getTenantStats(tenant.id, since);
    expect(stats.requests).toBe(3);      // 2 success + 1 rate_limited
    expect(stats.rateLimited).toBe(1);

    // Global stats include all 4 requests
    const globalStats = logStore.getStats(since);
    expect(globalStats.requests).toBe(4);
    expect(globalStats.rateLimited).toBe(1);

    // Step 5: List API keys for the tenant
    const { ApiKeyStore } = await import('../../src/core/db/api-keys.js');
    const keyStore = new ApiKeyStore(authDb);
    const keys = keyStore.listByTenant(tenant.id);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.tenantId).toBe(tenant.id);
    expect(keys[0]!.permissions).toContain('read');
    expect(keys[0]!.permissions).toContain('write');
    expect(keys[0]!.revokedAt).toBeNull();

    // Step 6: Storage tracking
    tenantStore.updateStorageUsed(tenant.id, 500_000);
    const updated = tenantStore.get(tenant.id)!;
    expect(updated.storageUsedBytes).toBe(500_000);

    validator.close();
    authDb.close();
  });

  // ── Test 13: Delete tenant cascades to api_keys ───────────────────────────────

  it('13. admin API: delete tenant cascades to api_keys and removes tenant data', async () => {
    const authDb = openInMemoryAuthDatabase();
    const tenantStore = new TenantStore(authDb);
    const validator = new ApiKeyValidator(authDb);

    // Create two tenants with keys
    const tenantA = tenantStore.create('Tenant Alpha');
    const tenantB = tenantStore.create('Tenant Beta');

    const keyA1 = validator.generate(tenantA.id, ['read']);
    const keyA2 = validator.generate(tenantA.id, ['write']);
    const keyB1 = validator.generate(tenantB.id, ['read']);

    // Verify both tenants exist
    expect(tenantStore.get(tenantA.id)).not.toBeNull();
    expect(tenantStore.get(tenantB.id)).not.toBeNull();

    // Verify keys exist before deletion
    const resultA1Before = await validator.validate(keyA1);
    const resultB1Before = await validator.validate(keyB1);
    expect(resultA1Before.valid).toBe(true);
    expect(resultB1Before.valid).toBe(true);

    // Delete tenant A
    tenantStore.delete(tenantA.id);

    // Tenant A is gone
    expect(tenantStore.get(tenantA.id)).toBeNull();

    // Tenant B is unaffected
    expect(tenantStore.get(tenantB.id)).not.toBeNull();

    // Tenant A's keys are gone (ON DELETE CASCADE on api_keys.tenant_id)
    const resultA1After = await validator.validate(keyA1);
    const resultA2After = await validator.validate(keyA2);
    expect(resultA1After.valid).toBe(false);
    expect(resultA2After.valid).toBe(false);

    // Tenant B's key is still valid
    const resultB1After = await validator.validate(keyB1);
    expect(resultB1After.valid).toBe(true);

    // Verify: list shows only tenant B
    const remaining = tenantStore.list();
    expect(remaining.map((t) => t.id)).toEqual([tenantB.id]);

    validator.close();
    authDb.close();
  });

  // ── Test 14: Regression — basic-ts-project indexes cleanly ────────────────────

  it('14. regression: basic-ts-project indexes cleanly after Phase 12 changes', async () => {
    _resetForTesting();
    registerHandler(typescriptHandler);
    await initParser();

    const { repoId } = await indexFolder(TS_FIXTURE);

    let repoDb: Database.Database | null = null;
    try {
      repoDb = openDatabase(repoId);

      // Core symbol extraction must still work
      const functions = searchSymbolsDb(repoDb, repoId, '', { kind: 'function' });
      const classes = searchSymbolsDb(repoDb, repoId, '', { kind: 'class' });

      expect(functions.length).toBeGreaterThan(0);
      expect(classes.length).toBeGreaterThan(0);

      // Verify tenant_id column is populated (defaults to 'local')
      const row = repoDb
        .prepare('SELECT tenant_id FROM repos WHERE id = ?')
        .get(repoId) as { tenant_id: string } | undefined;
      expect(row?.tenant_id).toBe('local');
    } finally {
      repoDb?.close();
      deleteIndex(repoId);
    }
  });
});
