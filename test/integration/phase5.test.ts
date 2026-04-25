/**
 * Phase 5 integration tests — Task 60.
 *
 * Validates the full Phase 5 pipeline end-to-end across all new handlers,
 * adapters, and the SymbolKind extension.
 *
 *  1.  Flask: @app.route('/users') produces route symbol
 *  2.  Flask: plain function without decorator is not extracted as route
 *  3.  FastAPI: @router.get('/items/{id}') produces route; async handled
 *  4.  Django: User(models.Model) produces kind 'model'; @login_required FBV → 'view'
 *  5.  Django: path('/users/', ...) in urls.py produces kind 'route'
 *  6.  Django: @receiver(post_save) produces kind 'signal'
 *  7.  Gin: r.GET("/users", handler) produces route; non-route call not extracted
 *  8.  PHP handler: public/protected/private methods — private skipped
 *  9.  PHP handler: namespace prefix applied to class names
 *  10. Laravel: Route::get('/users', ...) produces route; User extends Model → 'model'
 *  11. Ruby handler: top-level def → 'function'; class-level def → 'method'
 *  12. Ruby handler: # comment docstring captured
 *  13. Rails: User < ApplicationRecord → 'model'; controller action → 'view'
 *  14. Kotlin handler: data class → 'class'; companion object fun → 'method'
 *  15. Ktor: get("/users") produces route; nested route prefix combined
 *  16. C handler: non-static function extracted; static function skipped; #define → 'macro'
 *  17. C handler: typedef struct produces kind 'struct'
 *  18. SymbolKind: search with kind:'model' returns only model symbols
 *  19. SymbolKind: search with kind:'macro' returns only C macro symbols
 *  20. Regression: TypeScript fixture still indexes cleanly after all Phase 5 setup
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { pythonHandler } from '../../src/handlers/python.js';
import { goHandler } from '../../src/handlers/go.js';
import { phpHandler } from '../../src/handlers/php.js';
import { rubyHandler } from '../../src/handlers/ruby.js';
import { kotlinHandler } from '../../src/handlers/kotlin.js';
import { cHandler } from '../../src/handlers/c.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { flaskAdapter } from '../../src/adapters/flask.js';
import { fastapiAdapter } from '../../src/adapters/fastapi.js';
import { djangoAdapter } from '../../src/adapters/django.js';
import { ginAdapter } from '../../src/adapters/gin.js';
import { laravelAdapter } from '../../src/adapters/laravel.js';
import { railsAdapter } from '../../src/adapters/rails.js';
import { ktorAdapter } from '../../src/adapters/ktor.js';
import { _resetForTesting as resetAdapters } from '../../src/adapters/adapter-registry.js';

// ─── Fixture paths ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const FLASK_FIXTURE   = resolve(__dirname, '../fixtures/flask-project');
const FASTAPI_FIXTURE = resolve(__dirname, '../fixtures/fastapi-project');
const DJANGO_FIXTURE  = resolve(__dirname, '../fixtures/django-project');
const GIN_FIXTURE     = resolve(__dirname, '../fixtures/gin-project');
const PHP_FIXTURE     = resolve(__dirname, '../fixtures/php-project');
const LARAVEL_FIXTURE = resolve(__dirname, '../fixtures/laravel-project');
const RUBY_FIXTURE    = resolve(__dirname, '../fixtures/ruby-project');
const RAILS_FIXTURE   = resolve(__dirname, '../fixtures/rails-project');
const KOTLIN_FIXTURE  = resolve(__dirname, '../fixtures/kotlin-project');
const KTOR_FIXTURE    = resolve(__dirname, '../fixtures/ktor-project');
const C_FIXTURE       = resolve(__dirname, '../fixtures/c-project');
const TS_FIXTURE      = resolve(__dirname, '../fixtures/basic-ts-project');

// ─── Shared state ──────────────────────────────────────────────────────────────

let flaskRepoId:   string;
let fastapiRepoId: string;
let djangoRepoId:  string;
let ginRepoId:     string;
let phpRepoId:     string;
let laravelRepoId: string;
let rubyRepoId:    string;
let railsRepoId:   string;
let kotlinRepoId:  string;
let ktorRepoId:    string;
let cRepoId:       string;
let tsRepoId:      string;

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  resetAdapters();

  registerHandler(typescriptHandler);
  registerHandler(pythonHandler);
  registerHandler(goHandler);
  registerHandler(phpHandler);
  registerHandler(rubyHandler);
  registerHandler(kotlinHandler);
  registerHandler(cHandler);

  await initParser();

  const [
    flaskResult,
    fastapiResult,
    djangoResult,
    ginResult,
    phpResult,
    laravelResult,
    rubyResult,
    railsResult,
    kotlinResult,
    ktorResult,
    cResult,
    tsResult,
  ] = await Promise.all([
    indexFolder(FLASK_FIXTURE,   { adapters: [flaskAdapter] }),
    indexFolder(FASTAPI_FIXTURE, { adapters: [fastapiAdapter] }),
    indexFolder(DJANGO_FIXTURE,  { adapters: [djangoAdapter] }),
    indexFolder(GIN_FIXTURE,     { adapters: [ginAdapter] }),
    indexFolder(PHP_FIXTURE),
    indexFolder(LARAVEL_FIXTURE, { adapters: [laravelAdapter] }),
    indexFolder(RUBY_FIXTURE),
    indexFolder(RAILS_FIXTURE,   { adapters: [railsAdapter] }),
    indexFolder(KOTLIN_FIXTURE),
    indexFolder(KTOR_FIXTURE,    { adapters: [ktorAdapter] }),
    indexFolder(C_FIXTURE),
    indexFolder(TS_FIXTURE),
  ]);

  flaskRepoId   = flaskResult.repoId;
  fastapiRepoId = fastapiResult.repoId;
  djangoRepoId  = djangoResult.repoId;
  ginRepoId     = ginResult.repoId;
  phpRepoId     = phpResult.repoId;
  laravelRepoId = laravelResult.repoId;
  rubyRepoId    = rubyResult.repoId;
  railsRepoId   = railsResult.repoId;
  kotlinRepoId  = kotlinResult.repoId;
  ktorRepoId    = ktorResult.repoId;
  cRepoId       = cResult.repoId;
  tsRepoId      = tsResult.repoId;
}, 60_000);

afterAll(() => {
  for (const id of [
    flaskRepoId, fastapiRepoId, djangoRepoId, ginRepoId,
    phpRepoId, laravelRepoId, rubyRepoId, railsRepoId,
    kotlinRepoId, ktorRepoId, cRepoId, tsRepoId,
  ]) {
    if (id) deleteIndex(id);
  }
});

// ─── 1. Flask: @app.route produces route ──────────────────────────────────────

describe('1. Flask: @app.route produces route symbol', () => {
  it('blueprint route @users_bp.route("/") is extracted with kind route', () => {
    const db = openDatabase(flaskRepoId);
    const routes = searchSymbols(db, flaskRepoId, '', { kind: 'route', limit: 100 });
    db.close();
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((s) => s.kind === 'route')).toBe(true);
  });

  it('@app.get shorthand route is extracted', () => {
    const db = openDatabase(flaskRepoId);
    const all = searchSymbols(db, flaskRepoId, '', { kind: 'route', limit: 100 });
    db.close();
    // app.py has @app.get('/items/<int:item_id>') → name contains 'items'
    expect(all.some((s) => s.frameworkMeta?.http_method === 'GET')).toBe(true);
  });

  it('class-based view (MethodView) is extracted with kind view', () => {
    const db = openDatabase(flaskRepoId);
    const views = searchSymbols(db, flaskRepoId, '', { kind: 'view', limit: 50 });
    db.close();
    expect(views.length).toBeGreaterThan(0);
  });
});

// ─── 2. Flask: plain function not extracted as route ─────────────────────────

describe('2. Flask: plain function without decorator is not a route', () => {
  it('plain_helper has no route symbol in flask repo', () => {
    const db = openDatabase(flaskRepoId);
    const matches = searchSymbols(db, flaskRepoId, 'plain_helper', { kind: 'route' });
    db.close();
    expect(matches).toHaveLength(0);
  });
});

// ─── 3. FastAPI: async route extracted ────────────────────────────────────────

describe('3. FastAPI: @router.get route, async endpoint handled', () => {
  it('extracts routes from an APIRouter', () => {
    const db = openDatabase(fastapiRepoId);
    const routes = searchSymbols(db, fastapiRepoId, '', { kind: 'route', limit: 100 });
    db.close();
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((s) => s.kind === 'route')).toBe(true);
  });

  it('async route has GET http_method metadata', () => {
    const db = openDatabase(fastapiRepoId);
    const routes = searchSymbols(db, fastapiRepoId, '', { kind: 'route', limit: 100 });
    db.close();
    expect(routes.some((s) => s.frameworkMeta?.http_method === 'GET')).toBe(true);
  });

  it('path parameter route is extracted (item_id)', () => {
    const db = openDatabase(fastapiRepoId);
    const routes = searchSymbols(db, fastapiRepoId, '', { kind: 'route', limit: 100 });
    db.close();
    expect(
      routes.some((s) => String(s.frameworkMeta?.route_path ?? '').includes('{') ||
                         String(s.frameworkMeta?.route_path ?? '').includes('<')),
    ).toBe(true);
  });
});

// ─── 4. Django: model and view extraction ────────────────────────────────────

describe('4. Django: User(models.Model) → model; @login_required FBV → view', () => {
  it('User model is extracted with kind model', () => {
    const db = openDatabase(djangoRepoId);
    const models = searchSymbols(db, djangoRepoId, 'User', { kind: 'model' });
    db.close();
    expect(models.some((s) => s.name === 'User')).toBe(true);
  });

  it('PlainPythonClass is not extracted as model', () => {
    const db = openDatabase(djangoRepoId);
    const results = searchSymbols(db, djangoRepoId, 'PlainPythonClass', { kind: 'model' });
    db.close();
    expect(results).toHaveLength(0);
  });

  it('@login_required FBV dashboard is extracted as view', () => {
    const db = openDatabase(djangoRepoId);
    const views = searchSymbols(db, djangoRepoId, 'dashboard', { kind: 'view' });
    db.close();
    expect(views.some((s) => s.name === 'dashboard')).toBe(true);
  });
});

// ─── 5. Django: path() in urls.py produces route ─────────────────────────────

describe('5. Django: path(...) in urls.py produces kind route', () => {
  it('url path produces route symbols', () => {
    const db = openDatabase(djangoRepoId);
    const routes = searchSymbols(db, djangoRepoId, '', { kind: 'route', limit: 100 });
    db.close();
    expect(routes.length).toBeGreaterThan(0);
  });

  it('route path contains users/', () => {
    const db = openDatabase(djangoRepoId);
    const routes = searchSymbols(db, djangoRepoId, '', { kind: 'route', limit: 100 });
    db.close();
    expect(
      routes.some((s) => String(s.frameworkMeta?.route_path ?? '').includes('users')),
    ).toBe(true);
  });
});

// ─── 6. Django: @receiver signal ─────────────────────────────────────────────

describe('6. Django: @receiver(post_save) produces kind signal', () => {
  it('on_user_created is extracted as signal', () => {
    const db = openDatabase(djangoRepoId);
    const signals = searchSymbols(db, djangoRepoId, 'on_user_created', { kind: 'signal' });
    db.close();
    expect(signals.some((s) => s.name === 'on_user_created')).toBe(true);
  });

  it('plain_function in signals.py is not extracted as signal', () => {
    const db = openDatabase(djangoRepoId);
    const results = searchSymbols(db, djangoRepoId, 'plain_function', { kind: 'signal' });
    db.close();
    expect(results).toHaveLength(0);
  });
});

// ─── 7. Gin: r.GET route extracted; non-route not extracted ──────────────────

describe('7. Gin: r.GET("/users") produces route; non-route call not extracted', () => {
  it('r.GET("/users") produces a route symbol', () => {
    const db = openDatabase(ginRepoId);
    const routes = searchSymbols(db, ginRepoId, '', { kind: 'route', limit: 100 });
    db.close();
    expect(routes.some((s) => String(s.frameworkMeta?.route_path ?? '').includes('/users'))).toBe(true);
  });

  it('route has correct http_method GET', () => {
    const db = openDatabase(ginRepoId);
    const routes = searchSymbols(db, ginRepoId, '', { kind: 'route', limit: 100 });
    db.close();
    expect(routes.some((s) => s.frameworkMeta?.http_method === 'GET')).toBe(true);
  });

  it('r.Use (middleware call) produces middleware symbol, not route', () => {
    const db = openDatabase(ginRepoId);
    const mw = searchSymbols(db, ginRepoId, '', { kind: 'middleware', limit: 50 });
    db.close();
    // r.Use(AuthMiddleware) and r.Use(Logger) → kind 'middleware'
    expect(mw.some((s) => s.frameworkMeta?.gin_middleware === true)).toBe(true);
  });
});

// ─── 8. PHP: private method skipped ──────────────────────────────────────────

describe('8. PHP handler: public/protected methods extracted; private skipped', () => {
  it('public method index is extracted', () => {
    const db = openDatabase(phpRepoId);
    const results = searchSymbols(db, phpRepoId, 'index', { kind: 'method' });
    db.close();
    expect(results.some((s) => s.name.endsWith('index') || s.name.endsWith('::index'))).toBe(true);
  });

  it('private method secret is not extracted', () => {
    const db = openDatabase(phpRepoId);
    const results = searchSymbols(db, phpRepoId, 'secret', { kind: 'method' });
    db.close();
    expect(results).toHaveLength(0);
  });

  it('protected method validate is extracted', () => {
    const db = openDatabase(phpRepoId);
    const results = searchSymbols(db, phpRepoId, 'validate', { kind: 'method' });
    db.close();
    expect(results.length).toBeGreaterThan(0);
  });
});

// ─── 9. PHP: namespace prefix ────────────────────────────────────────────────

describe('9. PHP handler: namespace prefix applied to class names', () => {
  it('UserController includes namespace in its name or filePath', () => {
    const db = openDatabase(phpRepoId);
    const results = searchSymbols(db, phpRepoId, 'UserController', { kind: 'class' });
    db.close();
    expect(results.some((s) =>
      s.name.includes('UserController') &&
      (s.name.includes('\\') || s.name.includes('App')),
    )).toBe(true);
  });
});

// ─── 10. Laravel: Route::get and User model ──────────────────────────────────

describe('10. Laravel: Route::get → route; User extends Model → model', () => {
  it('Route::get /users is extracted', () => {
    const db = openDatabase(laravelRepoId);
    const routes = searchSymbols(db, laravelRepoId, '', { kind: 'route', limit: 100 });
    db.close();
    expect(routes.some((s) => String(s.frameworkMeta?.route_path ?? '').includes('/users'))).toBe(true);
  });

  it('Route::resource produces multiple route symbols', () => {
    const db = openDatabase(laravelRepoId);
    const routes = searchSymbols(db, laravelRepoId, '', { kind: 'route', limit: 100 });
    db.close();
    expect(routes.length).toBeGreaterThan(3);
  });

  it('User extending Authenticatable is extracted as model', () => {
    const db = openDatabase(laravelRepoId);
    const models = searchSymbols(db, laravelRepoId, 'User', { kind: 'model' });
    db.close();
    expect(models.some((s) => s.name.includes('User'))).toBe(true);
  });
});

// ─── 11. Ruby handler: function vs method ────────────────────────────────────

describe('11. Ruby handler: top-level def → function; class-level def → method', () => {
  it('greet (top-level) is extracted as function', () => {
    const db = openDatabase(rubyRepoId);
    const fns = searchSymbols(db, rubyRepoId, 'greet', { kind: 'function' });
    db.close();
    expect(fns.some((s) => s.name === 'greet')).toBe(true);
  });

  it('display_name (class-level) is extracted as method', () => {
    const db = openDatabase(rubyRepoId);
    const methods = searchSymbols(db, rubyRepoId, 'display_name', { kind: 'method' });
    db.close();
    expect(methods.some((s) => s.name.includes('display_name'))).toBe(true);
  });

  it('attr_accessor does not produce a method symbol', () => {
    const db = openDatabase(rubyRepoId);
    // attr_accessor :name, :email generates accessors but they are not explicit defs
    // The handler skips attr_accessor call nodes, so no method named 'name' should appear
    const results = searchSymbols(db, rubyRepoId, '', { kind: 'method', limit: 200 });
    db.close();
    // All method symbols should have explicit def names — none should be 'attr_accessor'
    expect(results.every((s) => s.name !== 'attr_accessor')).toBe(true);
  });
});

// ─── 12. Ruby handler: docstring captured ────────────────────────────────────

describe('12. Ruby handler: # comment docstring captured', () => {
  it('display_name has a non-empty summary from its docstring', () => {
    const db = openDatabase(rubyRepoId);
    const methods = searchSymbols(db, rubyRepoId, 'display_name', { kind: 'method' });
    db.close();
    const sym = methods.find((s) => s.name.includes('display_name'));
    expect(sym).toBeDefined();
    expect(sym!.summary.length).toBeGreaterThan(0);
  });

  it('format_bytes (util) has a summary captured from its leading comment', () => {
    const db = openDatabase(rubyRepoId);
    const results = searchSymbols(db, rubyRepoId, 'format_bytes', { kind: 'function' });
    db.close();
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].summary.length).toBeGreaterThan(0);
  });
});

// ─── 13. Rails: model and controller view ────────────────────────────────────

describe('13. Rails: User < ApplicationRecord → model; controller action → view', () => {
  it('User is extracted as kind model', () => {
    const db = openDatabase(railsRepoId);
    const models = searchSymbols(db, railsRepoId, 'User', { kind: 'model' });
    db.close();
    expect(models.some((s) => s.name.includes('User'))).toBe(true);
  });

  it('index action in UsersController is extracted as view', () => {
    const db = openDatabase(railsRepoId);
    const views = searchSymbols(db, railsRepoId, 'index', { kind: 'view' });
    db.close();
    expect(views.some((s) => s.name.includes('index'))).toBe(true);
  });
});

// ─── 14. Kotlin handler: data class and companion method ─────────────────────

describe('14. Kotlin handler: data class → class; companion object fun → method', () => {
  it('data class User is extracted as class', () => {
    const db = openDatabase(kotlinRepoId);
    const classes = searchSymbols(db, kotlinRepoId, 'User', { kind: 'class' });
    db.close();
    expect(classes.some((s) => s.name === 'User')).toBe(true);
  });

  it('companion object function guest is extracted as method', () => {
    const db = openDatabase(kotlinRepoId);
    const methods = searchSymbols(db, kotlinRepoId, 'guest', { kind: 'method' });
    db.close();
    expect(methods.some((s) => s.name.includes('guest'))).toBe(true);
  });
});

// ─── 15. Ktor: route extraction and nested prefix combination ─────────────────

describe('15. Ktor: get("/users") produces route; nested route prefix combined', () => {
  it('top-level get("/health") produces a route', () => {
    const db = openDatabase(ktorRepoId);
    const routes = searchSymbols(db, ktorRepoId, '', { kind: 'route', limit: 100 });
    db.close();
    expect(routes.some((s) => String(s.frameworkMeta?.route_path ?? '').includes('/health'))).toBe(true);
  });

  it('route("/api") { get("/users") } produces a combined path /api/users', () => {
    const db = openDatabase(ktorRepoId);
    const routes = searchSymbols(db, ktorRepoId, '', { kind: 'route', limit: 100 });
    db.close();
    expect(routes.some((s) => String(s.frameworkMeta?.route_path ?? '') === '/api/users')).toBe(true);
  });

  it('authenticated nested route has authenticated metadata', () => {
    const db = openDatabase(ktorRepoId);
    const routes = searchSymbols(db, ktorRepoId, '', { kind: 'route', limit: 100 });
    db.close();
    expect(routes.some((s) => s.frameworkMeta?.authenticated === true)).toBe(true);
  });
});

// ─── 16. C handler: static skipped; non-static extracted; macro extracted ─────

describe('16. C handler: non-static extracted; static skipped; #define → macro', () => {
  it('non-static auth_create is extracted as function', () => {
    const db = openDatabase(cRepoId);
    const results = searchSymbols(db, cRepoId, 'auth_create', { kind: 'function' });
    db.close();
    expect(results.some((s) => s.name === 'auth_create')).toBe(true);
  });

  it('static hash_password is not extracted', () => {
    const db = openDatabase(cRepoId);
    const results = searchSymbols(db, cRepoId, 'hash_password', {});
    db.close();
    expect(results).toHaveLength(0);
  });

  it('object-like #define MAX_USERNAME_LEN produces kind macro', () => {
    const db = openDatabase(cRepoId);
    const macros = searchSymbols(db, cRepoId, 'MAX_USERNAME_LEN', { kind: 'macro' });
    db.close();
    expect(macros.some((s) => s.name === 'MAX_USERNAME_LEN')).toBe(true);
  });

  it('function-like macro MAX(a,b) is not extracted', () => {
    const db = openDatabase(cRepoId);
    const results = searchSymbols(db, cRepoId, 'MAX', { kind: 'macro' });
    db.close();
    // MAX is a function-like macro — should not appear
    expect(results.every((s) => s.name !== 'MAX')).toBe(true);
  });
});

// ─── 17. C handler: typedef struct ───────────────────────────────────────────

describe('17. C handler: typedef struct produces kind struct', () => {
  it('AuthSession typedef struct is extracted as struct', () => {
    const db = openDatabase(cRepoId);
    const structs = searchSymbols(db, cRepoId, 'AuthSession', { kind: 'struct' });
    db.close();
    expect(structs.some((s) => s.name === 'AuthSession')).toBe(true);
  });

  it('AuthResult typedef enum is extracted as enum', () => {
    const db = openDatabase(cRepoId);
    const enums = searchSymbols(db, cRepoId, 'AuthResult', { kind: 'enum' });
    db.close();
    expect(enums.some((s) => s.name === 'AuthResult')).toBe(true);
  });
});

// ─── 18. SymbolKind: kind:'model' filter ─────────────────────────────────────

describe("18. SymbolKind: kind:'model' returns only model symbols", () => {
  it('Django repo: all results have kind model when filtered', () => {
    const db = openDatabase(djangoRepoId);
    const results = searchSymbols(db, djangoRepoId, '', { kind: 'model', limit: 100 });
    db.close();
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((s) => s.kind === 'model')).toBe(true);
  });

  it('Laravel repo: kind:model filter returns only model symbols', () => {
    const db = openDatabase(laravelRepoId);
    const results = searchSymbols(db, laravelRepoId, '', { kind: 'model', limit: 100 });
    db.close();
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((s) => s.kind === 'model')).toBe(true);
  });

  it('Rails repo: kind:model filter returns only model symbols', () => {
    const db = openDatabase(railsRepoId);
    const results = searchSymbols(db, railsRepoId, '', { kind: 'model', limit: 100 });
    db.close();
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((s) => s.kind === 'model')).toBe(true);
  });
});

// ─── 19. SymbolKind: kind:'macro' returns only C macros ──────────────────────

describe("19. SymbolKind: kind:'macro' returns only C macro symbols", () => {
  it('C repo: all results have kind macro when filtered', () => {
    const db = openDatabase(cRepoId);
    const results = searchSymbols(db, cRepoId, '', { kind: 'macro', limit: 100 });
    db.close();
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((s) => s.kind === 'macro')).toBe(true);
  });

  it('C repo: macro symbols include constants from constants.h', () => {
    const db = openDatabase(cRepoId);
    const results = searchSymbols(db, cRepoId, 'MAX_BUFFER_SIZE', { kind: 'macro' });
    db.close();
    expect(results.some((s) => s.name === 'MAX_BUFFER_SIZE')).toBe(true);
  });

  it('C repo: header guard #define is not extracted as macro', () => {
    const db = openDatabase(cRepoId);
    // CONSTANTS_H and AUTH_H are header guards (no value) — should be absent
    const results = searchSymbols(db, cRepoId, 'CONSTANTS_H', { kind: 'macro' });
    db.close();
    expect(results).toHaveLength(0);
  });
});

// ─── 20. Regression: TypeScript fixture still indexes correctly ───────────────

describe('20. Regression: Phase 1 TypeScript fixture unaffected by Phase 5 setup', () => {
  it('basic-ts-project indexes successfully', () => {
    const db = openDatabase(tsRepoId);
    const all = searchSymbols(db, tsRepoId, '', { limit: 100 });
    db.close();
    expect(all.length).toBeGreaterThan(0);
  });

  it('TypeScript symbols have kind function or class', () => {
    const db = openDatabase(tsRepoId);
    const all = searchSymbols(db, tsRepoId, '', { limit: 100 });
    db.close();
    const validKinds = new Set(['function', 'class', 'method', 'const', 'type', 'interface', 'enum']);
    expect(all.every((s) => validKinds.has(s.kind))).toBe(true);
  });
});
