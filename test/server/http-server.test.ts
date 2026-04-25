import { describe, it, expect, afterEach } from 'vitest';
import { createServer, request as httpRequest, IncomingMessage } from 'node:http';
import type { Server as NodeHttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startHttpServer, originAllowed, readBody, checkAuth } from '../../src/server/http-server.js';
import { VERSION } from '../../src/version.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeServerFactory(): () => McpServer {
  return () =>
    new McpServer({
      name: 'test-server',
      version: '0.0.0',
    });
}

/** Start a test HTTP server on a random port (port 0). Returns the server and its port. */
async function startTestServer(
  corsOrigins = ['http://localhost:*'],
  auth = { enabled: false, token: '' },
): Promise<{ server: NodeHttpServer; port: number }> {
  const server = await startHttpServer({
    port: 0, // OS picks a random free port
    host: '127.0.0.1',
    corsOrigins,
    auth,
    serverFactory: makeServerFactory(),
  });

  const port = (server.address() as { port: number }).port;
  return { server, port };
}

/** Perform a simple HTTP request and return status + body. */
function doRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...(body ? { 'Content-Length': Buffer.byteLength(body).toString() } : {}),
          ...headers,
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const responseHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') responseHeaders[k] = v;
            else if (Array.isArray(v)) responseHeaders[k] = v.join(', ');
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: responseHeaders,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── originAllowed ────────────────────────────────────────────────────────────

describe('originAllowed', () => {
  it('matches exact origin', () => {
    expect(originAllowed('http://localhost:3000', ['http://localhost:3000'])).toBe(true);
  });

  it('matches wildcard port', () => {
    expect(originAllowed('http://localhost:3000', ['http://localhost:*'])).toBe(true);
    expect(originAllowed('http://localhost:9999', ['http://localhost:*'])).toBe(true);
  });

  it('rejects unlisted origin', () => {
    expect(originAllowed('http://evil.com', ['http://localhost:*'])).toBe(false);
  });

  it('matches multiple patterns', () => {
    expect(
      originAllowed('http://app.local', ['http://localhost:*', 'http://app.local']),
    ).toBe(true);
  });

  it('is case-sensitive (HTTP origins are)', () => {
    expect(originAllowed('http://Localhost:3000', ['http://localhost:*'])).toBe(false);
  });
});

// ─── readBody ─────────────────────────────────────────────────────────────────

describe('readBody', () => {
  it('reads a small body from a mock readable', async () => {
    const payload = JSON.stringify({ hello: 'world' });
    let captured = '';

    await new Promise<void>((resolve) => {
      const server = createServer((req, res) => {
        readBody(req, 1024)
          .then((buf) => {
            captured = buf.toString('utf8');
            res.writeHead(200);
            res.end();
          })
          .catch(() => {
            res.writeHead(500);
            res.end();
          });
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as { port: number };
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/',
            headers: { 'Content-Length': payload.length.toString() },
          },
          (res) => {
            res.resume();
            res.on('end', () => {
              server.close();
              resolve();
            });
          },
        );
        req.write(payload);
        req.end();
      });
    });

    expect(captured).toBe(payload);
  });
});

// ─── GET /health ──────────────────────────────────────────────────────────────

describe('GET /health', () => {
  let server: NodeHttpServer;
  let port: number;

  afterEach(() => server?.close());

  it('returns status ok with required fields', async () => {
    ({ server, port } = await startTestServer());

    const { status, body } = await doRequest(port, 'GET', '/health');
    expect(status).toBe(200);

    const json = JSON.parse(body) as Record<string, unknown>;
    expect(json['status']).toBe('ok');
    expect(json['version']).toBe(VERSION);
    expect(typeof json['repoCount']).toBe('number');
    expect(typeof json['uptime']).toBe('number');
  });
});

// ─── Unknown paths → 404 ──────────────────────────────────────────────────────

describe('unknown path', () => {
  let server: NodeHttpServer;
  let port: number;

  afterEach(() => server?.close());

  it('returns 404 for an unrecognised path', async () => {
    ({ server, port } = await startTestServer());

    const { status, body } = await doRequest(port, 'GET', '/nonexistent');
    expect(status).toBe(404);
    expect(JSON.parse(body)).toMatchObject({ error: expect.any(String) });
  });

  it('returns 404 for a nested path', async () => {
    ({ server, port } = await startTestServer());

    const { status } = await doRequest(port, 'GET', '/api/v1/tools');
    expect(status).toBe(404);
  });
});

// ─── CORS headers ─────────────────────────────────────────────────────────────

describe('CORS', () => {
  let server: NodeHttpServer;
  let port: number;

  afterEach(() => server?.close());

  it('responds to OPTIONS with 204 and CORS headers', async () => {
    ({ server, port } = await startTestServer(['http://localhost:*']));

    const { status, headers } = await doRequest(port, 'OPTIONS', '/mcp', {
      Origin: 'http://localhost:3000',
    });
    expect(status).toBe(204);
    expect(headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(headers['access-control-allow-methods']).toMatch(/POST/);
  });

  it('does not set ACAO header for disallowed origin', async () => {
    ({ server, port } = await startTestServer(['http://localhost:*']));

    const { headers } = await doRequest(port, 'OPTIONS', '/health', {
      Origin: 'http://evil.com',
    });
    expect(headers['access-control-allow-origin']).toBeUndefined();
  });
});

// ─── Oversized POST ───────────────────────────────────────────────────────────

describe('oversized POST', () => {
  let server: NodeHttpServer;
  let port: number;

  afterEach(() => server?.close());

  it('rejects POST /mcp with content-length > 1 MB', async () => {
    ({ server, port } = await startTestServer());

    const { status, body } = await doRequest(
      port,
      'POST',
      '/mcp',
      { 'Content-Length': (1_048_577).toString() },
      '{}',
    );
    expect(status).toBe(413);
    expect(JSON.parse(body)).toMatchObject({ error: expect.any(String) });
  });
});

// ─── GET /mcp → 405 ──────────────────────────────────────────────────────────

describe('GET /mcp', () => {
  let server: NodeHttpServer;
  let port: number;

  afterEach(() => server?.close());

  it('returns 405 for GET /mcp (use POST)', async () => {
    ({ server, port } = await startTestServer());

    const { status } = await doRequest(port, 'GET', '/mcp');
    expect(status).toBe(405);
  });
});

// ─── Transport factory ────────────────────────────────────────────────────────

describe('transport factory', () => {
  it('StdioServerTransport can be constructed (stdio mode)', () => {
    const t = new StdioServerTransport();
    expect(t).toBeTruthy();
  });

  it('startHttpServer resolves to a listening Node.js http.Server', async () => {
    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: ['http://localhost:*'],
      auth: { enabled: false, token: '' },
      serverFactory: makeServerFactory(),
    });

    expect(server.listening).toBe(true);
    server.close();
  });

  it('two HTTP servers can run simultaneously on different ports (both mode)', async () => {
    const noAuth = { enabled: false, token: '' };
    const [s1, s2] = await Promise.all([
      startHttpServer({ port: 0, host: '127.0.0.1', corsOrigins: [], auth: noAuth, serverFactory: makeServerFactory() }),
      startHttpServer({ port: 0, host: '127.0.0.1', corsOrigins: [], auth: noAuth, serverFactory: makeServerFactory() }),
    ]);

    const p1 = (s1.address() as { port: number }).port;
    const p2 = (s2.address() as { port: number }).port;

    expect(p1).not.toBe(p2);

    const [r1, r2] = await Promise.all([
      doRequest(p1, 'GET', '/health'),
      doRequest(p2, 'GET', '/health'),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    s1.close();
    s2.close();
  });
});

// ─── checkAuth unit tests ─────────────────────────────────────────────────────

describe('checkAuth', () => {
  function makeReq(authHeader?: string): import('node:http').IncomingMessage {
    return { headers: authHeader ? { authorization: authHeader } : {} } as import('node:http').IncomingMessage;
  }

  it('returns true when auth is disabled', () => {
    expect(checkAuth(makeReq(), { enabled: false, token: 'secret' })).toBe(true);
    expect(checkAuth(makeReq('Bearer wrong'), { enabled: false, token: 'secret' })).toBe(true);
  });

  it('returns true for correct bearer token', () => {
    expect(checkAuth(makeReq('Bearer mysecret'), { enabled: true, token: 'mysecret' })).toBe(true);
  });

  it('returns false when Authorization header is missing', () => {
    expect(checkAuth(makeReq(), { enabled: true, token: 'mysecret' })).toBe(false);
  });

  it('returns false for wrong token', () => {
    expect(checkAuth(makeReq('Bearer wrongtoken'), { enabled: true, token: 'mysecret' })).toBe(false);
  });

  it('returns false for wrong scheme (Basic instead of Bearer)', () => {
    expect(checkAuth(makeReq('Basic mysecret'), { enabled: true, token: 'mysecret' })).toBe(false);
  });

  it('returns false when token is empty and auth is enabled', () => {
    expect(checkAuth(makeReq('Bearer '), { enabled: true, token: '' })).toBe(false);
  });
});

// ─── HTTP auth integration ────────────────────────────────────────────────────

describe('HTTP bearer token authentication', () => {
  let server: NodeHttpServer;
  let port: number;

  afterEach(() => server?.close());

  it('rejects /mcp POST with no Authorization header → 401', async () => {
    ({ server, port } = await startTestServer(['http://localhost:*'], {
      enabled: true,
      token: 'test-secret-token',
    }));

    const { status, body } = await doRequest(
      port,
      'POST',
      '/mcp',
      { 'Content-Type': 'application/json' },
      '{}',
    );
    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
  });

  it('rejects /mcp POST with wrong token → 401', async () => {
    ({ server, port } = await startTestServer(['http://localhost:*'], {
      enabled: true,
      token: 'test-secret-token',
    }));

    const { status } = await doRequest(
      port,
      'POST',
      '/mcp',
      { Authorization: 'Bearer wrong-token' },
      '{}',
    );
    expect(status).toBe(401);
  });

  it('allows /mcp POST with correct token', async () => {
    ({ server, port } = await startTestServer(['http://localhost:*'], {
      enabled: true,
      token: 'test-secret-token',
    }));

    // The MCP request itself will fail (malformed body), but auth passes → not 401
    const { status } = await doRequest(
      port,
      'POST',
      '/mcp',
      { Authorization: 'Bearer test-secret-token' },
      '{"jsonrpc":"2.0","method":"tools/list","id":1}',
    );
    expect(status).not.toBe(401);
  });

  it('/health is always public (no auth required)', async () => {
    ({ server, port } = await startTestServer(['http://localhost:*'], {
      enabled: true,
      token: 'test-secret-token',
    }));

    const { status } = await doRequest(port, 'GET', '/health');
    expect(status).toBe(200);
  });

  it('OPTIONS preflight is always public', async () => {
    ({ server, port } = await startTestServer(['http://localhost:*'], {
      enabled: true,
      token: 'test-secret-token',
    }));

    const { status } = await doRequest(port, 'OPTIONS', '/mcp');
    expect(status).toBe(204);
  });

  it('auth disabled → /mcp accessible without token', async () => {
    ({ server, port } = await startTestServer(['http://localhost:*'], {
      enabled: false,
      token: '',
    }));

    const { status } = await doRequest(
      port,
      'POST',
      '/mcp',
      {},
      '{"jsonrpc":"2.0","method":"tools/list","id":1}',
    );
    expect(status).not.toBe(401);
  });
});
