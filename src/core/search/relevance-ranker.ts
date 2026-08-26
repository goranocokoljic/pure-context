/**
 * Post-FTS5 relevance re-ranking layer.
 *
 * BM25 ranks by term frequency across all FTS content fields, so a symbol
 * whose summary mentions "index" five times can outrank `indexFolder` whose
 * name is an exact match.  This ranker applies an explicit additive scoring
 * scheme that promotes exact name matches to the top.
 *
 * Scoring (additive, higher = more relevant):
 *  100 — exact name match (case-insensitive, entire query = entire name)
 *   60 — name starts with query
 *   40 — name contains query as substring
 *   60 — identity-exact: any single query word exactly equals the symbol name (10–40 for data kinds, scaled by 40/queryWords.length); 2× when matched word appears twice in raw query
 *   30 — all query words match a word-boundary name part (exact or stem)
 *   20 — any query word matches a word-boundary name part (exact or stem)
 *   15 — method verb bonus: first part of method name matches a query word
 *   30 — kindBoost: method on a *Service class
 *   20 — kindBoost: Rust trait (interface kind) when ALL trait name parts match query words
 *   15 — kindBoost: method on a *Repository / *Manager / *Store / *_model / *Handler / *DB / *Client / *Activity / *Fragment / *Adapter / *ViewModel / *Processor / *Indexer / *Parser / *EventSubscriber / *Listener / *FormType class
 *   10 — each query word with an exact word-boundary name-part match
 *    8 — each query word with a stem-only word-boundary name-part match
 *    8 — query phrase in signature
 *    2 — any query word in signature (per word)
 *    5 — query phrase in summary
 *    1 — any query word in summary (per word)
 *  +15 — core path boost: symbol in /core/src/main/java/ or /main/java/ (Java/Groovy repos)
 *  +20 — frontend path boost: symbol in /apps/dashboard/ etc. in mixed monorepos, on hook/component queries
 *  +20 — use/hook bonus: symbol name starts with useXxx and query has React hook vocabulary
 *   +5 — path proximity boost per overlapping query token (applies when >= 3 symbols share name)
 *  -35 — library path penalty (system/, vendor/, third_party/, node_modules/, engine/, erts/, contrib/)
 *  -35 — Java plugin path penalty: /plugins/ or /plugin/ in Java/Groovy repos
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
  identityExact: number;
  compoundUnderscoreBoost: number;
  camelCompoundBoost: number;
  singleTokenExactBoost: number;
  wordOverlap: number;
  methodVerbBonus: number;
  signatureMatch: number;
  summaryMatch: number;
  kindBoost: number;
  kindHintBoost: number;
  libraryPenalty: number;
  unexportedPenalty: number;
  corePathBoost: number;
  frontendPathBoost: number;
  useHookBonus: number;
  groovySourceBoost: number;
  angularLifecycleBoost: number;
  renderingCompoundBoost: number;
  reactQueryHookBoost: number;
  interceptorBoost: number;
  packageContextBoost: number;
  trpcPrefixBoost: number;
  pathProximityBoost: number;
  recencyBoost: number;
  ftsBm25Bonus: number;
}

export interface RankOptions {
  isMixedMonorepo?: boolean;
  hasReactHookQuery?: boolean;
  isJavaGroovyMixed?: boolean;
  isAngularRepo?: boolean;
}

export interface ScoredSymbol {
  symbol: SymbolRecord;
  score: number;
  matchReason: 'exact_name' | 'prefix_name' | 'name_contains' | 'word_overlap' | 'content_match';
  debugScore?: DebugScore;
}

// ─── Library path detection ───────────────────────────────────────────────────

/**
 * Directory names that always indicate third-party or low-priority library code,
 * regardless of where they appear in the path.  Symbols under these directories
 * receive a -35 score penalty so application-level symbols rank above them.
 *
 * Covers:
 *   system/                       CodeIgniter framework core
 *   vendor/                       Composer packages (PHP) / generic vendor trees
 *   third_party/                  Generic third-party library directories
 *   node_modules/                 npm packages
 *   bower_components/             Bower packages
 *   engine/                       Flutter C++ engine (pollutes Dart widget queries)
 *   erts/                         Erlang/OTP BEAM VM C++ (pollutes Erlang stdlib)
 *   contrib/                      Scientific computing legacy code
 */
const LIBRARY_PATH_SEGMENTS = new Set([
  'system',
  'vendor',
  'third_party',
  'node_modules',
  'bower_components',
  // Phase 71 additions:
  'engine',
  'erts',
  'contrib',
]);

/**
 * Multi-segment path substrings that identify library/low-priority code.
 * Checked case-insensitively against the full lowercased path.
 *
 *   /lib/wx/    Erlang/OTP wxWidgets C++ bindings
 *   /blas/      BLAS numerical library wrappers
 *   /lapack/    LAPACK numerical library wrappers
 */
const LIBRARY_PATH_SUBSTRINGS = [
  '/lib/wx/',
  '/blas/',
  '/lapack/',
];

/**
 * Return true when the symbol's file path contains a well-known library
 * directory segment or multi-segment substring, indicating third-party /
 * framework code.
 *
 * Uses forward-slash normalisation so paths work correctly on Windows and Unix.
 * Checks are case-insensitive to handle /BLAS/, /Engine/, etc.
 */
export function isLibraryPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.split('/').some((seg) => LIBRARY_PATH_SEGMENTS.has(seg))) return true;
  // Prepend '/' so that repo-relative paths like 'lib/wx/...' match '/lib/wx/'
  const withLeadingSlash = '/' + normalized;
  return LIBRARY_PATH_SUBSTRINGS.some((sub) => withLeadingSlash.includes(sub));
}

/**
 * For methods stored with bare names (Java post-Task 258, Rust post-Task 255),
 * extract the class/type name from the signature prefix.
 *
 * Signature formats:
 *   Java:  "ClassName.methodName: <raw sig>"
 *   Rust:  "TypeName::methodName: <raw sig>"
 *
 * Returns the lower-cased class/type name, or '' when extraction fails.
 * Guards against false positives by requiring the class part to be a simple
 * identifier (no dots or colons in it).
 */
function classFromSignature(name: string, signature: string): string {
  if (!signature) return '';
  // Dot notation — Java: "ClassName.methodName: ..."
  const dotPat = '.' + name + ':';
  const di = signature.indexOf(dotPat);
  if (di > 0) {
    const candidate = signature.slice(0, di);
    if (!candidate.includes('.') && !candidate.includes(':')) {
      return candidate.toLowerCase();
    }
  }
  // Double-colon notation — Rust: "TypeName::methodName ..."
  const colonPat = '::' + name;
  const ci = signature.indexOf(colonPat);
  if (ci > 0) {
    const candidate = signature.slice(0, ci);
    if (!candidate.includes('.') && !candidate.includes(':')) {
      return candidate.toLowerCase();
    }
  }
  return '';
}

// ─── Core path boost helpers (Task 414) ──────────────────────────────────────

/**
 * Return true when the symbol is in the canonical source directory of a
 * Java/Groovy project: /core/src/main/java/, /main/java/, or the Groovy variants.
 * Only applied when domain === 'java' so TypeScript repos with similar paths
 * are unaffected.
 */
function isCoreJavaPath(filePath: string): boolean {
  const p = '/' + filePath.replace(/\\/g, '/');
  return (
    p.includes('/core/src/main/java/') ||
    p.includes('/core/src/main/groovy/') ||
    p.includes('/main/java/') ||
    p.includes('/main/groovy/')
  );
}

/**
 * Return true when the symbol lives in a Jenkins-style plugin tree.
 * Penalised for Java/Groovy repos to lift canonical core methods above plugin
 * overrides.
 */
function isJavaPluginPath(filePath: string): boolean {
  const p = '/' + filePath.replace(/\\/g, '/').toLowerCase();
  return p.includes('/plugins/') || p.includes('/plugin/');
}

// ─── Frontend path boost helpers (Task 415) ──────────────────────────────────

/**
 * Return true when the symbol lives in a frontend app directory of a mixed
 * monorepo (e.g. novu apps/dashboard/, cal.com apps/web/).
 */
function isFrontendAppPath(filePath: string): boolean {
  const p = '/' + filePath.replace(/\\/g, '/');
  return (
    p.includes('/apps/dashboard/') ||
    p.includes('/apps/web/') ||
    p.includes('/apps/frontend/') ||
    p.includes('/apps/client/')
  );
}

/**
 * Return true when the query contains vocabulary strongly associated with
 * React hooks or frontend components.
 */
function hasFrontendVocab(queryWords: string[]): boolean {
  return queryWords.some(
    (w) =>
      (w.startsWith('use') && w.length >= 4) ||
      w === 'hook' ||
      w === 'hooks' ||
      w === 'component' ||
      w === 'react' ||
      w === 'vue' ||
      w === 'svelte',
  );
}

// ─── Path proximity boost helpers (Task 417) ─────────────────────────────────

/**
 * Common path segments that are too generic to signal query relevance.
 * Excluded from the path-proximity overlap calculation.
 */
const COMMON_PATH_SEGMENTS = new Set([
  'src', 'lib', 'app', 'apps', 'packages', 'core', 'main',
  'index', 'test', 'tests', 'dist', 'build',
]);

/**
 * Compute a path-proximity bonus for symbols whose file-path tokens overlap
 * with query words.  Only applied when ≥ 3 candidates share the exact same
 * lowercase name (suppresses noise for unique symbols).
 *
 * Returns +5 per overlapping token.
 */
function computePathProximityBoost(filePath: string, queryWords: Set<string>): number {
  const pathTokens = filePath
    .replace(/\\/g, '/')
    .split(/[/\\\-_.]/)
    .filter((t) => t.length >= 3 && !COMMON_PATH_SEGMENTS.has(t.toLowerCase()))
    .map((t) => t.toLowerCase());
  const overlap = pathTokens.filter((t) => queryWords.has(t)).length;
  return overlap * 5;
}

// ─── Phase 73 boost helpers ───────────────────────────────────────────────────

const ANGULAR_LIFECYCLE_METHODS = new Set([
  'ngOnInit', 'ngOnDestroy', 'ngAfterViewInit', 'ngAfterContentInit',
  'ngOnChanges', 'ngDoCheck', 'ngAfterViewChecked', 'ngAfterContentChecked',
]);
const LIFECYCLE_QUERY_WORDS = new Set([
  'initialization', 'initialize', 'setup', 'teardown', 'destroy', 'cleanup',
  'mount', 'unmount', 'render',
]);

/**
 * Boost Angular lifecycle methods (+10) when the query contains lifecycle
 * vocabulary ("initialization", "destroy", etc.).  Only fires in Angular repos.
 */
function computeAngularLifecycleBoost(
  symbol: SymbolRecord,
  queryWords: string[],
  isAngularRepo: boolean,
): number {
  if (!isAngularRepo) return 0;
  const methodName = symbol.name.split('.').pop() ?? symbol.name;
  if (!ANGULAR_LIFECYCLE_METHODS.has(methodName)) return 0;
  for (const w of queryWords) if (LIFECYCLE_QUERY_WORDS.has(w)) return 10;
  return 0;
}

const RENDERING_VERBS = new Set(['render', 'draw', 'stroke', 'paint', 'plot', 'sketch']);

/**
 * Boost rendering functions (+15) that share a verb (render/draw/etc.) AND at
 * least one noun with the query.  Only fires in rendering-domain repos.
 *
 * Differentiates "renderSelectionElement" from bare "render" on a query like
 * "render canvas selection element" — only the compound function has the extra
 * noun "selection" in its name.
 */
function computeRenderingCompoundBoost(
  symbol: SymbolRecord,
  queryWords: string[],
  domain?: string,
): number {
  if (domain !== 'rendering') return 0;
  if (symbol.kind !== 'function') return 0;
  const nameWords = splitNameParts(symbol.name);
  const hasVerb = nameWords.some((w) => RENDERING_VERBS.has(w)) &&
                  queryWords.some((w) => RENDERING_VERBS.has(w));
  if (!hasVerb) return 0;
  const querySet = new Set(queryWords);
  const nameNouns = nameWords.filter((w) => !RENDERING_VERBS.has(w));
  const overlap = nameNouns.filter((w) => querySet.has(w)).length;
  return overlap >= 1 ? 15 : 0;
}

const MUTATION_QUERY_VERBS = new Set(['create', 'update', 'delete', 'patch', 'remove', 'add']);
const QUERY_FILE_RE = /\b(queries|mutations|hooks)\b/i;

/**
 * Boost React Query hooks (+25) that live in queries/mutations/hooks files and
 * match a mutation verb in the query.
 *
 * useCreateSecretV3 in src/hooks/api/secrets/queries.ts should rank first for
 * queries like "create secret api hook" ahead of schema type symbols.
 */
function computeReactQueryHookBoost(symbol: SymbolRecord, queryWords: string[]): number {
  const methodName = symbol.name.split('.').pop() ?? symbol.name;
  if (!/^use[A-Z]\w+$/.test(methodName)) return 0;
  if (!QUERY_FILE_RE.test(symbol.filePath)) return 0;
  for (const w of queryWords) if (MUTATION_QUERY_VERBS.has(w)) return 25;
  return 0;
}

const INTERCEPTOR_QUERY_WORDS = new Set([
  'interceptor', 'intercept', 'resolver', 'resolve', 'guard',
  'middleware', 'pipe', 'hook',
]);
// Matches Angular/NestJS convention: tokenInterceptor, errorInterceptor,
// bankAccountResolve (Angular route resolver), authGuard, etc.
const INTERCEPTOR_NAME_RE = /(?:Interceptor|Resolver|Resolve|Guard|Middleware|Pipe)$/;

/**
 * Boost HTTP interceptor / resolver / guard symbols (+15) when the query
 * explicitly mentions those concepts.
 */
function computeInterceptorBoost(symbol: SymbolRecord, queryWords: string[]): number {
  if (symbol.kind !== 'function' && symbol.kind !== 'class') return 0;
  const baseName = symbol.name.split('.').pop() ?? symbol.name;
  if (!INTERCEPTOR_NAME_RE.test(baseName)) return 0;
  for (const w of queryWords) if (INTERCEPTOR_QUERY_WORDS.has(w)) return 30;
  return 0;
}

// Generic MVC/framework namespace segments that appear in many package names
// but convey no discriminating signal — filtering prevents false matches like
// TestApp::Controller::Action matching "catalyst action controller" queries.
const PACKAGE_SEGMENT_STOPWORDS = new Set([
  'test', 'testapp', 'base', 'action', 'controller', 'model', 'view',
  'helper', 'plugin', 'role', 'app', 'core', 'type', 'class', 'package',
  'lib', 'util', 'utils', 'common', 'shared',
]);

/**
 * Boost Perl and R symbols (+8 per overlapping package token) when query words
 * overlap with the package name prefix.
 *
 * For "Mojolicious::Controller::render" matching "mojolicious render": the
 * package tokens ["mojolicious", "controller"] overlap with "mojolicious" in
 * the query → +8. Generic MVC segments (controller, action, model…) are excluded
 * to prevent TestApp::Controller from spuriously matching catalyst queries.
 */
function computePackageContextBoost(symbol: SymbolRecord, queryWords: string[]): number {
  const ext = symbol.filePath.split('.').pop()?.toLowerCase() ?? '';
  if (!['pm', 'pl', 'r'].includes(ext)) return 0;
  const parts = symbol.name.split(/[.:]+/);
  if (parts.length < 2) return 0;
  const packageWords = parts
    .slice(0, -1)
    .flatMap((p) => splitNameParts(p))
    .filter((w) => !PACKAGE_SEGMENT_STOPWORDS.has(w));
  const querySet = new Set(queryWords);
  let overlap = 0;
  for (const pw of packageWords) if (querySet.has(pw)) overlap++;
  // +4 for first match, +8 for each additional — single-match boost is intentionally
  // modest to avoid tipping rankings where the framework name appears as context
  // (e.g. "dispatch through the Catalyst router" should not boost Catalyst::Request
  // above the bare `dispatch` function that is the correct result).
  return overlap >= 2 ? (overlap - 1) * 8 + 4 : overlap >= 1 ? 4 : 0;
}

const TRPC_PREFIX_RE = /^(createTRPC|ProcedureBuilder)/;
const TRPC_QUERY_WORDS = new Set(['trpc', 'procedure', 'builder', 'router', 'rpc']);

/**
 * Boost tRPC factory functions and ProcedureBuilder symbols (+20) when the query
 * contains tRPC vocabulary.
 */
function computeTrpcPrefixBoost(symbol: SymbolRecord, queryWords: string[]): number {
  const baseName = symbol.name.split('.')[0] ?? symbol.name;
  if (!TRPC_PREFIX_RE.test(baseName)) return 0;
  for (const w of queryWords) if (TRPC_QUERY_WORDS.has(w)) return 20;
  return 0;
}

/**
 * Single-token exact-name boost (+50 for full match, +40 for last dot-segment).
 *
 * Fires only when the query is a single bare token. Differentiates "Pod" from
 * "PodSpec" when the user typed exactly the resource name, and handles
 * dot-qualified names like "io.k8s.api.core.v1.Pod" via the last-segment check.
 */
function computeSingleTokenExactBoost(symbol: SymbolRecord, queryLower: string): number {
  if (queryLower.includes(' ')) return 0;
  const nameLower = symbol.name.toLowerCase();
  if (queryLower === nameLower) return 50;
  // For dot-qualified names (e.g. OpenAPI / protobuf schemas): also match the
  // last name segment so "pod" matches "io.k8s.api.core.v1.Pod".
  const lastDot = nameLower.lastIndexOf('.');
  if (lastDot >= 0) {
    const lastSegment = nameLower.slice(lastDot + 1);
    if (queryLower === lastSegment) return 40;
  }
  return 0;
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
export function rankSymbols(
  symbols: SymbolRecord[],
  query: string,
  debug = false,
  domain?: string,
  opts?: RankOptions,
): ScoredSymbol[] {
  if (symbols.length === 0) return [];

  const queryLower = query.trim().toLowerCase();
  const queryWords = extractQueryWords(query.trim(), domain);

  // Count raw occurrences of each query word (before deduplication/stemming) so
  // identityExact can award a 2× boost when the matched concept is repeated in the
  // query (e.g. "base formula class ... formula files" has "formula" twice, signalling
  // it is the primary search target rather than a generic modifier like "files").
  const rawQueryFreq = new Map<string, number>();
  for (const tok of query.trim().toLowerCase().split(/[\s-]+/).filter(Boolean)) {
    if (!isStopWord(tok) && tok.length >= 2) {
      rawQueryFreq.set(tok, (rawQueryFreq.get(tok) ?? 0) + 1);
    }
  }

  // ── FTS5 BM25 normalization ──────────────────────────────────────────────────
  //
  // BM25 scores are negative (more negative = better match). We normalize the
  // candidate set's BM25 scores to a [0, 50] bonus so summary-only matches
  // (e.g. a function whose name is unrelated to the query but whose docstring
  // describes it perfectly) rise above generic name-noise matches.
  //
  // Normalization formula:
  //   bonus_i = (score_i - worst) / (best - worst) * 50
  // where best = min(bm25 values) and worst = max(bm25 values).
  // When all scores are equal (range = 0), every symbol gets 25.
  const bm25Values = symbols.map((s) => s.ftsBm25 ?? 0).filter((v) => v !== 0);
  let bm25Bonuses: number[] = symbols.map(() => 0);
  if (bm25Values.length > 0) {
    const best = Math.min(...bm25Values);   // most negative = best match
    const worst = Math.max(...bm25Values);  // least negative = worst match
    const range = best - worst;             // always <= 0
    bm25Bonuses = symbols.map((s) => {
      if (s.ftsBm25 === undefined) return 0;
      return range !== 0 ? Math.max(0, ((s.ftsBm25 - worst) / range) * 50) : 25;
    });
  }

  // Java-dominant pools get the Java/Groovy ranking rules (generic-verb identity
  // scaling + camelCompound boost) even when no .groovy file made this pool —
  // per-query pool composition varies on mixed repos like jenkins (Phase 88).
  const javaCount = symbols.reduce((n, s) => n + (s.filePath.endsWith('.java') ? 1 : 0), 0);
  const effOpts: RankOptions | undefined =
    javaCount > symbols.length / 2 ? { ...opts, isJavaGroovyMixed: true } : opts;

  // First pass: compute base scores (without BM25) for all symbols.
  const baseResults = symbols.map((symbol) => score(symbol, queryLower, queryWords, rawQueryFreq, domain, effOpts));

  // Cap BM25 bonus to 30% of its computed value when any symbol already has a
  // dominant name-match score (≥80). This prevents BM25 from overriding a clear
  // winner (e.g. identityExact+namePrefix+kindBoost on a NestJS *Service method)
  // while still letting it act as a tiebreaker between similarly-scored symbols.
  // The 30% scale reduces the maximum BM25 contribution from 50 to 15 points,
  // ensuring that a ≤2-point base score gap cannot be flipped by content ranking
  // when the result set already contains a strong name match.
  const topBaseScore = Math.max(...baseResults.map((r) => r.score));
  const bm25Scale = topBaseScore >= 80 ? 0.3 : 1.0;

  // ── Path proximity boost (Task 417) ─────────────────────────────────────────
  // When ≥ 3 candidates share the exact same lowercase name, boost the one
  // whose file-path tokens overlap with query words (+5 per overlapping token).
  // Suppressed for unique names to avoid noise.
  const nameFreq = new Map<string, number>();
  for (const s of symbols) {
    const n = s.name.toLowerCase();
    nameFreq.set(n, (nameFreq.get(n) ?? 0) + 1);
  }
  const queryWordsSet = new Set(queryWords);

  const scored = symbols.map((symbol, originalIndex) => {
    const baseScore = baseResults[originalIndex]!;
    const ftsBm25Bonus = Math.round(bm25Bonuses[originalIndex]! * bm25Scale);

    let pathProximity = 0;
    if ((nameFreq.get(symbol.name.toLowerCase()) ?? 0) >= 3) {
      pathProximity = computePathProximityBoost(symbol.filePath, queryWordsSet);
    }

    baseScore.debugScore.pathProximityBoost = pathProximity;
    baseScore.debugScore.ftsBm25Bonus = ftsBm25Bonus;
    baseScore.debugScore.total += ftsBm25Bonus + pathProximity;
    return {
      ...baseScore,
      score: baseScore.score + ftsBm25Bonus + pathProximity,
      symbol,
      originalIndex,
    };
  });

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
  rawQueryFreq: ReadonlyMap<string, number>,
  domain?: string,
  opts?: RankOptions,
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

  // ── Identity-exact boost ─────────────────────────────────────────────────────
  //
  // Fires when any single query word exactly matches the symbol's bare name
  // (case-insensitive). Equivalent to JC's Identity channel (weight=2.0).
  //
  // Primary use case: with Go/Rust bare method names (Phase 46), struct/class
  // symbols like `Builder` or `Mutex` share name parts with their own methods.
  // For a query like "Builder struct" or "Mutex lock", the struct symbol should
  // rank above a method named `build` or `lock` on the same type.
  //
  // This differs from nameExact (100pt, entire query = name): identityExact fires
  // for multi-word queries where ONE word is the symbol's full name.
  //
  // Boost: +40 — large enough to overcome a method's kindBoost (+15–+30) advantage.

  // For namespace-qualified C++ names like `folly::Future`, also check the
  // bare local name (last segment after ::) for identity matching, since ground
  // truth uses bare names while the index stores qualified names. Restricted to
  // non-method symbols: methods with :: are class::method pairs (PHP, C++) where
  // the bare method name is too generic to warrant a full identity boost.
  const isNsQualified = nameLower.includes('::');
  const bareLocalName = isNsQualified && symbol.kind !== 'method'
    ? nameLower.split('::').pop()!
    : nameLower;

  // For XML-disambiguated names (e.g. project@maven-cli), also check the bare
  // tag name (part before @) for identity matching.
  const isAtDisambiguated = nameLower.includes('@');
  const bareTagName = isAtDisambiguated ? nameLower.split('@')[0]! : nameLower;

  // Find the query word that triggered identityExact (needed for the frequency lookup).
  const identityMatchWord = queryWords.find((w) => w === nameLower)
    ?? (bareLocalName !== nameLower ? queryWords.find((w) => w === bareLocalName) : undefined)
    ?? (bareTagName !== nameLower ? queryWords.find((w) => w === bareTagName) : undefined);

  let identityExact = 0;
  if (queryWords.length > 0 && identityMatchWord !== undefined) {
    // Data-definition symbols (const, type, interface, enum, property) named after
    // a single concept (e.g. STRIPE, Subscribers) fire identityExact when that word
    // appears anywhere in a multi-word query, even as incidental context rather than
    // the actual search target. Scale the bonus proportionally so the signal weakens
    // as the query grows: 40/N, minimum 10. Code-definition symbols (function, method,
    // class, …) use a higher base of 60 with a frequency multiplier (capped at 2×):
    // when the matched word appears twice in the raw query (e.g. "base formula class
    // … formula files") that repetition signals it is the primary target, giving the
    // correctly-named symbol enough margin to overcome BM25 noise from generically-
    // named symbols that also match the repeated word.
    const DATA_KINDS = new Set<string>(['const', 'type', 'interface', 'enum', 'property']);
    if (DATA_KINDS.has(symbol.kind) && queryWords.length > 1) {
      identityExact = Math.max(10, Math.round(40 / queryWords.length));
    } else {
      const rawFreq = rawQueryFreq.get(identityMatchWord) ?? 1;
      identityExact = 60 * Math.min(rawFreq, 2);
    }
    // Generic-verb identity scaling (Phase 88, jenkins diagnosis) — Java/Groovy
    // gated. Single-token generic verb names (run, execute, get, call, …) hit
    // identityExact via one query word or its verb synonym ("build run" →
    // run/execute) and outrank the actual compound-named target (setResult) on
    // nearly every natural-language query. Scale to ⅓; a query genuinely
    // targeting `run` still ranks it top since competitors carry no identity.
    if (
      opts?.isJavaGroovyMixed &&
      queryWords.length >= 3 &&
      GENERIC_METHOD_NAMES.has(nameLower)
    ) {
      identityExact = Math.round(identityExact / 3);
    }
    total += identityExact;
  }

  // ── Compound underscore identity boost (Task 433) ─────────────────────────
  // Fires when the symbol has a compound underscore name (e.g. payment_intent)
  // and ALL underscore-separated parts appear as query words. Differentiates
  // "payment_intent" from "payment_method" for query "create payment intent"
  // where both share the "payment" part but only payment_intent matches all parts.
  const queryWordsSet = new Set(queryWords);
  let compoundUnderscoreBoost = 0;
  if (identityExact === 0 && nameLower.includes('_')) {
    const uParts = nameLower.split('_').filter((p) => p.length >= 2);
    if (uParts.length >= 2 && uParts.every((p) => queryWordsSet.has(p))) {
      compoundUnderscoreBoost = 30;
      total += compoundUnderscoreBoost;
    }
  }

  // ── Compound camelCase identity boost (Phase 88, jenkins diagnosis) ────────
  // camelCase analog of compoundUnderscoreBoost: `setResult` for the query
  // "set the result status of a build run" has every name part in the query
  // but no identity signal at all, while single-verb names (run/execute) take
  // the full identityExact. Gated to mixed Java/Groovy repos (per-language
  // gates only — Phase 88 boundary).
  let camelCompoundBoost = 0;
  if (
    opts?.isJavaGroovyMixed &&
    identityExact === 0 &&
    compoundUnderscoreBoost === 0
  ) {
    const cParts = splitNameParts(symbol.name).filter((p) => p.length >= 2);
    if (cParts.length >= 2 && cParts.every((p) => queryWordsSet.has(p))) {
      camelCompoundBoost = 30;
      total += camelCompoundBoost;
    }
  }

  // ── Single-token exact-name boost (Task 434) ──────────────────────────────
  // Fires only when the query is a single bare token. Lifts "Pod" above "PodSpec"
  // for the query "Pod", and handles dot-qualified names via last-segment check.
  const singleTokenExactBoost = computeSingleTokenExactBoost(symbol, queryLower);
  total += singleTokenExactBoost;

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

  // ── Kind boost for application-layer methods and Rust traits ────────────────
  //
  // For natural-language "how to do X" queries, a method on a *Service class is
  // almost always the correct answer — not the DTO, event type, schema const, or
  // controller delegate that happens to share words with the query.
  //
  // Boost values (additive):
  //   +30 — method on a *Service class  (e.g. AuthService.login)
  //   +20 — Rust trait (interface kind) when a query word matches the trait name
  //   +15 — method on a *Repository / *Manager / *Store class  (data-access layer)
  //   +15 — method on a *_model class  (PHP CodeIgniter model convention)
  //   +15 — method on a *Handler / *DB / *Client class  (Go HTTP handlers, DB layers, API clients)
  //   +15 — method on a *Activity / *Fragment / *Adapter / *ViewModel class  (Android framework)
  //   +15 — method on a *Processor / *Indexer / *Parser class  (Python application-layer patterns)
  //   +15 — method on a *EventSubscriber / *Listener / *FormType class  (Symfony patterns)
  //
  // The method boost is applied to 'method' kind symbols.  Class context is
  // extracted from the symbol name (qualified: "ClassName.method" or
  // "TypeName::method") or, for bare-name handlers (Java, Rust), from the
  // signature prefix ("ClassName.method: <sig>" / "TypeName::method: <sig>").
  // The interface boost applies to Rust traits (kind: 'interface') when query
  // words overlap with the trait name's word-boundary parts.

  let kindBoost = 0;

  // Rust trait kindBoost: boost when ALL word-boundary parts of the trait name
  // are matched by query words.  This lifts Serialize/Deserialize above private
  // helpers for queries like "serializable type" or "implement serialize",
  // without boosting TypeScript option-bag interfaces (e.g. NuxtLinkOptions
  // which has parts [nuxt, link, options] — "link" is rarely in the query).
  if (symbol.kind === 'interface' && queryWords.length > 0) {
    const traitParts = splitNameParts(symbol.name);
    const hasQueryMatch = traitParts.length > 0 && traitParts.every((p) => queryWords.includes(p));
    if (hasQueryMatch) kindBoost = 20;
  }

  if (symbol.kind === 'method') {
    const dotIdx = symbol.name.indexOf('.');
    const colonIdx = symbol.name.indexOf('::');
    const sepIdx = dotIdx >= 0 ? dotIdx : colonIdx;
    // For bare names (Java/Rust handlers store bare methodName), fall back to
    // extracting the class/type name from the signature prefix.
    const classPart = sepIdx > 0
      ? symbol.name.slice(0, sepIdx).toLowerCase()
      : classFromSignature(symbol.name, symbol.signature);
    if (classPart) {
      if (classPart.endsWith('service')) {
        kindBoost = 30;
      } else if (
        classPart.endsWith('repository') ||
        classPart.endsWith('manager') ||
        classPart.endsWith('store') ||
        classPart.endsWith('_model') ||
        (classPart.endsWith('model') && classPart.length > 5) ||
        // PHP / NestJS controller action methods
        classPart.endsWith('_controller') ||
        (classPart.endsWith('controller') && classPart.length > 10) ||
        // Go HTTP handlers, database layers, and API clients
        classPart.endsWith('handler') ||
        classPart.endsWith('db') ||
        classPart.endsWith('client') ||
        // Android framework classes (lifecycle methods, adapters)
        classPart.endsWith('activity') ||
        classPart.endsWith('fragment') ||
        classPart.endsWith('adapter') ||
        classPart.endsWith('viewmodel') ||
        // Python application-layer class patterns
        classPart.endsWith('processor') ||
        classPart.endsWith('indexer') ||
        classPart.endsWith('parser') ||
        // Symfony event-driven and form patterns
        classPart.endsWith('eventsubscriber') ||
        classPart.endsWith('listener') ||
        classPart.endsWith('formtype') ||
        (classPart.endsWith('type') && classPart.length > 4)
      ) {
        kindBoost = 15;
      }
    }
  }
  total += kindBoost;

  // ── Kind-hint boost ──────────────────────────────────────────────────────────
  //
  // When the query explicitly names a symbol kind ("class that ...", "callback
  // interface", "enum of ..."), strongly prefer symbols of that exact kind.
  // This prevents method/function symbols from outranking the class or interface
  // the query is asking about.
  //
  // Boost value: +35 — enough to overcome the method kindBoost (+15–+30) and a
  // multi-word overlap advantage that a method on a similarly-named class may have.
  //
  // Match rules (all case-insensitive, word-boundary in query words):
  //   "class"     → prefer kind 'class' or 'struct'
  //   "interface" → prefer kind 'class', 'struct', or 'interface'
  //   "struct"    → prefer kind 'struct'
  //   "enum"      → prefer kind 'enum'
  //   "function"  → prefer kind 'function'

  let kindHintBoost = 0;
  if (queryWords.includes('class') || queryWords.includes('cls')) {
    if (symbol.kind === 'class' || symbol.kind === 'struct') kindHintBoost = 35;
  } else if (queryWords.includes('interface')) {
    if (symbol.kind === 'class' || symbol.kind === 'struct' || symbol.kind === 'interface') kindHintBoost = 35;
  } else if (queryWords.includes('struct')) {
    if (symbol.kind === 'struct') kindHintBoost = 35;
  } else if (queryWords.includes('enum')) {
    if (symbol.kind === 'enum') kindHintBoost = 35;
  }

  // ── Haskell kind hints (Phase 88, Task 545 — gated to .hs/.lhs files) ──────
  // Haskell ground-truth queries announce the kind explicitly ("function that
  // converts…", "record holding…", "sum type enumerating…"), and the P@1=0
  // failure mode was always a kind mismatch at rank 1: the type outranking the
  // asked-for function via identityExact, or a data constructor / typeclass
  // instance (spaced name, e.g. "ToHeaderValue PreferCount") outranking the
  // asked-for type via sheer word overlap. Honour the hint both ways: +35 for
  // the matching kind, −20 for a contradicting kind. Spaced instance /
  // constructor names are never the search target — −15 on multi-word queries.
  if (/\.l?hs$/.test(symbol.filePath) && queryWords.length > 1) {
    const HS_TYPE_KINDS = new Set<string>(['class', 'type', 'interface', 'enum']);
    const wantsFunction = queryWords.includes('function');
    const wantsType =
      queryWords.includes('record') || queryWords.includes('type') ||
      queryWords.includes('enumeration') || queryWords.includes('alias');
    if (kindHintBoost === 0) {
      if (wantsFunction) {
        if (symbol.kind === 'function' || symbol.kind === 'method') kindHintBoost = 35;
        else if (HS_TYPE_KINDS.has(symbol.kind) || symbol.kind === 'const') kindHintBoost = -20;
      } else if (wantsType) {
        if (HS_TYPE_KINDS.has(symbol.kind)) kindHintBoost = 35;
        else if (symbol.kind === 'function' || symbol.kind === 'method') kindHintBoost = -20;
      }
    }
    if (symbol.name.includes(' ')) kindHintBoost -= 15;
  }
  total += kindHintBoost;

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

  // Perl test-fixture penalty: symbols in t/lib/ (e.g. TestApp::Controller)
  // are test stubs that should not outrank the actual library API symbols.
  if (libraryPenalty === 0) {
    const ext = symbol.filePath.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'pm' || ext === 'pl') {
      const normalizedFp = symbol.filePath.replace(/\\/g, '/').toLowerCase();
      if (normalizedFp.startsWith('t/lib/') || normalizedFp.includes('/t/lib/')) {
        libraryPenalty = -25;
        total += libraryPenalty;
      }
    }
  }

  // ── Unexported-visibility penalty (Phase 84, Task 520) ──────────────────────
  //
  // Go unexported names (lowercase first letter) are indexed since Phase 84 so
  // they stay findable, but for natural-language queries the exported API is
  // almost always the intended answer — package-private helpers with similar
  // names must not outrank it.  Mild penalty (-20): below the library penalty
  // (-35) and well below identityExact (+40), so an explicit search for the
  // exact unexported name still surfaces it at the top.
  // Phase 87 extends the same rule to Rust: no-modifier items are indexed with
  // visibility 'module' (module-private) — same "findable but not first" call.
  let unexportedPenalty = 0;
  {
    const vis = (symbol.frameworkMeta as Record<string, unknown> | undefined)?.['visibility'];
    if (vis === 'unexported' || vis === 'module') {
      unexportedPenalty = -20;
      total += unexportedPenalty;
    }
  }

  // ── Core path boost (Task 414) ────────────────────────────────────────────
  // For Java/Groovy repos: boost canonical core source paths (+15) and penalise
  // plugin implementations (-35) so core methods surface above plugin overrides.
  let corePathBoost = 0;
  if (domain === 'java' && libraryPenalty === 0) {
    // Check plugin penalty BEFORE core-path boost: plugin dirs may also contain
    // /main/java/ sub-paths, so ordering matters.
    if (isJavaPluginPath(symbol.filePath)) {
      corePathBoost = -35;
      total += corePathBoost;
    } else if (isCoreJavaPath(symbol.filePath)) {
      corePathBoost = 15;
      total += corePathBoost;
    }
  }

  // ── Frontend path boost (Task 415) ───────────────────────────────────────
  // In mixed monorepos (frontend + backend apps/ subdirs), boost symbols from
  // frontend paths when the query uses hook/component/use* vocabulary.
  let frontendPathBoost = 0;
  if (opts?.isMixedMonorepo && isFrontendAppPath(symbol.filePath) && hasFrontendVocab(queryWords)) {
    frontendPathBoost = 20;
    total += frontendPathBoost;
  }

  // ── Use/hook bonus (Task 416) ────────────────────────────────────────────
  // When the query is asking for a React hook (use*/hook vocabulary) and the
  // OR-fallback fired (indicated by opts.hasReactHookQuery), reward symbols
  // whose names follow the React hook naming convention (use[A-Z]...).
  let useHookBonus = 0;
  if (opts?.hasReactHookQuery && /^use[A-Z]/.test(symbol.name)) {
    useHookBonus = 20;
    total += useHookBonus;
  }

  // ── Groovy source boost (Task 423) ───────────────────────────────────────
  // In mixed Java+Groovy repos (e.g. gradle, groovy) Java methods dominate by
  // sheer count. Give a +10 bonus to symbols in .groovy files so that Groovy
  // `def` methods surface above equally-scored Java counterparts.
  let groovySourceBoost = 0;
  if (opts?.isJavaGroovyMixed && symbol.filePath.endsWith('.groovy')) {
    groovySourceBoost = 10;
    total += groovySourceBoost;
  }

  // ── Phase 73 boosts ───────────────────────────────────────────────────────

  const p73AngularLifecycle = computeAngularLifecycleBoost(
    symbol, queryWords, opts?.isAngularRepo ?? false,
  );
  total += p73AngularLifecycle;

  const p73RenderingCompound = computeRenderingCompoundBoost(symbol, queryWords, domain);
  total += p73RenderingCompound;

  const p73ReactQueryHook = computeReactQueryHookBoost(symbol, queryWords);
  total += p73ReactQueryHook;

  const p73Interceptor = computeInterceptorBoost(symbol, queryWords);
  total += p73Interceptor;

  const p73PackageContext = computePackageContextBoost(symbol, queryWords);
  total += p73PackageContext;

  const p73TrpcPrefix = computeTrpcPrefixBoost(symbol, queryWords);
  total += p73TrpcPrefix;

  const debugScore: DebugScore = {
    total,
    nameExact,
    namePrefix,
    nameFuzzy,
    identityExact,
    compoundUnderscoreBoost,
    camelCompoundBoost,
    singleTokenExactBoost,
    wordOverlap,
    methodVerbBonus,
    signatureMatch,
    summaryMatch,
    kindBoost,
    kindHintBoost,
    libraryPenalty,
    unexportedPenalty,
    corePathBoost,
    frontendPathBoost,
    useHookBonus,
    groovySourceBoost,
    angularLifecycleBoost: p73AngularLifecycle,
    renderingCompoundBoost: p73RenderingCompound,
    reactQueryHookBoost: p73ReactQueryHook,
    interceptorBoost: p73Interceptor,
    packageContextBoost: p73PackageContext,
    trpcPrefixBoost: p73TrpcPrefix,
    pathProximityBoost: 0, // filled in by rankSymbols after the name-frequency pass
    recencyBoost: 0,
    ftsBm25Bonus: 0,
  };

  return { score: total, matchReason, debugScore };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Single-token method names so generic that an identityExact hit on them is
 * almost never the query's real target in a natural-language multi-word query
 * (jenkins: "set the result status of a build run" → `run`/`execute` beat
 * `setResult`). Used only under the isJavaGroovyMixed gate.
 */
const GENERIC_METHOD_NAMES: ReadonlySet<string> = new Set([
  'run', 'execute', 'call', 'invoke', 'apply', 'main', 'start', 'stop',
  'init', 'close', 'open', 'get', 'set', 'add', 'remove', 'create', 'delete',
  'update', 'read', 'write', 'load', 'save', 'check', 'handle', 'process',
  'build', 'make', 'next', 'reset', 'clear', 'accept', 'submit', 'perform',
]);

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
  // Split on namespace/method-call separators: \ (PHP/Python paths), : (PHP ::), . (TS dot notation), @ (XML disambiguation)
  for (const segment of name.split(/[\\:.@]+/)) {
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
function extractQueryWords(raw: string, domain?: string): string[] {
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
    for (const syn of expandVerbSynonyms(lower, domain)) {
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
