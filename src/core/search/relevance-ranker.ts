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
 *   30 — all query words match a word-boundary name part (exact or stem)
 *   20 — any query word matches a word-boundary name part (exact or stem)
 *   15 — method verb bonus: first part of method name matches a query word
 *   30 — kindBoost: method on a *Service class
 *   15 — kindBoost: method on a *Repository / *Manager / *Store / *_model class
 *   10 — each query word with an exact word-boundary name-part match
 *    8 — each query word with a stem-only word-boundary name-part match
 *    8 — query phrase in signature
 *    2 — any query word in signature (per word)
 *    5 — query phrase in summary
 *    1 — any query word in summary (per word)
 *  -35 — library path penalty (system/, vendor/, third_party/, node_modules/)
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
import { isStopWord, expandVerbSynonyms } from './query-preprocessor.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DebugScore {
  total: number;
  nameExact: number;
  namePrefix: number;
  nameFuzzy: number;
  wordOverlap: number;
  methodVerbBonus: number;
  signatureMatch: number;
  summaryMatch: number;
  kindBoost: number;
  libraryPenalty: number;
  recencyBoost: number;
}

export interface ScoredSymbol {
  symbol: SymbolRecord;
  score: number;
  matchReason: 'exact_name' | 'prefix_name' | 'name_contains' | 'word_overlap' | 'content_match';
  debugScore?: DebugScore;
}

// ─── Library path detection ───────────────────────────────────────────────────

/**
 * Directory names that always indicate third-party library code, regardless of
 * where they appear in the path.  Symbols under these directories receive a
 * score penalty so application-level symbols rank above them.
 *
 * Covers:
 *   system/           CodeIgniter framework core
 *   vendor/           Composer packages (PHP) / generic vendor trees
 *   third_party/      Generic third-party library directories
 *   node_modules/     npm packages
 *   bower_components/ Bower packages
 */
const LIBRARY_PATH_SEGMENTS = new Set([
  'system',
  'vendor',
  'third_party',
  'node_modules',
  'bower_components',
]);

/**
 * Return true when the symbol's file path contains a well-known library
 * directory segment, indicating third-party / framework code.
 *
 * Uses forward-slash normalisation so paths work correctly on Windows and Unix.
 */
export function isLibraryPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.split('/').some((seg) => LIBRARY_PATH_SEGMENTS.has(seg));
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
    // Only award the prefix bonus when the character immediately after the
    // query string in the *original* (cased) symbol name is a word-boundary:
    // uppercase letter (camelCase), a non-alpha separator (_, \, :, .), or
    // end of string.  A continuing lowercase letter means the query is merely
    // a prefix of a longer word inside the name — not a name-level prefix.
    // e.g. query "model" vs name "models\Article_base" → nextChar="s" (lowercase)
    //      → treated as substring match, not prefix match.
    const nextChar = symbol.name[queryLower.length];
    const isWordBoundary = !nextChar || /[^a-z]/.test(nextChar);
    if (isWordBoundary) {
      namePrefix = 60;
      total += 60;
      matchReason = 'prefix_name';
    } else {
      // The query string is embedded inside a longer word — treat as substring.
      nameFuzzy = 40;
      total += 40;
      matchReason = 'name_contains';
    }
  } else if (nameLower.includes(queryLower)) {
    nameFuzzy = 40;
    total += 40;
    matchReason = 'name_contains';
  }

  // ── Word-overlap rules (word-boundary matching against split name parts) ────
  //
  // We split the symbol name into its constituent word-boundary parts
  // (camelCase + snake_case + namespace separators) and check query words
  // against those parts.  Inflectional stem variants of each name part are
  // also included so that query word "product" matches name part "products",
  // "order" matches "orders", "review" matches "reviews", etc.
  //
  // This is more precise than substring matching: query word "model" matches
  // the "model" part of "CIR_Model" but scores slightly less against the
  // "models" namespace prefix in "models\\Article_base" (stem-only match).

  let wordOverlap = 0;

  if (queryWords.length > 0) {
    const nameParts = splitNameParts(symbol.name);
    // Add inflectional stems of each name part so that pluralized name parts
    // match their singular query-word counterparts and vice-versa.
    // e.g. "products" → "product", "orders" → "order", "reviews" → "review"
    const namePartsSet = new Set(nameParts);
    for (const p of nameParts) {
      addStemsOf(p, namePartsSet);
    }
    // Two levels of matching used to differentiate exact vs stem-based hits:
    //   partStrict — query word appears verbatim in the split name parts
    //   partLoose  — query word matches a stem variant of a name part
    // This prevents a pluralised namespace prefix ("models") from scoring
    // identically to an exact name-part match ("model" in "CIR_Model").
    const partStrict = (w: string): boolean => nameParts.some((p) => p === w);
    const partLoose = (w: string): boolean => namePartsSet.has(w);

    if (queryWords.every(partLoose)) {
      wordOverlap += 30; // all query words match name parts (exact or stem)
    }
    if (queryWords.some(partLoose)) {
      wordOverlap += 20; // at least one query word matches
    }
    // Per-word bonus: exact part match earns +10; stem-only match earns +8.
    for (const w of queryWords) {
      if (partStrict(w)) wordOverlap += 10;
      else if (partLoose(w)) wordOverlap += 8;
    }

    if (wordOverlap > 0) {
      total += wordOverlap;
      if (matchReason === 'content_match') matchReason = 'word_overlap';
    }
  }

  // ── Method verb bonus ────────────────────────────────────────────────────────
  //
  // For method symbols, give a +15 bonus when a query word exactly matches the
  // FIRST split part of the method name — the "action verb" (e.g. "create" in
  // "ProductsService.create", "get" in "OrdersService.getMyOrders").
  //
  // This differentiates application methods from helper/utility methods that
  // happen to share other name parts with the query.  Example:
  //   query "create product listing"
  //   ProductsService.create       → verb "create" matches → +15 (total 89)
  //   buildProductListCacheKey     → verb "build" ≠ "create" → no bonus (total 76)
  //
  // The bonus is intentionally limited to exact query-word matches on the first
  // method part only — we do not use stems here because a stem match on the verb
  // is too loose (e.g. "builds" → "build" would also match "get").

  let methodVerbBonus = 0;
  if (symbol.kind === 'method' && queryWords.length > 0) {
    const dotIdx = symbol.name.indexOf('.');
    const colonIdx = symbol.name.indexOf('::');
    const sepIdx = dotIdx >= 0 ? dotIdx : colonIdx;
    if (sepIdx > 0) {
      const methodPart = symbol.name.slice(
        sepIdx + (colonIdx >= 0 && colonIdx === sepIdx ? 2 : 1),
      );
      const methodVerbParts = splitNameParts(methodPart);
      if (methodVerbParts.length > 0 && queryWords.some((w) => w === methodVerbParts[0])) {
        methodVerbBonus = 15;
      }
    }
  }
  total += methodVerbBonus;

  // ── Content rules (signature + summary) ────────────────────────────────────

  let signatureMatch = 0;
  let summaryMatch = 0;

  if (sigLower.includes(queryLower)) signatureMatch += 8;
  signatureMatch += queryWords.filter((w) => sigLower.includes(w)).length * 2;
  if (sumLower.includes(queryLower)) summaryMatch += 5;
  summaryMatch += queryWords.filter((w) => sumLower.includes(w)).length * 1;

  total += signatureMatch + summaryMatch;

  // ── Kind boost for application-layer methods ─────────────────────────────────
  //
  // For natural-language "how to do X" queries, a method on a *Service class is
  // almost always the correct answer — not the DTO, event type, schema const, or
  // controller delegate that happens to share words with the query.
  //
  // Boost values (additive):
  //   +30 — method on a *Service class  (e.g. AuthService.login)
  //   +15 — method on a *Repository / *Manager / *Store class  (data-access layer)
  //   +15 — method on a *_model class  (PHP CodeIgniter model convention)
  //
  // The boost is only applied to 'method' kind symbols that use dot ('.') or
  // double-colon ('::') notation, which is how PureContext records class methods.

  let kindBoost = 0;
  if (symbol.kind === 'method') {
    const dotIdx = symbol.name.indexOf('.');
    const colonIdx = symbol.name.indexOf('::');
    const sepIdx = dotIdx >= 0 ? dotIdx : colonIdx;
    if (sepIdx > 0) {
      const classPart = symbol.name.slice(0, sepIdx).toLowerCase();
      if (classPart.endsWith('service')) {
        kindBoost = 30;
      } else if (
        classPart.endsWith('repository') ||
        classPart.endsWith('manager') ||
        classPart.endsWith('store') ||
        classPart.endsWith('_model') ||
        (classPart.endsWith('model') && classPart.length > 5)
      ) {
        kindBoost = 15;
      }
    }
  }
  total += kindBoost;

  // ── Library path penalty ─────────────────────────────────────────────────────
  //
  // Symbols from well-known library/framework directories (CodeIgniter system/,
  // Composer vendor/, npm node_modules/, etc.) are almost never the intended
  // answer for a natural-language query about application behaviour.  Applying a
  // fixed penalty pushes them below application symbols that scored similarly on
  // name and word-overlap rules, without excluding them entirely (they still
  // appear when no application code matches).
  //
  // Penalty: -35 points — enough to overcome a 1-word lexical advantage that a
  // library class may have over an application wrapper (e.g. Twig_Template::render
  // matches "template" while the application Twig::render does not, but for
  // realistic multi-word queries the application symbol still wins).
  // Set just below the per-word bonus tier (10 × 3 = 30) so that a library
  // symbol with 4+ extra matching words can still surface for explicit library
  // lookups (e.g. query "CI_DB_driver execute").

  let libraryPenalty = 0;
  if (isLibraryPath(symbol.filePath)) {
    libraryPenalty = -35;
    total += libraryPenalty;
  }

  const debugScore: DebugScore = {
    total,
    nameExact,
    namePrefix,
    nameFuzzy,
    wordOverlap,
    methodVerbBonus,
    signatureMatch,
    summaryMatch,
    kindBoost,
    libraryPenalty,
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
  // Split on namespace/method-call separators: \ (PHP/Python paths), : (PHP ::), . (TS dot notation)
  for (const segment of name.split(/[\\:.]+/)) {
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
    // Synonym expansion: add code-domain synonyms so the ranker rewards symbols
    // whose names use a synonym of the query word (e.g. "authenticate" → "login").
    for (const syn of expandVerbSynonyms(lower)) {
      words.add(syn);
      addStemsOf(syn, words);
    }

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
