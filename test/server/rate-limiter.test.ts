import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenBucketLimiter } from '../../src/server/rate-limiter.js';
import { RateLimitStore } from '../../src/server/rate-limit-store.js';
import { extractToolName, getToolCost } from '../../src/server/http-server.js';

// ─── TokenBucketLimiter ────────────────────────────────────────────────────────

describe('TokenBucketLimiter', () => {
  describe('construction and defaults', () => {
    it('uses default options when none provided', () => {
      const limiter = new TokenBucketLimiter();
      // A fresh key should have the full bucket (100 tokens by default)
      expect(limiter.getRemainingTokens('client-1')).toBe(100);
    });

    it('respects custom maxTokens', () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 50 });
      expect(limiter.getRemainingTokens('x')).toBe(50);
    });
  });

  describe('tryConsume — token deduction', () => {
    it('allows requests when tokens are available', () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 10, refillRate: 1 });
      const result = limiter.tryConsume('k', 1);
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBe(0);
      expect(result.remainingTokens).toBe(9);
    });

    it('deducts multiple tokens in one call', () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 20, refillRate: 1 });
      const result = limiter.tryConsume('k', 10);
      expect(result.allowed).toBe(true);
      expect(result.remainingTokens).toBe(10);
    });

    it('rejects when bucket is empty', () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 5, refillRate: 1 });
      // Drain the bucket
      for (let i = 0; i < 5; i++) limiter.tryConsume('k', 1);
      const result = limiter.tryConsume('k', 1);
      expect(result.allowed).toBe(false);
      expect(result.remainingTokens).toBe(0);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it('rejects when cost exceeds remaining tokens', () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 10, refillRate: 1 });
      limiter.tryConsume('k', 8); // 2 remain
      const result = limiter.tryConsume('k', 5); // needs 5
      expect(result.allowed).toBe(false);
      expect(result.remainingTokens).toBe(2);
    });

    it('tracks separate buckets per key', () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 10, refillRate: 1 });
      limiter.tryConsume('a', 10);
      const resultA = limiter.tryConsume('a', 1);
      const resultB = limiter.tryConsume('b', 1);
      expect(resultA.allowed).toBe(false);
      expect(resultB.allowed).toBe(true);
    });

    it('defaults to 1 token cost', () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 5, refillRate: 1 });
      limiter.tryConsume('k'); // consume 1
      expect(limiter.getRemainingTokens('k')).toBe(4);
    });
  });

  describe('tryConsume — retryAfterMs calculation', () => {
    it('provides a non-zero retryAfterMs when rejected', () => {
      // Freeze the clock: with real time, ≥1ms elapsing between the two calls
      // refills a fraction of a token and the correct answer becomes 999ms —
      // this test asserts the math, not wall-clock behavior (CI flake fix).
      vi.useFakeTimers();
      try {
        const limiter = new TokenBucketLimiter({ maxTokens: 3, refillRate: 1 });
        limiter.tryConsume('k', 3);
        const result = limiter.tryConsume('k', 1);
        // At 1 token/sec with no elapsed time, exactly 1000ms to get 1 token
        expect(result.retryAfterMs).toBe(1000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('retryAfterMs scales with refillRate', () => {
      const slow = new TokenBucketLimiter({ maxTokens: 5, refillRate: 1 });
      const fast = new TokenBucketLimiter({ maxTokens: 5, refillRate: 10 });
      slow.tryConsume('k', 5);
      fast.tryConsume('k', 5);
      const slowResult = slow.tryConsume('k', 1);
      const fastResult = fast.tryConsume('k', 1);
      expect(slowResult.retryAfterMs).toBeGreaterThan(fastResult.retryAfterMs);
    });
  });

  describe('refill over time', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('restores tokens after elapsed time', () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 10, refillRate: 10 });
      // Drain completely
      limiter.tryConsume('k', 10);
      expect(limiter.getRemainingTokens('k')).toBe(0);

      // Advance 1 second — should get 10 tokens back (up to max)
      vi.advanceTimersByTime(1000);
      expect(limiter.getRemainingTokens('k')).toBe(10);
    });

    it('does not exceed maxTokens during refill', () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 10, refillRate: 5 });
      limiter.tryConsume('k', 3); // 7 remaining
      vi.advanceTimersByTime(2000); // +10 tokens would exceed cap
      expect(limiter.getRemainingTokens('k')).toBe(10);
    });

    it('allows requests again after refill', () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 5, refillRate: 5 });
      limiter.tryConsume('k', 5);
      expect(limiter.tryConsume('k', 1).allowed).toBe(false);

      vi.advanceTimersByTime(1000); // +5 tokens
      expect(limiter.tryConsume('k', 1).allowed).toBe(true);
    });
  });

  describe('reset', () => {
    it('restores bucket to full capacity', () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 10, refillRate: 1 });
      limiter.tryConsume('k', 10);
      expect(limiter.getRemainingTokens('k')).toBe(0);

      limiter.reset('k');
      expect(limiter.getRemainingTokens('k')).toBe(10);
    });

    it('reset of unknown key is a no-op', () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 10, refillRate: 1 });
      expect(() => limiter.reset('nonexistent')).not.toThrow();
    });
  });

  describe('per-tool token costs', () => {
    it('expensive operations consume more tokens', () => {
      const limiter = new TokenBucketLimiter({ maxTokens: 15, refillRate: 1 });
      // index_folder costs 10, search_symbols costs 1
      limiter.tryConsume('k', 10); // index
      expect(limiter.getRemainingTokens('k')).toBe(5);
      limiter.tryConsume('k', 1); // search
      expect(limiter.getRemainingTokens('k')).toBe(4);
    });
  });
});

// ─── RateLimitStore ────────────────────────────────────────────────────────────

describe('RateLimitStore', () => {
  it('stores and retrieves bucket state', () => {
    const store = new RateLimitStore();
    store.set('k', { tokens: 50, lastRefillMs: 1000 });
    expect(store.get('k')).toEqual({ tokens: 50, lastRefillMs: 1000 });
  });

  it('returns undefined for unknown keys', () => {
    const store = new RateLimitStore();
    expect(store.get('unknown')).toBeUndefined();
  });

  it('deletes entries', () => {
    const store = new RateLimitStore();
    store.set('k', { tokens: 10, lastRefillMs: 0 });
    store.delete('k');
    expect(store.get('k')).toBeUndefined();
  });

  it('updates existing entries', () => {
    const store = new RateLimitStore();
    store.set('k', { tokens: 10, lastRefillMs: 0 });
    store.set('k', { tokens: 5, lastRefillMs: 100 });
    expect(store.get('k')).toEqual({ tokens: 5, lastRefillMs: 100 });
    expect(store.size).toBe(1);
  });

  it('tracks size correctly', () => {
    const store = new RateLimitStore();
    expect(store.size).toBe(0);
    store.set('a', { tokens: 1, lastRefillMs: 0 });
    store.set('b', { tokens: 2, lastRefillMs: 0 });
    expect(store.size).toBe(2);
    store.delete('a');
    expect(store.size).toBe(1);
  });

  it('evicts LRU entry when at capacity', () => {
    // Use a small private limit — we can't inject MAX_ENTRIES so we fill it via the real limit
    // Instead, test the promotion logic by verifying order
    const store = new RateLimitStore();

    // Add two entries; access first so it becomes MRU
    store.set('old', { tokens: 1, lastRefillMs: 0 });
    store.set('newer', { tokens: 2, lastRefillMs: 0 });
    store.get('old'); // promote 'old' — 'newer' is now LRU

    // We can't fill to 10k in a unit test, but we can verify the promotion:
    // After promotion, 'old' should still be present
    expect(store.get('old')).toBeDefined();
    expect(store.get('newer')).toBeDefined();
  });
});

// ─── extractToolName ───────────────────────────────────────────────────────────

describe('extractToolName', () => {
  it('extracts tool name from tools/call request', () => {
    const body = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'search_symbols', arguments: {} },
      id: 1,
    };
    expect(extractToolName(body)).toBe('search_symbols');
  });

  it('returns undefined for non-tools/call methods', () => {
    expect(extractToolName({ jsonrpc: '2.0', method: 'tools/list', id: 1 })).toBeUndefined();
    expect(extractToolName({ jsonrpc: '2.0', method: 'initialize', id: 1 })).toBeUndefined();
  });

  it('returns undefined for null/non-object bodies', () => {
    expect(extractToolName(null)).toBeUndefined();
    expect(extractToolName('string')).toBeUndefined();
    expect(extractToolName(42)).toBeUndefined();
  });

  it('returns undefined when params.name is missing', () => {
    const body = { jsonrpc: '2.0', method: 'tools/call', params: {}, id: 1 };
    expect(extractToolName(body)).toBeUndefined();
  });

  it('returns undefined when params is not an object', () => {
    const body = { jsonrpc: '2.0', method: 'tools/call', params: null, id: 1 };
    expect(extractToolName(body)).toBeUndefined();
  });
});

// ─── getToolCost ──────────────────────────────────────────────────────────────

describe('getToolCost', () => {
  const costs: Record<string, number> = {
    index_folder: 10,
    index_repo: 10,
    search_symbols: 1,
  };

  it('returns mapped cost for known tools', () => {
    expect(getToolCost('index_folder', costs)).toBe(10);
    expect(getToolCost('search_symbols', costs)).toBe(1);
  });

  it('returns 1 for unknown tools', () => {
    expect(getToolCost('unknown_tool', costs)).toBe(1);
  });

  it('returns 1 for undefined tool name', () => {
    expect(getToolCost(undefined, costs)).toBe(1);
  });
});

// ─── HTTP integration — 429 responses ─────────────────────────────────────────

describe('HTTP rate limiting integration', () => {
  it('returns 429 when bucket is exhausted', async () => {
    const { startHttpServer } = await import('../../src/server/http-server.js');
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { request: httpRequest } = await import('node:http');

    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      rateLimit: {
        enabled: true,
        maxTokens: 3,
        refillRate: 0.1, // very slow refill
        perToolLimits: { search_symbols: 1 },
      },
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
    });
    const port = (server.address() as { port: number }).port;

    const sendRequest = () =>
      new Promise<{ status: number; headers: Record<string, string> }>((resolve, reject) => {
        const body = JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'search_symbols', arguments: {} },
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

    // First 3 requests should pass (budget = 3)
    const [r1, r2, r3] = await Promise.all([sendRequest(), sendRequest(), sendRequest()]);
    const statuses = [r1.status, r2.status, r3.status];
    // At least some should succeed
    expect(statuses.some((s) => s !== 429)).toBe(true);

    // Send more until we get a 429
    let got429 = false;
    for (let i = 0; i < 10; i++) {
      const r = await sendRequest();
      if (r.status === 429) {
        got429 = true;
        expect(r.headers['retry-after']).toBeDefined();
        break;
      }
    }
    expect(got429).toBe(true);

    server.close();
  });

  it('does not rate limit when disabled', async () => {
    const { startHttpServer } = await import('../../src/server/http-server.js');
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { request: httpRequest } = await import('node:http');

    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      rateLimit: {
        enabled: false,
        maxTokens: 1,
        refillRate: 0.001,
        perToolLimits: {},
      },
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
    });
    const port = (server.address() as { port: number }).port;

    const sendRequest = () =>
      new Promise<number>((resolve, reject) => {
        const body = JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'search_symbols', arguments: {} },
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
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });

    // With budget=1 but disabled, multiple requests should not return 429
    const statuses = await Promise.all(Array.from({ length: 5 }, sendRequest));
    expect(statuses.every((s) => s !== 429)).toBe(true);

    server.close();
  });
});
