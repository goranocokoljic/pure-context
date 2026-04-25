import { describe, it, expect, vi } from 'vitest';
import {
  AnthropicEmbedding,
  OpenAIEmbedding,
  LocalEmbedding,
  createEmbeddingProvider,
  type EmbedFetchFn,
} from '../../src/semantic/embedding-provider.js';
import { PureContextError } from '../../src/core/errors.js';
import type { PureContextConfig } from '../../src/config/config-schema.js';
import { DEFAULT_CONFIG } from '../../src/config/config-schema.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PureContextConfig> = {}): PureContextConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function makeSemanticConfig(
  provider: 'anthropic' | 'openai' | 'local' | 'none',
  extras: Partial<PureContextConfig['semantic']> = {},
): PureContextConfig['semantic'] {
  return { ...DEFAULT_CONFIG.semantic, provider, ...extras };
}

/** Build a mock fetch that returns a canned response. */
function mockFetch(response: unknown): EmbedFetchFn {
  return vi.fn().mockResolvedValue(response);
}

/** Build dimension-N random Float32Array. */
function fakeEmbedding(dim: number): number[] {
  return Array.from({ length: dim }, (_, i) => i / dim);
}

// ─── AnthropicEmbedding ───────────────────────────────────────────────────────

describe('AnthropicEmbedding', () => {
  it('has correct metadata', () => {
    const p = new AnthropicEmbedding('key');
    expect(p.name).toBe('anthropic');
    expect(p.dimension).toBe(1024);
    expect(p.maxTokens).toBe(4096);
  });

  it('embeds a small batch in a single API call', async () => {
    const embeddings = [fakeEmbedding(1024), fakeEmbedding(1024), fakeEmbedding(1024)];
    const fetch = mockFetch({ embeddings: embeddings.map((e) => ({ embedding: e })) });
    const provider = new AnthropicEmbedding('sk-test', fetch);

    const results = await provider.embed(['foo', 'bar', 'baz']);

    expect(fetch).toHaveBeenCalledOnce();
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r).toBeInstanceOf(Float32Array);
      expect(r.length).toBe(1024);
    }
  });

  it('sends correct request format', async () => {
    const fetch = mockFetch({ embeddings: [{ embedding: fakeEmbedding(1024) }] });
    const provider = new AnthropicEmbedding('sk-ant-key', fetch);
    await provider.embed(['hello world']);

    const [url, body, headers] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, string>,
    ];
    expect(url).toBe('https://api.anthropic.com/v1/embeddings');
    expect(body['inputs']).toEqual(['hello world']);
    expect(body['input_type']).toBe('document');
    expect(headers['x-api-key']).toBe('sk-ant-key');
    expect(headers['anthropic-version']).toBeTruthy();
  });

  it('batches requests when texts exceed batch size of 100', async () => {
    // 150 texts → 2 API calls (100 + 50)
    const texts = Array.from({ length: 150 }, (_, i) => `text-${i}`);
    const makeBatch = (n: number) => ({
      embeddings: Array.from({ length: n }, () => ({ embedding: fakeEmbedding(1024) })),
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce(makeBatch(100))
      .mockResolvedValueOnce(makeBatch(50));
    const provider = new AnthropicEmbedding('key', fetch);

    const results = await provider.embed(texts);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(150);
  });

  it('throws on API error response', async () => {
    const fetch: EmbedFetchFn = () =>
      Promise.reject(new PureContextError('Embedding API HTTP 401: Unauthorized'));
    const provider = new AnthropicEmbedding('bad-key', fetch);

    await expect(provider.embed(['text'])).rejects.toBeInstanceOf(PureContextError);
  });
});

// ─── OpenAIEmbedding ──────────────────────────────────────────────────────────

describe('OpenAIEmbedding', () => {
  it('has correct metadata', () => {
    const p = new OpenAIEmbedding('key');
    expect(p.name).toBe('openai');
    expect(p.dimension).toBe(1536);
    expect(p.maxTokens).toBe(8191);
  });

  it('embeds a small batch in a single API call', async () => {
    const data = [
      { embedding: fakeEmbedding(1536), index: 0 },
      { embedding: fakeEmbedding(1536), index: 1 },
    ];
    const fetch = mockFetch({ data });
    const provider = new OpenAIEmbedding('sk-openai', fetch);

    const results = await provider.embed(['a', 'b']);

    expect(fetch).toHaveBeenCalledOnce();
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r).toBeInstanceOf(Float32Array);
      expect(r.length).toBe(1536);
    }
  });

  it('sends correct request format', async () => {
    const fetch = mockFetch({ data: [{ embedding: fakeEmbedding(1536), index: 0 }] });
    const provider = new OpenAIEmbedding('sk-openai', fetch);
    await provider.embed(['test text']);

    const [url, body, headers] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, string>,
    ];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(body['model']).toBe('text-embedding-3-small');
    expect(body['input']).toEqual(['test text']);
    expect(headers['Authorization']).toBe('Bearer sk-openai');
  });

  it('respects index field for correct result ordering', async () => {
    // OpenAI may return results in any order — index field determines position
    const fetch = mockFetch({
      data: [
        { embedding: fakeEmbedding(1536).map(() => 2), index: 1 },
        { embedding: fakeEmbedding(1536).map(() => 1), index: 0 },
      ],
    });
    const provider = new OpenAIEmbedding('key', fetch);
    const results = await provider.embed(['first', 'second']);

    expect(results[0][0]).toBeCloseTo(1); // index 0 → all 1s
    expect(results[1][0]).toBeCloseTo(2); // index 1 → all 2s
  });

  it('batches at 2048 texts per call', async () => {
    const texts = Array.from({ length: 2050 }, (_, i) => `t${i}`);
    const makeBatch = (n: number) => ({
      data: Array.from({ length: n }, (_, i) => ({ embedding: fakeEmbedding(1536), index: i })),
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce(makeBatch(2048))
      .mockResolvedValueOnce(makeBatch(2));
    const provider = new OpenAIEmbedding('key', fetch);

    const results = await provider.embed(texts);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2050);
  });
});

// ─── LocalEmbedding ───────────────────────────────────────────────────────────

describe('LocalEmbedding', () => {
  it('has correct metadata', () => {
    const p = new LocalEmbedding('http://localhost:11434', 768);
    expect(p.name).toBe('local');
    expect(p.dimension).toBe(768);
    expect(p.maxTokens).toBe(512);
  });

  it('defaults dimension to 384', () => {
    const p = new LocalEmbedding('http://localhost:11434');
    expect(p.dimension).toBe(384);
  });

  it('embeds a batch via Ollama /api/embed', async () => {
    const embeddings = [fakeEmbedding(384), fakeEmbedding(384)];
    const fetch = mockFetch({ embeddings });
    const provider = new LocalEmbedding('http://localhost:11434', 384, fetch);

    const results = await provider.embed(['code snippet', 'another snippet']);

    expect(fetch).toHaveBeenCalledOnce();
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r).toBeInstanceOf(Float32Array);
      expect(r.length).toBe(384);
    }
  });

  it('sends correct request to /api/embed', async () => {
    const fetch = mockFetch({ embeddings: [fakeEmbedding(384)] });
    const provider = new LocalEmbedding('http://localhost:11434', 384, fetch);
    await provider.embed(['hello']);

    const [url, body] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, string>,
    ];
    expect(url).toBe('http://localhost:11434/api/embed');
    expect(body['model']).toBe('nomic-embed-text');
    expect(body['input']).toEqual(['hello']);
  });

  it('strips trailing slash from endpoint', async () => {
    const fetch = mockFetch({ embeddings: [fakeEmbedding(384)] });
    const provider = new LocalEmbedding('http://localhost:11434/', 384, fetch);
    await provider.embed(['hi']);

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('http://localhost:11434/api/embed');
  });
});

// ─── createEmbeddingProvider factory ─────────────────────────────────────────

describe('createEmbeddingProvider', () => {
  it("throws when provider is 'none'", () => {
    const config = makeConfig({ semantic: makeSemanticConfig('none') });
    expect(() => createEmbeddingProvider(config)).toThrow(PureContextError);
    expect(() => createEmbeddingProvider(config)).toThrow(/No embedding provider/);
  });

  it("returns AnthropicEmbedding when provider is 'anthropic'", () => {
    const config = makeConfig({
      semantic: makeSemanticConfig('anthropic'),
      ai: { ...DEFAULT_CONFIG.ai, apiKey: 'sk-ant' },
    });
    const provider = createEmbeddingProvider(config);
    expect(provider).toBeInstanceOf(AnthropicEmbedding);
    expect(provider.name).toBe('anthropic');
  });

  it("throws for 'anthropic' without API key", () => {
    const config = makeConfig({
      semantic: makeSemanticConfig('anthropic'),
      ai: { ...DEFAULT_CONFIG.ai, apiKey: '' },
    });
    // ensure env var is also absent
    const saved = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      expect(() => createEmbeddingProvider(config)).toThrow(PureContextError);
    } finally {
      if (saved !== undefined) process.env['ANTHROPIC_API_KEY'] = saved;
    }
  });

  it("returns OpenAIEmbedding when provider is 'openai'", () => {
    const config = makeConfig({
      semantic: makeSemanticConfig('openai'),
      ai: { ...DEFAULT_CONFIG.ai, openaiApiKey: 'sk-openai' },
    });
    const provider = createEmbeddingProvider(config);
    expect(provider).toBeInstanceOf(OpenAIEmbedding);
    expect(provider.name).toBe('openai');
  });

  it("throws for 'openai' without API key", () => {
    const config = makeConfig({
      semantic: makeSemanticConfig('openai'),
      ai: { ...DEFAULT_CONFIG.ai, openaiApiKey: '' },
    });
    const saved = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    try {
      expect(() => createEmbeddingProvider(config)).toThrow(PureContextError);
    } finally {
      if (saved !== undefined) process.env['OPENAI_API_KEY'] = saved;
    }
  });

  it("falls back to OPENAI_API_KEY env var", () => {
    const config = makeConfig({
      semantic: makeSemanticConfig('openai'),
      ai: { ...DEFAULT_CONFIG.ai, openaiApiKey: '' },
    });
    process.env['OPENAI_API_KEY'] = 'sk-from-env';
    try {
      const provider = createEmbeddingProvider(config);
      expect(provider).toBeInstanceOf(OpenAIEmbedding);
    } finally {
      delete process.env['OPENAI_API_KEY'];
    }
  });

  it("returns LocalEmbedding when provider is 'local'", () => {
    const config = makeConfig({
      semantic: makeSemanticConfig('local', {
        localEmbeddingEndpoint: 'http://localhost:11434',
      }),
    });
    const provider = createEmbeddingProvider(config);
    expect(provider).toBeInstanceOf(LocalEmbedding);
    expect(provider.name).toBe('local');
  });

  it("throws for 'local' without endpoint", () => {
    const config = makeConfig({
      semantic: makeSemanticConfig('local', { localEmbeddingEndpoint: null }),
    });
    expect(() => createEmbeddingProvider(config)).toThrow(PureContextError);
    expect(() => createEmbeddingProvider(config)).toThrow(/endpoint/);
  });

  it('uses semantic.dimension for local provider', () => {
    const config = makeConfig({
      semantic: makeSemanticConfig('local', {
        localEmbeddingEndpoint: 'http://localhost:11434',
        dimension: 768,
      }),
    });
    const provider = createEmbeddingProvider(config) as LocalEmbedding;
    expect(provider.dimension).toBe(768);
  });

  it('passes custom fetch fn through', async () => {
    const fetch = mockFetch({ embeddings: [{ embedding: fakeEmbedding(1024) }] });
    const config = makeConfig({
      semantic: makeSemanticConfig('anthropic'),
      ai: { ...DEFAULT_CONFIG.ai, apiKey: 'sk-ant' },
    });
    const provider = createEmbeddingProvider(config, fetch);
    await provider.embed(['test']);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
