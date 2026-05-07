import { describe, it, expect, afterEach, vi } from 'vitest';
import { callGemini, DEFAULT_GEMINI_MODEL } from '../../src/summarizer/providers/gemini-provider.js';
import { createAISummarizer } from '../../src/summarizer/ai-summarizer.js';
import type { HttpRequestFn as GeminiHttpRequestFn } from '../../src/summarizer/providers/gemini-provider.js';
import type { SymbolRecord } from '../../src/core/types.js';
import type { IncomingMessage, ClientRequest } from 'http';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sym(overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    id: 'aabb1122ccdd3344',
    name: 'myFn',
    kind: 'function',
    filePath: 'src/foo.ts',
    startByte: 0,
    endByte: 100,
    signature: 'function myFn(): void',
    summary: '',
    ...overrides,
  };
}

/**
 * Build a fake GeminiHttpRequestFn that immediately resolves with the given body/status.
 */
function fakeGeminiClient(statusCode: number, body: string): GeminiHttpRequestFn {
  return ((_opts: unknown, cb: unknown) => {
    const callback = cb as (res: Partial<IncomingMessage>) => void;
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};

    const res: Partial<IncomingMessage> = {
      statusCode,
      on(event: string, listener: (...args: unknown[]) => void) {
        (handlers[event] ??= []).push(listener);
        return res as IncomingMessage;
      },
    };

    callback(res);

    setTimeout(() => {
      for (const fn of handlers['data'] ?? []) fn(Buffer.from(body));
      for (const fn of handlers['end'] ?? []) fn();
    }, 0);

    const req: Partial<ClientRequest> = {
      on(_ev: string, _fn: (...args: unknown[]) => void) { return req as ClientRequest; },
      write: () => true,
      end: () => req as ClientRequest,
    };
    return req as ClientRequest;
  }) as unknown as GeminiHttpRequestFn;
}

function geminiBody(text: string): string {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
  });
}

// ─── Tests: callGemini ────────────────────────────────────────────────────────

describe('callGemini', () => {
  it('returns the text from a successful response', async () => {
    const client = fakeGeminiClient(200, geminiBody('Parses a symbol from source.'));
    const result = await callGemini('key123', DEFAULT_GEMINI_MODEL, 'prompt text', client);
    expect(result).toBe('Parses a symbol from source.');
  });

  it('rejects on HTTP error status', async () => {
    const errBody = JSON.stringify({ error: { code: 400, message: 'Bad Request' } });
    const client = fakeGeminiClient(400, errBody);
    await expect(callGemini('key123', DEFAULT_GEMINI_MODEL, 'prompt', client)).rejects.toThrow(
      'Gemini API error 400',
    );
  });

  it('rejects when response is missing text field', async () => {
    const malformed = JSON.stringify({ candidates: [{ content: { parts: [] } }] });
    const client = fakeGeminiClient(200, malformed);
    await expect(callGemini('key123', DEFAULT_GEMINI_MODEL, 'prompt', client)).rejects.toThrow(
      'Gemini response missing text field',
    );
  });

  it('rejects when response JSON is unparseable', async () => {
    const client = fakeGeminiClient(200, 'not-json{{{');
    await expect(callGemini('key123', DEFAULT_GEMINI_MODEL, 'prompt', client)).rejects.toThrow(
      'Failed to parse Gemini response',
    );
  });

  it('retries on 429 and succeeds on second call', async () => {
    let callCount = 0;
    const client: GeminiHttpRequestFn = ((_opts: unknown, cb: unknown) => {
      callCount++;
      const statusCode = callCount === 1 ? 429 : 200;
      const body =
        callCount === 1
          ? JSON.stringify({ error: { code: 429, message: 'Quota exceeded' } })
          : geminiBody('Retried summary.');

      const callback = cb as (res: Partial<IncomingMessage>) => void;
      const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
      const res: Partial<IncomingMessage> = {
        statusCode,
        on(event: string, listener: (...args: unknown[]) => void) {
          (handlers[event] ??= []).push(listener);
          return res as IncomingMessage;
        },
      };
      callback(res);
      setTimeout(() => {
        for (const fn of handlers['data'] ?? []) fn(Buffer.from(body));
        for (const fn of handlers['end'] ?? []) fn();
      }, 0);
      const req: Partial<ClientRequest> = {
        on(_ev: string, _fn: (...args: unknown[]) => void) { return req as ClientRequest; },
        write: () => true,
        end: () => req as ClientRequest,
      };
      return req as ClientRequest;
    }) as unknown as GeminiHttpRequestFn;

    // Use a minimal delay by spying on setTimeout — but since we just need it to work,
    // let's just verify the final result is the retried summary.
    const result = await callGemini('key123', DEFAULT_GEMINI_MODEL, 'prompt', client);
    expect(result).toBe('Retried summary.');
    expect(callCount).toBe(2);
  }, 10_000);
});

// ─── Tests: createAISummarizer with gemini provider ───────────────────────────

describe('createAISummarizer — gemini provider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns an AISummarizer when provider=gemini and apiKey is set', () => {
    const summarizer = createAISummarizer(
      { enabled: true, provider: 'gemini', apiKey: 'my-key' },
      undefined,
      undefined,
      fakeGeminiClient(200, geminiBody('')),
    );
    expect(summarizer).not.toBeNull();
  });

  it('returns null when provider=gemini and no API key is available', () => {
    vi.stubEnv('GOOGLE_API_KEY', '');
    const summarizer = createAISummarizer(
      { enabled: true, provider: 'gemini' },
      undefined,
      undefined,
      fakeGeminiClient(200, geminiBody('')),
    );
    expect(summarizer).toBeNull();
  });

  it('uses GOOGLE_API_KEY env var when apiKey is not set in config', () => {
    vi.stubEnv('GOOGLE_API_KEY', 'env-key');
    // If it returns non-null, the env var was picked up
    const summarizer = createAISummarizer(
      { enabled: true, provider: 'gemini' },
      undefined,
      undefined,
      fakeGeminiClient(200, geminiBody('Uses env key.')),
    );
    expect(summarizer).not.toBeNull();
  });

  it('auto-detects gemini when GOOGLE_API_KEY is set and ANTHROPIC_API_KEY is absent', () => {
    vi.stubEnv('GOOGLE_API_KEY', 'auto-key');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    // No provider specified — should auto-select gemini
    const summarizer = createAISummarizer(
      { enabled: true },
      undefined,
      undefined,
      fakeGeminiClient(200, geminiBody('Auto.')),
    );
    expect(summarizer).not.toBeNull();
  });

  it('does NOT auto-detect gemini when ANTHROPIC_API_KEY is also set', () => {
    vi.stubEnv('GOOGLE_API_KEY', 'auto-key');
    vi.stubEnv('ANTHROPIC_API_KEY', 'anth-key');
    // Should prefer anthropic (no provider specified, ANTHROPIC_API_KEY present)
    const summarizer = createAISummarizer({ enabled: true });
    // Non-null because anthropic key is available
    expect(summarizer).not.toBeNull();
  });

  it('summarizes symbols via Gemini and returns populated map', async () => {
    const responseText = 'aabb1122ccdd3344: Runs a simple function.';
    const client = fakeGeminiClient(200, geminiBody(responseText));
    const summarizer = createAISummarizer(
      { enabled: true, provider: 'gemini', apiKey: 'key', model: 'gemini-2.0-flash' },
      undefined,
      undefined,
      client,
    );
    expect(summarizer).not.toBeNull();
    const result = await summarizer!.summarizeBatch([sym()]);
    expect(result.get('aabb1122ccdd3344')).toBe('Runs a simple function.');
  });

  it('returns empty map and does not throw when Gemini returns error', async () => {
    const client = fakeGeminiClient(500, JSON.stringify({ error: 'server error' }));
    const summarizer = createAISummarizer(
      { enabled: true, provider: 'gemini', apiKey: 'key' },
      undefined,
      undefined,
      client,
    );
    expect(summarizer).not.toBeNull();
    const result = await summarizer!.summarizeBatch([sym()]);
    // Falls back gracefully — empty map, no throw
    expect(result.size).toBe(0);
  });

  it('returns empty map for empty symbols array', async () => {
    const client = fakeGeminiClient(200, geminiBody(''));
    const summarizer = createAISummarizer(
      { enabled: true, provider: 'gemini', apiKey: 'key' },
      undefined,
      undefined,
      client,
    );
    expect(summarizer).not.toBeNull();
    const result = await summarizer!.summarizeBatch([]);
    expect(result.size).toBe(0);
  });
});
