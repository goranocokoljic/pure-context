import { describe, it, expect } from 'vitest';
import { preprocessQuery, expandToken, toOrFallbackQuery, isStopWord, expandVerbSynonyms } from '../../src/core/search/query-preprocessor.js';

// ─── camelCase splitting ──────────────────────────────────────────────────────

describe('preprocessQuery — camelCase splitting', () => {
  it('expands parseFile to include parse and file', () => {
    const result = preprocessQuery('parseFile');
    expect(result).toContain('parse');
    expect(result).toContain('file');
    // Original token preserved as first term
    expect(result.split(' OR ')[0]).toBe('parseFile');
  });

  it('expands HybridSearcher to include hybrid and searcher', () => {
    const result = preprocessQuery('HybridSearcher');
    const lower = result.toLowerCase();
    expect(lower).toContain('hybrid');
    expect(lower).toContain('searcher');
  });

  it('does not split all-caps acronym MCP', () => {
    const result = preprocessQuery('MCP');
    expect(result).toBe('MCP');
  });

  it('does not split all-caps acronym HTTP', () => {
    const result = preprocessQuery('HTTP');
    expect(result).toBe('HTTP');
  });

  it('handles PascalCase with multiple words', () => {
    const result = preprocessQuery('IndexManager');
    expect(result.toLowerCase()).toContain('index');
    expect(result.toLowerCase()).toContain('manager');
  });

  it('handles camelCase with acronym in middle (getHTTPStatus)', () => {
    const result = preprocessQuery('getHTTPStatus');
    const lower = result.toLowerCase();
    expect(lower).toContain('get');
    expect(lower).toContain('status');
  });
});

// ─── snake_case splitting ─────────────────────────────────────────────────────

describe('preprocessQuery — snake_case splitting', () => {
  it('expands get_symbol_source to include get, symbol, source', () => {
    const result = preprocessQuery('get_symbol_source');
    expect(result).toContain('get');
    expect(result).toContain('symbol');
    expect(result).toContain('source');
    // Original token preserved
    expect(result.split(' OR ')[0]).toBe('get_symbol_source');
  });

  it('expands index_folder to include index and folder', () => {
    const result = preprocessQuery('index_folder');
    expect(result).toContain('index');
    expect(result).toContain('folder');
  });

  it('returns token unchanged when no multi-part snake_case', () => {
    const result = preprocessQuery('simple');
    expect(result).toBe('simple');
  });
});

// ─── natural language passthrough ────────────────────────────────────────────

describe('preprocessQuery — natural language passthrough', () => {
  it('passes orchestrate indexing pipeline through unchanged', () => {
    const result = preprocessQuery('orchestrate indexing pipeline');
    expect(result).toBe('orchestrate indexing pipeline');
  });

  it('passes a two-word phrase through unchanged', () => {
    const result = preprocessQuery('format diagnostic');
    expect(result).toBe('format diagnostic');
  });

  it('trims extra whitespace in multi-word queries', () => {
    const result = preprocessQuery('  blast   radius  ');
    expect(result).toBe('blast radius');
  });
});

// ─── FTS5 special character escaping ─────────────────────────────────────────

describe('preprocessQuery — special char escaping', () => {
  it('strips double quotes from query', () => {
    const result = preprocessQuery('"dangerous query"');
    expect(result).not.toContain('"');
    expect(result).toContain('dangerous');
    expect(result).toContain('query');
  });

  it('strips parentheses', () => {
    const result = preprocessQuery('foo(bar)');
    expect(result).not.toContain('(');
    expect(result).not.toContain(')');
  });

  it('strips caret and asterisk', () => {
    const result = preprocessQuery('foo^*bar');
    expect(result).not.toContain('^');
    expect(result).not.toContain('*');
  });

  it('returns empty string for all-special-char input', () => {
    const result = preprocessQuery('"()*^');
    expect(result).toBe('');
  });

  it('replaces hyphens to avoid FTS5 column-filter syntax error', () => {
    // "tree-sitter" would become column filter "tree:sitter" in FTS5 — must be sanitised
    const result = preprocessQuery('tree-sitter');
    expect(result).not.toContain('-');
    expect(result).toContain('tree');
    expect(result).toContain('sitter');
  });

  it('multi-word query with hyphen passes both words through', () => {
    const result = preprocessQuery('parse tree-sitter ast');
    expect(result).not.toContain('-');
    expect(result).toContain('parse');
    expect(result).toContain('ast');
  });

  it('strips single quotes to avoid FTS5 string-literal syntax error', () => {
    // "user's" → "users" after stripping ' and collapsing spaces
    const result = preprocessQuery("user's cart");
    expect(result).not.toContain("'");
    expect(result).toContain('user');
    expect(result).toContain('cart');
  });

  it('handles possessive apostrophe in multi-word query without crashing', () => {
    const result = preprocessQuery("change the logged-in user's password");
    expect(result).not.toContain("'");
    expect(result).toContain('user');
    expect(result).toContain('password');
  });
});

// ─── Short token filter ───────────────────────────────────────────────────────

describe('preprocessQuery — short token filter', () => {
  it('drops single-char tokens from camelCase expansion', () => {
    // 'aFile' splits to 'a' and 'file' — 'a' should be dropped
    const result = preprocessQuery('aFile');
    const terms = result.split(' OR ');
    // 'a' should not appear as a standalone OR term after the original
    expect(terms.filter((t) => t === 'a')).toHaveLength(0);
    expect(terms.some((t) => t.toLowerCase() === 'file')).toBe(true);
  });

  it('keeps two-char tokens like "go"', () => {
    // 'goRun' → 'go' and 'run'; 'go' has length 2 and should be kept
    const result = preprocessQuery('goRun');
    const lower = result.toLowerCase();
    expect(lower).toContain('go');
    expect(lower).toContain('run');
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('preprocessQuery — edge cases', () => {
  it('returns empty string for empty input', () => {
    expect(preprocessQuery('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(preprocessQuery('   ')).toBe('');
  });

  it('handles single lowercase word', () => {
    expect(preprocessQuery('format')).toBe('format');
  });

  it('preserves numbers within identifiers', () => {
    const result = preprocessQuery('phase14');
    // Numbers don't trigger camelCase split — returned as-is
    expect(result).toBe('phase14');
  });
});

// ─── Task 216: expandToken ────────────────────────────────────────────────────

describe('expandToken — unit', () => {
  it('expands "db" to "database"', () => {
    expect(expandToken('db')).toBe('database');
  });

  it('expands "DB" (uppercase) to "database" (case-insensitive)', () => {
    expect(expandToken('DB')).toBe('database');
  });

  it('expands "database" to "db" (reverse direction)', () => {
    expect(expandToken('database')).toBe('db');
  });

  it('expands "auth" to "authentication"', () => {
    expect(expandToken('auth')).toBe('authentication');
  });

  it('expands "authentication" to "auth"', () => {
    expect(expandToken('authentication')).toBe('auth');
  });

  it('expands "cfg" to "config"', () => {
    expect(expandToken('cfg')).toBe('config');
  });

  it('expands "config" to "cfg"', () => {
    expect(expandToken('config')).toBe('cfg');
  });

  it('expands "msg" to "message"', () => {
    expect(expandToken('msg')).toBe('message');
  });

  it('expands "req" to "request"', () => {
    expect(expandToken('req')).toBe('request');
  });

  it('expands "res" to "response"', () => {
    expect(expandToken('res')).toBe('response');
  });

  it('expands "err" to "error"', () => {
    expect(expandToken('err')).toBe('error');
  });

  it('expands "ctx" to "context"', () => {
    expect(expandToken('ctx')).toBe('context');
  });

  it('expands "fn" to "function"', () => {
    expect(expandToken('fn')).toBe('function');
  });

  it('expands "dir" to "directory"', () => {
    expect(expandToken('dir')).toBe('directory');
  });

  it('returns null for unknown token', () => {
    expect(expandToken('parseFile')).toBeNull();
  });

  it('returns null for an unrecognised short word', () => {
    expect(expandToken('foo')).toBeNull();
  });
});

// ─── Task 216: abbreviation expansion in preprocessQuery ─────────────────────

describe('preprocessQuery — abbreviation expansion (single token)', () => {
  it('"db" expands to include "database"', () => {
    const result = preprocessQuery('db');
    expect(result).toContain('db');
    expect(result).toContain('database');
    expect(result.split(' OR ')[0]).toBe('db');
  });

  it('"database" expands to include "db"', () => {
    const result = preprocessQuery('database');
    expect(result).toContain('database');
    expect(result).toContain('db');
  });

  it('"auth" expands to include "authentication"', () => {
    const result = preprocessQuery('auth');
    expect(result).toContain('auth');
    expect(result).toContain('authentication');
  });

  it('"authentication" expands to include "auth"', () => {
    const result = preprocessQuery('authentication');
    expect(result).toContain('authentication');
    expect(result).toContain('auth');
  });

  it('"cfg" expands to include "config"', () => {
    const result = preprocessQuery('cfg');
    expect(result).toContain('cfg');
    expect(result).toContain('config');
  });

  it('"err" expands to include "error"', () => {
    const result = preprocessQuery('err');
    expect(result).toContain('err');
    expect(result).toContain('error');
  });

  it('"ctx" expands to include "context"', () => {
    const result = preprocessQuery('ctx');
    expect(result).toContain('ctx');
    expect(result).toContain('context');
  });

  it('camelCase with embedded abbreviation — "getDbRow" includes "database"', () => {
    const result = preprocessQuery('getDbRow');
    expect(result).toContain('getDbRow');
    expect(result).toContain('get');
    expect(result).toContain('database');
  });

  it('camelCase with embedded abbreviation — "openDbConnection" includes "database"', () => {
    const result = preprocessQuery('openDbConnection');
    expect(result).toContain('openDbConnection');
    expect(result).toContain('database');
    expect(result).toContain('connection');
  });

  it('snake_case with abbreviation — "get_db_row" includes "database"', () => {
    const result = preprocessQuery('get_db_row');
    expect(result).toContain('get_db_row');
    expect(result).toContain('db');
    expect(result).toContain('database');
    expect(result).toContain('row');
  });

  it('no duplicate terms when token matches its own expansion direction', () => {
    // "db" should appear exactly once, "database" exactly once
    const result = preprocessQuery('db');
    const terms = result.split(' OR ');
    expect(terms.filter((t) => t === 'db')).toHaveLength(1);
    expect(terms.filter((t) => t === 'database')).toHaveLength(1);
  });

  it('unknown single token is not expanded', () => {
    const result = preprocessQuery('format');
    expect(result).toBe('format');
  });

  it('multi-word natural language is not altered by abbreviation expansion', () => {
    // "db connection" is multi-word — passed through as AND, no OR expansion
    const result = preprocessQuery('db connection');
    expect(result).toBe('db connection');
  });

  it('"fn" expands to include "function"', () => {
    const result = preprocessQuery('fn');
    expect(result).toContain('fn');
    expect(result).toContain('function');
  });

  it('"dir" expands to include "directory"', () => {
    const result = preprocessQuery('dir');
    expect(result).toContain('dir');
    expect(result).toContain('directory');
  });

  it('expansion result contains original token as first OR term', () => {
    const result = preprocessQuery('auth');
    expect(result.split(' OR ')[0]).toBe('auth');
  });

  it('"env" expands to include "environment"', () => {
    const result = preprocessQuery('env');
    expect(result).toContain('env');
    expect(result).toContain('environment');
  });
});

// ─── Task 218: isStopWord ─────────────────────────────────────────────────────

describe('isStopWord — unit', () => {
  it('"and" is a stop word', () => {
    expect(isStopWord('and')).toBe(true);
  });

  it('"the" is a stop word', () => {
    expect(isStopWord('the')).toBe(true);
  });

  it('"for" is a stop word', () => {
    expect(isStopWord('for')).toBe(true);
  });

  it('"is" is a stop word', () => {
    expect(isStopWord('is')).toBe(true);
  });

  it('"to" is a stop word', () => {
    expect(isStopWord('to')).toBe(true);
  });

  it('"from" is a stop word', () => {
    expect(isStopWord('from')).toBe(true);
  });

  it('"into" is a stop word', () => {
    expect(isStopWord('into')).toBe(true);
  });

  it('check is case-insensitive — "AND" is a stop word', () => {
    expect(isStopWord('AND')).toBe(true);
  });

  it('"get" is NOT a stop word', () => {
    expect(isStopWord('get')).toBe(false);
  });

  it('"create" is NOT a stop word', () => {
    expect(isStopWord('create')).toBe(false);
  });

  it('"delete" is NOT a stop word', () => {
    expect(isStopWord('delete')).toBe(false);
  });

  it('"all" IS a stop word (common English quantifier, near-zero identifier use)', () => {
    expect(isStopWord('all')).toBe(true);
  });

  it('"not" is NOT a stop word (appears in isNotNull, notFound)', () => {
    expect(isStopWord('not')).toBe(false);
  });

  it('"new" IS a stop word (common English adjective, near-zero identifier use in multi-word NL queries)', () => {
    expect(isStopWord('new')).toBe(true);
  });
});

// ─── Task 218: stop word filtering in preprocessQuery ────────────────────────

describe('preprocessQuery — stop word filtering (multi-word)', () => {
  it('removes conjunction "and" from multi-word query', () => {
    expect(preprocessQuery('render and display')).toBe('render display');
  });

  it('removes article "the" from multi-word query', () => {
    // "load" now has synonyms (get, find, fetch) so the output is an AND query with an OR group
    const result = preprocessQuery('load the user');
    expect(result).toContain('load');
    expect(result).toContain('user');
    expect(result).not.toContain('the');
  });

  it('removes multiple stop words in one pass', () => {
    // "and" + "the" removed; "execute" now has synonyms so output has OR group
    const result = preprocessQuery('execute query and return the row');
    expect(result).toContain('execute');
    expect(result).toContain('query');
    expect(result).toContain('return');
    expect(result).toContain('row');
    expect(result).not.toContain(' the ');
    expect(result).not.toContain(' and ');
  });

  it('removes preposition "for" from multi-word query', () => {
    expect(preprocessQuery('base controller for public pages')).toBe('base controller public pages');
  });

  it('removes auxiliary "be" from multi-word query', () => {
    expect(preprocessQuery('function to be called from twig')).toBe('function called twig');
  });

  it('preserves meaningful verbs like "get", "set" but filters "new", "all"', () => {
    // "from", "new", "all" are stop words; "get" and "user" are preserved
    expect(preprocessQuery('get new user from all')).toBe('get user');
  });

  it('falls back to original words when ALL tokens are stop words', () => {
    // Should not produce empty string
    const result = preprocessQuery('is it for the');
    expect(result).toBe('is it for the');
  });

  it('does NOT filter stop words from single-word queries', () => {
    // Single-word branch is not affected — "for" alone is a valid identifier search
    expect(preprocessQuery('for')).toBe('for');
  });

  it('does NOT filter stop words from OR-expanded single identifiers', () => {
    // camelCase expansion should still work normally
    const result = preprocessQuery('parseFile');
    expect(result).toContain('parse');
    expect(result).toContain('file');
  });

  // Phase 39 additions
  it('filters "with" as a stop word', () => {
    expect(preprocessQuery('authenticate user with credentials')).not.toContain('with');
  });

  it('filters "without" as a stop word', () => {
    expect(preprocessQuery('disable product without deleting')).not.toContain('without');
  });

  it('filters "using" as a stop word', () => {
    expect(preprocessQuery('confirm email using verification token')).not.toContain('using');
  });

  it('filters "before" as a stop word', () => {
    expect(preprocessQuery('cancel order before ships')).not.toContain('before');
  });

  it('filters "existing" as a stop word', () => {
    expect(preprocessQuery('cancel existing order')).not.toContain('existing');
  });

  it('filters single-char tokens from multi-word queries (apostrophe-stripped "s")', () => {
    // "user's" → "user s" after apostrophe strip; "s" (length 1) must be dropped
    const result = preprocessQuery("change the user's password");
    expect(result).not.toMatch(/\bs\b/);
    expect(result).toContain('change');
    expect(result).toContain('user');
    expect(result).toContain('password');
  });
});

// ─── Task 218: stop word filtering in toOrFallbackQuery ──────────────────────

describe('toOrFallbackQuery — stop word filtering', () => {
  it('removes stop words before joining with OR', () => {
    expect(toOrFallbackQuery('render and display')).toBe('render OR display');
  });

  it('removes multiple stop words from OR conversion (stop words only — no synonym expansion in OR fallback)', () => {
    // toOrFallbackQuery does NOT expand synonyms — it only flattens existing OR groups.
    // "execute query and return row" preprocessed → "(execute OR run OR perform) AND query AND return AND row"
    // OR-fallback of that → "execute OR run OR perform OR query OR return OR row"
    const preprocessed = preprocessQuery('execute query and return row');
    const orResult = toOrFallbackQuery(preprocessed);
    expect(orResult).toContain('execute');
    expect(orResult).toContain('query');
    expect(orResult).toContain('return');
    expect(orResult).toContain('row');
    expect(orResult).not.toContain(' AND ');
    expect(orResult).not.toContain(' and ');
  });

  it('removes prepositions before OR conversion', () => {
    expect(toOrFallbackQuery('configure paths for views')).toBe('configure OR paths OR views');
  });

  it('falls back to all words when all are stop words', () => {
    const result = toOrFallbackQuery('is it for the');
    expect(result).toBe('is OR it OR for OR the');
  });

  it('leaves single-token query unchanged (no stop word check needed)', () => {
    expect(toOrFallbackQuery('indexFolder')).toBe('indexFolder');
  });

  it('leaves already-OR query unchanged', () => {
    const q = 'parse OR source OR file';
    expect(toOrFallbackQuery(q)).toBe(q);
  });
});

// ─── Task 220: expandVerbSynonyms — unit ─────────────────────────────────────

describe('expandVerbSynonyms — unit', () => {
  it('remove → delete and clear (bidirectional with clear)', () => {
    expect(expandVerbSynonyms('remove')).toEqual(['delete', 'clear']);
  });

  it('delete → remove (bidirectional)', () => {
    expect(expandVerbSynonyms('delete')).toEqual(['remove']);
  });

  it('pagination → paging', () => {
    expect(expandVerbSynonyms('pagination')).toEqual(['paging']);
  });

  it('paging → pagination (bidirectional)', () => {
    expect(expandVerbSynonyms('paging')).toEqual(['pagination']);
  });

  it('signin → login', () => {
    expect(expandVerbSynonyms('signin')).toEqual(['login']);
  });

  it('retrieve → get and fetch', () => {
    expect(expandVerbSynonyms('retrieve')).toEqual(['get', 'fetch']);
  });

  it('expose → register', () => {
    expect(expandVerbSynonyms('expose')).toEqual(['register']);
  });

  it('attach → add', () => {
    expect(expandVerbSynonyms('attach')).toEqual(['add']);
  });

  it('lookup is case-insensitive — REMOVE maps like remove', () => {
    expect(expandVerbSynonyms('REMOVE')).toEqual(['delete', 'clear']);
  });

  it('unknown token returns empty array', () => {
    expect(expandVerbSynonyms('unknown')).toEqual([]);
  });

  it('get has no synonym (retrieve→get is one-directional)', () => {
    expect(expandVerbSynonyms('get')).toEqual([]);
  });

  it('login has no synonym (signin→login is one-directional)', () => {
    expect(expandVerbSynonyms('login')).toEqual([]);
  });

  // Phase 39 new synonyms
  it('confirm → verify', () => {
    expect(expandVerbSynonyms('confirm')).toEqual(['verify']);
  });

  it('verify → confirm + check (Phase 43 addition)', () => {
    const syns = expandVerbSynonyms('verify');
    expect(syns).toContain('confirm');
    expect(syns).toContain('check');
  });

  it('authenticate → login', () => {
    expect(expandVerbSynonyms('authenticate')).toEqual(['login']);
  });

  it('disable → deactivate', () => {
    expect(expandVerbSynonyms('disable')).toEqual(['deactivate']);
  });

  it('deactivate → disable (bidirectional)', () => {
    expect(expandVerbSynonyms('deactivate')).toEqual(['disable']);
  });

  it('suspend → deactivate and disable', () => {
    expect(expandVerbSynonyms('suspend')).toEqual(['deactivate', 'disable']);
  });

  it('clear → remove and delete', () => {
    expect(expandVerbSynonyms('clear')).toEqual(['remove', 'delete']);
  });

  it('initiate → create and start', () => {
    expect(expandVerbSynonyms('initiate')).toEqual(['create', 'start']);
  });

  it('save → create and store', () => {
    expect(expandVerbSynonyms('save')).toEqual(['create', 'store']);
  });
});

// ─── Task 220: verb synonym expansion in preprocessQuery (multi-word) ─────────

describe('preprocessQuery — verb synonym expansion (multi-word)', () => {
  it('remove → wraps as (remove OR delete OR clear) in AND query', () => {
    const result = preprocessQuery('remove unused imports');
    expect(result).toContain('(remove OR delete OR clear)');
    expect(result).toContain('unused');
    expect(result).toContain('imports');
  });

  it('delete → wraps as (delete OR remove) in AND query', () => {
    const result = preprocessQuery('delete user account');
    expect(result).toContain('(delete OR remove)');
    expect(result).toContain('user');
    expect(result).toContain('account');
  });

  it('retrieve → wraps as (retrieve OR get OR fetch) in AND query', () => {
    const result = preprocessQuery('retrieve user records');
    expect(result).toContain('(retrieve OR get OR fetch)');
    expect(result).toContain('user');
    expect(result).toContain('records');
  });

  it('pagination → wraps as (pagination OR paging)', () => {
    const result = preprocessQuery('pagination controls render');
    expect(result).toContain('(pagination OR paging)');
    expect(result).toContain('controls');
    expect(result).toContain('render');
  });

  it('expose → wraps as (expose OR register)', () => {
    const result = preprocessQuery('expose api routes');
    expect(result).toContain('(expose OR register)');
    expect(result).toContain('api');
    expect(result).toContain('routes');
  });

  it('attach → wraps as (attach OR add)', () => {
    const result = preprocessQuery('attach middleware pipeline');
    expect(result).toContain('(attach OR add)');
    expect(result).toContain('middleware');
    expect(result).toContain('pipeline');
  });

  it('signin → wraps as (signin OR login) after hyphen strip', () => {
    // "sign-in" → hyphen stripped → "sign in" → two words; "in" is stop word → "sign"
    // "signin" (no hyphen) as a single word → single-word path, not multi-word
    // Test multi-word with "signin" already merged:
    const result = preprocessQuery('signin page handler');
    expect(result).toContain('(signin OR login)');
    expect(result).toContain('page');
    expect(result).toContain('handler');
  });

  it('words without synonyms are passed through unchanged', () => {
    const result = preprocessQuery('orchestrate indexing pipeline');
    expect(result).toBe('orchestrate indexing pipeline');
  });

  it('stop words are filtered before synonym expansion', () => {
    // "for" is a stop word and is removed; "remove" gets synonym expansion
    const result = preprocessQuery('remove entry for user');
    expect(result).toContain('(remove OR delete OR clear)');
    expect(result).toContain('entry');
    expect(result).toContain('user');
    expect(result).not.toContain('for');
  });
});

// ─── Task 220: verb synonym expansion in toOrFallbackQuery ───────────────────

describe('toOrFallbackQuery — verb synonym expansion', () => {
  it('remove adds delete to OR list', () => {
    const result = toOrFallbackQuery('remove unused imports');
    expect(result).toContain('remove');
    expect(result).toContain('delete');
    expect(result).toContain('unused');
    expect(result).toContain('imports');
    // All joined with OR
    expect(result).toMatch(/remove OR|OR remove/);
    expect(result).toMatch(/delete/);
  });

  it('retrieve adds get and fetch to OR list', () => {
    const result = toOrFallbackQuery('retrieve data from cache');
    expect(result).toContain('retrieve');
    expect(result).toContain('get');
    expect(result).toContain('fetch');
    expect(result).toContain('data');
    expect(result).toContain('cache');
    // "from" is a stop word and should be excluded
    expect(result).not.toContain('from');
  });

  it('pagination adds paging to OR list', () => {
    const result = toOrFallbackQuery('pagination settings');
    expect(result).toContain('pagination');
    expect(result).toContain('paging');
    expect(result).toContain('settings');
  });

  it('no duplicate synonyms added when synonym already in query', () => {
    // "remove" would add "delete", but "delete" is already present — no dup
    const result = toOrFallbackQuery('remove delete unused');
    const terms = result.split(' OR ');
    expect(terms.filter((t) => t === 'delete')).toHaveLength(1);
    expect(terms.filter((t) => t === 'remove')).toHaveLength(1);
  });

  it('words without synonyms are not affected', () => {
    const result = toOrFallbackQuery('orchestrate indexing pipeline');
    expect(result).toBe('orchestrate OR indexing OR pipeline');
  });
});

// ─── FTS5 explicit AND for synonym groups (bug fix) ──────────────────────────

describe('preprocessQuery — explicit AND with synonym groups', () => {
  it('uses explicit AND when any part is a synonym group', () => {
    // "(remove OR delete OR clear)" is a group — must use AND not implicit space so FTS5
    // does not throw "syntax error near <next token>"
    const result = preprocessQuery('remove record from table by id');
    expect(result).toBe('(remove OR delete OR clear) AND record AND table AND id');
  });

  it('still uses spaces (implicit AND) when no synonyms are present', () => {
    const result = preprocessQuery('orchestrate indexing pipeline');
    expect(result).toBe('orchestrate indexing pipeline');
  });

  it('explicit AND separates every token when first token has synonyms', () => {
    const result = preprocessQuery('delete user account');
    expect(result).toBe('(delete OR remove) AND user AND account');
  });

  it('explicit AND separates every token when middle token has synonyms', () => {
    const result = preprocessQuery('get and remove item');
    // "and" is a stop word → removed; "remove" gets synonym group
    expect(result).toBe('get AND (remove OR delete OR clear) AND item');
  });
});

describe('toOrFallbackQuery — synonym group flattening', () => {
  it('flattens synonym groups into top-level OR terms', () => {
    // Produced by preprocessQuery when "remove" has a synonym group:
    // "(remove OR delete) AND record AND table AND id"
    const result = toOrFallbackQuery('(remove OR delete) AND record AND table AND id');
    expect(result).toContain('remove');
    expect(result).toContain('delete');
    expect(result).toContain('record');
    expect(result).toContain('table');
    expect(result).toContain('id');
    // All joined with OR (no AND remaining)
    expect(result).not.toContain(' AND ');
    expect(result).not.toContain('(');
  });

  it('leaves top-level OR query unchanged even if it contains inner OR groups', () => {
    // "a OR b OR c" has top-level OR → unchanged
    expect(toOrFallbackQuery('remove OR delete OR record')).toBe('remove OR delete OR record');
  });

  it('does not duplicate synonyms already present from the group', () => {
    const result = toOrFallbackQuery('(remove OR delete) AND record AND table AND id');
    const terms = result.split(' OR ');
    expect(terms.filter((t) => t === 'remove')).toHaveLength(1);
    expect(terms.filter((t) => t === 'delete')).toHaveLength(1);
  });

  it('flattens multiple synonym groups', () => {
    const result = toOrFallbackQuery('(remove OR delete) AND image AND (attach OR add) AND name');
    expect(result).toContain('remove');
    expect(result).toContain('delete');
    expect(result).toContain('image');
    expect(result).toContain('attach');
    expect(result).toContain('add');
    expect(result).toContain('name');
    expect(result).not.toContain(' AND ');
  });
});

// ─── forgot ↔ reset synonym (gt-03 regression) ───────────────────────────────

describe('expandVerbSynonyms — forgot/reset password flow', () => {
  it('"forgot" expands to ["reset"]', () => {
    expect(expandVerbSynonyms('forgot')).toContain('reset');
  });

  it('"reset" expands to ["forgot"]', () => {
    expect(expandVerbSynonyms('reset')).toContain('forgot');
  });

  it('multi-word query "send password reset link" includes forgot synonym group in FTS', () => {
    // "reset" → synonym "forgot", so FTS output should have OR group for "reset"
    const result = preprocessQuery('send password reset link');
    // Both "reset" and "forgot" should appear (either as OR group or inline)
    expect(result).toContain('reset');
    expect(result).toContain('forgot');
  });

  it('multi-word query "forgot password" includes reset synonym group', () => {
    const result = preprocessQuery('forgot password');
    expect(result).toContain('forgot');
    expect(result).toContain('reset');
  });
});

// ─── Phase 43 synonym round 2 ─────────────────────────────────────────────────

describe('expandVerbSynonyms — fetch/execute/run/sign/check round 2', () => {
  it('"fetch" expands to ["get", "retrieve"]', () => {
    const syns = expandVerbSynonyms('fetch');
    expect(syns).toContain('get');
    expect(syns).toContain('retrieve');
  });

  it('"execute" expands to ["run", "perform"]', () => {
    const syns = expandVerbSynonyms('execute');
    expect(syns).toContain('run');
    expect(syns).toContain('perform');
  });

  it('"run" expands to ["execute"]', () => {
    expect(expandVerbSynonyms('run')).toContain('execute');
  });

  it('"perform" expands to ["execute", "run"]', () => {
    const syns = expandVerbSynonyms('perform');
    expect(syns).toContain('execute');
    expect(syns).toContain('run');
  });

  it('"sign" expands to ["login"] (for sign-in hyphen split)', () => {
    expect(expandVerbSynonyms('sign')).toContain('login');
  });

  it('"check" expands to ["verify", "confirm"]', () => {
    const syns = expandVerbSynonyms('check');
    expect(syns).toContain('verify');
    expect(syns).toContain('confirm');
  });

  it('"verify" now also expands to include "check"', () => {
    expect(expandVerbSynonyms('verify')).toContain('check');
  });

  it('"resolve" expands to ["verify", "check"]', () => {
    const syns = expandVerbSynonyms('resolve');
    expect(syns).toContain('verify');
    expect(syns).toContain('check');
  });

  it('"load" expands to ["get", "find", "fetch"]', () => {
    const syns = expandVerbSynonyms('load');
    expect(syns).toContain('get');
    expect(syns).toContain('find');
    expect(syns).toContain('fetch');
  });

  it('"lookup" expands to ["find", "get"]', () => {
    const syns = expandVerbSynonyms('lookup');
    expect(syns).toContain('find');
    expect(syns).toContain('get');
  });
});

describe('preprocessQuery — PHP benchmark near-miss queries round 2', () => {
  it('"fetch scalar value from database" includes "get" and "retrieve" synonyms', () => {
    const result = preprocessQuery('fetch scalar value from database');
    expect(result).toContain('fetch');
    expect(result).toContain('get');
    expect(result).toContain('retrieve');
  });

  it('"execute parameterized query" includes "run" and "perform" synonyms', () => {
    const result = preprocessQuery('execute parameterized query');
    expect(result).toContain('execute');
    expect(result).toContain('run');
    expect(result).toContain('perform');
  });

  it('"controller handling user sign-in form" includes "login" from sign synonym', () => {
    // "sign-in" → hyphen stripped → "sign" + "in" (stop word) → "sign" expands to "login"
    const result = preprocessQuery('controller handling user sign-in form submission');
    expect(result).toContain('sign');
    expect(result).toContain('login');
  });

  it('"load and verify admin user access rights" includes check/confirm synonyms', () => {
    const result = preprocessQuery('load and verify admin user access rights');
    expect(result).toContain('verify');
    expect(result).toContain('check');
    expect(result).toContain('confirm');
  });

  it('"render twig template" — no synonym confusion, stays clean', () => {
    const result = preprocessQuery('render twig template');
    // No synonym for "render" — should remain as-is
    expect(result).toContain('render');
    expect(result).toContain('twig');
    expect(result).toContain('template');
  });
});

// ─── Phase 43 synonym round 3 (log → insert/record) ──────────────────────────

describe('expandVerbSynonyms — log synonym (gt-08 fix)', () => {
  it('"log" expands to ["insert", "record"]', () => {
    const syns = expandVerbSynonyms('log');
    expect(syns).toContain('insert');
    expect(syns).toContain('record');
  });

  it('"log" synonym is lowercase-normalised', () => {
    const syns = expandVerbSynonyms('LOG');
    expect(syns).toContain('insert');
    expect(syns).toContain('record');
  });
});

describe('preprocessQuery — log synonym fixes gt-08 insert regression', () => {
  it('"log user action" query includes "insert" and "record" from log synonym', () => {
    const result = preprocessQuery('log user action');
    // "log" should expand to synonyms "insert" and "record"
    expect(result).toContain('insert');
    expect(result).toContain('record');
    expect(result).toContain('log');
  });

  it('"log user action on content item with type and description" — full benchmark query', () => {
    const result = preprocessQuery('log user action on content item with type and description');
    // "log" synonym words must appear in the OR group or expanded query
    expect(result).toContain('insert');
    expect(result).toContain('record');
    // Stop words should be removed
    expect(result).not.toContain(' on ');
    expect(result).not.toContain(' with ');
  });
});

// ─── Punctuation stripping (FTS5 safety) ─────────────────────────────────────

describe('preprocessQuery — punctuation stripping', () => {
  it('strips commas from natural-language queries with commas', () => {
    const result = preprocessQuery('add a digit, respecting radix, integer mode');
    expect(result).not.toContain(',');
    // Remaining meaningful words should be present
    expect(result).toContain('digit');
    expect(result).toContain('respecting');
    expect(result).toContain('radix');
    expect(result).toContain('integer');
    expect(result).toContain('mode');
  });

  it('strips colons, semicolons, and exclamation marks', () => {
    const result = preprocessQuery('check status: active; not pending!');
    expect(result).not.toContain(':');
    expect(result).not.toContain(';');
    expect(result).not.toContain('!');
  });

  it('strips question marks', () => {
    const result = preprocessQuery('is the user authenticated?');
    expect(result).not.toContain('?');
  });

  it('returns valid FTS5 query for comma-heavy benchmark query', () => {
    // Reproduces the calculator benchmark crash (gt-10)
    const q = 'add a single digit to the current numeric input, respecting radix, integer mode, and word-bit-width limits';
    const result = preprocessQuery(q);
    expect(result).not.toContain(',');
    expect(result).not.toMatch(/[,:;!?]/);
    // Should contain meaningful words
    expect(result).toContain('digit');
    expect(result).toContain('numeric');
  });

  it('strips periods from queries containing version numbers like 802.11', () => {
    // Reproduces the airodump benchmark crash (gt-03, gt-15)
    const q = 'process a captured 802.11 packet and record it';
    const result = preprocessQuery(q);
    expect(result).not.toContain('.');
    expect(result).toContain('802');
    expect(result).toContain('packet');
  });

  it('strips periods from DD.MM.YYYY date format strings', () => {
    const q = 'extract and format date portion as DD.MM.YYYY';
    const result = preprocessQuery(q);
    expect(result).not.toContain('.');
  });

  it('strips forward slashes from I/O and open/closed style queries', () => {
    // Reproduces tokio gt-20/gt-21 and origamicms-frontend gt-14
    expect(preprocessQuery('trait for reading bytes from an I/O source')).not.toContain('/');
    expect(preprocessQuery('store controlling open/closed modal state')).not.toContain('/');
    expect(preprocessQuery('1D/2D sample generation')).not.toContain('/');
  });
});
