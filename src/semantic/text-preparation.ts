/**
 * Text preparation utilities for embedding generation.
 *
 * Converts SymbolRecord fields into a single string suitable for embedding.
 * Consistent formatting across providers ensures comparable vector spaces.
 */

import type { SymbolRecord } from '../core/types.js';
import type { EmbeddingProvider } from './embedding-provider.js';

// ─── Character-based token estimation ────────────────────────────────────────

/**
 * Rough token estimate: 1 token ≈ 4 characters (works well for code).
 * Used for truncation — not for billing.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

// ─── Symbol text preparation ──────────────────────────────────────────────────

/**
 * Combine a symbol's name, signature, and summary into a single embedding text.
 *
 * Format: `{name}: {signature}\n{summary}`
 *
 * If a `docstring` is stored in `frameworkMeta.docstring`, it is appended
 * as a third line. The result is truncated to `maxTokens` (estimated).
 */
export function prepareSymbolText(
  symbol: SymbolRecord,
  maxTokens: number = 4096,
): string {
  const parts: string[] = [];

  // Line 1: name + signature
  const sig = symbol.signature.trim();
  parts.push(sig ? `${symbol.name}: ${sig}` : symbol.name);

  // Line 2: summary (skip if empty or identical to signature)
  const summary = symbol.summary.trim();
  if (summary && summary !== sig) {
    parts.push(summary);
  }

  // Line 3: docstring from frameworkMeta (optional)
  const docstring = symbol.frameworkMeta?.['docstring'];
  if (typeof docstring === 'string' && docstring.trim()) {
    const doc = docstring.trim();
    if (doc !== summary) {
      parts.push(doc);
    }
  }

  const text = parts.join('\n');
  return truncateToTokens(text, maxTokens);
}

/**
 * Prepare a batch of symbols for embedding.
 * Each text is independently truncated to the provider's `maxTokens` limit.
 */
export function prepareBatch(
  symbols: SymbolRecord[],
  provider: Pick<EmbeddingProvider, 'maxTokens'>,
): string[] {
  return symbols.map((s) => prepareSymbolText(s, provider.maxTokens));
}
