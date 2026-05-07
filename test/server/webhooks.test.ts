import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

// ─── Unit tests for webhook helpers (no HTTP server needed) ───────────────────

import {
  verifyGitHubSignature,
  parseGitHubPayload,
  extractChangedFiles,
} from '../../src/server/webhooks/github-webhook.js';

import {
  verifyGitLabToken,
  parseGitLabPayload,
  extractChangedFilesGitLab,
} from '../../src/server/webhooks/gitlab-webhook.js';

// ─── GitHub webhook tests ──────────────────────────────────────────────────────

describe('verifyGitHubSignature', () => {
  const secret = 'my-secret';
  const body = Buffer.from('{"hello":"world"}');

  function validSig(b: Buffer, s: string): string {
    return `sha256=${createHmac('sha256', s).update(b).digest('hex')}`;
  }

  it('returns true for a valid HMAC-SHA256 signature', () => {
    expect(verifyGitHubSignature(body, validSig(body, secret), secret)).toBe(true);
  });

  it('returns false for a tampered signature', () => {
    const bad = validSig(body, secret).slice(0, -4) + '0000';
    expect(verifyGitHubSignature(body, bad, secret)).toBe(false);
  });

  it('returns false when signature header is missing', () => {
    expect(verifyGitHubSignature(body, undefined, secret)).toBe(false);
  });

  it('returns false when signature length differs', () => {
    expect(verifyGitHubSignature(body, 'sha256=short', secret)).toBe(false);
  });

  it('returns true (skip verification) when secret is empty', () => {
    expect(verifyGitHubSignature(body, undefined, '')).toBe(true);
    expect(verifyGitHubSignature(body, 'anything', '')).toBe(true);
  });
});

describe('parseGitHubPayload', () => {
  const minimal = Buffer.from(JSON.stringify({
    ref: 'refs/heads/main',
    repository: { full_name: 'owner/repo', clone_url: 'https://github.com/owner/repo.git' },
    head_commit: { id: 'abc123' },
    commits: [
      { added: ['src/foo.ts'], modified: ['src/bar.ts'], removed: [] },
    ],
  }));

  it('parses a valid push payload', () => {
    const p = parseGitHubPayload(minimal);
    expect(p).not.toBeNull();
    expect(p!.ref).toBe('refs/heads/main');
    expect(p!.repository.full_name).toBe('owner/repo');
    expect(p!.commits).toHaveLength(1);
  });

  it('returns null for malformed JSON', () => {
    expect(parseGitHubPayload(Buffer.from('not-json'))).toBeNull();
  });

  it('returns null when ref is missing', () => {
    const bad = JSON.parse(minimal.toString());
    delete bad.ref;
    expect(parseGitHubPayload(Buffer.from(JSON.stringify(bad)))).toBeNull();
  });

  it('returns null when repository is missing', () => {
    const bad = JSON.parse(minimal.toString());
    delete bad.repository;
    expect(parseGitHubPayload(Buffer.from(JSON.stringify(bad)))).toBeNull();
  });
});

describe('extractChangedFiles (GitHub)', () => {
  it('separates added/modified from removed', () => {
    const payload = parseGitHubPayload(Buffer.from(JSON.stringify({
      ref: 'refs/heads/main',
      repository: { full_name: 'owner/repo', clone_url: 'https://github.com/owner/repo.git' },
      head_commit: { id: 'abc' },
      commits: [
        { added: ['a.ts', 'b.ts'], modified: ['c.ts'], removed: ['d.ts'] },
      ],
    })))!;

    const { changedPaths, deletedPaths } = extractChangedFiles(payload);
    expect(changedPaths).toContain('a.ts');
    expect(changedPaths).toContain('b.ts');
    expect(changedPaths).toContain('c.ts');
    expect(deletedPaths).toContain('d.ts');
    expect(changedPaths).not.toContain('d.ts');
  });

  it('deduplicates files across multiple commits', () => {
    const payload = parseGitHubPayload(Buffer.from(JSON.stringify({
      ref: 'refs/heads/main',
      repository: { full_name: 'owner/repo', clone_url: 'https://github.com/owner/repo.git' },
      head_commit: { id: 'abc' },
      commits: [
        { added: ['a.ts'], modified: [], removed: [] },
        { added: [], modified: ['a.ts'], removed: [] },
      ],
    })))!;

    const { changedPaths } = extractChangedFiles(payload);
    expect(changedPaths.filter((f) => f === 'a.ts')).toHaveLength(1);
  });

  it('removes a file from changedPaths when it is also deleted in the same push', () => {
    const payload = parseGitHubPayload(Buffer.from(JSON.stringify({
      ref: 'refs/heads/main',
      repository: { full_name: 'owner/repo', clone_url: 'https://github.com/owner/repo.git' },
      head_commit: { id: 'abc' },
      commits: [
        { added: ['tmp.ts'], modified: [], removed: ['tmp.ts'] },
      ],
    })))!;

    const { changedPaths, deletedPaths } = extractChangedFiles(payload);
    expect(changedPaths).not.toContain('tmp.ts');
    expect(deletedPaths).toContain('tmp.ts');
  });
});

// ─── GitLab webhook tests ──────────────────────────────────────────────────────

describe('verifyGitLabToken', () => {
  it('returns true for matching tokens', () => {
    expect(verifyGitLabToken('my-secret', 'my-secret')).toBe(true);
  });

  it('returns false for mismatched tokens', () => {
    expect(verifyGitLabToken('wrong', 'my-secret')).toBe(false);
  });

  it('returns false when token is missing', () => {
    expect(verifyGitLabToken(undefined, 'my-secret')).toBe(false);
  });

  it('returns true (skip verification) when secret is empty', () => {
    expect(verifyGitLabToken(undefined, '')).toBe(true);
    expect(verifyGitLabToken('anything', '')).toBe(true);
  });
});

describe('parseGitLabPayload', () => {
  const minimal = Buffer.from(JSON.stringify({
    ref: 'refs/heads/main',
    project: {
      path_with_namespace: 'owner/repo',
      http_url_to_repo: 'https://gitlab.com/owner/repo.git',
    },
    checkout_sha: 'abc123',
    commits: [
      { added: ['src/foo.ts'], modified: [], removed: [] },
    ],
  }));

  it('parses a valid push payload', () => {
    const p = parseGitLabPayload(minimal);
    expect(p).not.toBeNull();
    expect(p!.ref).toBe('refs/heads/main');
    expect(p!.project.path_with_namespace).toBe('owner/repo');
  });

  it('returns null for malformed JSON', () => {
    expect(parseGitLabPayload(Buffer.from('bad'))).toBeNull();
  });

  it('returns null when project is missing', () => {
    const bad = JSON.parse(minimal.toString());
    delete bad.project;
    expect(parseGitLabPayload(Buffer.from(JSON.stringify(bad)))).toBeNull();
  });
});

describe('extractChangedFilesGitLab', () => {
  it('separates changed from removed files', () => {
    const payload = parseGitLabPayload(Buffer.from(JSON.stringify({
      ref: 'refs/heads/main',
      project: {
        path_with_namespace: 'owner/repo',
        http_url_to_repo: 'https://gitlab.com/owner/repo.git',
      },
      checkout_sha: 'abc',
      commits: [
        { added: ['x.ts'], modified: ['y.ts'], removed: ['z.ts'] },
      ],
    })))!;

    const { changedPaths, deletedPaths } = extractChangedFilesGitLab(payload);
    expect(changedPaths).toContain('x.ts');
    expect(changedPaths).toContain('y.ts');
    expect(deletedPaths).toContain('z.ts');
  });
});

// ─── Webhook utils: rate limiting ─────────────────────────────────────────────

describe('webhook rate limiting', () => {
  it('allows a first call and blocks within 60s', async () => {
    // Import the module fresh for each test by using dynamic import with cache-busting
    // Since we can't easily reset module state, we test the logic directly
    const { isRateLimited, markReindexed } = await import('../../src/server/webhooks/webhook-utils.js');

    const repoId = `test-rate-limit-${Date.now()}`;
    expect(isRateLimited(repoId)).toBe(false);
    markReindexed(repoId);
    expect(isRateLimited(repoId)).toBe(true);
  });
});

// ─── HTTP integration tests ────────────────────────────────────────────────────

import { request as httpRequest } from 'node:http';
import type { Server as NodeHttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startHttpServer } from '../../src/server/http-server.js';

function makeServerFactory(): () => McpServer {
  return () => new McpServer({ name: 'test', version: '0.0.0' });
}

async function startWebhookServer(
  webhookCfg: Parameters<typeof startHttpServer>[0]['webhook'],
): Promise<{ server: NodeHttpServer; port: number }> {
  const server = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    corsOrigins: [],
    auth: { enabled: false, token: '' },
    serverFactory: makeServerFactory(),
    serveUi: false,
    webhook: webhookCfg,
  });
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

function post(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(buf.byteLength),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

describe('webhook HTTP endpoints', () => {
  let server: NodeHttpServer;
  let port: number;

  beforeEach(async () => {
    // Start with webhooks disabled
    ({ server, port } = await startWebhookServer(undefined));
  });

  afterEach(() => {
    server.close();
  });

  it('returns 404 when webhook is not enabled', async () => {
    const res = await post(port, '/webhooks/github', {}, '{}');
    expect(res.status).toBe(404);
  });
});

describe('webhook HTTP endpoints — enabled', () => {
  let server: NodeHttpServer;
  let port: number;
  const secret = 'test-secret-abc';

  beforeEach(async () => {
    ({ server, port } = await startWebhookServer({
      enabled: true,
      secret,
      allowedRepos: [],
      autoIndex: false,
    }));
  });

  afterEach(() => {
    server.close();
  });

  it('returns 403 for GitHub push with invalid HMAC', async () => {
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      repository: { full_name: 'owner/repo', clone_url: 'https://github.com/owner/repo.git' },
      head_commit: { id: 'abc' },
      commits: [],
    });
    const res = await post(port, '/webhooks/github', {
      'x-hub-signature-256': 'sha256=badhash',
    }, body);
    expect(res.status).toBe(403);
  });

  it('returns 400 for GitHub push with invalid payload', async () => {
    const body = JSON.stringify({ not: 'a push event' });
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const res = await post(port, '/webhooks/github', {
      'x-hub-signature-256': sig,
    }, body);
    expect(res.status).toBe(400);
  });

  it('returns 404 for GitHub push when repo is not indexed', async () => {
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      repository: { full_name: 'owner/nonexistent-repo-xyz', clone_url: 'https://github.com/owner/nonexistent-repo-xyz.git' },
      head_commit: { id: 'abc' },
      commits: [],
    });
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const res = await post(port, '/webhooks/github', {
      'x-hub-signature-256': sig,
    }, body);
    expect(res.status).toBe(404);
  });

  it('returns 403 for GitLab push with invalid token', async () => {
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      project: {
        path_with_namespace: 'owner/repo',
        http_url_to_repo: 'https://gitlab.com/owner/repo.git',
      },
      checkout_sha: 'abc',
      commits: [],
    });
    const res = await post(port, '/webhooks/gitlab', {
      'x-gitlab-token': 'wrong-token',
    }, body);
    expect(res.status).toBe(403);
  });

  it('returns 400 for generic webhook missing repoPath', async () => {
    const body = JSON.stringify({ changedFiles: ['src/foo.ts'] });
    const res = await post(port, '/webhooks/generic', {}, body);
    expect(res.status).toBe(400);
    expect(res.body).toContain('repoPath');
  });

  it('returns 404 for generic webhook with unknown repoPath', async () => {
    const body = JSON.stringify({ repoPath: '/nonexistent/path/that/is/not/indexed' });
    const res = await post(port, '/webhooks/generic', {}, body);
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown webhook path', async () => {
    const body = JSON.stringify({});
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const res = await post(port, '/webhooks/unknown', { 'x-hub-signature-256': sig }, body);
    expect(res.status).toBe(404);
  });

  it('returns 403 for GitHub push when repo is not in allowedRepos', async () => {
    // Restart with allowedRepos filter
    server.close();
    const restricted = await startWebhookServer({
      enabled: true,
      secret,
      allowedRepos: ['allowed/repo'],
      autoIndex: false,
    });
    server = restricted.server;
    port = restricted.port;

    const body = JSON.stringify({
      ref: 'refs/heads/main',
      repository: { full_name: 'notallowed/repo', clone_url: 'https://github.com/notallowed/repo.git' },
      head_commit: { id: 'abc' },
      commits: [],
    });
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const res = await post(port, '/webhooks/github', {
      'x-hub-signature-256': sig,
    }, body);
    expect(res.status).toBe(403);
    expect(res.body).toContain('allowedRepos');
  });
});
