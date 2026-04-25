import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { actixWebAdapter } from '../../src/adapters/actix-web.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/actix-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-actix-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('actixWebAdapter metadata', () => {
  it('has name "actix-web"', () => {
    expect(actixWebAdapter.name).toBe('actix-web');
  });

  it('declares no extra extensions', () => {
    expect(actixWebAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('actixWebAdapter.detect', () => {
  it('detects actix-web in Cargo.toml (simple version string)', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'Cargo.toml'),
      '[dependencies]\nactix-web = "4"\n',
    );
    expect(await actixWebAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects actix-web in Cargo.toml (table dependency)', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'Cargo.toml'),
      '[dependencies]\nactix-web = { version = "4", features = ["macros"] }\n',
    );
    expect(await actixWebAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when actix-web is absent', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'Cargo.toml'),
      '[dependencies]\naxum = "0.7"\n',
    );
    expect(await actixWebAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false without Cargo.toml', async () => {
    const dir = tmpDir();
    expect(await actixWebAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture actix project', async () => {
    expect(await actixWebAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('actixWebAdapter.fileFilter', () => {
  it('accepts .rs files', () => {
    expect(actixWebAdapter.fileFilter('main.rs')).toBe(true);
    expect(actixWebAdapter.fileFilter('src/handlers.rs')).toBe(true);
  });

  it('rejects non-Rust files', () => {
    expect(actixWebAdapter.fileFilter('Cargo.toml')).toBe(false);
    expect(actixWebAdapter.fileFilter('main.go')).toBe(false);
  });
});

// ─── Attribute macro route extraction ────────────────────────────────────────

describe('actixWebAdapter — #[get] macro routes', () => {
  it('extracts #[get] route', () => {
    const source = `
use actix_web::{get, Responder};
#[get("/health")]
async fn health_check() -> impl Responder { "ok" }
`;
    const symbols = actixWebAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const route = symbols.find((s) => s.name === 'GET /health');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.route_path).toBe('/health');
    expect(route!.frameworkMeta?.actix_route).toBe(true);
  });

  it('extracts #[post] route', () => {
    const source = `
use actix_web::post;
#[post("/users")]
async fn create_user() -> impl actix_web::Responder { "" }
`;
    const symbols = actixWebAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'POST /users')).toBeDefined();
  });

  it('extracts all HTTP method macros', () => {
    const source = `
use actix_web::{get, post, put, patch, delete, head, options};
#[get("/a")] async fn a() {}
#[post("/b")] async fn b() {}
#[put("/c")] async fn c() {}
#[patch("/d")] async fn d() {}
#[delete("/e")] async fn e() {}
#[head("/f")] async fn f() {}
#[options("/g")] async fn g() {}
`;
    const symbols = actixWebAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /a');
    expect(names).toContain('POST /b');
    expect(names).toContain('PUT /c');
    expect(names).toContain('PATCH /d');
    expect(names).toContain('DELETE /e');
    expect(names).toContain('HEAD /f');
    expect(names).toContain('OPTIONS /g');
  });

  it('handles fully qualified attribute: #[actix_web::get]', () => {
    const source = `
#[actix_web::get("/status")]
async fn status() -> impl actix_web::Responder { "" }
`;
    const symbols = actixWebAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'GET /status')).toBeDefined();
  });

  it('preserves {param} in route path', () => {
    const source = `
use actix_web::get;
#[get("/users/{id}")]
async fn get_user(path: web::Path<u64>) -> impl actix_web::Responder { "" }
`;
    const symbols = actixWebAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const route = symbols.find((s) => s.name === 'GET /users/{id}');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.route_path).toBe('/users/{id}');
  });
});

// ─── Programmatic route extraction ───────────────────────────────────────────

describe('actixWebAdapter — web::resource() programmatic routes', () => {
  it('extracts GET from web::resource().route(web::get())', () => {
    const source = `
use actix_web::{web, App};
App::new()
    .service(
        web::resource("/items")
            .route(web::get().to(list_items))
    );
`;
    const symbols = actixWebAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'GET /items')).toBeDefined();
  });

  it('extracts multiple methods from one web::resource()', () => {
    const source = `
use actix_web::{web, App};
App::new()
    .service(
        web::resource("/items")
            .route(web::get().to(list_items))
            .route(web::post().to(create_item))
    );
`;
    const symbols = actixWebAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'GET /items')).toBeDefined();
    expect(symbols.find((s) => s.name === 'POST /items')).toBeDefined();
  });

  it('preserves {param} in resource path', () => {
    const source = `
use actix_web::{web, App};
App::new()
    .service(
        web::resource("/orders/{order_id}/items/{item_id}")
            .route(web::get().to(get_item))
    );
`;
    const symbols = actixWebAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(
      symbols.find((s) => s.name === 'GET /orders/{order_id}/items/{item_id}'),
    ).toBeDefined();
  });
});

// ─── Scope extraction ─────────────────────────────────────────────────────────

describe('actixWebAdapter — web::scope() prefix', () => {
  it('emits a SCOPE route symbol for web::scope()', () => {
    const source = `
use actix_web::{web, App};
App::new()
    .service(web::scope("/api/v2").service(inner));
`;
    const symbols = actixWebAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const scope = symbols.find((s) => s.name === 'SCOPE /api/v2');
    expect(scope).toBeDefined();
    expect(scope!.kind).toBe('route');
    expect(scope!.frameworkMeta?.route_path).toBe('/api/v2');
    expect(scope!.frameworkMeta?.actix_scope).toBe(true);
  });

  it('emits separate SCOPE symbols for multiple scopes', () => {
    const source = `
use actix_web::{web, App};
App::new()
    .service(web::scope("/v1").service(a))
    .service(web::scope("/v2").service(b));
`;
    const symbols = actixWebAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'SCOPE /v1')).toBeDefined();
    expect(symbols.find((s) => s.name === 'SCOPE /v2')).toBeDefined();
  });
});

// ─── Middleware (.wrap) extraction ────────────────────────────────────────────

describe('actixWebAdapter — .wrap() middleware', () => {
  it('emits a middleware symbol for .wrap()', () => {
    const source = `
use actix_web::{App, middleware};
App::new()
    .wrap(actix_web::middleware::Logger::default());
`;
    const symbols = actixWebAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const mw = symbols.find((s) => s.kind === 'middleware');
    expect(mw).toBeDefined();
    expect(mw!.frameworkMeta?.actix_middleware).toBe(true);
  });

  it('extracts bare struct name as middleware', () => {
    const source = `
use actix_web::App;
struct AuthMiddleware;
App::new().wrap(AuthMiddleware);
`;
    const symbols = actixWebAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const mw = symbols.find((s) => s.name === 'AuthMiddleware');
    expect(mw).toBeDefined();
    expect(mw!.kind).toBe('middleware');
  });

  it('emits separate symbols for multiple .wrap() calls', () => {
    const source = `
use actix_web::App;
App::new()
    .wrap(actix_web::middleware::Logger::default())
    .wrap(AuthMiddleware)
    .wrap(CorsMiddleware::new());
`;
    const symbols = actixWebAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const mwNames = symbols.filter((s) => s.kind === 'middleware').map((s) => s.name);
    expect(mwNames).toContain('Logger');
    expect(mwNames).toContain('AuthMiddleware');
    expect(mwNames).toContain('CorsMiddleware');
  });
});

// ─── FromRequest extractor extraction ────────────────────────────────────────

describe('actixWebAdapter — FromRequest extractors', () => {
  it('emits extractor type for impl FromRequest', () => {
    const source = `
use actix_web::FromRequest;
struct AuthUser { user_id: u64 }
impl FromRequest for AuthUser {
    type Error = actix_web::Error;
    type Future = std::future::Ready<Result<Self, Self::Error>>;
    fn from_request(req: &actix_web::HttpRequest, _: &mut actix_web::dev::Payload) -> Self::Future {
        std::future::ready(Ok(AuthUser { user_id: 1 }))
    }
}
`;
    const symbols = actixWebAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const ext = symbols.find((s) => s.name === 'AuthUser');
    expect(ext).toBeDefined();
    expect(ext!.kind).toBe('type');
    expect(ext!.frameworkMeta?.actix_extractor).toBe(true);
  });

  it('handles fully qualified impl actix_web::FromRequest', () => {
    const source = `
struct JsonBody<T>(T);
impl<T> actix_web::FromRequest for JsonBody<T> {
    type Error = actix_web::Error;
    type Future = std::future::Ready<Result<Self, Self::Error>>;
    fn from_request(_: &actix_web::HttpRequest, _: &mut actix_web::dev::Payload) -> Self::Future {
        todo!()
    }
}
`;
    const symbols = actixWebAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'JsonBody')).toBeDefined();
  });
});

// ─── Actix import guard ───────────────────────────────────────────────────────

describe('actixWebAdapter — actix import guard', () => {
  it('skips files that do not reference actix_web', () => {
    const source = `
fn main() {
    let app = App::new();
    app.service(resource("/health").route(get().to(handler)));
    app.wrap(Logger::default());
}
`;
    const symbols = actixWebAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols).toHaveLength(0);
  });
});

// ─── Deduplication ───────────────────────────────────────────────────────────

describe('actixWebAdapter — deduplication', () => {
  it('deduplicates identical macro routes', () => {
    const source = `
use actix_web::get;
#[get("/ping")] async fn ping1() {}
#[get("/ping")] async fn ping2() {}
`;
    const symbols = actixWebAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.filter((s) => s.name === 'GET /ping')).toHaveLength(1);
  });

  it('deduplicates identical middleware', () => {
    const source = `
use actix_web::App;
App::new()
    .wrap(Logger::default())
    .wrap(Logger::new("%r %s"));
`;
    const symbols = actixWebAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.filter((s) => s.name === 'Logger')).toHaveLength(1);
  });
});

// ─── Fixture integration ──────────────────────────────────────────────────────

describe('actixWebAdapter — fixture integration', () => {
  it('extracts macro routes from fixture main.rs', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'src/main.rs'), 'utf8');
    const symbols = actixWebAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'src/main.rs',
    );
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /health');
    expect(names).toContain('GET /users');
    expect(names).toContain('POST /users');
    expect(names).toContain('GET /users/{id}');
    expect(names).toContain('PUT /users/{id}');
    expect(names).toContain('DELETE /users/{id}');
    expect(names).toContain('PATCH /users/{id}');
  });

  it('extracts programmatic resource routes from fixture', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'src/main.rs'), 'utf8');
    const symbols = actixWebAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'src/main.rs',
    );
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /items');
    expect(names).toContain('POST /items');
  });

  it('extracts scope prefix from fixture', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'src/main.rs'), 'utf8');
    const symbols = actixWebAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'src/main.rs',
    );
    expect(symbols.find((s) => s.name === 'SCOPE /api/v2')).toBeDefined();
  });

  it('extracts middleware from fixture', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'src/main.rs'), 'utf8');
    const symbols = actixWebAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'src/main.rs',
    );
    const mwNames = symbols.filter((s) => s.kind === 'middleware').map((s) => s.name);
    expect(mwNames).toContain('Logger');
    expect(mwNames).toContain('AuthMiddleware');
  });

  it('extracts FromRequest extractor from fixture', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'src/main.rs'), 'utf8');
    const symbols = actixWebAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'src/main.rs',
    );
    const ext = symbols.find(
      (s) => s.frameworkMeta?.actix_extractor && s.name === 'AuthUser',
    );
    expect(ext).toBeDefined();
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('actixWebAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc',
      name: 'GET /users',
      kind: 'route' as const,
      filePath: 'main.rs',
      startByte: 0,
      endByte: 0,
      signature: '#[get("/users")]',
      summary: 'Actix route: GET /users',
      frameworkMeta: { http_method: 'GET', route_path: '/users', actix_route: true },
    };
    expect(actixWebAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});
