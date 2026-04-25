/**
 * AI-powered batch summarizer (Stage 3 of the summary pipeline).
 *
 * Supports two providers:
 *   'anthropic'         — Anthropic Messages API (https.request)
 *   'openai-compatible' — Any /v1/chat/completions endpoint (fetch)
 *
 * Error handling: any failure (network, API error, parse failure) logs a
 * warning and returns an empty Map so the caller can continue with Stage 4
 * (signature fallback) for the affected symbols.
 */

import { request as httpsRequest } from 'https';
import type { SymbolRecord } from '../core/types.js';
import { logger } from '../core/logger.js';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface AISummarizerConfig {
  /** Enable AI summarization. */
  enabled: boolean;
  /** Provider. Defaults to 'anthropic'. */
  provider?: 'anthropic' | 'openai-compatible';
  /** Model to use. Provider-specific defaults apply when omitted. */
  model?: string;
  /** Resolved API key (after env-var expansion). */
  apiKey?: string;
  /**
   * Base URL for the OpenAI-compatible endpoint (e.g. 'http://localhost:11434').
   * Required when provider is 'openai-compatible'.
   */
  endpoint?: string | null;
  /** Max symbols per batch. Defaults to 50. */
  batchSize?: number;
}

// ─── Public interface ─────────────────────────────────────────────────────────

export interface AISummarizer {
  /**
   * Generate summaries for a batch of symbols.
   * Returns a Map of symbol.id → summary string.
   * Symbols not covered (error, missing) are absent from the Map.
   */
  summarizeBatch(symbols: SymbolRecord[]): Promise<Map<string, string>>;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
}

interface OpenAIResponse {
  choices: Array<{ message: { role: string; content: string } }>;
}

// ─── Injectable HTTP clients ──────────────────────────────────────────────────

/** Injectable type for Node's https.request (Anthropic path). */
export type HttpRequestFn = typeof httpsRequest;

/** Injectable type for fetch (OpenAI-compatible path). */
export type FetchFn = typeof fetch;

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Build the full prompt including file path context and signature.
 * Response format: `id: summary` per line.
 */
export function buildPrompt(symbols: SymbolRecord[]): string {
  const items = symbols
    .map((s) => {
      const parentHint =
        s.kind === 'method' && s.name.includes('.')
          ? `  parent=${s.name.slice(0, s.name.lastIndexOf('.'))}`
          : '';
      return (
        `id=${s.id}  kind=${s.kind}  name=${s.name}  file=${s.filePath}${parentHint}\n` +
        s.signature
      );
    })
    .join('\n\n');

  return (
    'For each symbol below, write exactly one line in the format:\n' +
    'id: <one-line summary>\n\n' +
    'Rules:\n' +
    '- Summary must be ≤ 80 characters\n' +
    '- Use plain English, active voice\n' +
    '- Do not include the id or name in the summary\n' +
    '- Output ONLY the id: summary lines, nothing else\n\n' +
    'Symbols:\n' +
    items
  );
}

/**
 * Simplified prompt used on retry — signatures only, no extra context.
 */
export function buildSimplePrompt(symbols: SymbolRecord[]): string {
  const items = symbols
    .map((s) => `id=${s.id}\n${s.signature}`)
    .join('\n\n');

  return (
    'For each symbol below, write exactly one line: id: <one-line summary ≤ 80 chars>.\n' +
    'Output ONLY the id: summary lines.\n\n' +
    items
  );
}

// ─── Response parser ──────────────────────────────────────────────────────────

/**
 * Parse lines of the form `<id>: <summary>` from the model response.
 * Lines that don't match the pattern are silently skipped.
 */
export function parseResponse(text: string, expectedIds: Set<string>): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const id = line.slice(0, colon).trim();
    const summary = line.slice(colon + 1).trim();
    if (id && summary && expectedIds.has(id)) {
      result.set(id, summary);
    }
  }
  return result;
}

// ─── Anthropic HTTP call ──────────────────────────────────────────────────────

function callAnthropic(
  apiKey: string,
  model: string,
  messages: AnthropicMessage[],
  httpClient: HttpRequestFn,
): Promise<AnthropicResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, max_tokens: 1024, messages });

    const req = httpClient(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Anthropic API error ${res.statusCode}: ${raw}`));
            return;
          }
          try {
            resolve(JSON.parse(raw) as AnthropicResponse);
          } catch {
            reject(new Error(`Failed to parse Anthropic response: ${raw}`));
          }
        });
        res.on('error', reject);
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── OpenAI-compatible HTTP call ──────────────────────────────────────────────

async function callOpenAICompatible(
  endpoint: string,
  apiKey: string,
  model: string,
  prompt: string,
  fetchFn: FetchFn,
): Promise<OpenAIResponse> {
  const url = `${endpoint.replace(/\/$/, '')}/v1/chat/completions`;
  const body = JSON.stringify({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI-compatible API error ${response.status}: ${text}`);
  }

  return response.json() as Promise<OpenAIResponse>;
}

// ─── Batch with retry ─────────────────────────────────────────────────────────

/**
 * Send one batch of symbols to the model, retrying once with a simpler prompt
 * if the first response parses to 0 results.
 */
export async function summarizeBatchWithRetry(
  symbols: SymbolRecord[],
  sendPrompt: (prompt: string) => Promise<string>,
): Promise<Map<string, string>> {
  const expectedIds = new Set(symbols.map((s) => s.id));

  // First attempt — full prompt with file path context
  const text1 = await sendPrompt(buildPrompt(symbols));
  const results1 = parseResponse(text1, expectedIds);
  if (results1.size > 0) return results1;

  // Retry with simpler prompt
  logger.debug('AI batch returned 0 results — retrying with simpler prompt');
  const text2 = await sendPrompt(buildSimplePrompt(symbols));
  return parseResponse(text2, expectedIds);
}

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Create an AISummarizer if AI summarization is enabled and an API key is
 * available. Returns null if either condition is not met.
 *
 * @param config       Summarizer configuration.
 * @param httpClient   Injectable Anthropic HTTP client (defaults to https.request).
 * @param fetchFn      Injectable fetch function for OpenAI-compatible path.
 */
export function createAISummarizer(
  config: AISummarizerConfig,
  httpClient: HttpRequestFn = httpsRequest,
  fetchFn: FetchFn = globalThis.fetch,
): AISummarizer | null {
  if (!config.enabled) return null;

  const provider = config.provider ?? 'anthropic';
  const batchSize = config.batchSize ?? 50;

  // ── Anthropic ───────────────────────────────────────────────────────────────
  if (provider === 'anthropic') {
    const apiKey = config.apiKey || process.env['ANTHROPIC_API_KEY'] || '';
    if (!apiKey) {
      logger.warn('AI summarization enabled but no API key available — skipping Stage 3');
      return null;
    }

    const model = config.model ?? 'claude-haiku-4-5-20251001';

    return {
      async summarizeBatch(symbols: SymbolRecord[]): Promise<Map<string, string>> {
        if (symbols.length === 0) return new Map();

        const allResults = new Map<string, string>();

        for (let i = 0; i < symbols.length; i += batchSize) {
          const batch = symbols.slice(i, i + batchSize);

          try {
            const results = await summarizeBatchWithRetry(batch, async (prompt) => {
              const response = await callAnthropic(apiKey, model, [
                { role: 'user', content: prompt },
              ], httpClient);
              return response.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
            });

            for (const [id, summary] of results) allResults.set(id, summary);
            logger.debug(`AI summarized ${results.size}/${batch.length} symbols (batch ${Math.floor(i / batchSize) + 1})`);
          } catch (err) {
            logger.warn(`AI summarization batch failed: ${err} — falling back to Stage 4`);
          }
        }

        return allResults;
      },
    };
  }

  // ── OpenAI-compatible ───────────────────────────────────────────────────────
  if (provider === 'openai-compatible') {
    const endpoint = config.endpoint;
    if (!endpoint) {
      logger.warn('ai.provider is openai-compatible but ai.endpoint is not set — skipping Stage 3');
      return null;
    }

    const apiKey = config.apiKey || '';
    const model = config.model ?? 'gpt-4o-mini';

    return {
      async summarizeBatch(symbols: SymbolRecord[]): Promise<Map<string, string>> {
        if (symbols.length === 0) return new Map();

        const allResults = new Map<string, string>();

        for (let i = 0; i < symbols.length; i += batchSize) {
          const batch = symbols.slice(i, i + batchSize);

          try {
            const results = await summarizeBatchWithRetry(batch, async (prompt) => {
              const response = await callOpenAICompatible(endpoint, apiKey, model, prompt, fetchFn);
              return response.choices[0]?.message?.content ?? '';
            });

            for (const [id, summary] of results) allResults.set(id, summary);
            logger.debug(`AI summarized ${results.size}/${batch.length} symbols (batch ${Math.floor(i / batchSize) + 1})`);
          } catch (err) {
            logger.warn(`AI summarization batch failed: ${err} — falling back to Stage 4`);
          }
        }

        return allResults;
      },
    };
  }

  return null;
}
