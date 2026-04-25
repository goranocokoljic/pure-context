import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createAISummarizer,
  buildPrompt,
  buildSimplePrompt,
  summarizeBatchWithRetry,
  parseResponse,
} from '../../src/summarizer/ai-summarizer.js';
import type { HttpRequestFn, FetchFn } from '../../src/summarizer/ai-summarizer.js';
import type { SymbolRecord } from '../../src/core/types.js';
import type { IncomingMessage, ClientRequest } from 'http';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sym(overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    id: 'aabbccddeeff0011',
    name: 'testFn',
    kind: 'function',
    filePath: 'src/test.ts',
    startByte: 0,
    endByte: 100,
    signature: 'function testFn(): void',
    summary: '',
    ...overrides,
  };
}

/**
 * Build a fake HttpRequestFn that immediately calls the response callback
 * with a fake IncomingMessage emitting the given body and statusCode.
 */
function fakeHttpClient(statusCode: number, body: string): HttpRequestFn {
  return ((_opts: unknown, cb: unknown) => {
    const callback = cb as (res: Partial<IncomingMessage>) => void;

    // Simulate an IncomingMessage that emits data then end
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const res: Partial<IncomingMessage> = {
      statusCode,
      on(event: string, listener: (...args: unknown[]) => void) {
        (handlers[event] ??= []).push(listener);
        return res as IncomingMessage;
      },
    };

    callback(res);

    // Fire data and end events synchronously (next microtask)
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
  }) as unknown as HttpRequestFn;
}

/**
 * Build a fake HttpRequestFn that immediately emits a 'error' event on the
 * request object, simulating a network error.
 */
function fakeErrorClient(): HttpRequestFn {
  return ((_opts: unknown, _cb: unknown) => {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const req: Partial<ClientRequest> = {
      on(event: string, listener: (...args: unknown[]) => void) {
        (handlers[event] ??= []).push(listener);
        return req as ClientRequest;
      },
      write: () => true,
      end() {
        setTimeout(() => {
          for (const fn of handlers['error'] ?? []) fn(new Error('Network error'));
        }, 0);
        return req as ClientRequest;
      },
    };
    return req as ClientRequest;
  }) as unknown as HttpRequestFn;
}

// ─── createAISummarizer — disabled / no API key ───────────────────────────────

describe('createAISummarizer — disabled', () => {
  it('returns null when enabled is false', () => {
    expect(createAISummarizer({ enabled: false })).toBeNull();
  });

  it('returns null when enabled is false even if API key is set', () => {
    const original = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    try {
      expect(createAISummarizer({ enabled: false })).toBeNull();
    } finally {
      if (original === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = original;
    }
  });

  it('returns null when enabled is true but no API key', () => {
    const original = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      expect(createAISummarizer({ enabled: true })).toBeNull();
    } finally {
      if (original !== undefined) process.env['ANTHROPIC_API_KEY'] = original;
    }
  });
});

// ─── createAISummarizer — enabled with API key ────────────────────────────────

describe('createAISummarizer — enabled', () => {
  beforeEach(() => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-key';
  });

  afterEach(() => {
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('returns an AISummarizer when enabled and API key present', () => {
    const summarizer = createAISummarizer({ enabled: true });
    expect(summarizer).not.toBeNull();
    expect(typeof summarizer?.summarizeBatch).toBe('function');
  });

  it('summarizeBatch returns empty Map for empty input without making HTTP calls', async () => {
    let called = false;
    const noCallClient: HttpRequestFn = (() => { called = true; }) as unknown as HttpRequestFn;
    const summarizer = createAISummarizer({ enabled: true }, noCallClient);
    const result = await summarizer!.summarizeBatch([]);
    expect(result.size).toBe(0);
    expect(called).toBe(false);
  });

  it('returns empty Map on network error (graceful degradation)', async () => {
    const summarizer = createAISummarizer({ enabled: true }, fakeErrorClient());
    const result = await summarizer!.summarizeBatch([sym()]);
    expect(result.size).toBe(0);
  });
});

// ─── Response parsing ─────────────────────────────────────────────────────────

describe('createAISummarizer — response parsing', () => {
  beforeEach(() => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-key';
  });

  afterEach(() => {
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('parses id: summary lines from model response', async () => {
    const responseBody = JSON.stringify({
      content: [{ type: 'text', text: 'aabbccddeeff0011: Validates user input\n' }],
    });
    const client = fakeHttpClient(200, responseBody);
    const summarizer = createAISummarizer({ enabled: true }, client);
    const result = await summarizer!.summarizeBatch([sym({ id: 'aabbccddeeff0011' })]);
    expect(result.get('aabbccddeeff0011')).toBe('Validates user input');
  });

  it('ignores lines whose id is not in the expected set', async () => {
    const responseBody = JSON.stringify({
      content: [{ type: 'text', text: 'unknown-id: Some summary\ngarbage line\n' }],
    });
    const client = fakeHttpClient(200, responseBody);
    const summarizer = createAISummarizer({ enabled: true }, client);
    const result = await summarizer!.summarizeBatch([sym({ id: 'aabbccddeeff0011' })]);
    expect(result.size).toBe(0);
  });

  it('returns empty Map on API error status (graceful degradation)', async () => {
    const client = fakeHttpClient(401, '{"error":"unauthorized"}');
    const summarizer = createAISummarizer({ enabled: true }, client);
    const result = await summarizer!.summarizeBatch([sym()]);
    expect(result.size).toBe(0);
  });

  it('handles multiple symbols in one response', async () => {
    const symbols = [
      sym({ id: 'id0000000001', name: 'foo' }),
      sym({ id: 'id0000000002', name: 'bar' }),
    ];
    const responseBody = JSON.stringify({
      content: [{
        type: 'text',
        text: 'id0000000001: Does foo things\nid0000000002: Does bar things\n',
      }],
    });
    const client = fakeHttpClient(200, responseBody);
    const summarizer = createAISummarizer({ enabled: true }, client);
    const result = await summarizer!.summarizeBatch(symbols);
    expect(result.get('id0000000001')).toBe('Does foo things');
    expect(result.get('id0000000002')).toBe('Does bar things');
  });

  it('returns empty Map when response JSON is malformed (graceful degradation)', async () => {
    const client = fakeHttpClient(200, 'not-json{{{');
    const summarizer = createAISummarizer({ enabled: true }, client);
    const result = await summarizer!.summarizeBatch([sym()]);
    expect(result.size).toBe(0);
  });

  it('uses custom model from config', async () => {
    let capturedBody = '';
    const capturingClient: HttpRequestFn = ((_opts: unknown, cb: unknown) => {
      const callback = cb as (res: Partial<IncomingMessage>) => void;
      const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
      const res: Partial<IncomingMessage> = {
        statusCode: 200,
        on(event: string, listener: (...args: unknown[]) => void) {
          (handlers[event] ??= []).push(listener);
          return res as IncomingMessage;
        },
      };
      callback(res);
      setTimeout(() => {
        // Return a result so no retry is triggered — keeps capturedBody a single JSON object
        const text = `${sym().id}: Does the thing`;
        const body = JSON.stringify({ content: [{ type: 'text', text }] });
        for (const fn of handlers['data'] ?? []) fn(Buffer.from(body));
        for (const fn of handlers['end'] ?? []) fn();
      }, 0);

      const req: Partial<ClientRequest> = {
        on(_ev: string, _fn: (...args: unknown[]) => void) { return req as ClientRequest; },
        write(chunk: unknown) { capturedBody += chunk; return true; },
        end: () => req as ClientRequest,
      };
      return req as ClientRequest;
    }) as unknown as HttpRequestFn;

    const summarizer = createAISummarizer(
      { enabled: true, model: 'claude-opus-4-6' },
      capturingClient,
    );
    await summarizer!.summarizeBatch([sym()]);
    expect(JSON.parse(capturedBody).model).toBe('claude-opus-4-6');
  });
});

// ─── buildPrompt / buildSimplePrompt ──────────────────────────────────────────

describe('buildPrompt', () => {
  it('includes filePath in the prompt', () => {
    const s = sym({ filePath: 'src/core/utils.ts' });
    const prompt = buildPrompt([s]);
    expect(prompt).toContain('src/core/utils.ts');
  });

  it('includes parent hint for methods with dot-qualified names', () => {
    const s = sym({ kind: 'method', name: 'MyClass.doThing' });
    const prompt = buildPrompt([s]);
    expect(prompt).toContain('parent=MyClass');
  });

  it('does not include parent hint for non-method symbols', () => {
    const s = sym({ kind: 'function', name: 'myFunc' });
    const prompt = buildPrompt([s]);
    expect(prompt).not.toContain('parent=');
  });

  it('includes the symbol id', () => {
    const s = sym({ id: 'abc123' });
    expect(buildPrompt([s])).toContain('abc123');
  });

  it('buildSimplePrompt omits filePath', () => {
    const s = sym({ filePath: 'src/core/utils.ts' });
    const simple = buildSimplePrompt([s]);
    expect(simple).not.toContain('src/core/utils.ts');
  });

  it('buildSimplePrompt still includes id and signature', () => {
    const s = sym({ id: 'xyz', signature: 'function foo(): void' });
    const simple = buildSimplePrompt([s]);
    expect(simple).toContain('xyz');
    expect(simple).toContain('function foo(): void');
  });
});

// ─── summarizeBatchWithRetry ──────────────────────────────────────────────────

describe('summarizeBatchWithRetry', () => {
  it('returns results from first attempt when non-empty', async () => {
    const s = sym({ id: 'id001' });
    let callCount = 0;

    const sendPrompt = async (_prompt: string): Promise<string> => {
      callCount++;
      return 'id001: Validates input data';
    };

    const result = await summarizeBatchWithRetry([s], sendPrompt);
    expect(result.get('id001')).toBe('Validates input data');
    expect(callCount).toBe(1); // no retry needed
  });

  it('retries with simpler prompt when first response parses to 0 results', async () => {
    const s = sym({ id: 'id002' });
    let callCount = 0;

    const sendPrompt = async (_prompt: string): Promise<string> => {
      callCount++;
      if (callCount === 1) return 'no parseable content here';
      return 'id002: Renders the user profile';
    };

    const result = await summarizeBatchWithRetry([s], sendPrompt);
    expect(result.get('id002')).toBe('Renders the user profile');
    expect(callCount).toBe(2);
  });

  it('returns empty map when both attempts fail to parse', async () => {
    const s = sym({ id: 'id003' });
    const sendPrompt = async (): Promise<string> => 'garbage output';
    const result = await summarizeBatchWithRetry([s], sendPrompt);
    expect(result.size).toBe(0);
  });
});

// ─── OpenAI-compatible provider ───────────────────────────────────────────────

describe('createAISummarizer — openai-compatible', () => {
  it('returns null when endpoint is missing', () => {
    const summarizer = createAISummarizer({
      enabled: true,
      provider: 'openai-compatible',
      apiKey: 'sk-test',
      endpoint: null,
    });
    expect(summarizer).toBeNull();
  });

  it('returns null when enabled is false', () => {
    const summarizer = createAISummarizer({
      enabled: false,
      provider: 'openai-compatible',
      endpoint: 'http://localhost:11434',
    });
    expect(summarizer).toBeNull();
  });

  it('calls the OpenAI-compatible endpoint with correct payload', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};

    const mockFetch: FetchFn = async (url, init) => {
      capturedUrl = url as string;
      capturedBody = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
      const responseBody = JSON.stringify({
        choices: [{ message: { role: 'assistant', content: `${sym().id}: Test summary` } }],
      });
      return new Response(responseBody, { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const summarizer = createAISummarizer(
      { enabled: true, provider: 'openai-compatible', endpoint: 'http://localhost:11434', apiKey: 'ollama', model: 'llama3' },
      httpsRequest as HttpRequestFn,
      mockFetch,
    );

    await summarizer!.summarizeBatch([sym()]);

    expect(capturedUrl).toBe('http://localhost:11434/v1/chat/completions');
    expect(capturedBody['model']).toBe('llama3');
    expect(Array.isArray(capturedBody['messages'])).toBe(true);
  });

  it('parses OpenAI-compatible response correctly', async () => {
    const s = sym({ id: 'oc-id-001' });

    const mockFetch: FetchFn = async () => {
      const body = JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'oc-id-001: Handles auth flow' } }],
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const summarizer = createAISummarizer(
      { enabled: true, provider: 'openai-compatible', endpoint: 'http://localhost:11434', apiKey: '' },
      httpsRequest as HttpRequestFn,
      mockFetch,
    );

    const result = await summarizer!.summarizeBatch([s]);
    expect(result.get('oc-id-001')).toBe('Handles auth flow');
  });

  it('returns empty Map on fetch error (graceful degradation)', async () => {
    const mockFetch: FetchFn = async () => { throw new Error('connection refused'); };

    const summarizer = createAISummarizer(
      { enabled: true, provider: 'openai-compatible', endpoint: 'http://localhost:11434', apiKey: '' },
      httpsRequest as HttpRequestFn,
      mockFetch,
    );

    const result = await summarizer!.summarizeBatch([sym()]);
    expect(result.size).toBe(0);
  });

  it('uses default model gpt-4o-mini when model not specified', async () => {
    let capturedBody: Record<string, unknown> = {};

    const mockFetch: FetchFn = async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const summarizer = createAISummarizer(
      { enabled: true, provider: 'openai-compatible', endpoint: 'http://localhost:11434', apiKey: '' },
      httpsRequest as HttpRequestFn,
      mockFetch,
    );

    await summarizer!.summarizeBatch([sym()]);
    expect(capturedBody['model']).toBe('gpt-4o-mini');
  });
});

// We need httpsRequest as a type placeholder for tests above
import { request as httpsRequest } from 'https';

// ─── parseResponse ────────────────────────────────────────────────────────────

describe('parseResponse', () => {
  it('extracts id:summary pairs', () => {
    const text = 'abc123: Does something\ndef456: Does another thing\n';
    const ids = new Set(['abc123', 'def456']);
    const map = parseResponse(text, ids);
    expect(map.get('abc123')).toBe('Does something');
    expect(map.get('def456')).toBe('Does another thing');
  });

  it('ignores lines with unknown ids', () => {
    const text = 'unknownId: Some summary\n';
    const ids = new Set(['knownId']);
    expect(parseResponse(text, ids).size).toBe(0);
  });
});
