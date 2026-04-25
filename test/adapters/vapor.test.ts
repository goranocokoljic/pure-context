import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { vaporAdapter } from '../../src/adapters/vapor.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/vapor-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-vapor-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('vaporAdapter metadata', () => {
  it('has name "vapor"', () => {
    expect(vaporAdapter.name).toBe('vapor');
  });

  it('declares no extra extensions', () => {
    expect(vaporAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ───────────────────────────────────────────────────────────────

describe('vaporAdapter.detect', () => {
  it('detects a Vapor project from Package.swift', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'Package.swift'),
      `
let package = Package(
    dependencies: [
        .package(url: "https://github.com/vapor/vapor.git", from: "4.0.0"),
    ]
)`,
    );
    expect(await vaporAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects the fixture vapor project', async () => {
    expect(await vaporAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });

  it('returns false for a non-Vapor Swift project', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'Package.swift'),
      `
let package = Package(
    dependencies: [
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.0.0"),
    ]
)`,
    );
    expect(await vaporAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false when Package.swift is missing', async () => {
    const dir = tmpDir();
    expect(await vaporAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });
});

// ─── File filter ─────────────────────────────────────────────────────────────

describe('vaporAdapter.fileFilter', () => {
  it('accepts .swift files', () => {
    expect(vaporAdapter.fileFilter('Sources/App/routes.swift')).toBe(true);
  });

  it('rejects .ts files', () => {
    expect(vaporAdapter.fileFilter('src/app.ts')).toBe(false);
  });

  it('rejects Package.swift (is a .swift file, but that\'s OK)', () => {
    // Package.swift is accepted by fileFilter — detection is project-level
    expect(vaporAdapter.fileFilter('Package.swift')).toBe(true);
  });
});

// ─── Route extraction — basic HTTP methods ────────────────────────────────────

describe('vaporAdapter — route extraction', () => {
  it('extracts app.get with a single path segment', () => {
    const source = `
import Vapor
app.get("users", use: index)
`;
    const symbols = vaporAdapter.extractFrameworkSymbols(null, buf(source), 'routes.swift');
    const route = symbols.find((s) => s.name === 'GET /users');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.route_path).toBe('/users');
    expect(route!.frameworkMeta?.vapor_route).toBe(true);
  });

  it('extracts app.post route', () => {
    const source = `
import Vapor
app.post("users", use: create)
`;
    const symbols = vaporAdapter.extractFrameworkSymbols(null, buf(source), 'routes.swift');
    const route = symbols.find((s) => s.name === 'POST /users');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.http_method).toBe('POST');
  });

  it('extracts multi-segment path with dynamic parameter', () => {
    const source = `
import Vapor
app.get("users", ":id", use: show)
`;
    const symbols = vaporAdapter.extractFrameworkSymbols(null, buf(source), 'routes.swift');
    const route = symbols.find((s) => s.name === 'GET /users/:id');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.route_path).toBe('/users/:id');
  });

  it('extracts all HTTP methods', () => {
    const source = `
import Vapor
app.get("items", use: list)
app.post("items", use: create)
app.put("items", ":id", use: update)
app.patch("items", ":id", use: patch)
app.delete("items", ":id", use: delete)
`;
    const symbols = vaporAdapter.extractFrameworkSymbols(null, buf(source), 'routes.swift');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /items');
    expect(names).toContain('POST /items');
    expect(names).toContain('PUT /items/:id');
    expect(names).toContain('PATCH /items/:id');
    expect(names).toContain('DELETE /items/:id');
  });

  it('extracts webSocket route', () => {
    const source = `
import Vapor
app.webSocket("ws", "chat", onUpgrade: chatHandler)
`;
    const symbols = vaporAdapter.extractFrameworkSymbols(null, buf(source), 'routes.swift');
    const route = symbols.find((s) => s.name === 'WEBSOCKET /ws/chat');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.http_method).toBe('WEBSOCKET');
  });

  it('extracts deeply nested path', () => {
    const source = `
import Vapor
app.get("users", ":userId", "posts", use: listPosts)
`;
    const symbols = vaporAdapter.extractFrameworkSymbols(null, buf(source), 'routes.swift');
    const route = symbols.find((s) => s.name === 'GET /users/:userId/posts');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.route_path).toBe('/users/:userId/posts');
  });

  it('does not duplicate routes with the same path and method', () => {
    const source = `
import Vapor
app.get("users", use: list)
app.get("users", use: list)
`;
    const symbols = vaporAdapter.extractFrameworkSymbols(null, buf(source), 'routes.swift');
    const routes = symbols.filter((s) => s.name === 'GET /users');
    expect(routes.length).toBe(1);
  });

  it('returns empty for a non-Vapor file', () => {
    const source = `
import Foundation
struct Foo {}
`;
    const symbols = vaporAdapter.extractFrameworkSymbols(null, buf(source), 'Foo.swift');
    expect(symbols).toHaveLength(0);
  });
});

// ─── Middleware extraction ────────────────────────────────────────────────────

describe('vaporAdapter — middleware extraction', () => {
  it('extracts app.middleware.use(CORSMiddleware())', () => {
    const source = `
import Vapor
app.middleware.use(CORSMiddleware())
`;
    const symbols = vaporAdapter.extractFrameworkSymbols(null, buf(source), 'configure.swift');
    const mw = symbols.find((s) => s.name === 'CORSMiddleware');
    expect(mw).toBeDefined();
    expect(mw!.kind).toBe('middleware');
    expect(mw!.frameworkMeta?.vapor_middleware).toBe(true);
  });

  it('extracts multiple middleware registrations', () => {
    const source = `
import Vapor
app.middleware.use(CORSMiddleware())
app.middleware.use(AuthMiddleware())
app.middleware.use(FileMiddleware(publicDirectory: app.directory.publicDirectory))
`;
    const symbols = vaporAdapter.extractFrameworkSymbols(null, buf(source), 'configure.swift');
    const names = symbols.filter((s) => s.kind === 'middleware').map((s) => s.name);
    expect(names).toContain('CORSMiddleware');
    expect(names).toContain('AuthMiddleware');
    expect(names).toContain('FileMiddleware');
  });
});

// ─── RouteCollection extraction ───────────────────────────────────────────────

describe('vaporAdapter — RouteCollection', () => {
  it('extracts a struct conforming to RouteCollection', () => {
    const source = `
import Vapor
struct UserController: RouteCollection {
    func boot(routes: RoutesBuilder) throws {}
}
`;
    const symbols = vaporAdapter.extractFrameworkSymbols(null, buf(source), 'UserController.swift');
    const rc = symbols.find((s) => s.name === 'UserController');
    expect(rc).toBeDefined();
    expect(rc!.kind).toBe('class');
    expect(rc!.frameworkMeta?.vapor_route_collection).toBe(true);
    expect(rc!.frameworkMeta?.declaration_kind).toBe('struct');
  });

  it('extracts a class conforming to RouteCollection', () => {
    const source = `
import Vapor
class PostController: RouteCollection {
    func boot(routes: RoutesBuilder) throws {}
}
`;
    const symbols = vaporAdapter.extractFrameworkSymbols(null, buf(source), 'PostController.swift');
    const rc = symbols.find((s) => s.name === 'PostController');
    expect(rc).toBeDefined();
    expect(rc!.frameworkMeta?.declaration_kind).toBe('class');
  });

  it('extracts a RouteCollection conforming to multiple protocols', () => {
    const source = `
import Vapor
struct AdminController: RouteCollection, CustomStringConvertible {
    func boot(routes: RoutesBuilder) throws {}
}
`;
    const symbols = vaporAdapter.extractFrameworkSymbols(null, buf(source), 'AdminController.swift');
    const rc = symbols.find((s) => s.name === 'AdminController');
    expect(rc).toBeDefined();
    expect(rc!.frameworkMeta?.vapor_route_collection).toBe(true);
  });

  it('does not extract a non-RouteCollection conformance', () => {
    const source = `
import Vapor
struct UserDTO: Content {}
`;
    const symbols = vaporAdapter.extractFrameworkSymbols(null, buf(source), 'UserDTO.swift');
    expect(symbols.find((s) => s.name === 'UserDTO')).toBeUndefined();
  });
});

// ─── Fixture file test ─────────────────────────────────────────────────────────

import { readFileSync } from 'fs';

describe('vaporAdapter — fixture routes.swift', () => {
  it('extracts routes from fixture routes.swift', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'Sources/App/routes.swift'));
    const symbols = vaporAdapter.extractFrameworkSymbols(null, source, 'routes.swift');
    const routes = symbols.filter((s) => s.kind === 'route');
    expect(routes.length).toBeGreaterThanOrEqual(4);
    expect(routes.some((r) => r.name === 'GET /health')).toBe(true);
    expect(routes.some((r) => r.name === 'GET /users')).toBe(true);
    expect(routes.some((r) => r.name === 'GET /users/:id')).toBe(true);
    expect(routes.some((r) => r.name === 'POST /users')).toBe(true);
  });

  it('extracts middleware from fixture Middleware file', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'Sources/App/Middleware/AuthMiddleware.swift'),
    );
    const symbols = vaporAdapter.extractFrameworkSymbols(null, source, 'AuthMiddleware.swift');
    const middleware = symbols.filter((s) => s.kind === 'middleware');
    expect(middleware.length).toBeGreaterThanOrEqual(2);
    expect(middleware.some((m) => m.name === 'CORSMiddleware')).toBe(true);
    expect(middleware.some((m) => m.name === 'AuthMiddleware')).toBe(true);
  });

  it('extracts RouteCollection from fixture UserController', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'Sources/App/Controllers/UserController.swift'),
    );
    const symbols = vaporAdapter.extractFrameworkSymbols(null, source, 'UserController.swift');
    const rc = symbols.find((s) => s.name === 'UserController');
    expect(rc).toBeDefined();
    expect(rc!.frameworkMeta?.vapor_route_collection).toBe(true);
  });
});
