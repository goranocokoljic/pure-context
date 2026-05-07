/**
 * Gemini Flash summarization provider.
 *
 * Uses the Gemini REST API directly — no SDK dependency.
 * Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 * Auth: ?key={GOOGLE_API_KEY} query parameter
 *
 * Request:  { contents: [{ parts: [{ text: prompt }] }] }
 * Response: candidates[0].content.parts[0].text
 *
 * Error handling:
 *   - 429 quota errors → exponential backoff with jitter (up to 3 retries)
 *   - Malformed response (missing text) → throws so caller falls back to Stage 4
 */

import { request as httpsRequest } from 'https';
import { logger } from '../../core/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type HttpRequestFn = typeof httpsRequest;

export const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

// ─── HTTP call ────────────────────────────────────────────────────────────────

function callGeminiOnce(
  apiKey: string,
  model: string,
  prompt: string,
  httpClient: HttpRequestFn,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    });

    const req = httpClient(
      {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Gemini API error ${res.statusCode}: ${raw}`));
            return;
          }
          try {
            const parsed = JSON.parse(raw) as GeminiResponse;
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (typeof text !== 'string') {
              reject(new Error(`Gemini response missing text field: ${raw}`));
              return;
            }
            resolve(text);
          } catch {
            reject(new Error(`Failed to parse Gemini response: ${raw}`));
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

// ─── Retry wrapper ────────────────────────────────────────────────────────────

async function callGeminiWithRetry(
  apiKey: string,
  model: string,
  prompt: string,
  httpClient: HttpRequestFn,
  retriesLeft: number,
  delayMs: number,
): Promise<string> {
  try {
    return await callGeminiOnce(apiKey, model, prompt, httpClient);
  } catch (err) {
    const isRateLimit = err instanceof Error && err.message.includes('429');
    if (isRateLimit && retriesLeft > 0) {
      const jitter = Math.random() * 200;
      const waitMs = delayMs + jitter;
      logger.debug(
        `Gemini rate limit — retrying in ${Math.round(waitMs)}ms (${retriesLeft} retries left)`,
      );
      await new Promise<void>((r) => setTimeout(r, waitMs));
      return callGeminiWithRetry(apiKey, model, prompt, httpClient, retriesLeft - 1, delayMs * 2);
    }
    throw err;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a prompt to Gemini and return the text response.
 * Retries up to 3 times on 429 quota errors with exponential backoff + jitter.
 */
export function callGemini(
  apiKey: string,
  model: string,
  prompt: string,
  httpClient: HttpRequestFn = httpsRequest,
): Promise<string> {
  return callGeminiWithRetry(apiKey, model, prompt, httpClient, 3, 500);
}
