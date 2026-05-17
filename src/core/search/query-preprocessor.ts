/**
 * Preprocesses a raw user query into a valid FTS5 MATCH string.
 *
 * Pipeline:
 *  1. Strip FTS5 special characters that would cause syntax errors.
 *  2. If the input is a multi-word natural-language phrase, remove English
 *     stop words (articles, auxiliaries, prepositions) that never appear in
 *     code symbol names, then pass the remaining words through as an FTS5 AND
 *     query (whitespace = implicit AND).
 *  3. If the input is a single snake_case or camelCase identifier, expand it
 *     with OR alternatives so partial-word queries still find the symbol.
 *  4. Drop expanded tokens shorter than 2 characters.
 *  5. Expand any known code-domain abbreviations in the OR term list so that
 *     searching "db" also finds "database" and vice-versa.
 */

// ─── Stop words ──────────────────────────────────────────────────────────────

/**
 * English function words that never appear in code symbol names.
 *
 * Conservative list: only includes words where there is essentially zero risk
 * of a developer using them as a meaningful code identifier search term.
 * Words like "not", "or" are intentionally excluded because they do appear in
 * code names (notFound, orElse).
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  // Articles
  'a', 'an', 'the',
  // Coordinating conjunctions (and/but/nor are never code identifiers)
  'and', 'but', 'nor',
  // Be-verbs / state auxiliaries
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  // Have-verbs
  'have', 'has', 'had',
  // Modal verbs
  'will', 'would', 'shall', 'should', 'may', 'might',
  // Relative + interrogative pronouns
  'it', 'its', 'that', 'which', 'who', 'whom', 'what', 'when', 'where',
  // Pure prepositions with no code-name meaning
  'of', 'in', 'on', 'at', 'for', 'to', 'from', 'by', 'as', 'into',
  // Common English connectives / modifiers safe to drop in code queries
  'with', 'without', 'using', 'via',
  // Common adjectives with near-zero identifier occurrence
  'new', 'existing', 'all', 'any', 'some',
  // Temporal / positional prepositions safe in code search context
  'before', 'after', 'during', 'already', 'just',
  // Relative clause words
  'than', 'then',
]);

/**
 * Return true when the token (case-insensitive) is an English stop word that
 * should be excluded from code-domain FTS5 queries and relevance scoring.
 */
export function isStopWord(token: string): boolean {
  return STOP_WORDS.has(token.toLowerCase());
}

// ─── Verb / domain synonym dictionary ────────────────────────────────────────

/**
 * Synonym map for code-domain verbs and domain nouns that are commonly paraphrased
 * in natural-language queries but represented differently in code symbol names.
 *
 * Direction conventions (from the CLAUDE.md spec):
 *   ↔  bidirectional: both forms expand to each other.
 *   →  source expands to target(s) but not vice-versa.
 *
 * Applied only to individual tokens inside multi-word queries so single-word
 * OR-expansion is unaffected.
 */
const VERB_SYNONYMS: Readonly<Record<string, ReadonlyArray<string>>> = {
  // ↔ bidirectional pairs
  'remove':       ['delete', 'clear'],
  'delete':       ['remove'],
  'clear':        ['remove', 'delete'],
  'pagination':   ['paging'],
  'paging':       ['pagination'],
  'disable':      ['deactivate'],
  'deactivate':   ['disable'],
  'confirm':      ['verify'],
  'verify':       ['confirm'],
  'suspend':      ['deactivate', 'disable'],
  'revoke':       ['delete', 'remove'],
  'forgot':       ['reset'],   // "forgotPassword" ↔ "resetPassword" flow
  'reset':        ['forgot'],
  // → one-directional expansions
  'signin':       ['login'],   // "sign-in" has its hyphen stripped → "signin"
  'authenticate': ['login'],
  'retrieve':     ['get', 'fetch'],
  'expose':       ['register'],
  'attach':       ['add'],
  'initiate':     ['create', 'start'],
  'submit':       ['create', 'send'],
  'save':         ['create', 'store'],
  'list':         ['get', 'find'],
  'show':         ['get', 'find'],
  'checkout':     ['create', 'place'],
  'place':        ['create', 'checkout'],
};

/**
 * Return synonym alternatives for a single lowercase token, or an empty array
 * when no mapping is defined.
 *
 * Lookup is case-insensitive.
 *
 * Examples:
 *   expandVerbSynonyms('remove')   → ['delete']
 *   expandVerbSynonyms('delete')   → ['remove']
 *   expandVerbSynonyms('retrieve') → ['get', 'fetch']
 *   expandVerbSynonyms('expose')   → ['register']
 *   expandVerbSynonyms('unknown')  → []
 */
export function expandVerbSynonyms(token: string): ReadonlyArray<string> {
  return VERB_SYNONYMS[token.toLowerCase()] ?? [];
}

// ─── Abbreviation dictionaries ────────────────────────────────────────────────

/**
 * Common code-domain abbreviations and their full forms.
 * Lookup is bidirectional: searching an abbreviation also finds the full form
 * and vice-versa.
 */
const ABBREV_TO_FULL: Readonly<Record<string, string>> = {
  db:     'database',
  auth:   'authentication',
  cfg:    'config',
  msg:    'message',
  req:    'request',
  res:    'response',
  err:    'error',
  str:    'string',
  num:    'number',
  buf:    'buffer',
  dir:    'directory',
  env:    'environment',
  ctx:    'context',
  param:  'parameter',
  val:    'value',
  fn:     'function',
  obj:    'object',
  arr:    'array',
};

const FULL_TO_ABBREV: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ABBREV_TO_FULL).map(([abbr, full]) => [full, abbr]),
);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return the abbreviation counterpart for a token, if one is known.
 * Lookup is case-insensitive and bidirectional:
 *   'db'       → 'database'
 *   'database' → 'db'
 *   'auth'     → 'authentication'
 *   'parseFile'→ null  (no known mapping)
 *
 * Returns null when no expansion is known.
 */
export function expandToken(token: string): string | null {
  const lower = token.toLowerCase();
  return ABBREV_TO_FULL[lower] ?? FULL_TO_ABBREV[lower] ?? null;
}

/**
 * Convert a raw search query into an FTS5 MATCH-safe query string.
 *
 * Examples:
 *   preprocessQuery('parseFile')             → 'parseFile OR parse OR file'
 *   preprocessQuery('get_symbol_source')     → 'get_symbol_source OR get OR symbol OR source'
 *   preprocessQuery('orchestrate indexing')  → 'orchestrate indexing'
 *   preprocessQuery('"bad chars"')           → 'bad chars'
 *   preprocessQuery('db')                    → 'db OR database'
 *   preprocessQuery('database')              → 'database OR db'
 *   preprocessQuery('getDbRow')              → 'getDbRow OR get OR db OR row OR database'
 */
export function preprocessQuery(raw: string): string {
  // Step 1: strip/replace characters that have special meaning in FTS5 MATCH syntax.
  // Hyphen is replaced with a space because FTS5 interprets "word-word" as a column
  // filter ("column:token") which causes a syntax error for unknown column names.
  // Single quote is stripped because FTS5 interprets it as a string-literal delimiter
  // ("user's" → "users" after collapsing the resulting space).
  const escaped = raw.replace(/["'()\^*+\-]/g, ' ').replace(/\s+/g, ' ').trim();

  if (!escaped) return '';

  // Step 2: if the input contains spaces it is a natural-language phrase.
  // Strip stop words (articles, auxiliaries, prepositions) that never appear
  // in code symbol names, then rejoin as FTS5 implicit AND.
  // Fall back to the full word list if stripping removes everything.
  const words = escaped.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    // Filter stop words and single-char tokens (e.g. "s" from stripped apostrophes like "user's")
    const meaningful = words.filter((w) => w.length >= 2 && !isStopWord(w));
    const active = meaningful.length > 0 ? meaningful : words;
    // For each word, if synonyms exist, produce an FTS5 OR-group: (word OR syn1 OR syn2).
    // This lets the AND query match even when the code uses a synonym of the query word.
    const parts = active.map((w) => {
      const syns = expandVerbSynonyms(w);
      if (syns.length === 0) return w;
      return `(${[w, ...syns].join(' OR ')})`;
    });
    // FTS5 does not support implicit AND (space) adjacent to a parenthesised
    // OR group — e.g. "(remove OR delete) record" causes a syntax error.
    // Use explicit " AND " whenever at least one part is a group; otherwise
    // fall back to the original space-separated implicit AND so queries with
    // no synonyms continue to produce the same output as before.
    const hasGroup = parts.some((p) => p.startsWith('('));
    return parts.join(hasGroup ? ' AND ' : ' ');
  }

  const token = words[0];

  // Accumulate OR terms, starting with the original token.
  const terms: string[] = [token];

  // Step 3a: snake_case expansion — 'get_symbol_source' → parts joined with OR
  if (token.includes('_')) {
    const parts = token.split('_').filter((t) => t.length >= 2);
    if (parts.length > 1) {
      terms.push(...parts);
    }
  } else {
    // Step 3b: camelCase expansion — 'parseFile' → 'parseFile OR parse OR file'
    const camelParts = splitCamelCase(token);
    if (camelParts.length > 1) {
      const expanded = camelParts
        .map((t) => t.toLowerCase())
        .filter((t) => t.length >= 2);
      terms.push(...expanded);
    }
  }

  // Step 4: abbreviation expansion — for every term already in the list, add
  // its known counterpart (abbrev↔full) so both forms are searched.
  const seen = new Set(terms.map((t) => t.toLowerCase()));
  const toAdd: string[] = [];
  for (const t of terms) {
    const expansion = expandToken(t);
    if (expansion && !seen.has(expansion.toLowerCase())) {
      toAdd.push(expansion);
      seen.add(expansion.toLowerCase());
    }
  }
  terms.push(...toAdd);

  if (terms.length === 1) return terms[0];
  return terms.join(' OR ');
}

/**
 * Convert an AND-mode FTS5 query to an OR-mode fallback.
 *
 * Call this when the primary AND query returns zero results. Joining all tokens
 * with OR dramatically increases recall for multi-word natural-language queries
 * where the symbol content contains only some — not all — of the query terms.
 *
 * Rules:
 *  - Already-OR queries (have " OR " at the top level, outside parens) are returned unchanged.
 *  - Single-token queries are returned unchanged (no AND semantics in play).
 *  - Multi-word AND queries are rewritten: all tokens (including those inside synonym
 *    OR groups such as "(remove OR delete)") are flattened and joined with " OR ".
 *
 * Examples:
 *   toOrFallbackQuery('orchestrate indexing pipeline')        → 'orchestrate OR indexing OR pipeline'
 *   toOrFallbackQuery('parseFile OR parse OR file')           → 'parseFile OR parse OR file'  (unchanged)
 *   toOrFallbackQuery('parseFile')                            → 'parseFile'  (unchanged)
 *   toOrFallbackQuery('(remove OR delete) AND record AND id') → 'remove OR delete OR record OR id'
 */
export function toOrFallbackQuery(query: string): string {
  if (!query) return query;
  // Already in OR mode at the top level — nothing to change.
  // Uses hasTopLevelOr rather than a simple includes(' OR ') check so that
  // AND-mode queries containing synonym OR groups — e.g. "(remove OR delete) AND record" —
  // are still eligible for OR-fallback conversion.
  if (hasTopLevelOr(query)) return query;
  // Single token — AND semantics never applied.
  if (!query.includes(' ')) return query;
  // Flatten the query: strip parentheses, replace explicit AND/OR connectives with spaces,
  // then split into individual tokens.  This handles both implicit-AND queries
  // ("update existing record") and explicit-AND queries with synonym groups
  // ("(remove OR delete) AND record AND table AND id").
  const flat = query
    .replace(/[()]/g, ' ')
    .replace(/\bAND\b/g, ' ')
    .replace(/\bOR\b/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  // Strip stop words before OR-joining so the expanded result set is not
  // polluted by English function words that match nothing in the symbol index.
  // Fall back to the full word list when filtering removes everything.
  const meaningful = flat.filter((w) => !isStopWord(w));
  const active = meaningful.length > 0 ? meaningful : flat;
  // Also include verb synonyms in the OR list to broaden recall further.
  const seen = new Set(active.map((w) => w.toLowerCase()));
  const withSyns: string[] = [...active];
  for (const w of active) {
    for (const syn of expandVerbSynonyms(w)) {
      if (!seen.has(syn.toLowerCase())) {
        withSyns.push(syn);
        seen.add(syn.toLowerCase());
      }
    }
  }
  return withSyns.join(' OR ');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Return true when the FTS5 query has at least one " OR " connective at the
 * top level (outside any parenthesised group).
 *
 * Used by toOrFallbackQuery to distinguish between:
 *   - Queries that are already in OR mode:        "a OR b OR c"       → true
 *   - AND-mode queries with synonym OR groups:    "(a OR b) AND c"    → false
 */
function hasTopLevelOr(query: string): boolean {
  let depth = 0;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth === 0 && query.startsWith(' OR ', i)) return true;
  }
  return false;
}

/**
 * Split a camelCase or PascalCase identifier into its component words.
 * All-caps tokens (acronyms: MCP, HTTP) are returned as a single element.
 *
 * Examples:
 *   splitCamelCase('parseFile')      → ['parse', 'File']
 *   splitCamelCase('HybridSearcher') → ['Hybrid', 'Searcher']
 *   splitCamelCase('MCP')            → ['MCP']
 *   splitCamelCase('getHTTPStatus')  → ['get', 'HTTP', 'Status']
 */
function splitCamelCase(token: string): string[] {
  // All-caps acronym — do not split
  if (/^[A-Z\d]+$/.test(token)) return [token];

  const spaced = token
    // Insert space between a lowercase/digit and the next uppercase letter
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    // Insert space before the last uppercase letter in a run followed by lowercase
    // e.g. 'HTTPStatus' → 'HTTP Status'
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

  return spaced.split(' ').filter(Boolean);
}
