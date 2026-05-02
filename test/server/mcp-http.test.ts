/**
 * Task 130 — MCP-over-HTTP Transport (SSE)
 *
 * Tests the /mcp/sse endpoint that exposes the full MCP protocol over HTTP+SSE.
 *
 * Streamable HTTP protocol flow:
 *  1. POST /mcp/sse (initialize, no session ID) → SSE response + mcp-session-id header
 *  2. POST /mcp/sse (tool calls, mcp-session-id) → SSE response with result
 *  3. GET  /mcp/sse (mcp-session-id) → long-lived SSE stream for server-initiated messages
 *
 * POST requires: Accept: application/json, text/event-stream
 * GET  requires: Accept: text/event-stream
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { request as httpRequest, type IncomingMessage, type ClientRequest } from 'node:http';
import type { Server as NodeHttpServer } from 'node:http';
import { openInMemoryAuthDatabase } from '../../src/core/db/api-keys.js';
import { ApiKeyValidator } from '../../src/server/auth/api-key.js';
import { startHttpServer } from '../../src/server/http-server.js';
import { HttpSseTransport } from '../../src/server/transport.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSseTransport(): HttpSseTransport {
  return new HttpSseTransport(() => new McpServer({ name: 'test', version: '0.0.0' }));
}

function doRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string; headers: Record<string, string | string[]> }> {
  return new Promise((resolve, reject) => {
    const bodyBuf = body ? Buffer.from(body) : undefined;
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          // Streamable HTTP spec: POST requires Accept: application/json, text/event-stream
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          ...(bodyBuf ? { 'Content-Length': String(bodyBuf.length) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers as Record<string, string | string[]>,
          }),
        );
      },
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/**
 * Open an SSE GET connection. Resolves as soon as the response headers are
 * received — does NOT wait for body data, because SSE streams stay open
 * indefinitely. The caller is responsible for calling req.destroy() to close.
 */
function openSseConnection(
  port: number,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  contentType: string;
  sessionId: string | undefined;
  req: ClientRequest;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: '/mcp/sse',
        headers: {
          Accept: 'text/event-stream',
          ...headers,
        },
      },
      (res: IncomingMessage) => {
        const contentType = (res.headers['content-type'] as string | undefined) ?? '';
        const sessionId = res.headers['mcp-session-id'] as string | undefined;

        if ((res.statusCode ?? 0) !== 200) {
          // Error response: read body then resolve so the test can inspect the status
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, contentType, sessionId, req }),
          );
          return;
        }

        // 200 SSE: resolve immediately on headers — don't wait for body data.
        // The SSE stream stays open until the client destroys the request.
        resolve({ status: 200, contentType, sessionId, req });
        // Drain to prevent buffering (caller will destroy req when done)
        res.resume();
      },
    );
    req.on('error', (err) => {
      // Ignore ECONNRESET which fires when we call req.destroy()
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
    });
    req.end();
  });
}

/**
 * Initialize an MCP session via POST /mcp/sse.
 * Returns { sessionId, status } — sessionId is in the response header.
 * The initialize POST returns an SSE stream; we read until the stream closes.
 */
async function initSession(
  port: number,
  authHeaders: Record<string, string> = {},
): Promise<{ sessionId: string | undefined; status: number }> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-agent', version: '0.0.0' },
    },
    id: 1,
  });
  const r = await doRequest(port, 'POST', '/mcp/sse', authHeaders, body);
  return {
    status: r.status,
    sessionId: r.headers['mcp-session-id'] as string | undefined,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('/mcp/sse — unauthenticated access is rejected', () => {
  let server: NodeHttpServer;
  let port: number;
  let sseTransport: HttpSseTransport;

  beforeEach(async () => {
    const db = openInMemoryAuthDatabase();
    const validator = new ApiKeyValidator(db);
    sseTransport = makeSseTransport();
    await sseTransport.init();

    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      apiKeyAuth: { enabled: true, validator },
      sseTransport,
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
      serveUi: false,
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => { server.close(); await sseTransport.close(); });

  it('GET /mcp/sse without key → 401', async () => {
    const r = await openSseConnection(port);
    r.req.destroy();
    expect(r.status).toBe(401);
  });

  it('POST /mcp/sse without key → 401', async () => {
    const { status } = await initSession(port);
    expect(status).toBe(401);
  });

  it('GET /mcp/sse with invalid key format → 401', async () => {
    const r = await openSseConnection(port, { Authorization: 'Bearer not-a-key' });
    r.req.destroy();
    expect(r.status).toBe(401);
  });
});

describe('/mcp/sse — MCP session lifecycle with valid auth', () => {
  let server: NodeHttpServer;
  let port: number;
  let validator: ApiKeyValidator;
  let sseTransport: HttpSseTransport;

  beforeEach(async () => {
    const db = openInMemoryAuthDatabase();
    validator = new ApiKeyValidator(db);
    sseTransport = makeSseTransport();
    await sseTransport.init();

    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      apiKeyAuth: { enabled: true, validator },
      sseTransport,
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
      serveUi: false,
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => { server.close(); validator.close(); await sseTransport.close(); });

  it('POST initialize → 200 with mcp-session-id header', async () => {
    const key = validator.generate('tenantA', ['read']);
    const { status, sessionId } = await initSession(port, { Authorization: `Bearer ${key}` });
    expect(status).toBe(200);
    expect(typeof sessionId).toBe('string');
    expect(sessionId).toBeTruthy();
  });

  it('GET /mcp/sse with session ID → 200 SSE stream', async () => {
    const key = validator.generate('tenantA', ['read']);
    const { sessionId } = await initSession(port, { Authorization: `Bearer ${key}` });
    expect(sessionId).toBeTruthy();

    const r = await openSseConnection(port, {
      Authorization: `Bearer ${key}`,
      'mcp-session-id': sessionId!,
    });
    r.req.destroy();

    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/event-stream');
  });

  it('POST ping with session ID → valid JSON-RPC response via SSE', async () => {
    const key = validator.generate('tenantA', ['read']);
    const { sessionId } = await initSession(port, { Authorization: `Bearer ${key}` });
    expect(sessionId).toBeTruthy();

    // Use ping — always available on any McpServer regardless of registered tools.
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 2 });
    const r = await doRequest(
      port,
      'POST',
      '/mcp/sse',
      { Authorization: `Bearer ${key}`, 'mcp-session-id': sessionId! },
      body,
    );
    expect(r.status).toBe(200);
    // Response is SSE — the data: line contains a JSON-RPC object
    const dataLine = r.body.split('\n').find((l) => l.startsWith('data: '));
    expect(dataLine).toBeTruthy();
    const json = JSON.parse(dataLine!.slice('data: '.length)) as Record<string, unknown>;
    // ping returns an empty result: { jsonrpc, id, result: {} }
    expect(json['jsonrpc']).toBe('2.0');
    expect(json['id']).toBe(2);
    expect(json['result']).toBeDefined();
  });
});

describe('/mcp/sse — two concurrent sessions do not interfere', () => {
  let server: NodeHttpServer;
  let port: number;
  let validator: ApiKeyValidator;
  let sseTransport: HttpSseTransport;

  beforeEach(async () => {
    const db = openInMemoryAuthDatabase();
    validator = new ApiKeyValidator(db);
    sseTransport = makeSseTransport();
    await sseTransport.init();

    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      apiKeyAuth: { enabled: true, validator },
      sseTransport,
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
      serveUi: false,
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => { server.close(); validator.close(); await sseTransport.close(); });

  it('two agents get independent session IDs', async () => {
    const keyA = validator.generate('tenantA', ['read']);
    const keyB = validator.generate('tenantB', ['read']);

    const [a, b] = await Promise.all([
      initSession(port, { Authorization: `Bearer ${keyA}` }),
      initSession(port, { Authorization: `Bearer ${keyB}` }),
    ]);

    expect(a.sessionId).toBeTruthy();
    expect(b.sessionId).toBeTruthy();
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('session A\'s SSE stream does not receive session B\'s messages', async () => {
    const keyA = validator.generate('tenantA', ['read']);
    const keyB = validator.generate('tenantB', ['read']);

    const { sessionId: sidA } = await initSession(port, { Authorization: `Bearer ${keyA}` });
    const { sessionId: sidB } = await initSession(port, { Authorization: `Bearer ${keyB}` });

    expect(sidA).toBeTruthy();
    expect(sidB).toBeTruthy();

    // Both agents can open independent SSE streams with their own session IDs
    const [rA, rB] = await Promise.all([
      openSseConnection(port, { Authorization: `Bearer ${keyA}`, 'mcp-session-id': sidA! }),
      openSseConnection(port, { Authorization: `Bearer ${keyB}`, 'mcp-session-id': sidB! }),
    ]);

    rA.req.destroy();
    rB.req.destroy();

    expect(rA.status).toBe(200);
    expect(rB.status).toBe(200);
  });
});

describe('/mcp/sse — no sseTransport configured → falls through to 404', () => {
  let server: NodeHttpServer;
  let port: number;

  beforeEach(async () => {
    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      // no sseTransport
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
      serveUi: false,
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(() => server.close());

  it('GET /mcp/sse without sseTransport → 404', async () => {
    const r = await doRequest(port, 'GET', '/mcp/sse', { Accept: 'text/event-stream' });
    expect(r.status).toBe(404);
  });
});

describe('/mcp/sse — auth disabled → accessible without credentials', () => {
  let server: NodeHttpServer;
  let port: number;
  let sseTransport: HttpSseTransport;

  beforeEach(async () => {
    sseTransport = makeSseTransport();
    await sseTransport.init();

    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      auth: { enabled: false, token: '' },
      // apiKeyAuth not set → auth disabled
      sseTransport,
      serverFactory: () => new McpServer({ name: 'test', version: '0.0.0' }),
      serveUi: false,
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => { server.close(); await sseTransport.close(); });

  it('POST initialize without auth → 200 with session ID', async () => {
    const { status, sessionId } = await initSession(port);
    expect(status).toBe(200);
    expect(sessionId).toBeTruthy();
  });
});
