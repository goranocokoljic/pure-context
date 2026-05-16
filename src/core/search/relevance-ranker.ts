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
 *   30 — all query words match a word-boundary name part
 *   20 — any query word matches a word-boundary name part
 *   10 — each query word that matches a word-boundary name part
 *    8 — query phrase in signature
 *    2 — any query word in signature (per word)
 *    5 — query phrase in summary
 *    1 — any query word in summary (per word)
 *
 * Query word extraction:
 *  - Hyphenated tokens split ("front-end" → "front", "end")
 *  - camelCase and snake_case tokens split into components
 *  - English stop words removed
 *  - Inflectional suffixes stripped to add stem variants:
 *      -s  (plural)     "models"     → "model"
 *      -ing (gerund)    "building"   → "build"
 *      -ed  (past)      "updated"    → "update" and "updat"
 *      -tion (nominal)  "pagination" → "paginat"
 */

import type { SymbolRecord } from '../types.js';
import { isStopWord } from './query-preprocessor.js';

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

  // ── Word-overlap rules (word-boundary matching against split name parts) ────
  //
  // We split the symbol name into its constituent word-boundary parts
  // (camelCase + snake_case + namespace separators) and check query words
  // against those parts exactly.  This is more precise than substring
  // matching: query word "model" matches the "model" part of "CIR_Model" but
  // NOT the "models" namespace prefix in "models\\Article_base".

  let wordOverlap = 0;

  if (queryWords.length > 0) {
    const nameParts = splitNameParts(symbol.name);
    const partExact = (w: string): boolean => nameParts.some((p) => p === w);

    if (queryWords.every(partExact)) {
      wordOverlap += 30; // all query words match name parts
    }
    if (queryWords.some(partExact)) {
      wordOverlap += 20; // at least one query word matches a name part
    }
    wordOverlap += queryWords.filter(partExact).length * 10; // per-word bonus

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
 * Split a symbol name into word-boundary parts for precise matching.
 *
 * Handles namespace separators (\\, ::), snake_case underscores, and
 * camelCase/PascalCase boundaries.  Parts shorter than 2 characters are
 * excluded.
 *
 * Examples:
 *   'CIR_Model'                        → ['cir', 'model']
 *   'Homepage_model::getSettings'      → ['homepage', 'model', 'get', 'settings']
 *   'models\\Article_base'             → ['models', 'article', 'base']
 *   'CIR_FrontController'              → ['cir', 'front', 'controller']
 *   'CI_DB_query_builder::_insert'     → ['ci', 'db', 'query', 'builder', 'insert']
 */
function splitNameParts(name: string): string[] {
  const parts: string[] = [];
  // Split on namespace/method-call separators (\ and :)
  for (const segment of name.split(/[\\:]+/)) {
    // Split each segment on underscores
    for (const subSeg of segment.split('_').filter(Boolean)) {
      // camelCase / PascalCase split within each snake_case segment
      const camelParts = subSeg
        .replace(/([a-z\d])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(' ')
        .map((p) => p.toLowerCase())
        .filter((p) => p.length >= 2);
      parts.push(...camelParts);
    }
  }
  return parts;
}

/**
 * Add inflectional suffix stems of `word` to `set`.
 *
 * Adding stems (rather than replacing the original word) means both the
 * inflected form and the stem are available for matching — the inflected form
 * matches index tokens that include the suffix; the stem matches code symbol
 * parts that use the base form.
 *
 * Suffixes handled:
 *   -s     (plural / 3rd-person)   "models"     → "model"
 *   -ing   (gerund)                "building"   → "build"
 *   -ed    (past tense)            "updated"    → "update" + "updat"
 *                                  "matched"    → "matche" + "match"
 *   -tion  (nominalisation)        "pagination" → "paginat"
 *
 * For -ed we add both the e-drop form (strip only -d) and the regular form
 * (strip -ed) so that both "update" (code symbol) and "match" are covered
 * regardless of the inflection pattern.
 */
function addStemsOf(word: string, set: Set<string>): void {
  // -tion: "pagination" → "paginat" (minimum total length 7 to avoid "on" → "")
  if (word.length > 6 && word.endsWith('tion')) {
    const s = word.slice(0, -4);
    if (s.length >= 2) set.add(s);
    return;
  }
  // -ing: "building" → "build" (minimum total length 6 to avoid "ring" → "r")
  if (word.length > 5 && word.endsWith('ing')) {
    const s = word.slice(0, -3);
    if (s.length >= 2) set.add(s);
    return;
  }
  // -ed: add both e-drop ("updated"→"update") and regular strip ("matched"→"match")
  // The e-drop form may produce noise ("matche") but it won't match real symbol parts.
  if (word.length > 4 && word.endsWith('ed')) {
    const dStem = word.slice(0, -1);   // strip -d  : "updated"→"update", "matched"→"matche"
    const edStem = word.slice(0, -2);  // strip -ed : "updated"→"updat",  "matched"→"match"
    if (dStem.length >= 2) set.add(dStem);
    if (edStem.length >= 2 && edStem !== dStem) set.add(edStem);
    return;
  }
  // -s: "models"→"model", "records"→"record" (skip -ss endings like "class")
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) {
    const s = word.slice(0, -1);
    if (s.length >= 2) set.add(s);
  }
}

/**
 * Extract a deduplicated set of lowercase search terms from the raw query.
 *
 * Processing pipeline:
 *  1. Split on whitespace AND hyphens ("front-end" → "front", "end").
 *  2. Discard English stop words.
 *  3. Add inflectional stem variants via addStemsOf.
 *  4. For snake_case tokens split on underscores and repeat steps 2-3.
 *  5. For camelCase tokens split on case boundaries and repeat steps 2-3.
 *
 * Examples:
 *   'indexFolder'          → ['indexfolder', 'index', 'folder']
 *   'blast radius'         → ['blast', 'radius']
 *   'get_symbol_source'    → ['get_symbol_source', 'get', 'symbol', 'source']
 *   'models'               → ['models', 'model']
 *   'updated homepage'     → ['updated', 'update', 'updat', 'homepage']
 *   'front-end controller' → ['front', 'end', 'controller']
 */
function extractQueryWords(raw: string): string[] {
  const words = new Set<string>();

  // Split on both whitespace and hyphens so "front-end" → ["front", "end"]
  for (const part of raw.split(/[\s-]+/).filter(Boolean)) {
    const lower = part.toLowerCase();
    // Skip English function words — they never appear in code symbol names and
    // inflate the "all words in name" (30-pt) and per-word (10-pt) scoring
    // rules, making the 30-pt bonus unachievable for any real symbol.
    if (isStopWord(lower)) continue;
    if (lower.length < 2) continue;
    words.add(lower);
    addStemsOf(lower, words);

    if (part.includes('_')) {
      // snake_case — split on underscores
      for (const seg of part.split('_')) {
        const s = seg.toLowerCase();
        if (s.length >= 2 && !isStopWord(s)) {
          words.add(s);
          addStemsOf(s, words);
        }
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
        for (const s of parts) {
          if (!isStopWord(s)) {
            words.add(s);
            addStemsOf(s, words);
          }
        }
      }
    }
  }

  return Array.from(words);
}
