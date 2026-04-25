import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { laravelAdapter } from '../../src/adapters/laravel.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/laravel-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-laravel-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('laravelAdapter metadata', () => {
  it('has name "laravel"', () => {
    expect(laravelAdapter.name).toBe('laravel');
  });

  it('declares no extra extensions', () => {
    expect(laravelAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('laravelAdapter.detect', () => {
  it('detects Laravel via composer.json with laravel/framework in require', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'composer.json'),
      JSON.stringify({ require: { 'laravel/framework': '^10.0' } }),
    );
    expect(await laravelAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when composer.json has no laravel/framework', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'composer.json'),
      JSON.stringify({ require: { 'symfony/framework-bundle': '^6.0' } }),
    );
    expect(await laravelAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false when composer.json is absent', async () => {
    const dir = tmpDir();
    expect(await laravelAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false on malformed composer.json', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'composer.json'), 'not valid json');
    expect(await laravelAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture Laravel project via composer.json', async () => {
    expect(await laravelAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('laravelAdapter.fileFilter', () => {
  it('accepts routes/*.php', () => {
    expect(laravelAdapter.fileFilter('routes/web.php')).toBe(true);
    expect(laravelAdapter.fileFilter('routes/api.php')).toBe(true);
  });

  it('accepts app/Http/Controllers/**/*.php', () => {
    expect(laravelAdapter.fileFilter('app/Http/Controllers/UserController.php')).toBe(true);
    expect(laravelAdapter.fileFilter('app/Http/Controllers/Admin/DashboardController.php')).toBe(true);
  });

  it('accepts app/Models/**/*.php', () => {
    expect(laravelAdapter.fileFilter('app/Models/User.php')).toBe(true);
    expect(laravelAdapter.fileFilter('app/Models/Post.php')).toBe(true);
  });

  it('accepts app/Http/Middleware/**/*.php', () => {
    expect(laravelAdapter.fileFilter('app/Http/Middleware/VerifyCsrfToken.php')).toBe(true);
  });

  it('rejects files outside watched paths', () => {
    expect(laravelAdapter.fileFilter('app/Providers/AppServiceProvider.php')).toBe(false);
    expect(laravelAdapter.fileFilter('database/migrations/create_users_table.php')).toBe(false);
    expect(laravelAdapter.fileFilter('config/app.php')).toBe(false);
    expect(laravelAdapter.fileFilter('composer.json')).toBe(false);
  });

  it('rejects non-PHP files', () => {
    expect(laravelAdapter.fileFilter('routes/web.js')).toBe(false);
  });
});

// ─── Route extraction — basic HTTP methods ────────────────────────────────────

describe('laravelAdapter — Route::get/post/put/delete extraction', () => {
  it('extracts Route::get', () => {
    const source = `<?php
use Illuminate\\Support\\Facades\\Route;
Route::get('/users', [UserController::class, 'index']);
`;
    const symbols = laravelAdapter.extractFrameworkSymbols(null, buf(source), 'routes/web.php');
    const route = symbols.find((s) => s.kind === 'route' && s.name === 'GET /users');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.route_path).toBe('/users');
    expect(route!.frameworkMeta?.laravel_route).toBe(true);
  });

  it('extracts Route::post', () => {
    const source = `<?php
Route::post('/users', [UserController::class, 'store']);
`;
    const symbols = laravelAdapter.extractFrameworkSymbols(null, buf(source), 'routes/web.php');
    expect(symbols.find((s) => s.name === 'POST /users' && s.kind === 'route')).toBeDefined();
  });

  it('extracts Route::put', () => {
    const source = `<?php
Route::put('/users/{id}', [UserController::class, 'update']);
`;
    const symbols = laravelAdapter.extractFrameworkSymbols(null, buf(source), 'routes/web.php');
    expect(symbols.find((s) => s.name === 'PUT /users/{id}' && s.kind === 'route')).toBeDefined();
  });

  it('extracts Route::delete', () => {
    const source = `<?php
Route::delete('/users/{id}', [UserController::class, 'destroy']);
`;
    const symbols = laravelAdapter.extractFrameworkSymbols(null, buf(source), 'routes/web.php');
    expect(symbols.find((s) => s.name === 'DELETE /users/{id}' && s.kind === 'route')).toBeDefined();
  });

  it('extracts Route::patch', () => {
    const source = `<?php
Route::patch('/users/{id}', [UserController::class, 'update']);
`;
    const symbols = laravelAdapter.extractFrameworkSymbols(null, buf(source), 'routes/web.php');
    expect(symbols.find((s) => s.name === 'PATCH /users/{id}' && s.kind === 'route')).toBeDefined();
  });

  it('does not extract routes from non-route files', () => {
    const source = `<?php
Route::get('/users', [UserController::class, 'index']);
`;
    const symbols = laravelAdapter.extractFrameworkSymbols(
      null,
      buf(source),
      'app/Http/Controllers/UserController.php',
    );
    expect(symbols.filter((s) => s.kind === 'route')).toHaveLength(0);
  });
});

// ─── Route::resource ─────────────────────────────────────────────────────────

describe('laravelAdapter — Route::resource extraction', () => {
  it('emits 5 routes for Route::resource', () => {
    const source = `<?php
use Illuminate\\Support\\Facades\\Route;
Route::resource('users', UserController::class);
`;
    const symbols = laravelAdapter.extractFrameworkSymbols(null, buf(source), 'routes/web.php');
    const routes = symbols.filter((s) => s.kind === 'route');
    expect(routes).toHaveLength(5);

    const methods = routes.map((s) => s.frameworkMeta?.http_method as string).sort();
    expect(methods).toEqual(['DELETE', 'GET', 'GET', 'POST', 'PUT'].sort());

    // Check index and show routes
    expect(routes.find((s) => s.name === 'GET /users')).toBeDefined();
    expect(routes.find((s) => s.name === 'GET /users/{id}')).toBeDefined();
    expect(routes.find((s) => s.name === 'POST /users')).toBeDefined();
    expect(routes.find((s) => s.name === 'PUT /users/{id}')).toBeDefined();
    expect(routes.find((s) => s.name === 'DELETE /users/{id}')).toBeDefined();

    // All should have laravel_resource: true
    expect(routes.every((s) => s.frameworkMeta?.laravel_resource)).toBe(true);
  });

  it('handles resource name without leading slash', () => {
    const source = `<?php
Route::resource('posts', PostController::class);
`;
    const symbols = laravelAdapter.extractFrameworkSymbols(null, buf(source), 'routes/web.php');
    const routes = symbols.filter((s) => s.kind === 'route');
    expect(routes.find((s) => s.name === 'GET /posts')).toBeDefined();
    expect(routes.find((s) => s.name === 'GET /posts/{id}')).toBeDefined();
  });
});

// ─── Route::group with prefix ─────────────────────────────────────────────────

describe('laravelAdapter — Route::group prefix', () => {
  it('applies prefix to child routes', () => {
    const source = `<?php
use Illuminate\\Support\\Facades\\Route;
Route::group(['prefix' => '/admin'], function () {
    Route::get('/dashboard', function () {});
    Route::post('/settings', function () {});
});
`;
    const symbols = laravelAdapter.extractFrameworkSymbols(null, buf(source), 'routes/web.php');
    const routes = symbols.filter((s) => s.kind === 'route');
    expect(routes.find((s) => s.name === 'GET /admin/dashboard')).toBeDefined();
    expect(routes.find((s) => s.name === 'POST /admin/settings')).toBeDefined();
  });

  it('does not emit a route for the group itself', () => {
    const source = `<?php
Route::group(['prefix' => '/api'], function () {
    Route::get('/users', [UserController::class, 'index']);
});
`;
    const symbols = laravelAdapter.extractFrameworkSymbols(null, buf(source), 'routes/web.php');
    // Only the child route, not the group
    expect(symbols.filter((s) => s.kind === 'route')).toHaveLength(1);
    expect(symbols[0]!.name).toBe('GET /api/users');
  });

  it('extracts routes from fixture routes/web.php', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'routes/web.php'), 'utf8');
    const symbols = laravelAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'routes/web.php',
    );
    const routes = symbols.filter((s) => s.kind === 'route');

    // Direct routes
    expect(routes.find((s) => s.name === 'GET /users')).toBeDefined();
    expect(routes.find((s) => s.name === 'POST /users')).toBeDefined();

    // Resource routes
    expect(routes.find((s) => s.name === 'GET /posts')).toBeDefined();
    expect(routes.find((s) => s.name === 'GET /posts/{id}')).toBeDefined();

    // Group-prefixed routes
    expect(routes.find((s) => s.name === 'GET /admin/dashboard')).toBeDefined();
    expect(routes.find((s) => s.name === 'POST /admin/settings')).toBeDefined();
  });

  it('extracts group-prefixed routes from fixture routes/api.php', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'routes/api.php'), 'utf8');
    const symbols = laravelAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'routes/api.php',
    );
    const routes = symbols.filter((s) => s.kind === 'route');
    expect(routes.find((s) => s.name === 'GET /v1/users')).toBeDefined();
    expect(routes.find((s) => s.name === 'POST /v1/users')).toBeDefined();
  });
});

// ─── Controller extraction ────────────────────────────────────────────────────

describe('laravelAdapter — controller extraction', () => {
  it('extracts class extending Controller with laravel_controller meta', () => {
    const source = `<?php
class UserController extends Controller {
    public function index() { return []; }
}
`;
    const symbols = laravelAdapter.extractFrameworkSymbols(
      null,
      buf(source),
      'app/Http/Controllers/UserController.php',
    );
    const cls = symbols.find((s) => s.name === 'UserController' && s.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls!.frameworkMeta?.laravel_controller).toBe(true);
  });

  it('emits public controller methods as kind "view" with laravel_action meta', () => {
    const source = `<?php
class UserController extends Controller {
    public function index() { return []; }
    public function store(Request $request) {}
    protected function helper() {}
    private function secret() {}
}
`;
    const symbols = laravelAdapter.extractFrameworkSymbols(
      null,
      buf(source),
      'app/Http/Controllers/UserController.php',
    );
    const actions = symbols.filter((s) => s.kind === 'view');
    const names = actions.map((s) => s.name);
    expect(names).toContain('UserController::index');
    expect(names).toContain('UserController::store');
    // protected and private are NOT emitted
    expect(names).not.toContain('UserController::helper');
    expect(names).not.toContain('UserController::secret');
    expect(actions.every((s) => s.frameworkMeta?.laravel_action)).toBe(true);
  });

  it('does not extract non-controller classes', () => {
    const source = `<?php
class PlainClass {
    public function doSomething() {}
}
`;
    const symbols = laravelAdapter.extractFrameworkSymbols(
      null,
      buf(source),
      'app/Http/Controllers/PlainClass.php',
    );
    expect(symbols.filter((s) => s.kind === 'class')).toHaveLength(0);
    expect(symbols.filter((s) => s.kind === 'view')).toHaveLength(0);
  });

  it('extracts controller and actions from fixture UserController.php', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'app/Http/Controllers/UserController.php'),
      'utf8',
    );
    const symbols = laravelAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'app/Http/Controllers/UserController.php',
    );
    const cls = symbols.find((s) => s.name === 'UserController' && s.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls!.frameworkMeta?.laravel_controller).toBe(true);

    const actionNames = symbols.filter((s) => s.kind === 'view').map((s) => s.name);
    expect(actionNames).toContain('UserController::index');
    expect(actionNames).toContain('UserController::store');
    expect(actionNames).toContain('UserController::show');
    expect(actionNames).toContain('UserController::update');
    expect(actionNames).toContain('UserController::destroy');
    // protected and private methods must not appear
    expect(actionNames).not.toContain('UserController::authorizeAction');
    expect(actionNames).not.toContain('UserController::internalHelper');
  });
});

// ─── Model extraction ─────────────────────────────────────────────────────────

describe('laravelAdapter — model extraction', () => {
  it('extracts class extending Model with laravel_model meta', () => {
    const source = `<?php
class Post extends Model {
    protected $fillable = ['title'];
}
`;
    const symbols = laravelAdapter.extractFrameworkSymbols(
      null,
      buf(source),
      'app/Models/Post.php',
    );
    const model = symbols.find((s) => s.name === 'Post' && s.kind === 'model');
    expect(model).toBeDefined();
    expect(model!.frameworkMeta?.laravel_model).toBe(true);
  });

  it('extracts class extending Authenticatable as model', () => {
    const source = `<?php
class User extends Authenticatable {
    use HasFactory;
}
`;
    const symbols = laravelAdapter.extractFrameworkSymbols(
      null,
      buf(source),
      'app/Models/User.php',
    );
    const model = symbols.find((s) => s.name === 'User' && s.kind === 'model');
    expect(model).toBeDefined();
    expect(model!.frameworkMeta?.laravel_model).toBe(true);
  });

  it('does not extract plain non-model classes', () => {
    const source = `<?php
class NotAModel {
    public function doStuff() {}
}
`;
    const symbols = laravelAdapter.extractFrameworkSymbols(
      null,
      buf(source),
      'app/Models/NotAModel.php',
    );
    expect(symbols.filter((s) => s.kind === 'model')).toHaveLength(0);
  });

  it('extracts models from fixture app/Models/ files', () => {
    const userSource = readFileSync(join(FIXTURE_ROOT, 'app/Models/User.php'), 'utf8');
    const userSymbols = laravelAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(userSource),
      'app/Models/User.php',
    );
    expect(userSymbols.find((s) => s.name === 'User' && s.kind === 'model')).toBeDefined();

    const postSource = readFileSync(join(FIXTURE_ROOT, 'app/Models/Post.php'), 'utf8');
    const postSymbols = laravelAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(postSource),
      'app/Models/Post.php',
    );
    expect(postSymbols.find((s) => s.name === 'Post' && s.kind === 'model')).toBeDefined();
  });
});

// ─── Middleware extraction ────────────────────────────────────────────────────

describe('laravelAdapter — middleware extraction', () => {
  it('extracts class with handle(Request, Closure) as middleware', () => {
    const source = `<?php
class VerifyCsrfToken {
    public function handle(Request $request, Closure $next) {
        return $next($request);
    }
}
`;
    const symbols = laravelAdapter.extractFrameworkSymbols(
      null,
      buf(source),
      'app/Http/Middleware/VerifyCsrfToken.php',
    );
    const mw = symbols.find((s) => s.name === 'VerifyCsrfToken' && s.kind === 'middleware');
    expect(mw).toBeDefined();
    expect(mw!.frameworkMeta?.laravel_middleware).toBe(true);
  });

  it('does not emit middleware for class without handle method', () => {
    const source = `<?php
class NotMiddleware {
    public function process($request) {}
}
`;
    const symbols = laravelAdapter.extractFrameworkSymbols(
      null,
      buf(source),
      'app/Http/Middleware/NotMiddleware.php',
    );
    expect(symbols.filter((s) => s.kind === 'middleware')).toHaveLength(0);
  });

  it('extracts middleware from fixture VerifyCsrfToken.php', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'app/Http/Middleware/VerifyCsrfToken.php'),
      'utf8',
    );
    const symbols = laravelAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'app/Http/Middleware/VerifyCsrfToken.php',
    );
    expect(
      symbols.find((s) => s.name === 'VerifyCsrfToken' && s.kind === 'middleware'),
    ).toBeDefined();
  });

  it('extracts both middleware from fixture files', () => {
    for (const file of ['VerifyCsrfToken.php', 'AuthenticateMiddleware.php']) {
      const source = readFileSync(
        join(FIXTURE_ROOT, 'app/Http/Middleware', file),
        'utf8',
      );
      const symbols = laravelAdapter.extractFrameworkSymbols(
        null,
        Buffer.from(source),
        `app/Http/Middleware/${file}`,
      );
      expect(symbols.filter((s) => s.kind === 'middleware')).toHaveLength(1);
    }
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('laravelAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc123',
      name: 'UserController',
      kind: 'class' as const,
      filePath: 'app/Http/Controllers/UserController.php',
      startByte: 0,
      endByte: 100,
      signature: 'class UserController extends Controller',
      summary: 'Laravel controller: UserController',
      frameworkMeta: { laravel_controller: true },
    };
    expect(laravelAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});
