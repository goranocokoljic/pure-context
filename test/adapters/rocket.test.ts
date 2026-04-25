import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { rocketAdapter } from '../../src/adapters/rocket.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/rocket-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-rocket-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('rocketAdapter metadata', () => {
  it('has name "rocket"', () => {
    expect(rocketAdapter.name).toBe('rocket');
  });

  it('declares no extra extensions', () => {
    expect(rocketAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('rocketAdapter.detect', () => {
  it('detects rocket in Cargo.toml (simple version string)', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'Cargo.toml'),
      '[dependencies]\nrocket = "0.5"\n',
    );
    expect(await rocketAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects rocket in Cargo.toml (table dependency)', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'Cargo.toml'),
      '[dependencies]\nrocket = { version = "0.5", features = ["json"] }\n',
    );
    expect(await rocketAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when rocket is absent', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'Cargo.toml'),
      '[dependencies]\naxum = "0.7"\n',
    );
    expect(await rocketAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false without Cargo.toml', async () => {
    const dir = tmpDir();
    expect(await rocketAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture rocket project', async () => {
    expect(await rocketAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('rocketAdapter.fileFilter', () => {
  it('accepts .rs files', () => {
    expect(rocketAdapter.fileFilter('main.rs')).toBe(true);
    expect(rocketAdapter.fileFilter('src/routes.rs')).toBe(true);
  });

  it('rejects non-Rust files', () => {
    expect(rocketAdapter.fileFilter('Cargo.toml')).toBe(false);
    expect(rocketAdapter.fileFilter('main.go')).toBe(false);
    expect(rocketAdapter.fileFilter('index.ts')).toBe(false);
  });
});

// ─── Simple macro route extraction ────────────────────────────────────────────

describe('rocketAdapter — #[get] / #[post] macro routes', () => {
  it('extracts #[get] route', () => {
    const source = `
use rocket::get;
#[get("/health")]
fn health() -> &'static str { "ok" }
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const route = symbols.find((s) => s.name === 'GET /health');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.route_path).toBe('/health');
    expect(route!.frameworkMeta?.rocket_route).toBe(true);
  });

  it('extracts #[post] route', () => {
    const source = `
use rocket::post;
#[post("/users")]
fn create_user() -> rocket::http::Status { rocket::http::Status::Created }
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'POST /users')).toBeDefined();
  });

  it('extracts all HTTP method macros', () => {
    const source = `
use rocket::{get, post, put, patch, delete, head, options};
#[get("/a")] fn a() {}
#[post("/b")] fn b() {}
#[put("/c")] fn c() {}
#[patch("/d")] fn d() {}
#[delete("/e")] fn e() {}
#[head("/f")] fn f() {}
#[options("/g")] fn g() {}
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /a');
    expect(names).toContain('POST /b');
    expect(names).toContain('PUT /c');
    expect(names).toContain('PATCH /d');
    expect(names).toContain('DELETE /e');
    expect(names).toContain('HEAD /f');
    expect(names).toContain('OPTIONS /g');
  });

  it('preserves <param> path parameters', () => {
    const source = `
use rocket::get;
#[get("/users/<id>")]
fn get_user(id: u64) -> String { id.to_string() }
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const route = symbols.find((s) => s.name === 'GET /users/<id>');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.route_path).toBe('/users/<id>');
  });

  it('handles multi-segment path with multiple params', () => {
    const source = `
use rocket::get;
#[get("/orders/<order_id>/items/<item_id>")]
fn get_item(order_id: u64, item_id: u64) -> String { "".to_string() }
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(
      symbols.find((s) => s.name === 'GET /orders/<order_id>/items/<item_id>'),
    ).toBeDefined();
  });

  it('handles fully qualified attribute: #[rocket::get]', () => {
    const source = `
#[rocket::get("/status")]
fn status() -> &'static str { "ok" }
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'GET /status')).toBeDefined();
  });
});

// ─── Generic #[route(...)] macro extraction ───────────────────────────────────

describe('rocketAdapter — #[route(METHOD, path = "...")] generic routes', () => {
  it('extracts #[route(GET, path = "/v2/items")]', () => {
    const source = `
use rocket::route;
#[route(GET, path = "/v2/items")]
fn list_items_v2() -> &'static str { "[]" }
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const route = symbols.find((s) => s.name === 'GET /v2/items');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.route_path).toBe('/v2/items');
    expect(route!.frameworkMeta?.rocket_route).toBe(true);
  });

  it('extracts #[route(POST, path = "/...")]', () => {
    const source = `
#[route(POST, path = "/v2/items")]
fn create_item_v2() -> rocket::http::Status { rocket::http::Status::Created }
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'POST /v2/items')).toBeDefined();
  });

  it('handles path with <param> in generic route', () => {
    const source = `
#[route(DELETE, path = "/users/<id>")]
fn remove_user(id: u64) -> rocket::http::Status { rocket::http::Status::NoContent }
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'DELETE /users/<id>')).toBeDefined();
  });
});

// ─── Error catcher extraction ─────────────────────────────────────────────────

describe('rocketAdapter — #[catch] error catchers', () => {
  it('emits route symbol for #[catch(404)]', () => {
    const source = `
use rocket::catch;
#[catch(404)]
fn not_found(req: &rocket::Request) -> String { "not found".to_string() }
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const catcher = symbols.find((s) => s.name === 'CATCH 404');
    expect(catcher).toBeDefined();
    expect(catcher!.kind).toBe('route');
    expect(catcher!.frameworkMeta?.rocket_catcher).toBe(true);
    expect(catcher!.frameworkMeta?.status_code).toBe(404);
  });

  it('emits route symbol for #[catch(500)]', () => {
    const source = `
use rocket::catch;
#[catch(500)]
fn server_error() -> &'static str { "oops" }
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const catcher = symbols.find((s) => s.name === 'CATCH 500');
    expect(catcher).toBeDefined();
    expect(catcher!.frameworkMeta?.status_code).toBe(500);
  });

  it('emits route symbol for #[catch(default)] with null status_code', () => {
    const source = `
use rocket::catch;
#[catch(default)]
fn default_catcher(status: rocket::http::Status, req: &rocket::Request) -> String {
    format!("{}", status.code)
}
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const catcher = symbols.find((s) => s.name === 'CATCH default');
    expect(catcher).toBeDefined();
    expect(catcher!.kind).toBe('route');
    expect(catcher!.frameworkMeta?.rocket_catcher).toBe(true);
    expect(catcher!.frameworkMeta?.status_code).toBeNull();
  });

  it('emits separate symbols for multiple catchers', () => {
    const source = `
use rocket::catch;
#[catch(404)]
fn not_found() -> &'static str { "not found" }
#[catch(500)]
fn server_error() -> &'static str { "server error" }
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('CATCH 404');
    expect(names).toContain('CATCH 500');
  });

  it('handles fully qualified #[rocket::catch(404)]', () => {
    const source = `
#[rocket::catch(404)]
fn not_found() -> &'static str { "not found" }
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'CATCH 404')).toBeDefined();
  });
});

// ─── Fairing (middleware) extraction ─────────────────────────────────────────

describe('rocketAdapter — Fairing middleware', () => {
  it('emits middleware symbol for impl Fairing', () => {
    const source = `
use rocket::fairing::{Fairing, Info, Kind};
pub struct LogFairing;
impl Fairing for LogFairing {
    fn info(&self) -> Info { Info { name: "Logger", kind: Kind::Request } }
}
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const fairing = symbols.find((s) => s.name === 'LogFairing');
    expect(fairing).toBeDefined();
    expect(fairing!.kind).toBe('middleware');
    expect(fairing!.frameworkMeta?.rocket_fairing).toBe(true);
  });

  it('handles fully qualified impl rocket::fairing::Fairing', () => {
    const source = `
struct AuthFairing;
impl rocket::fairing::Fairing for AuthFairing {
    fn info(&self) -> rocket::fairing::Info {
        rocket::fairing::Info { name: "Auth", kind: rocket::fairing::Kind::Request }
    }
}
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'AuthFairing' && s.kind === 'middleware')).toBeDefined();
  });

  it('emits separate symbols for multiple fairings', () => {
    const source = `
use rocket::fairing::Fairing;
struct LogFairing;
impl Fairing for LogFairing {}
struct AuthFairing;
impl Fairing for AuthFairing {}
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const names = symbols.filter((s) => s.kind === 'middleware').map((s) => s.name);
    expect(names).toContain('LogFairing');
    expect(names).toContain('AuthFairing');
  });
});

// ─── Request guard / form type extraction ────────────────────────────────────

describe('rocketAdapter — FromForm / FromRequest guards', () => {
  it('emits type symbol for #[derive(FromForm)]', () => {
    const source = `
use rocket::FromForm;
#[derive(FromForm, Debug)]
pub struct LoginForm {
    pub username: String,
    pub password: String,
}
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const guard = symbols.find((s) => s.name === 'LoginForm');
    expect(guard).toBeDefined();
    expect(guard!.kind).toBe('type');
    expect(guard!.frameworkMeta?.rocket_guard).toBe(true);
  });

  it('emits type symbol for #[derive(FromRequest)]', () => {
    const source = `
use rocket::request::FromRequest;
#[derive(FromRequest)]
pub struct ApiKey(String);
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const guard = symbols.find((s) => s.name === 'ApiKey');
    expect(guard).toBeDefined();
    expect(guard!.kind).toBe('type');
    expect(guard!.frameworkMeta?.rocket_guard).toBe(true);
  });

  it('handles struct with multiple derives including FromForm', () => {
    const source = `
use rocket::FromForm;
#[derive(Debug, Clone, FromForm, serde::Deserialize)]
struct NewUser { name: String }
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'NewUser' && s.frameworkMeta?.rocket_guard)).toBeDefined();
  });
});

// ─── Rocket import guard ──────────────────────────────────────────────────────

describe('rocketAdapter — rocket import guard', () => {
  it('skips files that do not reference rocket', () => {
    const source = `
fn main() {
    println!("Hello, world!");
}
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols).toHaveLength(0);
  });

  it('processes files with #[macro_use] extern crate rocket', () => {
    const source = `
#[macro_use]
extern crate rocket;
#[get("/ping")]
fn ping() -> &'static str { "pong" }
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'GET /ping')).toBeDefined();
  });
});

// ─── Deduplication ───────────────────────────────────────────────────────────

describe('rocketAdapter — deduplication', () => {
  it('deduplicates identical macro routes', () => {
    const source = `
use rocket::get;
#[get("/ping")] fn ping1() -> &'static str { "pong" }
#[get("/ping")] fn ping2() -> &'static str { "pong" }
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.filter((s) => s.name === 'GET /ping')).toHaveLength(1);
  });

  it('deduplicates identical catchers', () => {
    const source = `
use rocket::catch;
#[catch(404)] fn not_found1() -> &'static str { "nope" }
#[catch(404)] fn not_found2() -> &'static str { "nope" }
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.filter((s) => s.name === 'CATCH 404')).toHaveLength(1);
  });

  it('deduplicates identical fairings', () => {
    const source = `
use rocket::fairing::Fairing;
impl Fairing for LogFairing {}
impl Fairing for LogFairing {}
`;
    const symbols = rocketAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.filter((s) => s.name === 'LogFairing')).toHaveLength(1);
  });
});

// ─── Fixture integration ──────────────────────────────────────────────────────

describe('rocketAdapter — fixture integration', () => {
  it('extracts simple macro routes from fixture main.rs', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'src/main.rs'), 'utf8');
    const symbols = rocketAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'src/main.rs',
    );
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /health');
    expect(names).toContain('GET /users');
    expect(names).toContain('POST /users');
    expect(names).toContain('GET /users/<id>');
    expect(names).toContain('PUT /users/<id>');
    expect(names).toContain('DELETE /users/<id>');
    expect(names).toContain('PATCH /users/<id>');
  });

  it('extracts generic #[route] macro routes from fixture', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'src/main.rs'), 'utf8');
    const symbols = rocketAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'src/main.rs',
    );
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /v2/items');
    expect(names).toContain('POST /v2/items');
  });

  it('extracts error catchers from fixture', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'src/main.rs'), 'utf8');
    const symbols = rocketAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'src/main.rs',
    );
    const names = symbols.map((s) => s.name);
    expect(names).toContain('CATCH 404');
    expect(names).toContain('CATCH 500');
    expect(names).toContain('CATCH default');
  });

  it('catchers have correct status_code metadata', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'src/main.rs'), 'utf8');
    const symbols = rocketAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'src/main.rs',
    );
    const c404 = symbols.find((s) => s.name === 'CATCH 404');
    expect(c404!.frameworkMeta?.status_code).toBe(404);
    const cDefault = symbols.find((s) => s.name === 'CATCH default');
    expect(cDefault!.frameworkMeta?.status_code).toBeNull();
  });

  it('extracts fairings from fixture', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'src/main.rs'), 'utf8');
    const symbols = rocketAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'src/main.rs',
    );
    const fairingNames = symbols.filter((s) => s.kind === 'middleware').map((s) => s.name);
    expect(fairingNames).toContain('LogFairing');
    expect(fairingNames).toContain('AuthFairing');
  });

  it('extracts FromForm and FromRequest guards from fixture', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'src/main.rs'), 'utf8');
    const symbols = rocketAdapter.extractFrameworkSymbols(
      null,
      Buffer.from(source),
      'src/main.rs',
    );
    const guardNames = symbols
      .filter((s) => s.frameworkMeta?.rocket_guard)
      .map((s) => s.name);
    expect(guardNames).toContain('NewUser');
    expect(guardNames).toContain('ApiKey');
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('rocketAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc',
      name: 'GET /users',
      kind: 'route' as const,
      filePath: 'main.rs',
      startByte: 0,
      endByte: 0,
      signature: '#[get("/users")]',
      summary: 'Rocket route: GET /users',
      frameworkMeta: { http_method: 'GET', route_path: '/users', rocket_route: true },
    };
    expect(rocketAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});
