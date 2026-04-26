import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Mock config-loader before importing telemetry ───────────────────────────

vi.mock('../../src/config/config-loader.js', () => ({
  getConfig: vi.fn(),
}));

// ─── Mock fs operations to avoid writing to disk ─────────────────────────────

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
  };
});

import { getConfig } from '../../src/config/config-loader.js';
import { track, isTelemetryEnabled } from '../../src/core/telemetry.js';

const mockGetConfig = vi.mocked(getConfig);
const mockAppendFileSync = vi.mocked(appendFileSync);

function makeConfig(enabled: boolean, endpoint?: string) {
  return {
    telemetry: {
      enabled,
      endpoint: endpoint ?? 'https://telemetry.purecontext.dev/v1/event',
    },
  } as ReturnType<typeof getConfig>;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('isTelemetryEnabled', () => {
  it('returns false when config has enabled: false', () => {
    mockGetConfig.mockReturnValue(makeConfig(false));
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('returns true when config has enabled: true', () => {
    mockGetConfig.mockReturnValue(makeConfig(true));
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('returns false when getConfig throws', () => {
    mockGetConfig.mockImplementation(() => { throw new Error('no config'); });
    expect(isTelemetryEnabled()).toBe(false);
  });
});

describe('track — telemetry disabled', () => {
  beforeEach(() => {
    mockGetConfig.mockReturnValue(makeConfig(false));
    vi.clearAllMocks();
  });

  it('does not write to local JSONL file', async () => {
    await track({ event: 'index_complete', fileCount: 42 });
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('does not make network calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    await track({ event: 'index_complete', fileCount: 42 });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('returns immediately without throwing', async () => {
    await expect(track({ event: 'index_complete' })).resolves.toBeUndefined();
  });
});

describe('track — telemetry enabled', () => {
  beforeEach(() => {
    mockGetConfig.mockReturnValue(makeConfig(true, 'https://example.com/telemetry'));
    vi.clearAllMocks();
  });

  it('appends to the local telemetry.jsonl file', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    await track({ event: 'index_complete', fileCount: 10 });

    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const [filePath, data] = mockAppendFileSync.mock.calls[0] as [string, string, string];
    expect(filePath).toBe(join(homedir(), '.purecontext', 'telemetry.jsonl'));
    expect(data).toContain('index_complete');
    fetchSpy.mockRestore();
  });

  it('POSTs correct payload shape to the configured endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    await track({ event: 'server_start', fileCount: 99 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/telemetry');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['event']).toBe('server_start');
    expect(body['version']).toBeDefined();
    expect(body['nodeVersion']).toBeDefined();
    expect(body['platform']).toBeDefined();
    expect(body['sessionId']).toBeDefined();
    expect(body['timestamp']).toBeDefined();
    fetchSpy.mockRestore();
  });

  it('does not throw when network request fails', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    await expect(track({ event: 'index_complete' })).resolves.toBeUndefined();
    fetchSpy.mockRestore();
  });

  it('does not throw when network returns non-2xx', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    await expect(track({ event: 'index_complete' })).resolves.toBeUndefined();
    fetchSpy.mockRestore();
  });
});

describe('track — PII sanitization', () => {
  beforeEach(() => {
    mockGetConfig.mockReturnValue(makeConfig(true));
  });

  it('strips filePath from payload', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    await track({ event: 'test', filePath: '/home/user/project/src/index.ts' });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body['filePath']).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it('strips symbolName from payload', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    await track({ event: 'test', symbolName: 'mySecretFunction' });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body['symbolName']).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it('strips string values that look like file paths', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    await track({ event: 'test', someField: '/absolute/path/here' });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body['someField']).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it('keeps safe numeric and array fields', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    await track({ event: 'index_complete', fileCount: 100, languages: ['typescript', 'javascript'] });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body['fileCount']).toBe(100);
    expect(body['languages']).toEqual(['typescript', 'javascript']);
    fetchSpy.mockRestore();
  });
});
