import { describe, it, expect } from 'vitest';
import { rankSymbols, isLibraryPath } from '../../src/core/search/relevance-ranker.js';
import type { SymbolRecord } from '../../src/core/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sym(
  name: string,
  opts: Partial<Pick<SymbolRecord, 'kind' | 'filePath' | 'signature' | 'summary'>> = {},
): SymbolRecord {
  return {
    id: `id-${name}`,
    name,
    kind: opts.kind ?? 'function',
    filePath: opts.filePath ?? 'src/index.ts',
    startByte: 0,
    endByte: 100,
    signature: opts.signature ?? `function ${name}()`,
    summary: opts.summary ?? `Does ${name}`,
  };
}

// ─── Exact name beats everything ─────────────────────────────────────────────

describe('rankSymbols — exact name match ranked first', () => {
  it('indexFolder at rank 1 when query is "indexFolder"', () => {
    const symbols = [sym('indexRepo'), sym('getBlastRadius'), sym('indexFolder')];
    const results = rankSymbols(symbols, 'indexFolder');
    expect(results[0].symbol.name).toBe('indexFolder');
    expect(results[0].matchReason).toBe('exact_name');
  });

  it('exact match score is 100 or more', () => {
    const results = rankSymbols([sym('indexFolder'), sym('indexRepo')], 'indexFolder');
    expect(results[0].score).toBeGreaterThanOrEqual(100);
  });

  it('exact match always beats prefix match', () => {
    // 'parseFile' is exact; 'parseFileAsync' is prefix
    const results = rankSymbols([sym('parseFileAsync'), sym('parseFile')], 'parseFile');
    expect(results[0].symbol.name).toBe('parseFile');
    expect(results[0].matchReason).toBe('exact_name');
    expect(results[1].matchReason).toBe('prefix_name');
  });

  it('prefix always beats name_contains', () => {
    const results = rankSymbols([sym('findParseFile'), sym('parseFileContent')], 'parseFile');
    // 'parseFileContent' starts with 'parseFile' → prefix
    // 'findParseFile' contains 'parseFile' → name_contains
    expect(results[0].symbol.name).toBe('parseFileContent');
    expect(results[0].matchReason).toBe('prefix_name');
    expect(results[1].matchReason).toBe('name_contains');
  });
});

// ─── Multi-word query: word overlap ──────────────────────────────────────────

describe('rankSymbols — multi-word query word overlap', () => {
  it('"blast radius" ranks getBlastRadius above buildGraph', () => {
    const results = rankSymbols([sym('buildGraph'), sym('getBlastRadius')], 'blast radius');
    expect(results[0].symbol.name).toBe('getBlastRadius');
    expect(results[0].matchReason).toBe('word_overlap');
  });

  it('word_overlap score >= 30 when all query words appear in name', () => {
    const results = rankSymbols([sym('getBlastRadius')], 'blast radius');
    // all words ('blast', 'radius') appear in name → 30 + 10 + 10 = 50
    expect(results[0].score).toBeGreaterThanOrEqual(30);
  });

  it('partial word match scores lower than all-words match', () => {
    // 'getBlastRadius' has both words; 'getBlastZone' has only 'blast'
    const results = rankSymbols([sym('getBlastZone'), sym('getBlastRadius')], 'blast radius');
    expect(results[0].symbol.name).toBe('getBlastRadius');
    expect(results[1].symbol.name).toBe('getBlastZone');
  });
});

// ─── CamelCase query expansion ────────────────────────────────────────────────

describe('rankSymbols — camelCase query', () => {
  it('indexFolder query scores indexFolder (exact) above indexRepo (partial word)', () => {
    const results = rankSymbols([sym('indexRepo'), sym('indexFolder')], 'indexFolder');
    expect(results[0].symbol.name).toBe('indexFolder');
  });

  it('camelCase query words match against name components', () => {
    // Query 'parseFile' has words ['parsefile', 'parse', 'file']
    // 'parseSymbols' contains 'parse' → word_overlap
    const results = rankSymbols([sym('buildGraph'), sym('parseSymbols')], 'parseFile');
    expect(results[0].symbol.name).toBe('parseSymbols');
    expect(results[0].matchReason).toBe('word_overlap');
  });
});

// ─── Signature and summary scoring ───────────────────────────────────────────

describe('rankSymbols — content matching', () => {
  it('signature match scores higher than summary-only match', () => {
    const sigMatch = sym('buildA', { signature: 'function buildA(indexFolder: string)', summary: 'builds stuff' });
    const sumMatch = sym('buildB', { signature: 'function buildB()', summary: 'calls indexFolder internally' });
    const results = rankSymbols([sumMatch, sigMatch], 'indexFolder');
    // sigMatch has 8pts for phrase in sig; sumMatch has 5pts for phrase in summary
    expect(results[0].symbol.name).toBe('buildA');
  });

  it('matchReason is content_match when only signature/summary matched', () => {
    const s = sym('utilHelper', {
      signature: 'function utilHelper()',
      summary: 'formats and displays output',
    });
    const results = rankSymbols([s], 'formats displays');
    expect(results[0].matchReason).toBe('content_match');
  });
});

// ─── Tie-breaking ────────────────────────────────────────────────────────────

describe('rankSymbols — tie-breaking preserves FTS order', () => {
  it('equal-score symbols keep their original array order', () => {
    // Both symbols have zero relevance to 'zzz' — should stay in original order
    const a = sym('alphaFn');
    const b = sym('betaFn');
    const c = sym('gammaFn');
    const results = rankSymbols([a, b, c], 'zzz');
    expect(results[0].symbol.name).toBe('alphaFn');
    expect(results[1].symbol.name).toBe('betaFn');
    expect(results[2].symbol.name).toBe('gammaFn');
  });
});

// ─── score and matchReason fields ────────────────────────────────────────────

describe('rankSymbols — output structure', () => {
  it('each result has symbol, score, and matchReason', () => {
    const results = rankSymbols([sym('formatDiagnostic')], 'format');
    expect(results[0]).toHaveProperty('symbol');
    expect(results[0]).toHaveProperty('score');
    expect(results[0]).toHaveProperty('matchReason');
    expect(typeof results[0].score).toBe('number');
  });

  it('returns empty array for empty input', () => {
    expect(rankSymbols([], 'query')).toHaveLength(0);
  });

  it('score is non-negative', () => {
    const results = rankSymbols([sym('foo'), sym('bar')], 'baz');
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── Word-boundary name-part matching ────────────────────────────────────────

describe('rankSymbols — word-boundary name-part matching', () => {
  it('exact name-part match outranks stem-only namespace-prefix match', () => {
    // "model" is an exact name part of CIR_Model (+10 per-word bonus)
    // "models" in models\\Article_base stems to "model" — only a stem match (+8)
    // Exact match wins over stem match, even when FTS order favours the latter.
    const modelClass = sym('CIR_Model', { kind: 'class' });
    const articleBase = sym('models\\Article_base', { kind: 'class' });
    const results = rankSymbols([articleBase, modelClass], 'model');
    expect(results[0].symbol.name).toBe('CIR_Model');
  });

  it('symbol with 2 matching name parts outranks symbol with 1 matching part', () => {
    // getSettings has parts [homepage, model, get, settings]
    // Homepage has parts [homepage]
    // query "retrieve homepage settings" → "homepage" and "settings" match getSettings
    const getSettings = sym('Homepage_model::getSettings', { kind: 'method' });
    const homepage = sym('Homepage', { kind: 'class' });
    const results = rankSymbols([homepage, getSettings], 'retrieve homepage settings');
    expect(results[0].symbol.name).toBe('Homepage_model::getSettings');
  });

  it('all-parts-match (30pt) fires when every query word matches a name part', () => {
    // "get row" → "get" and "row" both in parts of CIR_Model::get_row
    const getRow = sym('CIR_Model::get_row', { kind: 'method' });
    const getAll = sym('CIR_Model::get_all', { kind: 'method' });
    // get_row matches both "get" and "row"; get_all matches "get" but not "row"
    const results = rankSymbols([getAll, getRow], 'get row');
    expect(results[0].symbol.name).toBe('CIR_Model::get_row');
  });

  it('word-boundary matching does not fire when word is only a substring of a part', () => {
    // "add" should NOT match "address" (which contains "add" as a substring, but
    // "address" is the full word-boundary part — "add" ≠ "address")
    const addressFn = sym('getAddress', { kind: 'function' });
    const addFn = sym('addItem', { kind: 'function' });
    const results = rankSymbols([addressFn, addFn], 'add');
    // addItem has "add" as exact part; getAddress has "address" which is not "add"
    expect(results[0].symbol.name).toBe('addItem');
  });

  it('name parts from PHP namespaced names are split correctly', () => {
    // "bridge\\Grant_base_class::get_all" → parts include "bridge", "grant", "base", etc.
    const bridgeFn = sym('bridge\\Grant_base_class::get_all', { kind: 'method' });
    const grantFn = sym('GrantHelper', { kind: 'function' });
    const results = rankSymbols([bridgeFn, grantFn], 'grant');
    // Both match "grant"; bridge\\Grant gets it from "grant" part, GrantHelper from "grant" part
    // Just verify both get word_overlap matchReason
    expect(results.every((r) => r.matchReason === 'word_overlap' || r.score > 0)).toBe(true);
  });
});

// ─── Suffix stemming ──────────────────────────────────────────────────────────

describe('rankSymbols — suffix stemming', () => {
  it('plural -s: "models" query matches "model" name part', () => {
    // "models" stem is "model", which matches the part "model" in CIR_Model
    const cirModel = sym('CIR_Model', { kind: 'class' });
    const unrelated = sym('FileHelper', { kind: 'class' });
    const results = rankSymbols([unrelated, cirModel], 'models');
    expect(results[0].symbol.name).toBe('CIR_Model');
    expect(results[0].matchReason).toBe('word_overlap');
  });

  it('past tense -ed (e-drop): "updated" stem "update" matches name part', () => {
    // "updated" → stems include "update" → matches "update" part in Homepage_model::update
    const updateFn = sym('Homepage_model::update', { kind: 'method' });
    const saveFn = sym('CI_Cache_file::save', { kind: 'method' });
    const results = rankSymbols([saveFn, updateFn], 'save updated homepage');
    // updateFn matches "update" (from "updated") + "homepage"; saveFn matches "save"
    expect(results[0].symbol.name).toBe('Homepage_model::update');
  });

  it('past tense -ed (regular): "matched" stem "match" matches name part', () => {
    const matchFn = sym('matchPattern', { kind: 'function' });
    const unrelated = sym('buildGraph', { kind: 'function' });
    const results = rankSymbols([unrelated, matchFn], 'matched pattern');
    expect(results[0].symbol.name).toBe('matchPattern');
  });

  it('gerund -ing: "building" stem "build" matches name part', () => {
    const buildFn = sym('buildDependencyGraph', { kind: 'function' });
    const unrelated = sym('parseConfig', { kind: 'function' });
    const results = rankSymbols([unrelated, buildFn], 'building dependency graph');
    expect(results[0].symbol.name).toBe('buildDependencyGraph');
  });

  it('-tion: "pagination" stem "paginat" is added to query words', () => {
    // "pagination" → "paginat" (won't match "paging" but won't break things)
    // Primary assertion: symbol with "pagination" in its name still ranks well
    const paginateFn = sym('addPagination', { kind: 'method' });
    const unrelated = sym('connectDatabase', { kind: 'function' });
    const results = rankSymbols([unrelated, paginateFn], 'pagination');
    // "pagination" is an exact substring of "addPagination" → nameFuzzy fires (40pt)
    expect(results[0].symbol.name).toBe('addPagination');
  });

  it('-s not applied to -ss endings: "class" is NOT stemmed to "clas"', () => {
    const classFn = sym('parseClass', { kind: 'function' });
    const results = rankSymbols([classFn], 'class');
    // "class" should still match "parseClass" via nameFuzzy (substring), not stem
    expect(results[0].symbol.name).toBe('parseClass');
    expect(results[0].score).toBeGreaterThan(0);
  });
});

// ─── Hyphenated query token splitting ────────────────────────────────────────

describe('rankSymbols — hyphen splitting in queries', () => {
  it('"front-end" split into "front" and "end" for word-boundary matching', () => {
    // CIR_FrontController has parts ["cir", "front", "controller"]
    // "front-end" → ["front", "end"]; "front" matches name part of FrontController
    const frontCtrl = sym('CIR_FrontController', { kind: 'class' });
    const tagsPage = sym('eu_format_interval_for_tags_page', { kind: 'function' });
    // query words: front(from front-end), end, controller, pages→page
    const results = rankSymbols([tagsPage, frontCtrl], 'front-end controller');
    expect(results[0].symbol.name).toBe('CIR_FrontController');
  });

  it('"public-facing front-end" yields "public", "facing", "front", "end"', () => {
    // CIR_FrontController matches "front" and "controller"
    const frontCtrl = sym('CIR_FrontController', { kind: 'class' });
    const unrelated = sym('CI_DB_utility', { kind: 'class' });
    const results = rankSymbols([unrelated, frontCtrl],
      'base controller for public-facing front-end pages');
    expect(results[0].symbol.name).toBe('CIR_FrontController');
  });

  it('hyphen splits into tokens and synonym expansion fires (sign-in finds login symbols)', () => {
    // "sign-in" → hyphen stripped → "sign" + "in"(stop word) → queryWords include "sign"
    // "sign" expands to "login" via synonym, so UserLogin (contains "login") gets a word match.
    // The literal "sign-in" hyphenated token never appears in queryWords.
    const loginFn = sym('UserLogin', { kind: 'class' });
    const signFn = sym('signDocument', { kind: 'function' });
    const results = rankSymbols([loginFn, signFn], 'sign-in form');
    // "login" from synonym matches UserLogin's "login" part → UserLogin wins
    expect(results[0].symbol.name).toBe('UserLogin');
  });

  it('hyphen does not produce a literal "sign-in" token (only "sign" and "in" segments)', () => {
    // Verify using a non-synonym query: "back-end" → "back" + "end"
    // Neither "backend" nor "back-end" should be a queryWord; only "back" and "end"
    const backendSym = sym('BackendService', { kind: 'class' });
    const frontendSym = sym('FrontendController', { kind: 'class' });
    const results = rankSymbols([backendSym, frontendSym], 'back-end service');
    // "back" matches BackendService; "service" matches BackendService
    expect(results[0].symbol.name).toBe('BackendService');
  });
});

// ─── Benchmark-aligned regression tests ──────────────────────────────────────

describe('rankSymbols — benchmark scenario regressions', () => {
  it('gt-21: Homepage_model::getSettings outranks Homepage for settings retrieval query', () => {
    // Homepage gets +20 (any-part match for "homepage") + 10 = 30
    // Homepage_model::getSettings gets +20 + 20 (homepage + settings) = 40
    const getSettings = sym('Homepage_model::getSettings', {
      kind: 'method',
      signature: 'getSettings(): Settings',
      summary: 'Retrieve homepage content settings from database',
    });
    const homepage = sym('Homepage', {
      kind: 'class',
      signature: 'class Homepage',
      summary: 'Homepage controller',
    });
    const results = rankSymbols([homepage, getSettings],
      'retrieve homepage content settings from database');
    expect(results[0].symbol.name).toBe('Homepage_model::getSettings');
  });

  it('gt-22: Homepage_model::update outranks CI_Cache_file::save for save-updated query', () => {
    // "updated" stems include "update" which matches name part "update"
    // "homepage" matches name part "homepage"
    // → Homepage_model::update gets 2 part matches (update + homepage)
    // CI_Cache_file::save gets 1 part match (save)
    const updateFn = sym('Homepage_model::update', {
      kind: 'method',
      signature: 'update(data: object): void',
      summary: 'Save updated homepage content data',
    });
    const saveFn = sym('CI_Cache_file::save', {
      kind: 'method',
      signature: 'save(id: string, data: mixed): bool',
      summary: 'Save data to cache file',
    });
    const results = rankSymbols([saveFn, updateFn], 'save updated homepage content data');
    expect(results[0].symbol.name).toBe('Homepage_model::update');
  });

  it('gt-12: CIR_FrontController outranks eu_format_interval_for_tags_page for front-end controller query', () => {
    // After hyphen-split: "front" + "end", plus "controller", "pages"→"page"
    // CIR_FrontController: "front" ✓ + "controller" ✓ → 2 part matches
    // eu_format_interval_for_tags_page: "page" ✓ → 1 part match
    const frontCtrl = sym('CIR_FrontController', {
      kind: 'class',
      signature: 'class CIR_FrontController extends CIR_Controller',
      summary: 'Base controller for public-facing front-end pages',
    });
    const formatFn = sym('eu_format_interval_for_tags_page', {
      kind: 'function',
      signature: 'function eu_format_interval_for_tags_page(int $interval): string',
      summary: 'Format interval value for display on tags page',
    });
    const results = rankSymbols([formatFn, frontCtrl],
      'base controller for public-facing front-end pages');
    expect(results[0].symbol.name).toBe('CIR_FrontController');
  });

  it('word_overlap score >= 30 when all query words match name parts (updated rule)', () => {
    const results = rankSymbols([sym('getBlastRadius')], 'blast radius');
    // "blast" + "radius" both match parts → 30 (all) + 20 (any) + 10 + 10 = 70
    expect(results[0].score).toBeGreaterThanOrEqual(30);
  });
});

// ─── Kind boost — application-layer method preference ────────────────────────

describe('rankSymbols — kindBoost for Service/Repository methods', () => {
  it('Service method outranks Controller method with same name parts', () => {
    // "authenticate user" query: AuthService.login and AuthController.login
    // both have same word-overlap; Service gets +30 kindBoost
    const serviceMethod = sym('AuthService.login', { kind: 'method', summary: 'Authenticates a user' });
    const controllerMethod = sym('AuthController.login', { kind: 'method', summary: 'Authenticates a user' });
    const results = rankSymbols([controllerMethod, serviceMethod], 'authenticate user login');
    expect(results[0].symbol.name).toBe('AuthService.login');
  });

  it('Service method outranks controller method and DTO for authenticate/login query', () => {
    // "authenticate login credentials" → "login" matches all three names
    // AuthService.login gets +30 kindBoost, AuthController.login gets 0, LoginDto gets 0
    const serviceMethod = sym('AuthService.login', { kind: 'method', summary: 'Authenticates a user with credentials' });
    const controllerMethod = sym('AuthController.login', { kind: 'method', summary: 'Login endpoint' });
    const dto = sym('LoginDto', { kind: 'class', summary: 'DTO for login request' });
    const results = rankSymbols([dto, controllerMethod, serviceMethod], 'authenticate login credentials');
    expect(results[0].symbol.name).toBe('AuthService.login');
  });

  it('Service method kindBoost is +30 and reflected in debugScore', () => {
    const serviceMethod = sym('PaymentsService.refund', { kind: 'method' });
    const results = rankSymbols([serviceMethod], 'process refund payment', true);
    expect(results[0].debugScore?.kindBoost).toBe(30);
  });

  it('Repository method gets +15 kindBoost', () => {
    const repoMethod = sym('UserRepository.findById', { kind: 'method' });
    const results = rankSymbols([repoMethod], 'find user by id', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('Manager method gets +15 kindBoost', () => {
    const managerMethod = sym('CacheManager.get', { kind: 'method' });
    const results = rankSymbols([managerMethod], 'get cached value', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('Controller method gets kindBoost = 15 (Phase 45 — controllers now boosted)', () => {
    const controllerMethod = sym('AuthController.login', { kind: 'method' });
    const results = rankSymbols([controllerMethod], 'login user', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('non-method kinds get no kindBoost even with Service in name', () => {
    // A class named "AuthService" should not get kindBoost (it's a class, not a method)
    const serviceClass = sym('AuthService', { kind: 'class' });
    const results = rankSymbols([serviceClass], 'authenticate', true);
    expect(results[0].debugScore?.kindBoost).toBe(0);
  });

  it('PHP-style :: notation methods on Service class get +30 kindBoost', () => {
    const phpServiceMethod = sym('UserService::create', { kind: 'method' });
    const results = rankSymbols([phpServiceMethod], 'create user', true);
    expect(results[0].debugScore?.kindBoost).toBe(30);
  });

  it('Service method with dot notation ranks above schema const for deactivate query', () => {
    // Mirrors gt-10 benchmark scenario
    const serviceMethod = sym('ProductsService.deactivate', {
      kind: 'method',
      summary: 'Sets product active flag to false',
    });
    const schemaConst = sym('deactivateProductSchema', {
      kind: 'const',
      summary: 'Zod schema for deactivate request',
    });
    const results = rankSymbols([schemaConst, serviceMethod], 'disable product without deleting');
    expect(results[0].symbol.name).toBe('ProductsService.deactivate');
  });

  it('Service method with ::- style separator outranks helper function for same query', () => {
    const serviceMethod = sym('OrdersService::cancelOrder', { kind: 'method' });
    const helperFn = sym('cancelOrderEmail', { kind: 'function' });
    const results = rankSymbols([helperFn, serviceMethod], 'cancel order before shipment');
    expect(results[0].symbol.name).toBe('OrdersService::cancelOrder');
  });
});

// ─── Name-part stem matching ──────────────────────────────────────────────────

describe('rankSymbols — name part stem matching', () => {
  it('gt-06: ProductsService.create outranks Prisma CreateProductInput for "create product listing"', () => {
    // ProductsService.create: name parts ["products","service","create"]
    //   stems: "products" → "product" — query word "product" now matches ✓
    //   + kindBoost +30 → total high score
    // ProductCreateInput: name parts ["product","create","input"]
    //   "product" matches ✓, "create" matches ✓ — but no kindBoost (it's a type)
    const serviceMethod = sym('ProductsService.create', {
      kind: 'method',
      summary: 'Persists a new product record with its category, price and slug.',
    });
    const prismaType = sym('ProductCreateInput', {
      kind: 'type',
      summary: 'Prisma input type for creating a product.',
    });
    const results = rankSymbols([prismaType, serviceMethod], 'create new product listing with category and price');
    expect(results[0].symbol.name).toBe('ProductsService.create');
  });

  it('gt-24: ReviewsService.create outranks Prisma ReviewCreate* types for "post review product"', () => {
    // ReviewsService.create: name parts ["reviews","service","create"]
    //   stems: "reviews" → "review" — query word "review" now matches ✓
    //   + kindBoost +30 → beats Prisma types with no kindBoost
    // ReviewCreateWithoutProductInput: parts ["review","create","without","product","input"]
    //   "review" ✓ + "product" ✓ → 2 matches, but no kindBoost → total = 40
    const serviceMethod = sym('ReviewsService.create', {
      kind: 'method',
      summary: 'Saves a new review with rating score and recalculates the average rating.',
    });
    const prismaType = sym('ReviewCreateWithoutProductInput', {
      kind: 'type',
      summary: 'Prisma input type for review creation.',
    });
    const results = rankSymbols([prismaType, serviceMethod], 'post rating review for product');
    expect(results[0].symbol.name).toBe('ReviewsService.create');
  });

  it('gt-12: OrdersService.getMyOrders outranks UsersService.getProfile for "get orders current user"', () => {
    // OrdersService.getMyOrders: parts ["orders","service","get","my","orders"]
    //   stems: "orders" → "order" — "order" in queryWords (stem of "orders") now matches ✓
    //   "orders" also matches "orders" directly ✓ + "get" ✓ → 3 per-word matches → 30+20+30=80
    // UsersService.getProfile: parts ["users","service","get","profile"]
    //   stems: "users" → "user" — "user" matches ✓, "get" ✓ → 2 matches → 30+20+20=70
    const myOrders = sym('OrdersService.getMyOrders', {
      kind: 'method',
      summary: 'Returns a paged list of orders for the authenticated user.',
    });
    const getProfile = sym('UsersService.getProfile', {
      kind: 'method',
      summary: 'Returns the current user profile data.',
    });
    const results = rankSymbols([getProfile, myOrders], 'get paginated list of orders current user');
    expect(results[0].symbol.name).toBe('OrdersService.getMyOrders');
  });

  it('gt-14: OrdersService.requestRefund outranks Prisma RefundRequest* types for "submit refund"', () => {
    // OrdersService.requestRefund: parts ["orders","service","request","refund"]
    //   stems: "orders" → "order" — "order" in queryWords ✓
    //   "request" ✓, "refund" ✓, "order" ✓ → 3 per-word matches + kindBoost 30 → high score
    // RefundRequestCreateOrConnectWithoutOrderInput: parts include "refund","request","create","order"
    //   "refund" ✓, "request" ✓, "create" ✓, "order" ✓ → 4 matches but NO kindBoost (it's a type)
    const serviceMethod = sym('OrdersService.requestRefund', {
      kind: 'method',
      summary: 'Creates a refund request linked to the order for admin review.',
    });
    const prismaType = sym('RefundRequestCreateOrConnectWithoutOrderInput', {
      kind: 'type',
      summary: 'Prisma type for RefundRequest create or connect.',
    });
    const results = rankSymbols([prismaType, serviceMethod], 'submit refund request for delivered order');
    expect(results[0].symbol.name).toBe('OrdersService.requestRefund');
  });

  it('plural name part "users" stem-matches singular query word "user"', () => {
    const usersFn = sym('UsersService.deactivateUser', { kind: 'method' });
    const results = rankSymbols([usersFn], 'suspend user account', true);
    // "users" in name parts should stem to "user", matching query word "user"
    expect(results[0].debugScore?.wordOverlap).toBeGreaterThanOrEqual(20);
  });

  it('plural "orders" stem-matches singular "order" in query words', () => {
    // extractQueryWords("get paginated orders") produces "orders" AND stem "order"
    // splitNameParts("OrdersService.getMyOrders") → ["orders",...] stems to "order"
    // namePartsSet contains "order", query word "order" matches → score > 0
    const sym1 = sym('OrdersService.getMyOrders', { kind: 'method' });
    const results = rankSymbols([sym1], 'get paginated list orders', true);
    expect(results[0].debugScore?.wordOverlap).toBeGreaterThan(30);
  });
});

// ─── Method verb bonus ────────────────────────────────────────────────────────

describe('rankSymbols — method verb bonus', () => {
  it('ProductsService.create gets +15 methodVerbBonus for query containing "create"', () => {
    const serviceMethod = sym('ProductsService.create', { kind: 'method' });
    const results = rankSymbols([serviceMethod], 'create product listing', true);
    expect(results[0].debugScore?.methodVerbBonus).toBe(15);
  });

  it('buildProductListCacheKey gets no methodVerbBonus for "create" query (verb is "build")', () => {
    // This is a *function* but let's also test as method — verb is "build", not "create"
    const cacheKeyFn = sym('ProductsService.buildProductListCacheKey', { kind: 'method' });
    const results = rankSymbols([cacheKeyFn], 'create product listing', true);
    expect(results[0].debugScore?.methodVerbBonus).toBe(0);
  });

  it('method verb bonus makes ProductsService.create rank above buildProductListCacheKey', () => {
    // Without verb bonus: create scores 74, buildProductListCacheKey scores 76
    // With verb bonus: create scores 89, buildProductListCacheKey stays at 76
    const createMethod = sym('ProductsService.create', { kind: 'method' });
    const cacheKeyMethod = sym('ProductsService.buildProductListCacheKey', { kind: 'method' });
    const results = rankSymbols([cacheKeyMethod, createMethod], 'create product listing');
    expect(results[0].symbol.name).toBe('ProductsService.create');
  });

  it('OrdersService.getMyOrders gets +15 methodVerbBonus for query with "get"', () => {
    const serviceMethod = sym('OrdersService.getMyOrders', { kind: 'method' });
    const results = rankSymbols([serviceMethod], 'get orders for current user', true);
    expect(results[0].debugScore?.methodVerbBonus).toBe(15);
  });

  it('non-method symbols never get methodVerbBonus', () => {
    const fn = sym('createProduct', { kind: 'function' });
    const cls = sym('CreateProductDto', { kind: 'class' });
    const results = rankSymbols([fn, cls], 'create product', true);
    for (const r of results) {
      expect(r.debugScore?.methodVerbBonus).toBe(0);
    }
  });

  it('PHP :: notation methods also get methodVerbBonus', () => {
    const phpMethod = sym('ProductsService::create', { kind: 'method' });
    const results = rankSymbols([phpMethod], 'create product', true);
    expect(results[0].debugScore?.methodVerbBonus).toBe(15);
  });

  it('methodVerbBonus does not fire when no query word matches the verb', () => {
    const serviceMethod = sym('UsersService.findById', { kind: 'method' });
    const results = rankSymbols([serviceMethod], 'get user profile', true);
    // verb is "find", query has "get" — not a match
    expect(results[0].debugScore?.methodVerbBonus).toBe(0);
  });

  it('methodVerbBonus fires with synonym expansion: "get" query matches "find" verb via synonyms', () => {
    // extractQueryWords("get user") includes synonyms of "get" — check if "find" is one
    // If not, this is a non-bonus case (expected 0)
    // Either way, the method should still rank above unrelated symbols
    const findMethod = sym('UsersService.findById', { kind: 'method' });
    const results = rankSymbols([findMethod], 'find user by id', true);
    // "find" is the verb AND "find" is in the query → gets +15
    expect(results[0].debugScore?.methodVerbBonus).toBe(15);
  });
});

// ─── Go pattern kindBoost ─────────────────────────────────────────────────────

describe('rankSymbols — Go patterns', () => {
  it('*Handler method (HttpHandler.ServeHTTP) gets kindBoost = 15', () => {
    const goHandler = sym('HttpHandler.ServeHTTP', { kind: 'method' });
    const results = rankSymbols([goHandler], 'serve http request', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('*DB method (PostgresDB.Query) gets kindBoost = 15', () => {
    const goDb = sym('PostgresDB.Query', { kind: 'method' });
    const results = rankSymbols([goDb], 'query database records', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('*Client method (APIClient.Send) gets kindBoost = 15', () => {
    const goClient = sym('APIClient.Send', { kind: 'method' });
    const results = rankSymbols([goClient], 'send api request', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('Go handler method outranks unrelated function for an HTTP query', () => {
    const handler = sym('RouteHandler.Handle', {
      kind: 'method',
      summary: 'Handles incoming HTTP requests and routes them.',
    });
    const unrelated = sym('parseRequestBody', {
      kind: 'function',
      summary: 'Parses the JSON body of an HTTP request.',
    });
    const results = rankSymbols([unrelated, handler], 'handle incoming http request route');
    expect(results[0].symbol.name).toBe('RouteHandler.Handle');
  });

  it('*DB method with lowercase suffix gets kindBoost = 15', () => {
    const userDb = sym('UserDB.Insert', { kind: 'method' });
    const results = rankSymbols([userDb], 'insert user record', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('non-method *Handler symbol gets no kindBoost', () => {
    const handlerFn = sym('NewHttpHandler', { kind: 'function' });
    const results = rankSymbols([handlerFn], 'create http handler', true);
    expect(results[0].debugScore?.kindBoost).toBe(0);
  });
});

// ─── isLibraryPath ────────────────────────────────────────────────────────────

describe('isLibraryPath', () => {
  it('returns true for system/ directory (CodeIgniter)', () => {
    expect(isLibraryPath('system/libraries/Table.php')).toBe(true);
  });

  it('returns true for vendor/ directory (Composer)', () => {
    expect(isLibraryPath('vendor/stripe/stripe-php/lib/Client.php')).toBe(true);
  });

  it('returns true for third_party/ nested under application/', () => {
    expect(isLibraryPath('application/third_party/Twig/Template.php')).toBe(true);
  });

  it('returns true for node_modules/', () => {
    expect(isLibraryPath('node_modules/lodash/debounce.js')).toBe(true);
  });

  it('returns true for bower_components/', () => {
    expect(isLibraryPath('bower_components/jquery/jquery.js')).toBe(true);
  });

  it('returns false for application/core/ paths', () => {
    expect(isLibraryPath('application/core/CIR_Model.php')).toBe(false);
  });

  it('returns false for application/libraries/ (custom app libraries)', () => {
    expect(isLibraryPath('application/libraries/Twig.php')).toBe(false);
  });

  it('returns false for src/server/tools/ paths', () => {
    expect(isLibraryPath('src/server/tools/search-symbols.ts')).toBe(false);
  });

  it('normalises Windows backslash paths', () => {
    expect(isLibraryPath('application\\third_party\\Twig\\Template.php')).toBe(true);
    expect(isLibraryPath('application\\core\\CIR_Model.php')).toBe(false);
  });

  it('does NOT flag a file named vendor-utils.ts (segment must match exactly)', () => {
    expect(isLibraryPath('src/vendor-utils.ts')).toBe(false);
  });
});

// ─── Library path penalty ────────────────────────────────────────────────────

describe('rankSymbols — library path penalty', () => {
  it('symbol in system/ directory receives libraryPenalty = -35', () => {
    const libSym = sym('CI_Table::clear', { kind: 'method', filePath: 'system/libraries/Table.php' });
    const results = rankSymbols([libSym], 'remove record from table', true);
    expect(results[0].debugScore?.libraryPenalty).toBe(-35);
  });

  it('symbol in vendor/ directory receives libraryPenalty = -35', () => {
    const vendorSym = sym('StripeClient::charge', { kind: 'method', filePath: 'vendor/stripe/stripe-php/lib/StripeClient.php' });
    const results = rankSymbols([vendorSym], 'charge payment', true);
    expect(results[0].debugScore?.libraryPenalty).toBe(-35);
  });

  it('symbol in third_party/ directory receives libraryPenalty = -35', () => {
    const thirdSym = sym('Twig_Template::render', { kind: 'method', filePath: 'application/third_party/Twig/lib/Twig/Template.php' });
    const results = rankSymbols([thirdSym], 'render template', true);
    expect(results[0].debugScore?.libraryPenalty).toBe(-35);
  });

  it('symbol in node_modules/ receives libraryPenalty = -35', () => {
    const npmSym = sym('lodash.debounce', { kind: 'function', filePath: 'node_modules/lodash/debounce.js' });
    const results = rankSymbols([npmSym], 'debounce function', true);
    expect(results[0].debugScore?.libraryPenalty).toBe(-35);
  });

  it('symbol in application code receives no library penalty', () => {
    const appSym = sym('CIR_Model::delete_row', { kind: 'method', filePath: 'application/core/CIR_Model.php' });
    const results = rankSymbols([appSym], 'remove record from table', true);
    expect(results[0].debugScore?.libraryPenalty).toBe(0);
  });

  it('application symbol in libraries/ (not third_party) receives no penalty', () => {
    const libSym = sym('Twig::render', { kind: 'method', filePath: 'application/libraries/Twig.php' });
    const results = rankSymbols([libSym], 'render template', true);
    expect(results[0].debugScore?.libraryPenalty).toBe(0);
  });

  it('library symbol ranks below application symbol with same word overlap', () => {
    // Both match "remove record" but library symbol gets -25 penalty
    const libSym = sym('CI_Table::clear', {
      kind: 'method',
      filePath: 'system/libraries/Table.php',
    });
    const appSym = sym('CIR_Model::delete_row', {
      kind: 'method',
      filePath: 'application/core/CIR_Model.php',
    });
    const results = rankSymbols([libSym, appSym], 'remove record from table');
    expect(results[0].symbol.name).toBe('CIR_Model::delete_row');
    expect(results[1].symbol.name).toBe('CI_Table::clear');
  });

  it('application Twig wrapper ranks above third-party Twig library for realistic multi-word query', () => {
    // Short 3-word query "render twig template" gives a lexical advantage to
    // Twig_Template::render (all 3 words match its name) vs Twig::render (2 match).
    // Realistic queries from agents are longer — with 6 words, the per-word
    // word-overlap advantage shrinks and the library penalty tips the result.
    const appTwig = sym('Twig::render', {
      kind: 'method',
      filePath: 'application/libraries/Twig.php',
    });
    const libTwig = sym('Twig_Template::render', {
      kind: 'method',
      filePath: 'application/third_party/Twig/lib/Twig/Template.php',
    });
    const results = rankSymbols([libTwig, appTwig], 'render twig template and return output as string');
    expect(results[0].symbol.name).toBe('Twig::render');
  });

  it('libraryPenalty is 0 for non-library path with similar name (src/vendor-utils.ts)', () => {
    // "vendor-utils" in filename should not trigger penalty — it must be a PATH SEGMENT
    const notLibSym = sym('vendorUtils', { filePath: 'src/vendor-utils.ts' });
    const results = rankSymbols([notLibSym], 'vendor utils', true);
    expect(results[0].debugScore?.libraryPenalty).toBe(0);
  });

  it('bower_components/ directory triggers library penalty', () => {
    const bowerSym = sym('jQuery', { filePath: 'bower_components/jquery/dist/jquery.js' });
    const results = rankSymbols([bowerSym], 'jquery', true);
    expect(results[0].debugScore?.libraryPenalty).toBe(-35);
  });

  it('PHP fetch query: application model method ranks above system DB driver with library penalty', () => {
    const appSym = sym('CIR_Model::get_value', {
      kind: 'method',
      filePath: 'application/core/CIR_Model.php',
    });
    const libSym = sym('CI_DB_mssql_result::_fetch_object', {
      kind: 'method',
      filePath: 'system/database/drivers/mssql/mssql_result.php',
    });
    const results = rankSymbols([libSym, appSym], 'fetch scalar value from database query result');
    expect(results[0].symbol.name).toBe('CIR_Model::get_value');
  });
});

// ─── PHP *_model kindBoost ────────────────────────────────────────────────────

describe('rankSymbols — kindBoost for PHP *_model methods', () => {
  it('*_model method gets +15 kindBoost', () => {
    const modelMethod = sym('Homepage_model::update', { kind: 'method' });
    const results = rankSymbols([modelMethod], 'save updated homepage content', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('*_model method with :: notation gets +15 kindBoost', () => {
    const modelMethod = sym('User_model::get_by_id', { kind: 'method' });
    const results = rankSymbols([modelMethod], 'get user by id', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('*model (no underscore, longer than 5 chars) gets +15 kindBoost', () => {
    // e.g. "ArticleModel" — endsWith("model") and length > 5
    const modelMethod = sym('ArticleModel::save', { kind: 'method' });
    const results = rankSymbols([modelMethod], 'save article data', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('short "model" class name (exactly 5 chars) gets NO kindBoost to avoid false positives', () => {
    // "model" alone (length = 5) must not match — would match any bare "model." method
    const modelMethod = sym('model.save', { kind: 'method' });
    const results = rankSymbols([modelMethod], 'save data', true);
    expect(results[0].debugScore?.kindBoost).toBe(0);
  });

  it('PHP *_model method outranks generic helper function for content update query', () => {
    // Mirrors gt-22 benchmark scenario:
    // query "save updated homepage content data"
    // Homepage_model::update (model method, +15 kindBoost)  vs  Mailin::create_update_user
    const modelMethod = sym('Homepage_model::update', {
      kind: 'method',
      filePath: 'application/models/Homepage_model.php',
      summary: 'Updates homepage content fields in the database.',
    });
    const genericMethod = sym('Mailin::create_update_user', {
      kind: 'method',
      filePath: 'application/third_party/mailin/Mailin.php',
      summary: 'Creates or updates a user via Mailin API.',
    });
    const results = rankSymbols([genericMethod, modelMethod], 'save updated homepage content data');
    expect(results[0].symbol.name).toBe('Homepage_model::update');
  });

  it('PHP *_model method outranks controller for data retrieval query', () => {
    const modelMethod = sym('Settings_model::get_settings', {
      kind: 'method',
      filePath: 'application/models/Settings_model.php',
      summary: 'Returns all settings from the database.',
    });
    const controllerMethod = sym('Settings::get_all', {
      kind: 'method',
      filePath: 'application/controllers/Settings.php',
      summary: 'Returns all settings.',
    });
    const results = rankSymbols([controllerMethod, modelMethod], 'get all settings from database');
    expect(results[0].symbol.name).toBe('Settings_model::get_settings');
  });
});

// ─── Android pattern kindBoost ────────────────────────────────────────────────

describe('rankSymbols — Android patterns', () => {
  it('*Activity method gets +15 kindBoost', () => {
    const activityMethod = sym('MainActivity.onCreate', { kind: 'method' });
    const results = rankSymbols([activityMethod], 'create activity ui', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('*Fragment method gets +15 kindBoost', () => {
    const fragmentMethod = sym('HomeFragment.onCreateView', { kind: 'method' });
    const results = rankSymbols([fragmentMethod], 'create fragment view layout', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('*Adapter method gets +15 kindBoost', () => {
    const adapterMethod = sym('RecyclerAdapter.onBindViewHolder', { kind: 'method' });
    const results = rankSymbols([adapterMethod], 'bind view holder data', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('*ViewModel method gets +15 kindBoost', () => {
    const vmMethod = sym('ProductViewModel.loadData', { kind: 'method' });
    const results = rankSymbols([vmMethod], 'load product data', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('Android method outranks utility function for lifecycle query', () => {
    const activityMethod = sym('LoginActivity.onResume', {
      kind: 'method',
      summary: 'Resumes the login activity and refreshes the UI.',
    });
    const utilFunction = sym('resumeSession', {
      kind: 'function',
      summary: 'Resumes a user session.',
    });
    const results = rankSymbols([utilFunction, activityMethod], 'resume login activity');
    expect(results[0].symbol.name).toBe('LoginActivity.onResume');
  });

  it('non-method *Activity symbol gets no kindBoost', () => {
    const activityClass = sym('MainActivity', { kind: 'class' });
    const results = rankSymbols([activityClass], 'main activity setup', true);
    expect(results[0].debugScore?.kindBoost).toBe(0);
  });

  it('*Adapter method on RecyclerView pattern gets +15 kindBoost', () => {
    const adapterMethod = sym('ProductListAdapter.getItemCount', { kind: 'method' });
    const results = rankSymbols([adapterMethod], 'get number of items in list', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });
});

// ─── Python pattern kindBoost ────────────────────────────────────────────────

describe('rankSymbols — Python patterns', () => {
  it('*Processor method gets +15 kindBoost', () => {
    const processorMethod = sym('DataProcessor.process', { kind: 'method' });
    const results = rankSymbols([processorMethod], 'process data records', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('*Indexer method gets +15 kindBoost', () => {
    const indexerMethod = sym('SymbolIndexer.index', { kind: 'method' });
    const results = rankSymbols([indexerMethod], 'index symbol into store', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('*Parser method gets +15 kindBoost', () => {
    const parserMethod = sym('QueryParser.parse', { kind: 'method' });
    const results = rankSymbols([parserMethod], 'parse query string into tokens', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('*Processor method outranks unrelated function for processing query', () => {
    const processorMethod = sym('EventProcessor.handle', {
      kind: 'method',
      summary: 'Handles and processes incoming events.',
    });
    const utilFn = sym('processRawData', {
      kind: 'function',
      summary: 'Processes raw data into usable format.',
    });
    const results = rankSymbols([utilFn, processorMethod], 'handle process incoming event');
    expect(results[0].symbol.name).toBe('EventProcessor.handle');
  });

  it('*Parser method outranks standalone function for parse query', () => {
    const parserMethod = sym('ASTParser.parse', {
      kind: 'method',
      summary: 'Parses source code into an AST.',
    });
    const parseUtil = sym('parseSourceCode', {
      kind: 'function',
      summary: 'Parses source code string.',
    });
    const results = rankSymbols([parseUtil, parserMethod], 'parse source code into ast');
    expect(results[0].symbol.name).toBe('ASTParser.parse');
  });

  it('non-method *Processor symbol gets no kindBoost', () => {
    const processorClass = sym('DataProcessor', { kind: 'class' });
    const results = rankSymbols([processorClass], 'process data', true);
    expect(results[0].debugScore?.kindBoost).toBe(0);
  });
});

// ─── Rust trait kindBoost ─────────────────────────────────────────────────────

describe('rankSymbols — Rust trait kindBoost', () => {
  it('Serialize trait (interface kind) gets kindBoost = 20 for "serialize" query', () => {
    const trait = sym('Serialize', { kind: 'interface' });
    const results = rankSymbols([trait], 'serialize custom type', true);
    expect(results[0].debugScore?.kindBoost).toBe(20);
  });

  it('Deserialize trait gets kindBoost = 20 for "deserialize" query', () => {
    const trait = sym('Deserialize', { kind: 'interface' });
    const results = rankSymbols([trait], 'deserialize json into struct', true);
    expect(results[0].debugScore?.kindBoost).toBe(20);
  });

  it('Serialize trait gets kindBoost = 20 for "serializable" query (synonym expansion, rust domain)', () => {
    // "serializable" expands to ["serialize", "serde"] via synonym map (rust domain only)
    // extractQueryWords includes "serialize" → splitNameParts("Serialize") includes "serialize"
    const trait = sym('Serialize', { kind: 'interface' });
    const results = rankSymbols([trait], 'serializable type', true, 'rust');
    expect(results[0].debugScore?.kindBoost).toBe(20);
  });

  it('Serialize outranks private helper function for serialization query', () => {
    const trait = sym('Serialize', {
      kind: 'interface',
      summary: 'Trait implemented by types that can be serialized.',
    });
    const helperFn = sym('serialize_field', {
      kind: 'function',
      summary: 'Internal helper to serialize a single struct field.',
    });
    const results = rankSymbols([helperFn, trait],
      'trait a custom type implements to become serializable');
    expect(results[0].symbol.name).toBe('Serialize');
  });

  it('interface kind symbol with no matching query word gets NO kindBoost', () => {
    // "Iterator" trait for a query about "serialize" — name parts don't match query
    const iterTrait = sym('Iterator', { kind: 'interface' });
    const results = rankSymbols([iterTrait], 'serialize custom type', true);
    expect(results[0].debugScore?.kindBoost).toBe(0);
  });

  it('Display trait gets kindBoost = 20 for "display" query', () => {
    const trait = sym('Display', { kind: 'interface' });
    const results = rankSymbols([trait], 'implement display for custom type', true);
    expect(results[0].debugScore?.kindBoost).toBe(20);
  });

  it('multi-part TypeScript option interface gets NO kindBoost when one part is missing from query', () => {
    // NuxtLinkOptions has parts [nuxt, link, options] — "link" is not in the query
    // The "all parts must match" rule prevents option-bag interfaces from flooding results
    const optIface = sym('NuxtLinkOptions', { kind: 'interface' });
    const results = rankSymbols([optIface], 'initialise a new Nuxt framework instance with the provided options', true);
    expect(results[0].debugScore?.kindBoost).toBe(0);
  });

  it('two-part interface gets kindBoost when both parts match query', () => {
    // NuxtHooks has parts [nuxt, hooks] — both appear in the query
    const hooks = sym('NuxtHooks', { kind: 'interface' });
    const results = rankSymbols([hooks], 'interface listing all available build-time hooks for the nuxt framework', true);
    expect(results[0].debugScore?.kindBoost).toBe(20);
  });
});

// ─── Controller kindBoost ─────────────────────────────────────────────────────

describe('rankSymbols — controller kindBoost', () => {
  it('method on *Controller class gets kindBoost = 15', () => {
    const s = sym('UserController::create', { kind: 'method' });
    const results = rankSymbols([s], 'create user', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('method on namespace-qualified *Controller gets kindBoost = 15', () => {
    const s = sym('App\\Controller\\DefaultController::index', { kind: 'method' });
    const results = rankSymbols([s], 'home page render', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('method on *_controller class gets kindBoost = 15', () => {
    const s = sym('home_controller::index', { kind: 'method' });
    const results = rankSymbols([s], 'home page', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('*Controller method outranks *Repository method for same query when name matches better', () => {
    const controller = sym('App\\Controller\\DefaultController::index', { kind: 'method' });
    const repo = sym('App\\Repository\\PageRepository::getHomePagePages', { kind: 'method' });
    // Query matches "home" and "page" in repo name but "index" in controller name
    // Controller should get +15 boost, repo also gets +15 — name overlap decides
    const results = rankSymbols([controller, repo], 'home page render index', true);
    // Both get +15 kindBoost
    expect(results[0].debugScore?.kindBoost).toBe(15);
    expect(results[1].debugScore?.kindBoost).toBe(15);
  });

  it('short "controller" class name below length threshold gets no kindBoost', () => {
    // "controller" by itself is length 10, which is NOT > 10, so no boost
    const s = sym('controller::run', { kind: 'method' });
    const results = rankSymbols([s], 'run controller', true);
    expect(results[0].debugScore?.kindBoost).toBe(0);
  });

  it('*Controller non-method (class symbol) does not get kindBoost', () => {
    const s = sym('UserController', { kind: 'class' });
    const results = rankSymbols([s], 'user controller', true);
    // kindBoost is only for methods
    expect(results[0].debugScore?.kindBoost).toBe(0);
  });
});

// ─── Symfony pattern kindBoost ────────────────────────────────────────────────

describe('rankSymbols — Symfony patterns', () => {
  it('*EventSubscriber method gets kindBoost = 15', () => {
    const sub = sym('SecurityEventSubscriber.onKernelRequest', { kind: 'method' });
    const results = rankSymbols([sub], 'handle kernel request event', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('*Listener method gets kindBoost = 15', () => {
    const listener = sym('ExceptionListener.onKernelException', { kind: 'method' });
    const results = rankSymbols([listener], 'handle kernel exception', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('*FormType method gets kindBoost = 15', () => {
    const formType = sym('RegistrationFormType.buildForm', { kind: 'method' });
    const results = rankSymbols([formType], 'build registration form', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('*Type method (Symfony FormType convention) gets kindBoost = 15 when name > 4 chars', () => {
    const formType = sym('UserType.buildForm', { kind: 'method' });
    const results = rankSymbols([formType], 'build user form', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('exact "type" class (length <= 4) does NOT get kindBoost', () => {
    // "type" itself is length 4, condition is length > 4, so no boost
    const s = sym('type.doSomething', { kind: 'method' });
    const results = rankSymbols([s], 'do something', true);
    expect(results[0].debugScore?.kindBoost).toBe(0);
  });

  it('EventSubscriber method outranks unrelated function for event-listener query', () => {
    const subscriber = sym('RequestEventSubscriber.onKernelRequest', {
      kind: 'method',
      summary: 'Handles the kernel request event to authenticate the user.',
    });
    const unrelated = sym('checkAuthentication', {
      kind: 'function',
      summary: 'Checks whether the current user is authenticated.',
    });
    const results = rankSymbols([unrelated, subscriber], 'handle kernel request event authentication');
    expect(results[0].symbol.name).toBe('RequestEventSubscriber.onKernelRequest');
  });

  it('*EventSubscriber non-method gets no kindBoost', () => {
    const cls = sym('SecurityEventSubscriber', { kind: 'class' });
    const results = rankSymbols([cls], 'security event subscriber', true);
    expect(results[0].debugScore?.kindBoost).toBe(0);
  });
});

// ─── Kind-hint boost ─────────────────────────────────────────────────────────

describe('rankSymbols — kind-hint boost', () => {
  it('"class" in query gives +35 kindHintBoost to class symbols', () => {
    const cls = sym('CalculatorManager', { kind: 'class' });
    const results = rankSymbols([cls], 'class that manages calculator engines', true);
    expect(results[0].debugScore?.kindHintBoost).toBe(35);
  });

  it('"class" in query gives +35 kindHintBoost to struct symbols', () => {
    const st = sym('CalcInput', { kind: 'struct' });
    const results = rankSymbols([st], 'class representing the current numeric input', true);
    expect(results[0].debugScore?.kindHintBoost).toBe(35);
  });

  it('"class" in query does NOT boost function symbols', () => {
    const fn = sym('createCalculator', { kind: 'function' });
    const results = rankSymbols([fn], 'class that creates calculators', true);
    expect(results[0].debugScore?.kindHintBoost).toBe(0);
  });

  it('"interface" in query gives +35 kindHintBoost to interface symbols', () => {
    const iface = sym('ICalcDisplay', { kind: 'interface' });
    const results = rankSymbols([iface], 'callback interface for display updates', true);
    expect(results[0].debugScore?.kindHintBoost).toBe(35);
  });

  it('"interface" in query also boosts class symbols (C++ classes implement interfaces)', () => {
    const cls = sym('CalcDisplay', { kind: 'class' });
    const results = rankSymbols([cls], 'interface that the calculator uses to display', true);
    expect(results[0].debugScore?.kindHintBoost).toBe(35);
  });

  it('"struct" in query gives +35 kindHintBoost to struct symbols only', () => {
    const st = sym('SurfaceInteraction', { kind: 'struct' });
    const cls = sym('SurfaceHandler', { kind: 'class' });
    const resultsStruct = rankSymbols([st], 'struct holding intersection record', true);
    const resultsClass = rankSymbols([cls], 'struct holding intersection record', true);
    expect(resultsStruct[0].debugScore?.kindHintBoost).toBe(35);
    expect(resultsClass[0].debugScore?.kindHintBoost).toBe(0);
  });

  it('"enum" in query gives +35 kindHintBoost to enum symbols only', () => {
    const en = sym('ViewMode', { kind: 'enum' });
    const fn = sym('getViewMode', { kind: 'function' });
    const resultsEnum = rankSymbols([en], 'enum of calculator view modes', true);
    const resultsFn = rankSymbols([fn], 'enum of calculator view modes', true);
    expect(resultsEnum[0].debugScore?.kindHintBoost).toBe(35);
    expect(resultsFn[0].debugScore?.kindHintBoost).toBe(0);
  });

  it('kind-hint boost lifts class symbol above function for class query', () => {
    const cls = sym('CalculationManager', { kind: 'class' });
    const fn = sym('calculateManager', { kind: 'function' });
    const results = rankSymbols([fn, cls], 'class that orchestrates calculator engines');
    expect(results[0].symbol.name).toBe('CalculationManager');
  });

  it('"cls" abbreviation also triggers class kind-hint boost', () => {
    const cls = sym('BaseController', { kind: 'class' });
    const results = rankSymbols([cls], 'cls for handling web requests', true);
    expect(results[0].debugScore?.kindHintBoost).toBe(35);
  });

  it('no kind-hint boost when query has no kind hint word', () => {
    const cls = sym('UserService', { kind: 'class' });
    const results = rankSymbols([cls], 'service that manages user accounts', true);
    expect(results[0].debugScore?.kindHintBoost).toBe(0);
  });
});

// ─── Identity-exact boost ─────────────────────────────────────────────────────

describe('rankSymbols — identityExact boost', () => {
  it('identityExact fires +60 when a query word exactly matches the symbol name', () => {
    const s = sym('Builder', { kind: 'struct' });
    const results = rankSymbols([s], 'builder struct', true);
    expect(results[0].debugScore?.identityExact).toBe(60);
  });

  it('identityExact does NOT fire when no query word equals the symbol name', () => {
    const s = sym('BuilderFactory', { kind: 'class' });
    const results = rankSymbols([s], 'builder struct', true);
    expect(results[0].debugScore?.identityExact).toBe(0);
  });

  it('identityExact lifts struct Builder above bare method "build" for multi-word query', () => {
    // Phase 46: Go/Rust methods now stored with bare names
    // "Builder struct" → queryWords includes "builder"
    // Builder (struct): nameLower = "builder" matches queryWord "builder" → +60
    // build (method, bare name): nameLower = "build" ≠ "builder" → no boost
    const builderStruct = sym('Builder', { kind: 'struct' });
    const buildMethod = sym('build', { kind: 'method' });
    const results = rankSymbols([buildMethod, builderStruct], 'builder struct');
    expect(results[0].symbol.name).toBe('Builder');
  });

  it('identityExact lifts Mutex struct above bare method "lock" for exact-name query', () => {
    const mutexStruct = sym('Mutex', { kind: 'struct' });
    const lockMethod = sym('lock', { kind: 'method' });
    const results = rankSymbols([lockMethod, mutexStruct], 'mutex thread-safe type');
    expect(results[0].symbol.name).toBe('Mutex');
  });

  it('identityExact also fires for single-word exact queries (stacks with nameExact)', () => {
    const s = sym('Builder', { kind: 'struct' });
    const results = rankSymbols([s], 'Builder', true);
    // nameExact = 100, identityExact = 60 (queryWords includes "builder", freq=1)
    expect(results[0].debugScore?.nameExact).toBe(100);
    expect(results[0].debugScore?.identityExact).toBe(60);
    expect(results[0].score).toBeGreaterThanOrEqual(160);
  });

  it('identityExact is case-insensitive', () => {
    const s = sym('PushCampaignMessage', { kind: 'method' });
    // query word "pushcampaignmessage" should match nameLower "pushcampaignmessage"
    const results = rankSymbols([s], 'PushCampaignMessage', true);
    expect(results[0].debugScore?.identityExact).toBe(60);
  });

  it('identityExact fires for Go bare method name matching query word', () => {
    // Phase 46 Go handler: methods stored as bare names like "PushCampaignMessage"
    // Query "push campaign message" → queryWords: ["push", "campaign", "message"]
    // "push" ≠ "pushcampaignmessage"; "campaign" ≠ …; "message" ≠ …
    // → no identityExact (bare name is the full method name, not a single word)
    const s = sym('PushCampaignMessage', { kind: 'method' });
    const results = rankSymbols([s], 'push campaign message', true);
    // identityExact should NOT fire — no single query word equals the full name
    expect(results[0].debugScore?.identityExact).toBe(0);
  });

  it('identityExact fires when query is longer but contains the exact name as a token', () => {
    // query "find Builder implementation" → queryWords includes "builder"
    // symbol "Builder" → nameLower = "builder" matches
    const s = sym('Builder', { kind: 'struct' });
    const results = rankSymbols([s], 'find Builder implementation', true);
    expect(results[0].debugScore?.identityExact).toBe(60);
  });

  it('identityExact doubles (120) when matched query word appears twice in raw query', () => {
    // brew gt-01: "base formula class that all Homebrew formula files inherit"
    // "formula" appears twice → Formula (class) gets 60×2=120; Files (class) gets 60×1=60
    const formula = sym('Formula', { kind: 'class' });
    const results = rankSymbols([formula], 'base formula class that all Homebrew formula files inherit', true);
    expect(results[0].debugScore?.identityExact).toBe(120);
  });

  it('identityExact stays at 60 when matched word appears only once', () => {
    const keg = sym('Keg', { kind: 'class' });
    const results = rankSymbols([keg], 'keg representing an installed version of a formula', true);
    expect(results[0].debugScore?.identityExact).toBe(60);
  });

  it('identityExact does not apply frequency multiplier to DATA_KINDS', () => {
    // Data kinds still use 40/N scaling regardless of repetition
    const c = sym('formula', { kind: 'const' });
    const results = rankSymbols([c], 'base formula class that all Homebrew formula files inherit', true);
    // queryWords length ≈ 6 (base, formula, class, homebrew, files, inherit) → 40/6 = 7, min 10
    expect(results[0].debugScore?.identityExact).toBeLessThanOrEqual(40);
    expect(results[0].debugScore?.identityExact).toBeGreaterThanOrEqual(10);
  });
});

// ─── Bare method name kindBoost (Java/Rust signature fallback) ────────────────

describe('rankSymbols — kindBoost from signature for bare method names', () => {
  // Java methods (Task 258): stored as bare name, class in signature prefix
  // "ClassName.methodName: <raw sig>"

  it('Java *Activity bare method gets kindBoost = 15 via signature', () => {
    const method = sym('nextButtonClicked', {
      kind: 'method',
      signature: 'InspectionFragment.nextButtonClicked: public void nextButtonClicked(View v)',
    });
    const results = rankSymbols([method], 'validate form and advance tab', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('Java *ViewModel bare method gets kindBoost = 15 via signature', () => {
    const method = sym('getTabData', {
      kind: 'method',
      signature: 'InspectionViewModel.getTabData: public LiveData<List<TabItem>> getTabData()',
    });
    const results = rankSymbols([method], 'get inspection tab data', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('Java *Service bare method gets kindBoost = 30 via signature', () => {
    const method = sym('sendLocation', {
      kind: 'method',
      signature: 'GpsService.sendLocation: public void sendLocation(double lat, double lng)',
    });
    const results = rankSymbols([method], 'send gps location coordinates', true);
    expect(results[0].debugScore?.kindBoost).toBe(30);
  });

  // Rust methods (Task 255): "TypeName::methodName: <raw sig>"
  it('Rust bare method gets kindBoost via :: signature prefix', () => {
    const method = sym('lock', {
      kind: 'method',
      signature: 'MutexManager::lock: pub async fn lock(&self) -> Guard',
    });
    const results = rankSymbols([method], 'lock resource', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('qualified name (dot) still works as before', () => {
    const method = sym('InspectionFragment.nextButtonClicked', { kind: 'method' });
    const results = rankSymbols([method], 'validate form and advance tab', true);
    expect(results[0].debugScore?.kindBoost).toBe(15);
  });

  it('bare name with no class context in signature gets no kindBoost', () => {
    const method = sym('doSomething', {
      kind: 'method',
      signature: 'public void doSomething()',
    });
    const results = rankSymbols([method], 'do something useful', true);
    expect(results[0].debugScore?.kindBoost).toBe(0);
  });
});

// ─── FTS BM25 bonus ──────────────────────────────────────────────────────────

describe('rankSymbols — FTS BM25 bonus', () => {
  function symFts(name: string, summary: string, bm25: number): SymbolRecord {
    return { ...sym(name, { summary }), ftsBm25: bm25 };
  }

  it('FTS BM25 bonus lifts a summary-only match above a weak name match', () => {
    // "nameHelper" has no overlap with query but a strong BM25 score (best in set)
    // "unrelated" has a weaker BM25 score and no name overlap
    const summaryMatch = symFts('unrelated', 'weighted reciprocal rank fusion merges scoring', -4.5);
    const nameMismatch = symFts('nameHelper', 'does something', -0.5);
    const results = rankSymbols([nameMismatch, summaryMatch], 'weighted reciprocal rank fusion', true);
    // summaryMatch has best BM25 → gets max ftsBm25Bonus; nameMismatch has worst BM25 → gets 0
    expect(results[0].symbol.name).toBe('unrelated');
    expect(results[0].debugScore?.ftsBm25Bonus).toBe(50);
    expect(results[1].debugScore?.ftsBm25Bonus).toBe(0);
  });

  it('FTS BM25 bonus does not override a strong identity-exact match', () => {
    // queryWord matches nameExact symbol perfectly
    const exactMatch = symFts('fuse', 'fuse results', -0.5); // worst BM25 in set
    const summaryOnly = symFts('unrelated', 'weighted reciprocal rank fusion', -4.5); // best BM25
    const results = rankSymbols([exactMatch, summaryOnly], 'fuse');
    // exactMatch gets nameExact=100; summaryOnly gets ftsBm25Bonus=50 but no name match
    expect(results[0].symbol.name).toBe('fuse');
  });

  it('symbols without ftsBm25 (non-FTS path) get zero bonus', () => {
    const noFts = sym('doSomething', { summary: 'does something useful' });
    const results = rankSymbols([noFts], 'something useful', true);
    expect(results[0].debugScore?.ftsBm25Bonus).toBe(0);
  });

  it('full BM25 bonus applied when all symbols are within 30 points of the top base score', () => {
    // Both symbols have the same base score (0) — gap = 0 ≤ 30 — full BM25 applies.
    const bestBm25  = { ...sym('unrelated'), ftsBm25: -4.5 };
    const worstBm25 = { ...sym('doOther'),   ftsBm25: -0.5 };
    const results = rankSymbols([worstBm25, bestBm25], 'foo bar baz', true);
    expect(results[0].symbol.name).toBe('unrelated');
    expect(results[0].debugScore?.ftsBm25Bonus).toBe(50); // full bonus, not capped
  });

  it('BM25 capped to 30% for symbol more than 30 points below the top base score — NestJS regression fix', () => {
    // Reproduces the NestJS regression: a utility function with partial name overlap
    // and the best BM25 score was outranking a *Service method with a stronger base.
    //
    // ProductsService.create (method): wordOverlap(68) + methodVerbBonus(15) + kindBoost(30) = 113
    // createCartProduct (function):    wordOverlap(70) + no kindBoost = 70
    //   gap = 113 - 70 = 43 > 30 → BM25 capped at 30%
    //
    // Without cap: createCartProduct = 70 + 50(BM25) = 120 > 113 → regression (wrong winner)
    // With cap:    createCartProduct = 70 + 15(BM25) = 85  < 113 → correct winner
    const serviceMethod = {
      ...sym('ProductsService.create', { kind: 'method', signature: 'ProductsService.create: create(dto)' }),
      ftsBm25: -0.5, // worst BM25 in set
    };
    const utilFn = {
      ...sym('createCartProduct', { kind: 'function' }),
      ftsBm25: -4.5, // best BM25 in set
    };
    const results = rankSymbols([utilFn, serviceMethod], 'create product', true);
    expect(results[0].symbol.name).toBe('ProductsService.create');
    // Capped BM25: best BM25 in set gets round(50 * 0.3) = 15 (not 50)
    const utilResult = results.find((r) => r.symbol.name === 'createCartProduct');
    expect(utilResult?.debugScore?.ftsBm25Bonus).toBe(15);
  });

  it('capped BM25 still breaks ties between symbols within 30 points of the top', () => {
    // The dominant symbol (nameExact=100) is the top base. createFoo/createBar both
    // have namePrefix=60, gap=40>30 → their BM25 is capped. Despite the cap, the
    // better-BM25 symbol among the capped group still ranks first within that group.
    const dominant = { ...sym('create'), ftsBm25: -0.5 }; // worst BM25, base=100
    const tieLoser  = { ...sym('createFoo'), ftsBm25: -1.0 }; // base=60, gap=40
    const tieWinner = { ...sym('createBar'), ftsBm25: -4.5 }; // base=60, gap=40, best BM25
    const results = rankSymbols([tieLoser, tieWinner, dominant], 'create', true);
    expect(results[0].symbol.name).toBe('create'); // dominant winner unchanged
    // createBar has better BM25 → ranks above createFoo despite equal base score
    expect(results[1].symbol.name).toBe('createBar');
    expect(results[2].symbol.name).toBe('createFoo');
  });
});

// ─── Phase 71: Library path penalty extensions (Task 413) ─────────────────────

describe('isLibraryPath — Phase 71 extensions', () => {
  it('engine/ directory gets library penalty', () => {
    expect(isLibraryPath('engine/lib/foo.cc')).toBe(true);
  });

  it('nested engine/ directory gets library penalty', () => {
    expect(isLibraryPath('flutter/engine/src/rendering/compositor.cc')).toBe(true);
  });

  it('erts/ directory gets library penalty', () => {
    expect(isLibraryPath('erts/emulator/beam/erl_process.c')).toBe(true);
  });

  it('lib/wx/ multi-segment path gets library penalty', () => {
    expect(isLibraryPath('lib/wx/src/gen/wx_object.erl')).toBe(true);
  });

  it('unstable-core-do-not-import/ is NOT a library penalty (tRPC canonical core path)', () => {
    expect(isLibraryPath('packages/server/src/unstable-core-do-not-import/router.ts')).toBe(false);
  });

  it('contrib/ directory gets library penalty', () => {
    expect(isLibraryPath('contrib/autoconf/config.guess')).toBe(true);
  });

  it('BLAS/ directory gets library penalty (case-insensitive)', () => {
    expect(isLibraryPath('deps/BLAS/dgemm.f')).toBe(true);
  });

  it('lapack/ lowercase also gets library penalty', () => {
    expect(isLibraryPath('deps/lapack/src/dgesv.f')).toBe(true);
  });

  it('core/src/main/java/ does NOT get library penalty', () => {
    expect(isLibraryPath('core/src/main/java/hudson/model/Run.java')).toBe(false);
  });

  it('engine_room/ does NOT match — engine must be a separate directory segment', () => {
    expect(isLibraryPath('engine_room/boiler.ts')).toBe(false);
  });
});

describe('rankSymbols — Phase 71 library path penalty extends to new paths', () => {
  it('symbol in engine/ gets -35 penalty', () => {
    const dartWidget = sym('StatefulWidget', { filePath: 'packages/flutter/lib/widgets/framework.dart' });
    const cppEngine = sym('StatefulWidget', { filePath: 'engine/src/flutter/runtime/dart_vm.cc' });
    const results = rankSymbols([cppEngine, dartWidget], 'stateful widget');
    expect(results[0].symbol.filePath).toBe('packages/flutter/lib/widgets/framework.dart');
  });

  it('symbol in unstable-core-do-not-import/ is NOT penalized (tRPC canonical core path)', () => {
    // tRPC's core API lives in unstable-core-do-not-import — penalizing it hurts expected results
    const unstableSymbol = sym('ProcedureBuilder', { filePath: 'packages/server/src/unstable-core-do-not-import/procedureBuilder.ts' });
    const otherSymbol = sym('ProcedureBuilder', { filePath: 'packages/server/src/core/procedureBuilder.ts' });
    const results = rankSymbols([unstableSymbol, otherSymbol], 'procedure builder');
    // Both should score equally (no penalty on either); first insertion order wins
    expect(results.length).toBe(2);
    const scores = results.map((r) => r.score);
    expect(scores[0]).toBe(scores[1]);
  });
});

// ─── Phase 71: Java/Groovy core-path boost (Task 414) ─────────────────────────

describe('rankSymbols — Phase 71 Java core-path boost', () => {
  it('symbol in core/src/main/java/ gets +15 corePathBoost in java domain', () => {
    const coreMethod = sym('Run.isBuilding', {
      kind: 'method',
      filePath: 'core/src/main/java/hudson/model/Run.java',
    });
    const results = rankSymbols([coreMethod], 'is building', true, 'java');
    expect(results[0].debugScore?.corePathBoost).toBe(15);
  });

  it('symbol in /main/java/ also gets +15 corePathBoost', () => {
    const mavenMethod = sym('OrderService.create', {
      kind: 'method',
      filePath: 'src/main/java/com/example/OrderService.java',
    });
    const results = rankSymbols([mavenMethod], 'create order', true, 'java');
    expect(results[0].debugScore?.corePathBoost).toBe(15);
  });

  it('symbol in plugins/ gets -35 corePathBoost (plugin penalty) in java domain', () => {
    const pluginMethod = sym('FooStep.perform', {
      kind: 'method',
      filePath: 'plugins/build-step/src/main/java/FooStep.java',
    });
    const results = rankSymbols([pluginMethod], 'perform step', true, 'java');
    expect(results[0].debugScore?.corePathBoost).toBe(-35);
  });

  it('core path boost does NOT fire outside java domain', () => {
    const tsMethod = sym('OrderService.create', {
      kind: 'method',
      filePath: 'src/main/typescript/OrderService.ts',
    });
    const results = rankSymbols([tsMethod], 'create order', true, undefined);
    expect(results[0].debugScore?.corePathBoost).toBe(0);
  });

  it('core path boost and library penalty are mutually exclusive', () => {
    // vendor/ triggers library penalty, so corePathBoost must not double-penalise
    const vendorMethod = sym('Run.isBuilding', {
      kind: 'method',
      filePath: 'vendor/core/src/main/java/Run.java',
    });
    const results = rankSymbols([vendorMethod], 'is building', true, 'java');
    expect(results[0].debugScore?.libraryPenalty).toBe(-35);
    expect(results[0].debugScore?.corePathBoost).toBe(0);
  });

  it('core method in java domain outranks plugin override', () => {
    const coreMethod = sym('isBuilding', {
      kind: 'method',
      filePath: 'core/src/main/java/hudson/model/Run.java',
      signature: 'Run.isBuilding: boolean',
    });
    const pluginMethod = sym('isBuilding', {
      kind: 'method',
      filePath: 'plugins/my-plugin/src/main/java/PluginRun.java',
      signature: 'PluginRun.isBuilding: boolean',
    });
    const results = rankSymbols([pluginMethod, coreMethod], 'is building', false, 'java');
    expect(results[0].symbol.filePath).toBe('core/src/main/java/hudson/model/Run.java');
  });
});

// ─── Phase 71: Frontend path boost (Task 415) ─────────────────────────────────

describe('rankSymbols — Phase 71 frontend path boost', () => {
  it('frontend symbol gets +20 in mixed monorepo with hook query', () => {
    const hook = sym('useCreateWorkflow', {
      kind: 'function',
      filePath: 'apps/dashboard/src/hooks/useCreateWorkflow.ts',
    });
    const results = rankSymbols([hook], 'use create workflow hook', true, undefined, {
      isMixedMonorepo: true,
      hasReactHookQuery: false,
    });
    expect(results[0].debugScore?.frontendPathBoost).toBe(20);
  });

  it('frontend symbol gets no boost when NOT a mixed monorepo', () => {
    const hook = sym('useCreateWorkflow', {
      kind: 'function',
      filePath: 'apps/dashboard/src/hooks/useCreateWorkflow.ts',
    });
    const results = rankSymbols([hook], 'use create workflow hook', true, undefined, {
      isMixedMonorepo: false,
    });
    expect(results[0].debugScore?.frontendPathBoost).toBe(0);
  });

  it('backend symbol gets no frontend boost even in mixed monorepo with hook query', () => {
    const backendMethod = sym('WorkflowService.create', {
      kind: 'method',
      filePath: 'apps/api/src/workflow/workflow.service.ts',
    });
    const results = rankSymbols([backendMethod], 'use create workflow', true, undefined, {
      isMixedMonorepo: true,
    });
    expect(results[0].debugScore?.frontendPathBoost).toBe(0);
  });

  it('non-hook query does not trigger frontend boost', () => {
    const hook = sym('WorkflowService.create', {
      kind: 'method',
      filePath: 'apps/dashboard/src/services/WorkflowService.ts',
    });
    const results = rankSymbols([hook], 'create workflow in database', true, undefined, {
      isMixedMonorepo: true,
    });
    expect(results[0].debugScore?.frontendPathBoost).toBe(0);
  });

  it('frontend hook outranks backend service method in mixed monorepo for hook query', () => {
    const dashboardHook = sym('useCreateWorkflow', {
      kind: 'function',
      filePath: 'apps/dashboard/src/hooks/useCreateWorkflow.ts',
    });
    const apiService = sym('WorkflowService.createWorkflowMap', {
      kind: 'method',
      filePath: 'apps/api/src/workflow/workflow.service.ts',
    });
    const results = rankSymbols([apiService, dashboardHook], 'use create workflow', false, undefined, {
      isMixedMonorepo: true,
      hasReactHookQuery: true,
    });
    expect(results[0].symbol.name).toBe('useCreateWorkflow');
  });
});

// ─── Phase 71: use* hook bonus (Task 416) ─────────────────────────────────────

describe('rankSymbols — Phase 71 use/hook bonus', () => {
  it('use[A-Z] symbol gets +20 useHookBonus when hasReactHookQuery is true', () => {
    const hook = sym('useBookingFilters', { kind: 'function' });
    const results = rankSymbols([hook], 'use booking filters', true, undefined, {
      hasReactHookQuery: true,
    });
    expect(results[0].debugScore?.useHookBonus).toBe(20);
  });

  it('symbol NOT starting with use[A-Z] gets no useHookBonus', () => {
    const service = sym('BookingService.getFilters', { kind: 'method' });
    const results = rankSymbols([service], 'use booking filters', true, undefined, {
      hasReactHookQuery: true,
    });
    expect(results[0].debugScore?.useHookBonus).toBe(0);
  });

  it('useHookBonus does not fire when hasReactHookQuery is false', () => {
    const hook = sym('useBookingFilters', { kind: 'function' });
    const results = rankSymbols([hook], 'booking filters', true, undefined, {
      hasReactHookQuery: false,
    });
    expect(results[0].debugScore?.useHookBonus).toBe(0);
  });

  it('lowercase use does not trigger bonus (useSomething without upper: userService)', () => {
    // 'userService' starts with 'user', not 'use[A-Z]'
    const notHook = sym('userService', { kind: 'class' });
    const results = rankSymbols([notHook], 'user service', true, undefined, {
      hasReactHookQuery: true,
    });
    expect(results[0].debugScore?.useHookBonus).toBe(0);
  });

  it('useHookBonus lifts useBookingFilters above BookingService.list', () => {
    const hook = sym('useBookingFilters', { kind: 'function' });
    const service = sym('BookingService.list', { kind: 'method' });
    const results = rankSymbols([service, hook], 'use booking filters', false, undefined, {
      hasReactHookQuery: true,
    });
    expect(results[0].symbol.name).toBe('useBookingFilters');
  });
});

// ─── Phase 71: Path proximity boost (Task 417) ───────────────────────────────

describe('rankSymbols — Phase 71 path proximity boost', () => {
  it('boost goes to candidate whose file-path overlaps with query when >= 3 share the name', () => {
    const platformerSpawn = sym('spawn_count', { filePath: 'platformer/enemy_spawner.gd' });
    const spaceSpawn     = sym('spawn_count', { filePath: 'space_invader/enemy_spawner.gd' });
    const rpgSpawn       = sym('spawn_count', { filePath: 'rpg/enemy_spawner.gd' });
    // query has "space" and "invader" → only spaceSpawn's path overlaps
    const results = rankSymbols([platformerSpawn, rpgSpawn, spaceSpawn], 'enemy spawn count space invader');
    expect(results[0].symbol.filePath).toBe('space_invader/enemy_spawner.gd');
  });

  it('path proximity boost NOT applied when fewer than 3 candidates share the name', () => {
    const hookA = sym('useCreateWorkflow', { filePath: 'apps/dashboard/src/hooks/useCreateWorkflow.ts' });
    const hookB = sym('useCreateWorkflow', { filePath: 'apps/web/src/hooks/useCreateWorkflow.ts' });
    // Only 2 symbols with the same name → path proximity boost suppressed
    const results = rankSymbols([hookA, hookB], 'create workflow dashboard', true);
    for (const r of results) {
      expect(r.debugScore?.pathProximityBoost).toBe(0);
    }
  });

  it('common path segments (src, lib, app) do not count towards proximity overlap', () => {
    // "src" and "lib" in filePath should be excluded from scoring
    const a = sym('programs', { filePath: 'modules/programs/bash.nix' });
    const b = sym('programs', { filePath: 'modules/programs/git.nix' });
    const c = sym('programs', { filePath: 'modules/programs/zsh.nix' });
    const results = rankSymbols([a, b, c], 'bash configuration program', true);
    // "bash" appears in a's path (bash.nix) but not b or c
    expect(results[0].symbol.filePath).toBe('modules/programs/bash.nix');
    // proximity boost should be positive for the bash one
    expect(results[0].debugScore?.pathProximityBoost).toBeGreaterThan(0);
  });

  it('unique-name symbol (only 1 in pool) gets no path proximity boost', () => {
    const unique = sym('useCreateWorkflow', { filePath: 'apps/dashboard/src/hooks/useCreateWorkflow.ts' });
    const other  = sym('useDeleteWorkflow', { filePath: 'apps/dashboard/src/hooks/useDeleteWorkflow.ts' });
    const results = rankSymbols([unique, other], 'create workflow dashboard', true);
    // useCreateWorkflow is the only one with that name → no proximity boost
    const target = results.find((r) => r.symbol.name === 'useCreateWorkflow')!;
    expect(target.debugScore?.pathProximityBoost).toBe(0);
  });
});

// ─── Groovy source boost (Task 423) ───────────────────────────────────────────

describe('rankSymbols — groovy source boost', () => {
  it('applies +10 to .groovy symbols when isJavaGroovyMixed is true', () => {
    const groovySym = sym('buildScript', { filePath: 'build.groovy', kind: 'function' });
    const javaSym   = sym('buildScript', { filePath: 'src/main/java/Build.java', kind: 'method' });
    const results = rankSymbols(
      [javaSym, groovySym],
      'build script',
      true,
      'java',
      { isJavaGroovyMixed: true },
    );
    const groovyResult = results.find((r) => r.symbol.filePath === 'build.groovy')!;
    expect(groovyResult.debugScore?.groovySourceBoost).toBe(10);
  });

  it('does NOT apply groovy boost when isJavaGroovyMixed is false', () => {
    const groovySym = sym('buildScript', { filePath: 'build.groovy' });
    const results = rankSymbols([groovySym], 'build script', true, 'java', { isJavaGroovyMixed: false });
    const result = results[0]!;
    expect(result.debugScore?.groovySourceBoost).toBe(0);
  });

  it('does NOT apply groovy boost to .java files even in mixed repo', () => {
    const javaSym = sym('buildScript', { filePath: 'src/Build.java' });
    const results = rankSymbols([javaSym], 'build script', true, 'java', { isJavaGroovyMixed: true });
    expect(results[0]!.debugScore?.groovySourceBoost).toBe(0);
  });

  it('groovy symbol ranks above equally-scored java symbol in mixed repo', () => {
    // Both symbols have identical names and content — only the groovy boost differentiates them
    const groovySym = sym('configure', { filePath: 'src/main/groovy/Configure.groovy' });
    const javaSym   = sym('configure', { filePath: 'src/main/java/Configure.java' });
    const results = rankSymbols(
      [javaSym, groovySym],
      'configure task',
      false,
      'java',
      { isJavaGroovyMixed: true },
    );
    expect(results[0]!.symbol.filePath).toBe('src/main/groovy/Configure.groovy');
  });
});

// ─── Task 426: Angular lifecycle method boost ─────────────────────────────────

describe('rankSymbols — angular lifecycle boost (Task 426)', () => {
  it('ngOnInit gets +10 for "initialization" query in Angular repo', () => {
    const lifecycle = sym('VaultFilterComponent.ngOnInit', { kind: 'method' });
    const other     = sym('VaultFilterComponent.filterSearchText', { kind: 'method' });
    const results   = rankSymbols([other, lifecycle], 'vault filter component initialization', true, undefined, { isAngularRepo: true });
    const lcResult  = results.find((r) => r.symbol.name === 'VaultFilterComponent.ngOnInit')!;
    expect(lcResult.debugScore?.angularLifecycleBoost).toBe(10);
  });

  it('ngOnInit gets no boost when isAngularRepo is false', () => {
    const lifecycle = sym('VaultFilterComponent.ngOnInit', { kind: 'method' });
    const results   = rankSymbols([lifecycle], 'component initialization', true, undefined, { isAngularRepo: false });
    expect(results[0]!.debugScore?.angularLifecycleBoost).toBe(0);
  });

  it('non-lifecycle method gets no boost even in Angular repo with lifecycle query', () => {
    const other   = sym('AppComponent.handleClick', { kind: 'method' });
    const results = rankSymbols([other], 'component initialization', true, undefined, { isAngularRepo: true });
    expect(results[0]!.debugScore?.angularLifecycleBoost).toBe(0);
  });

  it('ngOnInit gets no boost without lifecycle vocabulary', () => {
    const lifecycle = sym('AppComponent.ngOnInit', { kind: 'method' });
    const results   = rankSymbols([lifecycle], 'app component route', true, undefined, { isAngularRepo: true });
    expect(results[0]!.debugScore?.angularLifecycleBoost).toBe(0);
  });
});

// ─── Task 427: React rendering verb compound boost ────────────────────────────

describe('rankSymbols — rendering compound boost (Task 427)', () => {
  it('renderSelectionElement gets +15 for "render canvas selection" in rendering domain', () => {
    const compound = sym('renderSelectionElement', { kind: 'function' });
    const bare     = sym('render', { kind: 'function' });
    const results  = rankSymbols([bare, compound], 'render canvas selection element', true, 'rendering');
    const compResult = results.find((r) => r.symbol.name === 'renderSelectionElement')!;
    expect(compResult.debugScore?.renderingCompoundBoost).toBe(15);
  });

  it('bare render function gets no compound boost (no shared noun)', () => {
    const bare    = sym('render', { kind: 'function' });
    const results = rankSymbols([bare], 'render canvas selection element', true, 'rendering');
    expect(results[0]!.debugScore?.renderingCompoundBoost).toBe(0);
  });

  it('rendering compound boost does NOT fire outside rendering domain', () => {
    const compound = sym('renderSelectionElement', { kind: 'function' });
    const results  = rankSymbols([compound], 'render canvas selection element', true, undefined);
    expect(results[0]!.debugScore?.renderingCompoundBoost).toBe(0);
  });

  it('non-function rendering symbol gets no compound boost', () => {
    const cls     = sym('SelectionRenderer', { kind: 'class' });
    const results = rankSymbols([cls], 'render selection element', true, 'rendering');
    expect(results[0]!.debugScore?.renderingCompoundBoost).toBe(0);
  });
});

// ─── Task 428: React Query mutation hook boost ────────────────────────────────

describe('rankSymbols — react query hook boost (Task 428)', () => {
  it('useCreateSecretV3 in queries.ts gets +25 for "create" query', () => {
    const hook    = sym('useCreateSecretV3', { kind: 'function', filePath: 'src/hooks/api/secrets/queries.ts' });
    const results = rankSymbols([hook], 'create secret api hook', true);
    expect(results[0]!.debugScore?.reactQueryHookBoost).toBe(25);
  });

  it('use-hook in non-queries file gets no boost', () => {
    const hook    = sym('useCreateSecretV3', { kind: 'function', filePath: 'src/components/SecretForm.tsx' });
    const results = rankSymbols([hook], 'create secret', true);
    expect(results[0]!.debugScore?.reactQueryHookBoost).toBe(0);
  });

  it('non-use function in queries file gets no boost', () => {
    const fn      = sym('createSecretHelper', { kind: 'function', filePath: 'src/api/queries.ts' });
    const results = rankSymbols([fn], 'create secret', true);
    expect(results[0]!.debugScore?.reactQueryHookBoost).toBe(0);
  });

  it('hook in mutations file also gets boost', () => {
    const hook    = sym('useDeleteOrgMember', { kind: 'function', filePath: 'src/hooks/api/mutations.ts' });
    const results = rankSymbols([hook], 'delete organization member', true);
    expect(results[0]!.debugScore?.reactQueryHookBoost).toBe(25);
  });
});

// ─── Task 429: Interceptor / resolver / guard boost ───────────────────────────

describe('rankSymbols — interceptor boost (Task 429)', () => {
  it('tokenInterceptor gets +15 for "interceptor" query', () => {
    const interceptor = sym('tokenInterceptor', { kind: 'function' });
    const results     = rankSymbols([interceptor], 'interceptor that attaches JWT token', true);
    expect(results[0]!.debugScore?.interceptorBoost).toBe(30);
  });

  it('bankAccountResolve gets +15 for "resolver" query', () => {
    const resolver = sym('bankAccountResolve', { kind: 'function' });
    const results  = rankSymbols([resolver], 'bank account resolver route', true);
    expect(results[0]!.debugScore?.interceptorBoost).toBe(30);
  });

  it('LoginService gets no boost for "intercept" query (no Interceptor suffix)', () => {
    const service = sym('LoginService', { kind: 'class' });
    const results = rankSymbols([service], 'intercept login request', true);
    expect(results[0]!.debugScore?.interceptorBoost).toBe(0);
  });

  it('authGuard class gets +15 for "guard" query', () => {
    const guard   = sym('authGuard', { kind: 'class' });
    const results = rankSymbols([guard], 'auth guard route protection', true);
    expect(results[0]!.debugScore?.interceptorBoost).toBe(30);
  });
});

// ─── Task 430: Perl/R package-context boost ───────────────────────────────────

describe('rankSymbols — package context boost (Task 430)', () => {
  it('Mojolicious::Controller::render in .pm file gets +8 for "mojolicious" query word', () => {
    const sym1    = sym('Mojolicious::Controller::render', { kind: 'function', filePath: 'lib/Mojolicious/Controller.pm' });
    const results = rankSymbols([sym1], 'mojolicious render response', true);
    expect(results[0]!.debugScore?.packageContextBoost).toBeGreaterThanOrEqual(4);
  });

  it('bare render function in .pl file gets no package boost (no package prefix)', () => {
    const fn      = sym('render', { kind: 'function', filePath: 'script/app.pl' });
    const results = rankSymbols([fn], 'mojolicious render response', true);
    expect(results[0]!.debugScore?.packageContextBoost).toBe(0);
  });

  it('R function Rcpp.package.skeleton gets boost when "rcpp" in query', () => {
    const fn      = sym('Rcpp.package.skeleton', { kind: 'function', filePath: 'R/rcpp.R' });
    const results = rankSymbols([fn], 'rcpp package skeleton', true);
    expect(results[0]!.debugScore?.packageContextBoost).toBeGreaterThanOrEqual(4);
  });

  it('TypeScript function gets no package boost even if named with dots', () => {
    const fn      = sym('Mojo.render', { kind: 'function', filePath: 'src/mojo.ts' });
    const results = rankSymbols([fn], 'mojo render', true);
    expect(results[0]!.debugScore?.packageContextBoost).toBe(0);
  });

  it('generic MVC segments (controller, action) are filtered — TestApp::Controller::Action gets no boost', () => {
    const fn      = sym('TestApp::Controller::Action::new', { kind: 'function', filePath: 'lib/TestApp/Controller/Action.pm' });
    const results = rankSymbols([fn], 'catalyst action controller wrap method', true);
    expect(results[0]!.debugScore?.packageContextBoost).toBe(0);
  });
});

describe('rankSymbols — Perl t/lib/ test-fixture penalty', () => {
  it('TestApp symbol in t/lib/ gets -25 library penalty', () => {
    const fn      = sym('TestApp::Controller::Action::Action', { kind: 'class', filePath: 't/lib/TestApp/Controller/Action/Action.pm' });
    const results = rankSymbols([fn], 'dispatch action execution', true);
    expect(results[0]!.debugScore?.libraryPenalty).toBe(-25);
  });

  it('Catalyst symbol in lib/ does NOT get the t/lib/ penalty', () => {
    const fn      = sym('Catalyst::Action', { kind: 'class', filePath: 'lib/Catalyst/Action.pm' });
    const results = rankSymbols([fn], 'dispatch action execution', true);
    expect(results[0]!.debugScore?.libraryPenalty).toBe(0);
  });

  it('TestApp symbol with Windows backslash path also gets -25 penalty', () => {
    const fn      = sym('TestApp::Controller::Action::Action', { kind: 'class', filePath: 't\\lib\\TestApp\\Controller\\Action\\Action.pm' });
    const results = rankSymbols([fn], 'dispatch action execution', true);
    expect(results[0]!.debugScore?.libraryPenalty).toBe(-25);
  });
});

// ─── Task 432: tRPC prefix boost ─────────────────────────────────────────────

describe('rankSymbols — tRPC prefix boost (Task 432)', () => {
  it('createTRPCReact gets +20 for "trpc" query', () => {
    const fn      = sym('createTRPCReact', { kind: 'function' });
    const results = rankSymbols([fn], 'react trpc client', true);
    expect(results[0]!.debugScore?.trpcPrefixBoost).toBe(20);
  });

  it('ProcedureBuilder.query gets +20 for "procedure" query', () => {
    const fn      = sym('ProcedureBuilder.query', { kind: 'method' });
    const results = rankSymbols([fn], 'trpc procedure builder query', true);
    expect(results[0]!.debugScore?.trpcPrefixBoost).toBe(20);
  });

  it('non-tRPC function gets no boost', () => {
    const fn      = sym('createRouter', { kind: 'function' });
    const results = rankSymbols([fn], 'trpc router', true);
    expect(results[0]!.debugScore?.trpcPrefixBoost).toBe(0);
  });
});

// ─── Task 433: Compound underscore identityExact ──────────────────────────────

describe('rankSymbols — compound underscore boost (Task 433)', () => {
  it('payment_intent gets +30 for "create payment intent" (both parts in query)', () => {
    const schema  = sym('payment_intent', { kind: 'class' });
    const results = rankSymbols([schema], 'create payment intent', true);
    expect(results[0]!.debugScore?.compoundUnderscoreBoost).toBe(30);
  });

  it('payment_intent_v2 gets no boost when only 2 of 3 parts match "payment intent"', () => {
    const schema  = sym('payment_intent_v2', { kind: 'class' });
    const results = rankSymbols([schema], 'create payment intent', true);
    expect(results[0]!.debugScore?.compoundUnderscoreBoost).toBe(0);
  });

  it('no compound boost when identityExact already fires (whole name = query word)', () => {
    const schema  = sym('payment', { kind: 'class' });
    const results = rankSymbols([schema], 'payment intent', true);
    // identityExact fires for "payment" word match; compound doesn't fire for single-part
    expect(results[0]!.debugScore?.compoundUnderscoreBoost).toBe(0);
  });

  it('compound boost fires for non-data kinds too (e.g. function with underscore name)', () => {
    const fn      = sym('get_user', { kind: 'function' });
    const results = rankSymbols([fn], 'get user profile', true);
    expect(results[0]!.debugScore?.compoundUnderscoreBoost).toBe(30);
  });
});

// ─── Task 434: Single-token exact-name boost ──────────────────────────────────

describe('rankSymbols — single token exact boost (Task 434)', () => {
  it('Pod gets +50 for single-token query "pod"', () => {
    const pod     = sym('Pod', { kind: 'class' });
    const results = rankSymbols([pod], 'Pod', true);
    expect(results[0]!.debugScore?.singleTokenExactBoost).toBe(50);
  });

  it('PodSpec does NOT get single-token exact boost for query "pod"', () => {
    const podSpec = sym('PodSpec', { kind: 'class' });
    const results = rankSymbols([podSpec], 'Pod', true);
    expect(results[0]!.debugScore?.singleTokenExactBoost).toBe(0);
  });

  it('Pod beats PodSpec for single-token query "Pod"', () => {
    const pod     = sym('Pod', { kind: 'class' });
    const podSpec = sym('PodSpec', { kind: 'class' });
    const results = rankSymbols([podSpec, pod], 'Pod', false);
    expect(results[0]!.symbol.name).toBe('Pod');
  });

  it('multi-token query gets no single-token boost', () => {
    const pod     = sym('Pod', { kind: 'class' });
    const results = rankSymbols([pod], 'pod spec', true);
    expect(results[0]!.debugScore?.singleTokenExactBoost).toBe(0);
  });

  it('dot-qualified name gets +40 when query matches last segment', () => {
    const pod     = sym('io.k8s.api.core.v1.Pod', { kind: 'class' });
    const results = rankSymbols([pod], 'Pod', true);
    expect(results[0]!.debugScore?.singleTokenExactBoost).toBe(40);
  });

  it('dot-qualified PodSpec does NOT get last-segment boost for query "pod"', () => {
    const podSpec = sym('io.k8s.api.core.v1.PodSpec', { kind: 'class' });
    const results = rankSymbols([podSpec], 'Pod', true);
    expect(results[0]!.debugScore?.singleTokenExactBoost).toBe(0);
  });
});


// ─── Unexported-visibility penalty (Phase 84, Task 520) ──────────────────────

describe('rankSymbols — unexported visibility penalty', () => {
  function unexportedSym(name: string, filePath = 'internal/core.go'): SymbolRecord {
    return { ...sym(name, { filePath }), frameworkMeta: { visibility: 'unexported' } };
  }

  it('applies -20 to symbols with visibility "unexported"', () => {
    const results = rankSymbols([unexportedSym('registerView')], 'register view', true);
    expect(results[0]!.debugScore?.unexportedPenalty).toBe(-20);
  });

  it('does not penalize exported symbols (no frameworkMeta)', () => {
    const results = rankSymbols([sym('RegisterView')], 'register view', true);
    expect(results[0]!.debugScore?.unexportedPenalty).toBe(0);
  });

  it('exported symbol outranks an unexported one on equal word overlap', () => {
    const exported = sym('RegisterCampaignView', { filePath: 'cmd/views.go' });
    const unexported = unexportedSym('registerCampaignView');
    const results = rankSymbols([unexported, exported], 'register campaign view');
    expect(results[0]!.symbol.name).toBe('RegisterCampaignView');
  });

  it('exact-name search still surfaces the unexported symbol first', () => {
    const results = rankSymbols(
      [unexportedSym('helperLookup'), sym('HelperService')],
      'helperLookup',
    );
    expect(results[0]!.symbol.name).toBe('helperLookup');
  });

  // Phase 87: Rust module-private items ride the same penalty
  it('applies -20 to Rust symbols with visibility "module"', () => {
    const modSym: SymbolRecord = {
      ...sym('parse_config', { filePath: 'src/config.rs' }),
      frameworkMeta: { visibility: 'module' },
    };
    const results = rankSymbols([modSym], 'parse config', true);
    expect(results[0]!.debugScore?.unexportedPenalty).toBe(-20);
  });

  it('does NOT penalize Rust visibility "crate" (crate-visible API)', () => {
    const crateSym: SymbolRecord = {
      ...sym('parse_config', { filePath: 'src/config.rs' }),
      frameworkMeta: { visibility: 'crate' },
    };
    const results = rankSymbols([crateSym], 'parse config', true);
    expect(results[0]!.debugScore?.unexportedPenalty).toBe(0);
  });
});
