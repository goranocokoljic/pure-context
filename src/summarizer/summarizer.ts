import type { SymbolRecord } from '../core/types.js';
import { extractSummaryFromDocstring } from './docstring-extractor.js';

// ─── Stage 2: framework-derived summary ──────────────────────────────────────

/**
 * Derive a one-line summary from a symbol's frameworkMeta when present.
 * Returns null if no useful metadata is available.
 *
 * Priority order matches the specificity of the metadata:
 *   server routes (have method + path) > pages > plugins/middleware >
 *   composables > hooks > components
 */
function deriveFrameworkSummary(symbol: SymbolRecord): string | null {
  const m = symbol.frameworkMeta;
  if (!m) return null;

  // Nuxt server route
  if (m['nuxt_server']) {
    const method = m['http_method'] ? `${m['http_method']} ` : '';
    const path   = m['route_path'] ?? symbol.name;
    return `${method}${path} server route`;
  }

  // Nuxt page
  if (m['nuxt_page']) {
    const path = m['route_path'] ?? symbol.name;
    return `Page route ${path}`;
  }

  // Nuxt plugin
  if (m['nuxt_plugin']) return `Nuxt plugin ${symbol.name}`;

  // Nuxt middleware (also covers generic middleware kind)
  if (m['nuxt_middleware']) return `Nuxt middleware ${symbol.name}`;

  // React hook
  if (m['react_hook']) return `React hook ${symbol.name}`;

  // React component
  if (m['react_component']) return `React component ${symbol.name}`;

  // Vue composable
  if (m['vue_composable']) return `Vue composable ${symbol.name}`;

  // Vue component
  if (m['vue_component']) return `Vue component ${symbol.name}`;

  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a one-line summary for a symbol using a staged fallback pipeline.
 *
 * Stage 1: Extract summary from the provided docstring (JSDoc / TSDoc).
 * Stage 2: Derive from frameworkMeta (component type, route path, etc.).
 * Stage 3: AI batch summarization — handled externally by AISummarizer and
 *          applied post-indexing; this function is not involved in Stage 3.
 * Stage 4: Use the symbol's signature, truncated to 100 chars.
 *
 * @param symbol    The symbol record. Must have frameworkMeta populated before
 *                  this is called so Stage 2 can use it.
 * @param docstring Raw docstring text, or null / empty if none.
 */
export function generateSummary(
  symbol: SymbolRecord,
  docstring: string | null,
): string {
  // Stage 1 — docstring
  if (docstring) {
    const fromDoc = extractSummaryFromDocstring(docstring);
    if (fromDoc) return fromDoc;
  }

  // Stage 2 — framework-derived
  const fromFramework = deriveFrameworkSummary(symbol);
  if (fromFramework) return fromFramework;

  // Stage 3 — AI (external, applied post-indexing via AISummarizer)

  // Stage 4 — signature fallback
  return symbol.signature.slice(0, 100).trim();
}

/**
 * Apply `generateSummary` to an array of symbols in-place.
 * Each symbol's existing `summary` is treated as the raw docstring input
 * (handlers already pre-populate it from JSDoc).
 */
export function enrichSymbols(symbols: SymbolRecord[]): SymbolRecord[] {
  return symbols.map((s) => ({
    ...s,
    summary: generateSummary(s, s.summary || null),
  }));
}
