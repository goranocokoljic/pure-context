/**
 * Preprocesses a raw user query into a valid FTS5 MATCH string.
 *
 * Pipeline:
 *  1. Strip FTS5 special characters that would cause syntax errors.
 *  2. If the input is a multi-word natural-language phrase, pass it through
 *     unchanged (FTS5 treats whitespace as implicit AND).
 *  3. If the input is a single snake_case or camelCase identifier, expand it
 *     with OR alternatives so partial-word queries still find the symbol.
 *  4. Drop expanded tokens shorter than 2 characters.
 */

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert a raw search query into an FTS5 MATCH-safe query string.
 *
 * Examples:
 *   preprocessQuery('parseFile')             → 'parseFile OR parse OR file'
 *   preprocessQuery('get_symbol_source')     → 'get_symbol_source OR get OR symbol OR source'
 *   preprocessQuery('orchestrate indexing')  → 'orchestrate indexing'
 *   preprocessQuery('"bad chars"')           → 'bad chars'
 */
export function preprocessQuery(raw: string): string {
  // Step 1: strip/replace characters that have special meaning in FTS5 MATCH syntax.
  // Hyphen is replaced with a space because FTS5 interprets "word-word" as a column
  // filter ("column:token") which causes a syntax error for unknown column names.
  const escaped = raw.replace(/["()\^*+\-]/g, ' ').trim();

  if (!escaped) return '';

  // Step 2: if the input contains spaces it is a natural-language phrase —
  // pass it through so FTS5 treats each word as an implicit AND term.
  const words = escaped.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return words.join(' ');
  }

  const token = words[0];

  // Step 3a: snake_case expansion — 'get_symbol_source' → parts joined with OR
  if (token.includes('_')) {
    const parts = token.split('_').filter((t) => t.length >= 2);
    if (parts.length > 1) {
      return [token, ...parts].join(' OR ');
    }
    return token;
  }

  // Step 3b: camelCase expansion — 'parseFile' → 'parseFile OR parse OR file'
  const camelParts = splitCamelCase(token);
  if (camelParts.length > 1) {
    const expanded = camelParts
      .map((t) => t.toLowerCase())
      .filter((t) => t.length >= 2);
    return [token, ...expanded].join(' OR ');
  }

  return token;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
