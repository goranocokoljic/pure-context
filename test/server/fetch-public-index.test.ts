/**
 * Tests for fetch_public_index (Task 169: Pre-Built Index Registry).
 *
 * The CDN and import handler are mocked — no real network access or DB writes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

// ─── Mock globals and modules ─────────────────────────────────────────────────

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock the import handler so we don't need a real DB
vi.mock('../../src/server/tools/import-index.js', () => ({
  handler: vi.fn(),
}));

// Mock openDatabase so source-tagging doesn't fail
vi.mock('../../src/core/db/schema.js', () => ({
  openDatabase: vi.fn(() => ({
    prepare: vi.fn(() => ({ run: vi.fn() })),
    close: vi.fn(),
  })),
  getIndexDir: vi.fn(() => join(tmpdir(), 'pctx-test-indexes')),
  SCHEMA_VERSION: 7,
  computeRepoId: vi.fn((p: string) => 'test-repo-id'),
}));

// Redirect file writes to a temp dir so tests don't pollute ~/.purecontext
let testHome: string;

vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return {
    ...orig,
    homedir: () => testHome,
    tmpdir: () => orig.tmpdir(),
  };
});

import { handler, fetchManifest, REGISTRY_MANIFEST_URL } from '../../src/server/tools/fetch-public-index.js';
import { handler as importHandlerMock } from '../../src/server/tools/import-index.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FAKE_BUNDLE = Buffer.from('fake-bundle-content');
const FAKE_SHA256 = createHash('sha256').update(FAKE_BUNDLE).digest('hex');

const MANIFEST = {
  version: '1.0',
  updatedAt: '2026-05-05T00:00:00Z',
  repos: [
    {
      repo: 'expressjs/express',
      latest: '4.18.2',
      versions: [
        {
          version: '4.18.2',
          sha256: FAKE_SHA256,
          bundleSize: FAKE_BUNDLE.length,
          symbolCount: 1234,
          fileCount: 56,
          publishedAt: '2026-05-01T00:00:00Z',
          url: 'https://registry.purecontext.dev/indexes/expressjs/express/4.18.2.pcx',
        },
      ],
    },
    {
      repo: 'fastify/fastify',
      latest: '4.26.0',
      versions: [
        {
          version: '4.26.0',
          sha256: 'aaaa',
          bundleSize: 1000,
          symbolCount: 800,
          fileCount: 30,
          publishedAt: '2026-05-01T00:00:00Z',
          url: 'https://registry.purecontext.dev/indexes/fastify/fastify/4.26.0.pcx',
        },
      ],
    },
  ],
};

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeBufferResponse(buf: Buffer, status = 200): Response {
  return new Response(buf, { status });
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

let prevDataDir: string | undefined;

beforeEach(() => {
  testHome = join(tmpdir(), `pctx-test-home-${Date.now()}`);
  mkdirSync(testHome, { recursive: true });

  // fetch-public-index prefers PCTX_DATA_DIR over homedir(), and test/setup.ts
  // (Task 551) sets it globally to a STABLE shared dir — which would let the
  // manifest cache persist across tests and mask fetch-failure cases. Point it
  // at this test's fresh per-test home instead.
  prevDataDir = process.env['PCTX_DATA_DIR'];
  process.env['PCTX_DATA_DIR'] = join(testHome, '.purecontext');

  vi.clearAllMocks();

  vi.mocked(importHandlerMock).mockResolvedValue({
    content: [
      {
        type: 'text',
        text: JSON.stringify({ repoId: 'abc123', symbolCount: 1234, fileCount: 56, alreadyExisted: false }),
      },
    ],
  });
});

afterEach(() => {
  if (prevDataDir === undefined) {
    delete process.env['PCTX_DATA_DIR'];
  } else {
    process.env['PCTX_DATA_DIR'] = prevDataDir;
  }
  if (existsSync(testHome)) {
    rmSync(testHome, { recursive: true, force: true });
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('fetch_public_index handler', () => {
  it('downloads bundle from registry and imports it', async () => {
    mockFetch
      .mockResolvedValueOnce(makeJsonResponse(MANIFEST))
      .mockResolvedValueOnce(makeBufferResponse(FAKE_BUNDLE));

    const result = await handler({ repo: 'expressjs/express' });
    expect(result.content[0].type).toBe('text');

    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    expect(parsed.repo).toBe('expressjs/express');
    expect(parsed.version).toBe('4.18.2');
    expect(parsed.source).toBe('registry');
    expect(parsed.repoId).toBe('abc123');
    expect(parsed.symbolCount).toBe(1234);
    expect(parsed.cachedAt).toBeTruthy();
  });

  it('resolves "latest" to the current latest version', async () => {
    mockFetch
      .mockResolvedValueOnce(makeJsonResponse(MANIFEST))
      .mockResolvedValueOnce(makeBufferResponse(FAKE_BUNDLE));

    const result = await handler({ repo: 'expressjs/express', version: 'latest' });
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    expect(parsed.version).toBe('4.18.2');
  });

  it('verifies SHA-256 before import and rejects corrupt bundle', async () => {
    const corruptBundle = Buffer.from('this-is-not-the-right-bundle');

    mockFetch
      .mockResolvedValueOnce(makeJsonResponse(MANIFEST))
      .mockResolvedValueOnce(makeBufferResponse(corruptBundle));

    await expect(handler({ repo: 'expressjs/express' })).rejects.toMatchObject({
      message: expect.stringContaining('integrity check failed'),
    });

    // import handler should NOT have been called with corrupt data
    expect(importHandlerMock).not.toHaveBeenCalled();
  });

  it('returns source: cache when repo is already in registry-cache.json', async () => {
    // Pre-populate the registry cache
    const cacheDir = join(testHome, '.purecontext');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'registry-cache.json'),
      JSON.stringify({
        'expressjs/express': {
          repoId: 'cached-repo-id',
          repo: 'expressjs/express',
          version: '4.18.2',
          symbolCount: 1234,
          indexedAt: Date.now() - 1000,
        },
      }),
    );

    const result = await handler({ repo: 'expressjs/express' });
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);

    expect(parsed.source).toBe('cache');
    expect(parsed.repoId).toBe('cached-repo-id');
    // Should NOT have fetched anything
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('re-downloads when force: true even if cached', async () => {
    // Pre-populate cache
    const cacheDir = join(testHome, '.purecontext');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'registry-cache.json'),
      JSON.stringify({
        'expressjs/express': {
          repoId: 'old-id',
          repo: 'expressjs/express',
          version: '4.18.2',
          symbolCount: 999,
          indexedAt: Date.now() - 5000,
        },
      }),
    );

    mockFetch
      .mockResolvedValueOnce(makeJsonResponse(MANIFEST))
      .mockResolvedValueOnce(makeBufferResponse(FAKE_BUNDLE));

    const result = await handler({ repo: 'expressjs/express', force: true });
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);

    expect(parsed.source).toBe('registry');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws a clear error for unknown repo', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse(MANIFEST));

    await expect(handler({ repo: 'unknown/repo' })).rejects.toMatchObject({
      message: expect.stringContaining('not in the public registry'),
    });
  });

  it('throws a clear error for unknown version', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse(MANIFEST));

    await expect(handler({ repo: 'expressjs/express', version: 'v99.0.0' })).rejects.toMatchObject({
      message: expect.stringContaining('not found for expressjs/express'),
    });
  });

  it('throws on invalid repo format (missing slash)', async () => {
    await expect(handler({ repo: 'notaslug' })).rejects.toMatchObject({
      message: expect.stringContaining('Invalid repo format'),
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws when manifest fetch returns HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    await expect(handler({ repo: 'expressjs/express' })).rejects.toMatchObject({
      message: expect.stringContaining('manifest fetch failed'),
    });
  });

  it('throws when bundle download returns HTTP error', async () => {
    mockFetch
      .mockResolvedValueOnce(makeJsonResponse(MANIFEST))
      .mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }));

    await expect(handler({ repo: 'expressjs/express' })).rejects.toMatchObject({
      message: expect.stringContaining('download failed'),
    });
  });

  it('persists to registry-cache.json after successful download', async () => {
    mockFetch
      .mockResolvedValueOnce(makeJsonResponse(MANIFEST))
      .mockResolvedValueOnce(makeBufferResponse(FAKE_BUNDLE));

    await handler({ repo: 'expressjs/express' });

    const cachePath = join(testHome, '.purecontext', 'registry-cache.json');
    expect(existsSync(cachePath)).toBe(true);
    const { readFileSync } = await import('fs');
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(cache['expressjs/express']).toBeDefined();
    expect(cache['expressjs/express'].version).toBe('4.18.2');
  });
});

describe('fetchManifest', () => {
  it('returns the manifest from the registry', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse(MANIFEST));

    const manifest = await fetchManifest();
    expect(manifest.repos).toHaveLength(2);
    expect(manifest.repos[0].repo).toBe('expressjs/express');
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    await expect(fetchManifest()).rejects.toMatchObject({
      message: expect.stringContaining('manifest fetch failed'),
    });
  });
});
