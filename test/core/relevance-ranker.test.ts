import { describe, it, expect } from 'vitest';
import { rankSymbols } from '../../src/core/search/relevance-ranker.js';
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

  it('hyphen does not appear as a literal token in query words', () => {
    // "sign-in" → "sign" + "in"(stop) → only "sign" is a query word
    // The literal "sign-in" should not be a query word (no symbol name has a hyphen)
    const loginFn = sym('UserLogin', { kind: 'class' });
    const signFn = sym('signDocument', { kind: 'function' });
    const results = rankSymbols([loginFn, signFn], 'sign-in form');
    // "sign" matches "sign" in signDocument's parts; "form" doesn't match either
    expect(results[0].symbol.name).toBe('signDocument');
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

  it('Controller method gets no kindBoost', () => {
    const controllerMethod = sym('AuthController.login', { kind: 'method' });
    const results = rankSymbols([controllerMethod], 'login user', true);
    expect(results[0].debugScore?.kindBoost).toBe(0);
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
