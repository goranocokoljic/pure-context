/**
 * Embedding provider abstraction for Phase 11 semantic search.
 *
 * Supported providers:
 *   'anthropic' — Anthropic embedding endpoint (uses ai.apiKey / ANTHROPIC_API_KEY)
 *   'openai'    — OpenAI text-embedding-3-small (uses ai.openaiApiKey / OPENAI_API_KEY)
 *   'local'     — Ollama or any local /api/embed endpoint (no API key)
 *
 * All providers return Float32Array for memory efficiency.
 * Batch embedding reduces API round trips.
 */

import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import type { PureContextConfig } from '../config/config-schema.js';
import { PureContextError } from '../core/errors.js';
import { logger } from '../core/logger.js';

// ─── Public interface ─────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  name: string;
  /** Vector dimensionality produced by this provider. */
  dimension: number;
  /** Approximate max input tokens per text (used for truncation). */
  maxTokens: number;
  /** Embed a batch of texts. Returns one Float32Array per input text, in order. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

// ─── Internal HTTP helper ─────────────────────────────────────────────────────

/**
 * Minimal injectable HTTP POST function for testability.
 * Accepts a URL, JSON body, and headers; resolves with the parsed JSON response.
 */
export type EmbedFetchFn = (
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
) => Promise<unknown>;

function defaultEmbedFetch(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (err) {
      reject(new PureContextError(`Invalid embedding endpoint URL: ${url}`, err));
      return;
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const port = parsedUrl.port
      ? Number(parsedUrl.port)
      : isHttps ? 443 : 80;

    const req = reqFn(
      {
        hostname: parsedUrl.hostname,
        port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            reject(new PureContextError(`Embedding API returned non-JSON response: ${text.slice(0, 200)}`));
            return;
          }
          if (res.statusCode !== undefined && res.statusCode >= 400) {
            reject(new PureContextError(`Embedding API HTTP ${res.statusCode}: ${text.slice(0, 400)}`));
            return;
          }
          resolve(parsed);
        });
      },
    );

    req.on('error', (err: Error) =>
      reject(new PureContextError('Embedding API network error', err)),
    );
    req.write(bodyStr);
    req.end();
  });
}

// ─── Anthropic provider ───────────────────────────────────────────────────────

interface AnthropicEmbedResponse {
  embeddings: Array<{ embedding: number[] }>;
}

export class AnthropicEmbedding implements EmbeddingProvider {
  readonly name = 'anthropic';
  readonly dimension = 1024;
  readonly maxTokens = 4096;

  private static readonly BATCH_SIZE = 100;
  private static readonly ENDPOINT = 'https://api.anthropic.com/v1/embeddings';

  private readonly apiKey: string;
  private readonly fetch: EmbedFetchFn;

  constructor(apiKey: string, fetch: EmbedFetchFn = defaultEmbedFetch) {
    this.apiKey = apiKey;
    this.fetch = fetch;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += AnthropicEmbedding.BATCH_SIZE) {
      const batch = texts.slice(i, i + AnthropicEmbedding.BATCH_SIZE);
      logger.debug('AnthropicEmbedding: embedding batch', { offset: i, size: batch.length });
      const data = (await this.fetch(
        AnthropicEmbedding.ENDPOINT,
        { inputs: batch, input_type: 'document' },
        {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
      )) as AnthropicEmbedResponse;
      for (const item of data.embeddings) {
        results.push(new Float32Array(item.embedding));
      }
    }
    return results;
  }
}

// ─── OpenAI provider ──────────────────────────────────────────────────────────

interface OpenAIEmbedResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

export class OpenAIEmbedding implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimension = 1536;
  readonly maxTokens = 8191;

  private static readonly BATCH_SIZE = 2048;
  private static readonly MODEL = 'text-embedding-3-small';
  private static readonly ENDPOINT = 'https://api.openai.com/v1/embeddings';

  private readonly apiKey: string;
  private readonly fetch: EmbedFetchFn;

  constructor(apiKey: string, fetch: EmbedFetchFn = defaultEmbedFetch) {
    this.apiKey = apiKey;
    this.fetch = fetch;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = new Array(texts.length);
    for (let i = 0; i < texts.length; i += OpenAIEmbedding.BATCH_SIZE) {
      const batch = texts.slice(i, i + OpenAIEmbedding.BATCH_SIZE);
      logger.debug('OpenAIEmbedding: embedding batch', { offset: i, size: batch.length });
      const data = (await this.fetch(
        OpenAIEmbedding.ENDPOINT,
        { model: OpenAIEmbedding.MODEL, input: batch },
        { Authorization: `Bearer ${this.apiKey}` },
      )) as OpenAIEmbedResponse;
      // OpenAI returns results with an index field — respect it for correct ordering
      for (const item of data.data) {
        results[i + item.index] = new Float32Array(item.embedding);
      }
    }
    return results;
  }
}

// ─── Local provider ───────────────────────────────────────────────────────────

interface OllamaEmbedResponse {
  embeddings: number[][];
}

export class LocalEmbedding implements EmbeddingProvider {
  readonly name = 'local';
  readonly maxTokens = 512;
  dimension: number;

  private readonly endpoint: string;
  private readonly fetch: EmbedFetchFn;

  constructor(
    endpoint: string,
    dimension: number = 384,
    fetch: EmbedFetchFn = defaultEmbedFetch,
  ) {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.dimension = dimension;
    this.fetch = fetch;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    logger.debug('LocalEmbedding: embedding batch', { size: texts.length, endpoint: this.endpoint });
    const data = (await this.fetch(
      `${this.endpoint}/api/embed`,
      { model: 'nomic-embed-text', input: texts },
      {},
    )) as OllamaEmbedResponse;
    return data.embeddings.map((e) => new Float32Array(e));
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an EmbeddingProvider from the current config.
 * Throws `PureContextError` if `semantic.provider` is 'none' or required config is missing.
 *
 * Pass `fetch` to inject a custom HTTP function (useful in tests).
 */
export function createEmbeddingProvider(
  config: PureContextConfig,
  fetch?: EmbedFetchFn,
): EmbeddingProvider {
  const { provider } = config.semantic;

  if (provider === 'none') {
    throw new PureContextError(
      "No embedding provider configured. Set semantic.provider to 'anthropic', 'openai', or 'local' in config.json.",
    );
  }

  if (provider === 'anthropic') {
    const apiKey = config.ai.apiKey || process.env['ANTHROPIC_API_KEY'] || '';
    if (!apiKey) {
      throw new PureContextError(
        'Anthropic embedding provider requires an API key. ' +
          'Set ai.apiKey in config.json or the ANTHROPIC_API_KEY environment variable.',
      );
    }
    return new AnthropicEmbedding(apiKey, fetch);
  }

  if (provider === 'openai') {
    const apiKey = config.ai.openaiApiKey || process.env['OPENAI_API_KEY'] || '';
    if (!apiKey) {
      throw new PureContextError(
        'OpenAI embedding provider requires an API key. ' +
          'Set ai.openaiApiKey in config.json or the OPENAI_API_KEY environment variable.',
      );
    }
    return new OpenAIEmbedding(apiKey, fetch);
  }

  // local
  const endpoint = config.semantic.localEmbeddingEndpoint;
  if (!endpoint) {
    throw new PureContextError(
      'Local embedding provider requires an endpoint URL. ' +
        'Set semantic.localEmbeddingEndpoint in config.json.',
    );
  }
  const dimension = config.semantic.dimension ?? 384;
  return new LocalEmbedding(endpoint, dimension, fetch);
}
