/**
 * Post-FTS5 relevance re-ranking layer.
 *
 * BM25 ranks by term frequency across all FTS content fields, so a symbol
 * whose summary mentions "index" five times can outrank `indexFolder` whose
 * name is an exact match.  This ranker applies an explicit additive scoring
 * scheme that promotes exact name matches to the top.
 *
 * Scoring (additive, higher = more relevant):
 *  100 — exact name match (case-insensitive)
 *   60 — name starts with query
 *   40 — name contains query as substring
 *   30 — all query words appear in name
 *   20 — any query word is exact name match
 *   10 — any query word appears in name (per word)
 *    8 — query phrase in signature
 *    2 — any query word in signature (per word)
 *    5 — query phrase in summary
 *    1 — any query word in summary (per word)
 */

import type { SymbolRecord } from '../types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DebugScore {
  total: number;
  nameExact: number;
  namePrefix: number;
  nameFuzzy: number;
  wordOverlap: number;
  signatureMatch: number;
  summaryMatch: number;
  kindBoost: number;
  recencyBoost: number;
}

export interface ScoredSymbol {
  symbol: SymbolRecord;
  score: number;
  matchReason: 'exact_name' | 'prefix_name' | 'name_contains' | 'word_overlap' | 'content_match';
  debugScore?: DebugScore;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Score and sort a list of symbols by relevance to `query`.
 *
 * Input symbols are assumed to already be filtered by FTS5 (or LIKE) — this
 * layer only re-orders them.  Ties in score preserve the original (BM25) order.
 *
 * When `debug` is true, each result includes a `debugScore` breakdown.
 */
export function rankSymbols(symbols: SymbolRecord[], query: string, debug = false): ScoredSymbol[] {
  if (symbols.length === 0) return [];

  const queryLower = query.trim().toLowerCase();
  const queryWords = extractQueryWords(query.trim());

  const scored = symbols.map((symbol, originalIndex) => ({
    ...score(symbol, queryLower, queryWords),
    symbol,
    originalIndex,
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex; // preserve FTS order on tie
  });

  return scored.map(({ symbol, score: s, matchReason, debugScore }) => ({
    symbol,
    score: s,
    matchReason,
    ...(debug ? { debugScore } : {}),
  }));
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function score(
  symbol: SymbolRecord,
  queryLower: string,
  queryWords: string[],
): { score: number; matchReason: ScoredSymbol['matchReason']; debugScore: DebugScore } {
  const nameLower = symbol.name.toLowerCase();
  const sigLower = symbol.signature.toLowerCase();
  const sumLower = symbol.summary.toLowerCase();

  let total = 0;
  let matchReason: ScoredSymbol['matchReason'] = 'content_match';

  // ── Name-level rules (mutually exclusive for matchReason priority) ──────────

  let nameExact = 0;
  let namePrefix = 0;
  let nameFuzzy = 0;

  if (nameLower === queryLower) {
    nameExact = 100;
    total += 100;
    matchReason = 'exact_name';
  } else if (nameLower.startsWith(queryLower)) {
    namePrefix = 60;
    total += 60;
    matchReason = 'prefix_name';
  } else if (nameLower.includes(queryLower)) {
    nameFuzzy = 40;
    total += 40;
    matchReason = 'name_contains';
  }

  // ── Word-overlap rules (always additive; update matchReason if not yet set) ─

  let wordOverlap = 0;

  if (queryWords.length > 0) {
    if (queryWords.every((w) => nameLower.includes(w))) {
      wordOverlap += 30;
    }
    if (queryWords.some((w) => nameLower === w)) {
      wordOverlap += 20;
    }
    const wordsInName = queryWords.filter((w) => nameLower.includes(w)).length;
    wordOverlap += wordsInName * 10;

    if (wordOverlap > 0) {
      total += wordOverlap;
      if (matchReason === 'content_match') matchReason = 'word_overlap';
    }
  }

  // ── Content rules (signature + summary) ────────────────────────────────────

  let signatureMatch = 0;
  let summaryMatch = 0;

  if (sigLower.includes(queryLower)) signatureMatch += 8;
  signatureMatch += queryWords.filter((w) => sigLower.includes(w)).length * 2;
  if (sumLower.includes(queryLower)) summaryMatch += 5;
  summaryMatch += queryWords.filter((w) => sumLower.includes(w)).length * 1;

  total += signatureMatch + summaryMatch;

  const debugScore: DebugScore = {
    total,
    nameExact,
    namePrefix,
    nameFuzzy,
    wordOverlap,
    signatureMatch,
    summaryMatch,
    kindBoost: 0,
    recencyBoost: 0,
  };

  return { score: total, matchReason, debugScore };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract a deduplicated set of lowercase search terms from the raw query.
 *
 * For camelCase/snake_case identifiers the component words are included so
 * scoring works on both the full token and its parts.
 *
 * Examples:
 *   'indexFolder'      → ['indexfolder', 'index', 'folder']
 *   'blast radius'     → ['blast', 'radius']
 *   'get_symbol_source'→ ['get_symbol_source', 'get', 'symbol', 'source']
 */
function extractQueryWords(raw: string): string[] {
  const words = new Set<string>();

  for (const part of raw.split(/\s+/).filter(Boolean)) {
    const lower = part.toLowerCase();
    words.add(lower);

    if (part.includes('_')) {
      // snake_case — split on underscores
      for (const seg of part.split('_')) {
        const s = seg.toLowerCase();
        if (s.length >= 2) words.add(s);
      }
    } else {
      // camelCase — split on case boundaries using the raw (cased) token
      const parts = part
        .replace(/([a-z\d])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(' ')
        .map((s) => s.toLowerCase())
        .filter((s) => s.length >= 2);

      if (parts.length > 1) {
        for (const s of parts) words.add(s);
      }
    }
  }

  return Array.from(words);
}
