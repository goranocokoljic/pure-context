/**
 * Embedding provider abstraction for semantic search.
 *
 * Supports:
 *   voyage            — Voyage AI (voyage-code-2; recommended for code)
 *   openai-compatible — any /v1/embeddings endpoint (Ollama, OpenAI, etc.)
 *
 * Returns null when no provider is configured.
 */

import { logger } from '../core/logger.js';
import type { PureContextConfig } from '../config/config-schema.js';

// ─── Interface ────────────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  /** Embed one or more texts. Returns one float array per input text. */
  embed(texts: string[]): Promise<number[][]>;
}

// ─── Cosine similarity ────────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two float vectors.
 * Both vectors must have the same length. Returns a value in [-1, 1].
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Float32Array serialization ───────────────────────────────────────────────

/** Serialize a number[] to a Buffer of 32-bit floats (little-endian). */
export function packEmbedding(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer);
}

/** Deserialize a Buffer of 32-bit floats back to number[]. */
export function unpackEmbedding(buf: Buffer): number[] {
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f32);
}

// ─── Voyage AI provider ───────────────────────────────────────────────────────

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const DEFAULT_VOYAGE_MODEL = 'voyage-code-2';

class VoyageEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Voyage AI embedding failed (${response.status}): ${text}`);
    }

    const json = await response.json() as { data: Array<{ embedding: number[] }> };
    return json.data.map((d) => d.embedding);
  }
}

// ─── OpenAI-compatible provider ───────────────────────────────────────────────

class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const url = `${this.endpoint.replace(/\/$/, '')}/v1/embeddings`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI-compatible embedding failed (${response.status}): ${text}`);
    }

    const json = await response.json() as { data: Array<{ embedding: number[] }> };
    return json.data.map((d) => d.embedding);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an embedding provider from the active config, or return null
 * if no embedding provider is configured.
 */
export function createEmbeddingProvider(config: PureContextConfig): EmbeddingProvider | null {
  const { embeddingProvider, embeddingModel, apiKey, endpoint } = config.ai;

  if (!embeddingProvider) return null;
  if (!config.ai.allowRemoteAI) {
    logger.debug('Embedding provider configured but allowRemoteAI is false — embeddings disabled');
    return null;
  }

  if (embeddingProvider === 'voyage') {
    const key = apiKey || process.env['ANTHROPIC_API_KEY'] || '';
    if (!key) {
      logger.warn('ai.embeddingProvider = "voyage" but no API key configured — embeddings disabled');
      return null;
    }
    return new VoyageEmbeddingProvider(key, embeddingModel ?? DEFAULT_VOYAGE_MODEL);
  }

  if (embeddingProvider === 'openai-compatible') {
    if (!endpoint) {
      logger.warn('ai.embeddingProvider = "openai-compatible" but no ai.endpoint configured — embeddings disabled');
      return null;
    }
    const model = embeddingModel ?? 'nomic-embed-text';
    return new OpenAICompatibleEmbeddingProvider(endpoint, apiKey, model);
  }

  return null;
}
