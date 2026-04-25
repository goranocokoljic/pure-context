/**
 * Query expansion — generates lightweight variations of a search query to
 * improve recall without requiring API calls.
 *
 * Techniques:
 *   - Abbreviation expansion: "auth" → ["authentication", "authorization"]
 *   - Camel/snake splitting: "getUserById" → ["get", "user", "by", "id"]
 *   - Common synonym expansion for programming terms
 */

// ─── Abbreviation Map ─────────────────────────────────────────────────────────

const ABBREVIATIONS: Record<string, string[]> = {
  auth:    ['authentication', 'authorization', 'authenticate', 'authorize'],
  authn:   ['authentication', 'authenticate'],
  authz:   ['authorization', 'authorize'],
  db:      ['database'],
  repo:    ['repository'],
  cfg:     ['config', 'configuration'],
  config:  ['configuration'],
  env:     ['environment'],
  msg:     ['message'],
  err:     ['error'],
  req:     ['request'],
  res:     ['response'],
  resp:    ['response'],
  ctx:     ['context'],
  fn:      ['function'],
  func:    ['function'],
  cb:      ['callback'],
  param:   ['parameter'],
  params:  ['parameters'],
  args:    ['arguments'],
  arg:     ['argument'],
  val:     ['value'],
  vals:    ['values'],
  idx:     ['index'],
  info:    ['information'],
  mgr:     ['manager'],
  svc:     ['service'],
  srv:     ['server'],
  cmd:     ['command'],
  cmds:    ['commands'],
  init:    ['initialize', 'initialization'],
  util:    ['utility', 'utilities'],
  utils:   ['utilities', 'utility'],
  impl:    ['implementation', 'implement'],
  def:     ['definition', 'default'],
  calc:    ['calculate', 'calculation'],
  max:     ['maximum'],
  min:     ['minimum'],
  num:     ['number'],
  str:     ['string'],
  int:     ['integer'],
  bool:    ['boolean'],
  buf:     ['buffer'],
  perm:    ['permission'],
  perms:   ['permissions'],
  pwd:     ['password'],
  usr:     ['user'],
  addr:    ['address'],
  conn:    ['connection'],
  conns:   ['connections'],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Split a camelCase or snake_case identifier into lowercase tokens.
 *
 * Examples:
 *   getUserById   → ['get', 'user', 'by', 'id']
 *   validate_user → ['validate', 'user']
 *   HTTPSClient   → ['https', 'client']
 */
function splitIdentifier(word: string): string[] {
  // snake_case / kebab-case split
  const parts = word.replace(/[-_]/g, ' ').split(' ');

  const tokens: string[] = [];
  for (const part of parts) {
    // camelCase / PascalCase split: insert space before uppercase sequences
    const camelSplit = part
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(' ')
      .filter(Boolean);
    tokens.push(...camelSplit);
  }

  return tokens;
}

/**
 * Expand a single token using the abbreviation map.
 * Returns the token itself plus any expansions.
 */
function expandToken(token: string): string[] {
  const lower = token.toLowerCase();
  const expansions = ABBREVIATIONS[lower];
  return expansions ? [lower, ...expansions] : [lower];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate query variations for better semantic search coverage.
 *
 * The returned array always includes the original query as the first element.
 * Duplicates are removed. The result is limited to 8 variations to keep
 * embedding costs bounded.
 *
 * @example
 * expandQuery('auth')
 * // → ['auth', 'authentication', 'authorization', 'authenticate', 'authorize']
 *
 * expandQuery('getUserById')
 * // → ['getUserById', 'get user by id', 'getuser', 'by', 'id']
 */
export function expandQuery(query: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  function add(s: string): void {
    const trimmed = s.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      results.push(trimmed);
    }
  }

  // Always include the original
  add(query);

  const words = query.trim().split(/\s+/);

  // If query is a single word, try identifier splitting
  if (words.length === 1) {
    const tokens = splitIdentifier(query);

    // Joined form (e.g., 'get user by id')
    if (tokens.length > 1) {
      add(tokens.join(' '));
    }

    // Abbreviation expansions for the whole word and each token
    for (const token of [query.toLowerCase(), ...tokens]) {
      for (const expansion of expandToken(token)) {
        add(expansion);
      }
    }
  } else {
    // Multi-word query: expand each word individually
    for (const word of words) {
      for (const expansion of expandToken(word)) {
        add(expansion);
      }
    }
  }

  // Cap at 8 variations to keep embedding cost bounded
  return results.slice(0, 8);
}
