/**
 * Phase 7 integration tests — Task 69.
 *
 * Validates the full Phase 7 pipeline end-to-end for Swift handler
 * and Vapor adapter.
 *
 *  1. Swift: `public class AuthService` extracted, `private func helper()` skipped
 *  2. Swift: `public struct User: Encodable` → kind 'class' with struct in signature
 *  3. Swift: `public protocol Authenticatable` → kind 'interface'
 *  4. Swift: `public actor TokenStore` → kind 'class' with `swift_actor: true`
 *  5. Swift: `extension String` → kind 'class' with `swift_extension: true`
 *  6. Swift: `///` triple-slash doc comment captured
 *  7. Swift: `async throws` included in function signature
 *  8. Vapor: `app.get("users", ":id", use: handler)` → route with path `/users/:id`
 *  9. Vapor: `app.post("users", use: create)` → route with http_method `POST`
 *  10. Vapor: `RouteCollection` conformance → class with `vapor_route_collection: true`
 *  11. Vapor: `app.middleware.use(...)` → middleware symbol
 *  12. Vapor: WebSocket route → http_method `WEBSOCKET`
 *  13. Full suite regression: TypeScript fixture still green
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { swiftHandler } from '../../src/handlers/swift.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { vaporAdapter } from '../../src/adapters/vapor.js';
import { _resetForTesting as resetAdapters } from '../../src/adapters/adapter-registry.js';

// ─── Fixture paths ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const SWIFT_FIXTURE = resolve(__dirname, '../fixtures/swift-project');
const VAPOR_FIXTURE = resolve(__dirname, '../fixtures/vapor-project');
const TS_FIXTURE    = resolve(__dirname, '../fixtures/basic-ts-project');

// ─── Shared state ──────────────────────────────────────────────────────────────

let swiftRepoId: string;
let vaporRepoId: string;
let tsRepoId:    string;

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  resetAdapters();

  registerHandler(typescriptHandler);
  registerHandler(swiftHandler);

  await initParser();

  const [swiftResult, vaporResult, tsResult] = await Promise.all([
    indexFolder(SWIFT_FIXTURE),
    indexFolder(VAPOR_FIXTURE, { adapters: [vaporAdapter] }),
    indexFolder(TS_FIXTURE),
  ]);

  swiftRepoId = swiftResult.repoId;
  vaporRepoId = vaporResult.repoId;
  tsRepoId    = tsResult.repoId;
}, 60_000);

afterAll(() => {
  for (const id of [swiftRepoId, vaporRepoId, tsRepoId]) {
    if (id) deleteIndex(id);
  }
});

// ─── 1. Swift: public class extracted, private func skipped ───────────────────

describe('1. Swift: public class AuthService extracted, private func skipped', () => {
  it('AuthService is extracted as kind "class"', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'AuthService', { kind: 'class' });
    db.close();
    expect(results.some((s) => s.name === 'AuthService')).toBe(true);
  });

  it('public method AuthService.login is extracted', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'login', { kind: 'method' });
    db.close();
    expect(results.some((s) => s.name === 'AuthService.login')).toBe(true);
  });

  it('private method hashPassword is NOT extracted', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'hashPassword');
    db.close();
    expect(results).toHaveLength(0);
  });

  it('AuthService.init is extracted', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'AuthService.init');
    db.close();
    expect(results.some((s) => s.name === 'AuthService.init' && s.kind === 'method')).toBe(true);
  });

  it('AuthService.deinit is extracted', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'AuthService.deinit');
    db.close();
    expect(results.some((s) => s.name === 'AuthService.deinit' && s.kind === 'method')).toBe(true);
  });
});

// ─── 2. Swift: struct → kind 'class' with struct in signature ─────────────────

describe('2. Swift: public struct User: Encodable → kind "class" with struct signature', () => {
  it('User is extracted as kind "class"', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'User', { kind: 'class' });
    db.close();
    expect(results.some((s) => s.name === 'User')).toBe(true);
  });

  it('User signature contains "struct"', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'User', { kind: 'class' });
    db.close();
    const user = results.find((s) => s.name === 'User');
    expect(user).toBeDefined();
    expect(user!.signature.toLowerCase()).toContain('struct');
  });

  it('User signature contains protocol conformance', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'User', { kind: 'class' });
    db.close();
    const user = results.find((s) => s.name === 'User');
    expect(user).toBeDefined();
    expect(user!.signature).toContain('Encodable');
  });
});

// ─── 3. Swift: protocol → kind 'interface' ────────────────────────────────────

describe('3. Swift: public protocol Authenticatable → kind "interface"', () => {
  it('Authenticatable is extracted as kind "interface"', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'Authenticatable', { kind: 'interface' });
    db.close();
    expect(results.some((s) => s.name === 'Authenticatable')).toBe(true);
  });

  it('Authenticatable signature contains "protocol"', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'Authenticatable', { kind: 'interface' });
    db.close();
    const proto = results.find((s) => s.name === 'Authenticatable');
    expect(proto).toBeDefined();
    expect(proto!.signature.toLowerCase()).toContain('protocol');
  });

  it('protocol method authenticate is extracted', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'authenticate');
    db.close();
    expect(results.some((s) => s.name === 'Authenticatable.authenticate' && s.kind === 'method')).toBe(true);
  });

  it('protocol property username is extracted as const', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'username');
    db.close();
    expect(results.some((s) => s.name === 'Authenticatable.username' && s.kind === 'const')).toBe(true);
  });
});

// ─── 4. Swift: actor → kind 'class' with swift_actor ──────────────────────────

describe('4. Swift: public actor TokenStore → kind "class" with swift_actor: true', () => {
  it('TokenStore is extracted as kind "class"', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'TokenStore', { kind: 'class' });
    db.close();
    expect(results.some((s) => s.name === 'TokenStore')).toBe(true);
  });

  it('TokenStore has swift_actor: true in frameworkMeta', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'TokenStore', { kind: 'class' });
    db.close();
    const actor = results.find((s) => s.name === 'TokenStore');
    expect(actor).toBeDefined();
    expect(actor!.frameworkMeta?.swift_actor).toBe(true);
  });

  it('TokenStore signature contains "actor"', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'TokenStore', { kind: 'class' });
    db.close();
    const actor = results.find((s) => s.name === 'TokenStore');
    expect(actor).toBeDefined();
    expect(actor!.signature.toLowerCase()).toContain('actor');
  });
});

// ─── 5. Swift: extension → kind 'class' with swift_extension ──────────────────

describe('5. Swift: extension String → kind "class" with swift_extension: true', () => {
  it('String extension is extracted as kind "class"', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'String', { kind: 'class' });
    db.close();
    expect(results.some((s) => s.name === 'String')).toBe(true);
  });

  it('String has swift_extension: true in frameworkMeta', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'String', { kind: 'class' });
    db.close();
    const ext = results.find((s) => s.name === 'String');
    expect(ext).toBeDefined();
    expect(ext!.frameworkMeta?.swift_extension).toBe(true);
  });

  it('String extension method sanitised is extracted', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'sanitised');
    db.close();
    expect(results.some((s) => s.name === 'String.sanitised' && s.kind === 'method')).toBe(true);
  });
});

// ─── 6. Swift: /// doc comment captured ───────────────────────────────────────

describe('6. Swift: /// triple-slash doc comment captured', () => {
  it('AuthService class has doc comment in summary', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'AuthService', { kind: 'class' });
    db.close();
    const authSvc = results.find((s) => s.name === 'AuthService');
    expect(authSvc).toBeDefined();
    expect(authSvc!.summary.toLowerCase()).toContain('authentication');
  });

  it('TokenStore actor has doc comment in summary', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'TokenStore', { kind: 'class' });
    db.close();
    const ts = results.find((s) => s.name === 'TokenStore');
    expect(ts).toBeDefined();
    expect(ts!.summary.toLowerCase()).toContain('thread-safe');
  });
});

// ─── 7. Swift: async throws in signature ──────────────────────────────────────

describe('7. Swift: async throws included in function signature', () => {
  it('AuthService.login signature contains async', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'AuthService.login');
    db.close();
    const login = results.find((s) => s.name === 'AuthService.login');
    expect(login).toBeDefined();
    expect(login!.signature.toLowerCase()).toContain('async');
  });

  it('AuthService.login signature contains throws', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'AuthService.login');
    db.close();
    const login = results.find((s) => s.name === 'AuthService.login');
    expect(login).toBeDefined();
    expect(login!.signature.toLowerCase()).toContain('throws');
  });
});

// ─── 8. Vapor: route with dynamic path component ──────────────────────────────

describe('8. Vapor: app.get("users", ":id", use: handler) → route /users/:id', () => {
  it('GET /users/:id route is extracted', () => {
    const db = openDatabase(vaporRepoId);
    const results = searchSymbols(db, vaporRepoId, 'GET /users/:id', { kind: 'route' });
    db.close();
    expect(results.some((s) => s.name === 'GET /users/:id')).toBe(true);
  });

  it('route has http_method GET', () => {
    const db = openDatabase(vaporRepoId);
    const results = searchSymbols(db, vaporRepoId, 'GET /users/:id', { kind: 'route' });
    db.close();
    const route = results.find((s) => s.name === 'GET /users/:id');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.http_method).toBe('GET');
  });

  it('route has route_path /users/:id', () => {
    const db = openDatabase(vaporRepoId);
    const results = searchSymbols(db, vaporRepoId, 'GET /users/:id', { kind: 'route' });
    db.close();
    const route = results.find((s) => s.name === 'GET /users/:id');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.route_path).toBe('/users/:id');
  });

  it('route has vapor_route: true', () => {
    const db = openDatabase(vaporRepoId);
    const results = searchSymbols(db, vaporRepoId, 'GET /users/:id', { kind: 'route' });
    db.close();
    const route = results.find((s) => s.name === 'GET /users/:id');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.vapor_route).toBe(true);
  });
});

// ─── 9. Vapor: POST route ──────────────────────────────────────────────────────

describe('9. Vapor: app.post("users", use: create) → route with http_method POST', () => {
  it('POST /users route is extracted', () => {
    const db = openDatabase(vaporRepoId);
    const results = searchSymbols(db, vaporRepoId, 'POST /users', { kind: 'route' });
    db.close();
    expect(results.some((s) => s.name === 'POST /users')).toBe(true);
  });

  it('route has http_method POST', () => {
    const db = openDatabase(vaporRepoId);
    const results = searchSymbols(db, vaporRepoId, 'POST /users', { kind: 'route' });
    db.close();
    const route = results.find((s) => s.name === 'POST /users');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.http_method).toBe('POST');
  });
});

// ─── 10. Vapor: RouteCollection ─────────────────────────────────────────────────

describe('10. Vapor: RouteCollection conformance → class with vapor_route_collection', () => {
  it('UserController is extracted as kind "class"', () => {
    const db = openDatabase(vaporRepoId);
    const results = searchSymbols(db, vaporRepoId, 'UserController', { kind: 'class' });
    db.close();
    expect(results.some((s) => s.name === 'UserController')).toBe(true);
  });

  it('UserController has vapor_route_collection: true', () => {
    const db = openDatabase(vaporRepoId);
    const results = searchSymbols(db, vaporRepoId, 'UserController', { kind: 'class' });
    db.close();
    const ctrl = results.find((s) => s.name === 'UserController');
    expect(ctrl).toBeDefined();
    expect(ctrl!.frameworkMeta?.vapor_route_collection).toBe(true);
  });
});

// ─── 11. Vapor: middleware ──────────────────────────────────────────────────────

describe('11. Vapor: app.middleware.use(...) → middleware symbol', () => {
  it('CORSMiddleware is extracted as kind "middleware"', () => {
    const db = openDatabase(vaporRepoId);
    const results = searchSymbols(db, vaporRepoId, 'CORSMiddleware', { kind: 'middleware' });
    db.close();
    expect(results.some((s) => s.name === 'CORSMiddleware')).toBe(true);
  });

  it('AuthMiddleware is extracted as kind "middleware"', () => {
    const db = openDatabase(vaporRepoId);
    const results = searchSymbols(db, vaporRepoId, 'AuthMiddleware', { kind: 'middleware' });
    db.close();
    expect(results.some((s) => s.name === 'AuthMiddleware')).toBe(true);
  });

  it('middleware has vapor_middleware: true', () => {
    const db = openDatabase(vaporRepoId);
    const results = searchSymbols(db, vaporRepoId, 'CORSMiddleware', { kind: 'middleware' });
    db.close();
    const mw = results.find((s) => s.name === 'CORSMiddleware');
    expect(mw).toBeDefined();
    expect(mw!.frameworkMeta?.vapor_middleware).toBe(true);
  });
});

// ─── 12. Vapor: WebSocket route ─────────────────────────────────────────────────

describe('12. Vapor: WebSocket route → http_method WEBSOCKET', () => {
  it('WEBSOCKET /ws/chat route is extracted', () => {
    const db = openDatabase(vaporRepoId);
    const results = searchSymbols(db, vaporRepoId, 'WEBSOCKET', { kind: 'route' });
    db.close();
    expect(results.some((s) => s.name.includes('WEBSOCKET') && s.name.includes('/ws/chat'))).toBe(true);
  });

  it('WebSocket route has http_method WEBSOCKET', () => {
    const db = openDatabase(vaporRepoId);
    const results = searchSymbols(db, vaporRepoId, 'WEBSOCKET', { kind: 'route' });
    db.close();
    const wsRoute = results.find((s) => s.frameworkMeta?.http_method === 'WEBSOCKET');
    expect(wsRoute).toBeDefined();
  });
});

// ─── 13. Regression: TypeScript fixture ────────────────────────────────────────

describe('13. Regression: TypeScript fixture indexes cleanly', () => {
  it('TypeScript fixture produces symbols', () => {
    const db = openDatabase(tsRepoId);
    const results = searchSymbols(db, tsRepoId, '', { limit: 50 });
    db.close();
    expect(results.length).toBeGreaterThan(0);
  });

  it('TypeScript symbols have no swift_actor or vapor_route contamination', () => {
    const db = openDatabase(tsRepoId);
    const all = searchSymbols(db, tsRepoId, '', { limit: 100 });
    db.close();
    const contaminated = all.filter((s) =>
      s.frameworkMeta?.swift_actor ||
      s.frameworkMeta?.swift_extension ||
      s.frameworkMeta?.vapor_route ||
      s.frameworkMeta?.vapor_middleware
    );
    expect(contaminated).toHaveLength(0);
  });
});

// ─── 14. Swift enum → kind 'enum' ──────────────────────────────────────────────

describe('14. Swift: public enum Role → kind "enum"', () => {
  it('Role is extracted as kind "enum"', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'Role', { kind: 'enum' });
    db.close();
    expect(results.some((s) => s.name === 'Role')).toBe(true);
  });

  it('AuthError is extracted as kind "enum"', () => {
    const db = openDatabase(swiftRepoId);
    const results = searchSymbols(db, swiftRepoId, 'AuthError', { kind: 'enum' });
    db.close();
    expect(results.some((s) => s.name === 'AuthError')).toBe(true);
  });
});

// ─── 15. Swift: multiple routes extracted from same file ───────────────────────

describe('15. Vapor: multiple routes extracted from same file', () => {
  it('health route is extracted', () => {
    const db = openDatabase(vaporRepoId);
    const results = searchSymbols(db, vaporRepoId, 'GET /health', { kind: 'route' });
    db.close();
    expect(results.some((s) => s.name === 'GET /health')).toBe(true);
  });

  it('DELETE route is extracted', () => {
    const db = openDatabase(vaporRepoId);
    const results = searchSymbols(db, vaporRepoId, 'DELETE', { kind: 'route' });
    db.close();
    expect(results.some((s) => s.frameworkMeta?.http_method === 'DELETE')).toBe(true);
  });

  it('PUT route is extracted', () => {
    const db = openDatabase(vaporRepoId);
    const results = searchSymbols(db, vaporRepoId, 'PUT', { kind: 'route' });
    db.close();
    expect(results.some((s) => s.frameworkMeta?.http_method === 'PUT')).toBe(true);
  });
});

// ─── 16. Swift: nested path route ──────────────────────────────────────────────

describe('16. Vapor: nested path /users/:userId/posts', () => {
  it('nested route is extracted', () => {
    const db = openDatabase(vaporRepoId);
    const results = searchSymbols(db, vaporRepoId, '/users/:userId/posts', { kind: 'route' });
    db.close();
    expect(results.some((s) => s.frameworkMeta?.route_path === '/users/:userId/posts')).toBe(true);
  });
});
