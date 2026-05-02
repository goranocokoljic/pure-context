/**
 * Task 129 — --server flag and server-mode behaviour.
 *
 * Tests:
 *  - HTTP server starts and /health returns 200
 *  - Auth is enforced when requireAuth is set
 *  - PCTX_DATA_DIR redirects index storage (via getIndexDir)
 *  - PCTX_ADMIN_KEY is reflected in config
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { Server as NodeHttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { startHttpServer } from '../../src/server/http-server.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(
  server: NodeHttpServer,
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = httpRequest(
      { host: '127.0.0.1', port: addr.port, path, method, headers },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function noop(): McpServer {
  return new McpServer({ name: 'test', version: '0.0.0' });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('HTTP server — /health endpoint', () => {
  let server: NodeHttpServer;

  beforeEach(async () => {
    server = await startHttpServer({
      port: 0, // random ephemeral port
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      serveUi: false,
      serverFactory: noop,
    });
  });

  afterEach(() => {
    server.close();
  });

  it('returns 200 with status ok', async () => {
    const { status, body } = await makeRequest(server, '/health');
    expect(status).toBe(200);
    const json = JSON.parse(body) as Record<string, unknown>;
    expect(json['status']).toBe('ok');
    expect(typeof json['version']).toBe('string');
    expect(typeof json['uptime']).toBe('number');
  });

  it('/health is accessible without auth even when auth is enabled', async () => {
    // Start a second server with auth enabled
    const authServer = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: true, token: 'test-token' },
      serveUi: false,
      serverFactory: noop,
    });

    try {
      const { status } = await makeRequest(authServer, '/health');
      expect(status).toBe(200);
    } finally {
      authServer.close();
    }
  });
});

describe('HTTP server — auth enforcement', () => {
  it('returns 401 on /mcp without a key when auth is enabled', async () => {
    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: true, token: 'secret' },
      serveUi: false,
      serverFactory: noop,
    });

    try {
      const { status } = await makeRequest(server, '/mcp', 'POST', {
        'Content-Type': 'application/json',
      });
      expect(status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('accepts a valid bearer token', async () => {
    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: true, token: 'secret' },
      serveUi: false,
      serverFactory: noop,
    });

    try {
      // POST a minimal JSON-RPC initialize request
      const { status } = await makeRequest(server, '/mcp', 'POST', {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
      });
      // 200 or 400 (invalid payload) — either means auth passed
      expect(status).not.toBe(401);
      expect(status).not.toBe(403);
    } finally {
      server.close();
    }
  });
});

describe('PCTX_DATA_DIR — index directory override', () => {
  it('getIndexDir() uses PCTX_DATA_DIR when set', async () => {
    const prev = process.env['PCTX_DATA_DIR'];
    const dataDir = join(tmpdir(), 'pctx-test-data');
    process.env['PCTX_DATA_DIR'] = dataDir;

    try {
      const { getIndexDir } = await import('../../src/core/db/schema.js');
      const dir = getIndexDir();
      expect(normalize(dir)).toBe(normalize(join(dataDir, 'indexes')));
    } finally {
      if (prev === undefined) {
        delete process.env['PCTX_DATA_DIR'];
      } else {
        process.env['PCTX_DATA_DIR'] = prev;
      }
    }
  });

  it('getIndexDir() falls back to ~/.purecontext/indexes without PCTX_DATA_DIR', async () => {
    const prev = process.env['PCTX_DATA_DIR'];
    delete process.env['PCTX_DATA_DIR'];

    try {
      const { getIndexDir } = await import('../../src/core/db/schema.js');
      const dir = getIndexDir();
      expect(dir).toContain('.purecontext');
      expect(dir).toContain('indexes');
    } finally {
      if (prev !== undefined) process.env['PCTX_DATA_DIR'] = prev;
    }
  });
});

describe('PCTX_ADMIN_KEY — config resolution', () => {
  it('is picked up from environment variable', async () => {
    const prev = process.env['PCTX_ADMIN_KEY'];
    process.env['PCTX_ADMIN_KEY'] = 'test-admin-key-from-env';

    try {
      const { reloadConfig, getConfig } = await import('../../src/config/config-loader.js');
      reloadConfig();
      const cfg = getConfig();
      expect(cfg.server.adminKey).toBe('test-admin-key-from-env');
      reloadConfig(); // reset for other tests
    } finally {
      if (prev === undefined) {
        delete process.env['PCTX_ADMIN_KEY'];
      } else {
        process.env['PCTX_ADMIN_KEY'] = prev;
      }
    }
  });
});
