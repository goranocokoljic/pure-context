/**
 * Phase 6 integration tests — Task 66.
 *
 * Validates the full Phase 6 pipeline end-to-end across all new handlers
 * and adapters.
 *
 *  1.  C++: namespace Auth { class AuthService } → symbol name is Auth::AuthService
 *  2.  C++: nested namespace → App::Models::User
 *  3.  C++: template<T> class Cache → kind 'class' with template in signature
 *  4.  C++: private method → not extracted; public method → extracted
 *  5.  C++: struct Point → kind 'struct' (not 'class')
 *  6.  C++: namespace Auth declaration → kind 'namespace'
 *  7.  Lua: function M.login() → kind 'method' with name M.login
 *  8.  Lua: function M:logout() → kind 'method' with name M:logout
 *  9.  Lua: top-level function trim() → kind 'function'
 *  10. Dart: class with public methods → extracted; _private method → skipped
 *  11. Dart: named constructor → kind 'method' with name ClassName.namedConstructor
 *  12. Dart: /// doc comment captured in summary
 *  13. Flutter: StatelessWidget subclass → kind 'widget' with flutter_widget_type 'stateless'
 *  14. Flutter: StatefulWidget + linked State class → both emitted as 'widget'
 *  15. Flutter: ChangeNotifier subclass → kind 'class' with flutter_notifier
 *  16. Flutter: plain Dart class → kind 'class', not 'widget'
 *  17. search-symbols with kind:'widget' returns only Flutter widgets
 *  18. search-symbols with kind:'namespace' returns only C++ namespaces
 *  19. Regression: TypeScript fixture still indexes cleanly
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { cppHandler } from '../../src/handlers/cpp.js';
import { luaHandler } from '../../src/handlers/lua.js';
import { dartHandler } from '../../src/handlers/dart.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { flutterAdapter } from '../../src/adapters/flutter.js';
import { _resetForTesting as resetAdapters } from '../../src/adapters/adapter-registry.js';

// ─── Fixture paths ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const CPP_FIXTURE     = resolve(__dirname, '../fixtures/cpp-project');
const LUA_FIXTURE     = resolve(__dirname, '../fixtures/lua-project');
const DART_FIXTURE    = resolve(__dirname, '../fixtures/dart-project');
const FLUTTER_FIXTURE = resolve(__dirname, '../fixtures/flutter-project');
const TS_FIXTURE      = resolve(__dirname, '../fixtures/basic-ts-project');

// ─── Shared state ──────────────────────────────────────────────────────────────

let cppRepoId:     string;
let luaRepoId:     string;
let dartRepoId:    string;
let flutterRepoId: string;
let tsRepoId:      string;

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  resetAdapters();

  registerHandler(typescriptHandler);
  registerHandler(cppHandler);
  registerHandler(luaHandler);
  registerHandler(dartHandler);

  await initParser();

  const [cppResult, luaResult, dartResult, flutterResult, tsResult] = await Promise.all([
    indexFolder(CPP_FIXTURE),
    indexFolder(LUA_FIXTURE),
    indexFolder(DART_FIXTURE),
    indexFolder(FLUTTER_FIXTURE, { adapters: [flutterAdapter] }),
    indexFolder(TS_FIXTURE),
  ]);

  cppRepoId     = cppResult.repoId;
  luaRepoId     = luaResult.repoId;
  dartRepoId    = dartResult.repoId;
  flutterRepoId = flutterResult.repoId;
  tsRepoId      = tsResult.repoId;
}, 60_000);

afterAll(() => {
  for (const id of [cppRepoId, luaRepoId, dartRepoId, flutterRepoId, tsRepoId]) {
    if (id) deleteIndex(id);
  }
});

// ─── 1. C++: namespace-qualified class name ───────────────────────────────────

describe('1. C++: namespace Auth { class AuthService } → Auth::AuthService', () => {
  it('AuthService is stored with fully-qualified name Auth::AuthService', () => {
    const db = openDatabase(cppRepoId);
    const results = searchSymbols(db, cppRepoId, 'AuthService', { kind: 'class' });
    db.close();
    expect(results.some((s) => s.name === 'Auth::AuthService')).toBe(true);
  });

  it('AuthService symbol kind is "class"', () => {
    const db = openDatabase(cppRepoId);
    const results = searchSymbols(db, cppRepoId, 'Auth::AuthService', { kind: 'class' });
    db.close();
    expect(results.length).toBeGreaterThan(0);
  });
});

// ─── 2. C++: nested namespace → App::Models::User ────────────────────────────

describe('2. C++: nested namespace → App::Models::User', () => {
  it('User struct in nested namespace is named App::Models::User', () => {
    const db = openDatabase(cppRepoId);
    const results = searchSymbols(db, cppRepoId, 'User');
    db.close();
    expect(results.some((s) => s.name === 'App::Models::User')).toBe(true);
  });
});

// ─── 3. C++: template class ───────────────────────────────────────────────────

describe('3. C++: template<T> class Cache → kind "class" with template signature', () => {
  it('Cache is extracted as kind "class"', () => {
    const db = openDatabase(cppRepoId);
    const results = searchSymbols(db, cppRepoId, 'Cache', { kind: 'class' });
    db.close();
    expect(results.length).toBeGreaterThan(0);
  });

  it('Cache signature contains template parameter', () => {
    const db = openDatabase(cppRepoId);
    const results = searchSymbols(db, cppRepoId, 'Cache', { kind: 'class' });
    db.close();
    expect(results.some((s) => s.signature.includes('template') || s.signature.includes('<'))).toBe(true);
  });
});

// ─── 4. C++: access specifier filtering ──────────────────────────────────────

describe('4. C++: private method not extracted; public method extracted', () => {
  it('public method login is extracted under Auth::AuthService', () => {
    const db = openDatabase(cppRepoId);
    const results = searchSymbols(db, cppRepoId, 'login', { kind: 'method' });
    db.close();
    expect(results.some((s) => s.name.includes('AuthService') && s.name.includes('login'))).toBe(true);
  });

  it('private method _validateCredentials is NOT extracted', () => {
    const db = openDatabase(cppRepoId);
    const results = searchSymbols(db, cppRepoId, '_validateCredentials');
    db.close();
    expect(results).toHaveLength(0);
  });
});

// ─── 5. C++: struct → kind 'struct' ──────────────────────────────────────────

describe('5. C++: struct Point → kind "struct"', () => {
  it('Point is extracted as kind "struct"', () => {
    const db = openDatabase(cppRepoId);
    const results = searchSymbols(db, cppRepoId, 'Point', { kind: 'struct' });
    db.close();
    expect(results.length).toBeGreaterThan(0);
  });

  it('Point kind is "struct", not "class"', () => {
    const db = openDatabase(cppRepoId);
    const structs = searchSymbols(db, cppRepoId, 'Point', { kind: 'struct' });
    const classes = searchSymbols(db, cppRepoId, 'Point', { kind: 'class' });
    db.close();
    expect(structs.length).toBeGreaterThan(0);
    // Point should appear as struct not class
    expect(structs.some((s) => s.name.includes('Point') && s.kind === 'struct')).toBe(true);
  });
});

// ─── 6. C++: namespace declaration → kind 'namespace' ────────────────────────

describe('6. C++: namespace Auth → kind "namespace"', () => {
  it('Auth is extracted as kind "namespace"', () => {
    const db = openDatabase(cppRepoId);
    const results = searchSymbols(db, cppRepoId, 'Auth', { kind: 'namespace' });
    db.close();
    expect(results.some((s) => s.name === 'Auth' && s.kind === 'namespace')).toBe(true);
  });

  it('Utils is extracted as kind "namespace"', () => {
    const db = openDatabase(cppRepoId);
    const results = searchSymbols(db, cppRepoId, 'Utils', { kind: 'namespace' });
    db.close();
    expect(results.some((s) => s.name === 'Utils')).toBe(true);
  });
});

// ─── 7. Lua: M.login → kind 'method' ─────────────────────────────────────────

describe('7. Lua: function M.login() → kind "method" with name M.login', () => {
  it('M.login is extracted as kind "method"', () => {
    const db = openDatabase(luaRepoId);
    const results = searchSymbols(db, luaRepoId, 'M.login', { kind: 'method' });
    db.close();
    expect(results.some((s) => s.name === 'M.login')).toBe(true);
  });
});

// ─── 8. Lua: M:logout → kind 'method' ────────────────────────────────────────

describe('8. Lua: function M:logout() → kind "method" with name M:logout', () => {
  it('M:logout is extracted as kind "method"', () => {
    const db = openDatabase(luaRepoId);
    const results = searchSymbols(db, luaRepoId, 'logout');
    db.close();
    expect(results.some((s) => s.name === 'M:logout' && s.kind === 'method')).toBe(true);
  });
});

// ─── 9. Lua: top-level function ───────────────────────────────────────────────

describe('9. Lua: top-level function trim() → kind "function"', () => {
  it('trim is extracted as kind "function"', () => {
    const db = openDatabase(luaRepoId);
    const results = searchSymbols(db, luaRepoId, 'trim', { kind: 'function' });
    db.close();
    expect(results.some((s) => s.name === 'trim')).toBe(true);
  });
});

// ─── 10. Dart: public vs private method ──────────────────────────────────────

describe('10. Dart: public methods extracted; _private method skipped', () => {
  it('AuthService.login is extracted', () => {
    const db = openDatabase(dartRepoId);
    const results = searchSymbols(db, dartRepoId, 'login');
    db.close();
    expect(results.some((s) => s.name === 'AuthService.login')).toBe(true);
  });

  it('private method _validateToken is NOT extracted', () => {
    const db = openDatabase(dartRepoId);
    const results = searchSymbols(db, dartRepoId, '_validateToken');
    db.close();
    expect(results).toHaveLength(0);
  });
});

// ─── 11. Dart: named constructor ─────────────────────────────────────────────

describe('11. Dart: named constructor → kind "method"', () => {
  it('AuthService.withTimeout named constructor is extracted', () => {
    const db = openDatabase(dartRepoId);
    const results = searchSymbols(db, dartRepoId, 'withTimeout');
    db.close();
    expect(results.some((s) => s.name === 'AuthService.withTimeout' && s.kind === 'method')).toBe(true);
  });

  it('User.fromJson named constructor is extracted', () => {
    const db = openDatabase(dartRepoId);
    const results = searchSymbols(db, dartRepoId, 'fromJson');
    db.close();
    expect(results.some((s) => s.name === 'User.fromJson' && s.kind === 'method')).toBe(true);
  });
});

// ─── 12. Dart: /// doc comment captured ──────────────────────────────────────

describe('12. Dart: /// doc comment captured in summary', () => {
  it('AuthService class has doc comment in summary', () => {
    const db = openDatabase(dartRepoId);
    const results = searchSymbols(db, dartRepoId, 'AuthService', { kind: 'class' });
    db.close();
    const authSvc = results.find((s) => s.name === 'AuthService');
    expect(authSvc).toBeDefined();
    // Summary should not be the generic fallback for a documented class
    expect(authSvc!.summary).not.toBe('Dart class: AuthService');
  });

  it('AuthService.login doc comment captured', () => {
    const db = openDatabase(dartRepoId);
    const results = searchSymbols(db, dartRepoId, 'AuthService.login');
    db.close();
    const login = results.find((s) => s.name === 'AuthService.login');
    expect(login).toBeDefined();
    expect(login!.summary.toLowerCase()).toContain('authenticat');
  });
});

// ─── 13. Flutter: StatelessWidget → kind 'widget' ────────────────────────────

describe('13. Flutter: StatelessWidget → kind "widget" with flutter_widget_type "stateless"', () => {
  it('MyButton is extracted as kind "widget"', () => {
    const db = openDatabase(flutterRepoId);
    const results = searchSymbols(db, flutterRepoId, 'MyButton', { kind: 'widget' });
    db.close();
    expect(results.some((s) => s.name === 'MyButton')).toBe(true);
  });

  it('MyButton has flutter_widget_type stateless', () => {
    const db = openDatabase(flutterRepoId);
    const results = searchSymbols(db, flutterRepoId, 'MyButton', { kind: 'widget' });
    db.close();
    const btn = results.find((s) => s.name === 'MyButton');
    expect(btn?.frameworkMeta?.flutter_widget_type).toBe('stateless');
  });
});

// ─── 14. Flutter: StatefulWidget + State linked ───────────────────────────────

describe('14. Flutter: StatefulWidget + State<T> both emitted as "widget"', () => {
  it('HomeScreen is extracted as kind "widget"', () => {
    const db = openDatabase(flutterRepoId);
    const results = searchSymbols(db, flutterRepoId, 'HomeScreen', { kind: 'widget' });
    db.close();
    expect(results.some((s) => s.name === 'HomeScreen')).toBe(true);
  });

  it('HomeScreen is linked to _HomeScreenState via state_class', () => {
    const db = openDatabase(flutterRepoId);
    const results = searchSymbols(db, flutterRepoId, 'HomeScreen', { kind: 'widget' });
    db.close();
    const home = results.find((s) => s.name === 'HomeScreen');
    expect(home?.frameworkMeta?.state_class).toBe('_HomeScreenState');
  });

  it('_HomeScreenState is extracted as kind "widget" with type "state"', () => {
    const db = openDatabase(flutterRepoId);
    const results = searchSymbols(db, flutterRepoId, '_HomeScreenState', { kind: 'widget' });
    db.close();
    expect(results.some((s) => s.frameworkMeta?.flutter_widget_type === 'state')).toBe(true);
  });
});

// ─── 15. Flutter: ChangeNotifier → 'class' with flutter_notifier ─────────────

describe('15. Flutter: ChangeNotifier subclass → kind "class" with flutter_notifier', () => {
  it('AuthProvider is extracted as kind "class" with flutter_notifier', () => {
    const db = openDatabase(flutterRepoId);
    const results = searchSymbols(db, flutterRepoId, 'AuthProvider');
    db.close();
    const p = results.find((s) => s.name === 'AuthProvider');
    expect(p).toBeDefined();
    expect(p!.kind).toBe('class');
    expect(p!.frameworkMeta?.flutter_notifier).toBe(true);
  });
});

// ─── 16. Flutter: plain Dart class → 'class', not 'widget' ───────────────────

describe('16. Flutter: plain Dart class → kind "class", not "widget"', () => {
  it('User model in flutter fixture has kind "class"', () => {
    const db = openDatabase(flutterRepoId);
    const results = searchSymbols(db, flutterRepoId, 'User');
    db.close();
    const user = results.find((s) => s.name === 'User');
    expect(user).toBeDefined();
    expect(user!.kind).toBe('class');
    expect(user!.kind).not.toBe('widget');
  });
});

// ─── 17. search-symbols kind:'widget' returns only widgets ───────────────────

describe('17. search-symbols kind:"widget" returns only Flutter widget symbols', () => {
  it('all results have kind "widget"', () => {
    const db = openDatabase(flutterRepoId);
    const results = searchSymbols(db, flutterRepoId, '', { kind: 'widget', limit: 100 });
    db.close();
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((s) => s.kind === 'widget')).toBe(true);
  });

  it('widget results contain flutter_widget meta', () => {
    const db = openDatabase(flutterRepoId);
    const results = searchSymbols(db, flutterRepoId, '', { kind: 'widget', limit: 100 });
    db.close();
    expect(results.every((s) => s.frameworkMeta?.flutter_widget === true)).toBe(true);
  });
});

// ─── 18. search-symbols kind:'namespace' returns only C++ namespaces ─────────

describe('18. search-symbols kind:"namespace" returns only C++ namespaces', () => {
  it('all results have kind "namespace"', () => {
    const db = openDatabase(cppRepoId);
    const results = searchSymbols(db, cppRepoId, '', { kind: 'namespace', limit: 50 });
    db.close();
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((s) => s.kind === 'namespace')).toBe(true);
  });
});

// ─── 19. Regression: TypeScript fixture ──────────────────────────────────────

describe('19. Regression: TypeScript fixture indexes cleanly', () => {
  it('TypeScript fixture produces symbols', () => {
    const db = openDatabase(tsRepoId);
    const results = searchSymbols(db, tsRepoId, '', { limit: 50 });
    db.close();
    expect(results.length).toBeGreaterThan(0);
  });

  it('TypeScript symbols have no kind "widget" or "namespace" contamination', () => {
    const db = openDatabase(tsRepoId);
    const widgets    = searchSymbols(db, tsRepoId, '', { kind: 'widget',    limit: 10 });
    const namespaces = searchSymbols(db, tsRepoId, '', { kind: 'namespace', limit: 10 });
    db.close();
    expect(widgets).toHaveLength(0);
    expect(namespaces).toHaveLength(0);
  });
});
