import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { axumAdapter } from '../../src/adapters/axum.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/axum-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-axum-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('axumAdapter metadata', () => {
  it('has name "axum"', () => {
    expect(axumAdapter.name).toBe('axum');
  });

  it('declares no extra extensions', () => {
    expect(axumAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('axumAdapter.detect', () => {
  it('detects axum in Cargo.toml (simple version string)', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'Cargo.toml'),
      '[dependencies]\naxum = "0.7"\ntokio = { version = "1" }\n',
    );
    expect(await axumAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects axum in Cargo.toml (table dependency)', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'Cargo.toml'),
      '[dependencies]\naxum = { version = "0.7", features = ["macros"] }\n',
    );
    expect(await axumAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when axum is absent', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'Cargo.toml'),
      '[dependencies]\nactix-web = "4"\n',
    );
    expect(await axumAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false without Cargo.toml', async () => {
    const dir = tmpDir();
    expect(await axumAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture axum project', async () => {
    expect(await axumAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('axumAdapter.fileFilter', () => {
  it('accepts .rs files', () => {
    expect(axumAdapter.fileFilter('main.rs')).toBe(true);
    expect(axumAdapter.fileFilter('src/routes.rs')).toBe(true);
  });

  it('rejects non-Rust files', () => {
    expect(axumAdapter.fileFilter('Cargo.toml')).toBe(false);
    expect(axumAdapter.fileFilter('main.go')).toBe(false);
    expect(axumAdapter.fileFilter('main.ts')).toBe(false);
  });
});

// ─── Route extraction — single method ────────────────────────────────────────

describe('axumAdapter — single-method routes', () => {
  it('extracts GET route', () => {
    const source = `
use axum::{routing::get, Router};
async fn health() {}
fn app() -> Router {
    Router::new().route("/health", get(health))
}
`;
    const symbols = axumAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const route = symbols.find((s) => s.name === 'GET /health');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.route_path).toBe('/health');
    expect(route!.frameworkMeta?.axum_route).toBe(true);
  });

  it('extracts POST route', () => {
    const source = `
use axum::{routing::post, Router};
async fn create() {}
fn app() -> Router {
    Router::new().route("/users", post(create))
}
`;
    const symbols = axumAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'POST /users')).toBeDefined();
  });

  it('extracts all supported HTTP methods', () => {
    const source = `
use axum::Router;
fn app() -> Router {
    Router::new()
        .route("/a", get(h))
        .route("/b", post(h))
        .route("/c", put(h))
        .route("/d", patch(h))
        .route("/e", delete(h))
        .route("/f", head(h))
        .route("/g", options(h))
        .route("/h", trace(h))
}
`;
    const symbols = axumAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /a');
    expect(names).toContain('POST /b');
    expect(names).toContain('PUT /c');
    expect(names).toContain('PATCH /d');
    expect(names).toContain('DELETE /e');
    expect(names).toContain('HEAD /f');
    expect(names).toContain('OPTIONS /g');
    expect(names).toContain('TRACE /h');
  });
});

// ─── Route extraction — multiple methods on one path ─────────────────────────

describe('axumAdapter — multi-method routes', () => {
  it('extracts two methods from a chained handler', () => {
    const source = `
use axum::Router;
fn app() -> Router {
    Router::new()
        .route("/users", get(list).post(create))
}
`;
    const symbols = axumAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'GET /users')).toBeDefined();
    expect(symbols.find((s) => s.name === 'POST /users')).toBeDefined();
  });

  it('extracts three methods from a chained handler', () => {
    const source = `
use axum::Router;
fn app() -> Router {
    Router::new()
        .route("/:id", get(show).put(update).delete(destroy))
}
`;
    const symbols = axumAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'GET /:id')).toBeDefined();
    expect(symbols.find((s) => s.name === 'PUT /:id')).toBeDefined();
    expect(symbols.find((s) => s.name === 'DELETE /:id')).toBeDefined();
  });
});

// ─── Route extraction — path parameters ──────────────────────────────────────

describe('axumAdapter — path parameters', () => {
  it('preserves :param in route path', () => {
    const source = `
use axum::Router;
fn app() -> Router {
    Router::new()
        .route("/users/:id", get(get_user))
}
`;
    const symbols = axumAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const route = symbols.find((s) => s.name === 'GET /users/:id');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.route_path).toBe('/users/:id');
  });

  it('preserves nested :params', () => {
    const source = `
use axum::Router;
fn app() -> Router {
    Router::new()
        .route("/orgs/:org_id/repos/:repo_id", get(get_repo))
}
`;
    const symbols = axumAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'GET /orgs/:org_id/repos/:repo_id')).toBeDefined();
  });
});

// ─── Nested router extraction ─────────────────────────────────────────────────

describe('axumAdapter — .nest() prefix', () => {
  it('emits a NEST route symbol for .nest()', () => {
    const source = `
use axum::Router;
fn app() -> Router {
    let api = Router::new().route("/users", get(list_users));
    Router::new().nest("/api", api)
}
`;
    const symbols = axumAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const nest = symbols.find((s) => s.name === 'NEST /api');
    expect(nest).toBeDefined();
    expect(nest!.kind).toBe('route');
    expect(nest!.frameworkMeta?.route_path).toBe('/api');
    expect(nest!.frameworkMeta?.axum_nest).toBe(true);
  });

  it('emits separate NEST symbols for multiple .nest() calls', () => {
    const source = `
use axum::Router;
fn app() -> Router {
    Router::new()
        .nest("/users", user_routes())
        .nest("/items", item_routes())
}
`;
    const symbols = axumAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'NEST /users')).toBeDefined();
    expect(symbols.find((s) => s.name === 'NEST /items')).toBeDefined();
  });
});

// ─── Layer (middleware) extraction ────────────────────────────────────────────

describe('axumAdapter — .layer() middleware', () => {
  it('emits a middleware symbol for .layer()', () => {
    const source = `
use axum::Router;
use tower_http::cors::CorsLayer;
fn app() -> Router {
    Router::new()
        .route("/", get(handler))
        .layer(CorsLayer::permissive())
}
`;
    const symbols = axumAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const mw = symbols.find((s) => s.name === 'CorsLayer');
    expect(mw).toBeDefined();
    expect(mw!.kind).toBe('middleware');
    expect(mw!.frameworkMeta?.axum_layer).toBe(true);
  });

  it('emits separate symbols for multiple .layer() calls', () => {
    const source = `
use axum::Router;
fn app() -> Router {
    Router::new()
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
}
`;
    const symbols = axumAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'CorsLayer')).toBeDefined();
    expect(symbols.find((s) => s.name === 'TraceLayer')).toBeDefined();
  });

  it('extracts type name from a variable argument', () => {
    const source = `
use axum::Router;
fn app() -> Router {
    let auth = AuthLayer::new();
    Router::new().layer(auth)
}
`;
    const symbols = axumAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const mw = symbols.find((s) => s.name === 'auth');
    // Variable name is the first identifier when no :: path is used
    expect(mw).toBeDefined();
    expect(mw!.kind).toBe('middleware');
  });
});

// ─── FromRequest extractor extraction ────────────────────────────────────────

describe('axumAdapter — FromRequest extractors', () => {
  it('emits extractor type for #[derive(FromRequest)]', () => {
    const source = `
use axum::extract::FromRequest;
#[derive(FromRequest)]
#[from_request(via(axum::Json))]
struct CreateUserPayload {
    name: String,
}
`;
    const symbols = axumAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const ext = symbols.find((s) => s.name === 'CreateUserPayload');
    expect(ext).toBeDefined();
    expect(ext!.kind).toBe('type');
    expect(ext!.frameworkMeta?.axum_extractor).toBe(true);
  });

  it('emits extractor type for impl FromRequest', () => {
    const source = `
use axum::extract::FromRequest;
struct AuthUser { user_id: u64 }
impl<S> FromRequest<S> for AuthUser where S: Send + Sync {
    type Rejection = ();
    async fn from_request(_req: axum::extract::Request, _state: &S) -> Result<Self, ()> {
        Ok(AuthUser { user_id: 1 })
    }
}
`;
    const symbols = axumAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    const ext = symbols.find((s) => s.name === 'AuthUser');
    expect(ext).toBeDefined();
    expect(ext!.kind).toBe('type');
    expect(ext!.frameworkMeta?.axum_extractor).toBe(true);
  });

  it('emits extractor for pub struct with derive', () => {
    const source = `
use axum::extract::FromRequest;
#[derive(Debug, FromRequest)]
pub struct JsonBody<T>(T);
`;
    const symbols = axumAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.find((s) => s.name === 'JsonBody')).toBeDefined();
  });
});

// ─── Axum import guard ────────────────────────────────────────────────────────

describe('axumAdapter — axum import guard', () => {
  it('skips files that do not reference axum', () => {
    const source = `
fn app() {
    let router = Router::new();
    router.route("/health", get(handler));
    router.layer(SomeLayer::new());
}
`;
    const symbols = axumAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols).toHaveLength(0);
  });
});

// ─── Deduplication ───────────────────────────────────────────────────────────

describe('axumAdapter — deduplication', () => {
  it('deduplicates identical routes', () => {
    const source = `
use axum::Router;
fn app() -> Router {
    Router::new()
        .route("/ping", get(handler1))
        .route("/ping", get(handler2))
}
`;
    const symbols = axumAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.filter((s) => s.name === 'GET /ping')).toHaveLength(1);
  });

  it('deduplicates identical layer types', () => {
    const source = `
use axum::Router;
fn app() -> Router {
    Router::new()
        .layer(CorsLayer::permissive())
        .layer(CorsLayer::new())
}
`;
    const symbols = axumAdapter.extractFrameworkSymbols(null, buf(source), 'main.rs');
    expect(symbols.filter((s) => s.name === 'CorsLayer')).toHaveLength(1);
  });
});

// ─── Fixture integration ──────────────────────────────────────────────────────

describe('axumAdapter — fixture integration', () => {
  it('extracts routes from fixture main.rs', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'src/main.rs'), 'utf8');
    const symbols = axumAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'src/main.rs');
    const names = symbols.map((s) => s.name);

    // Direct routes
    expect(names).toContain('GET /health');
    // Sub-router routes (inside user_routes)
    expect(names).toContain('GET /');
    expect(names).toContain('POST /');
    expect(names).toContain('GET /:id');
    expect(names).toContain('PUT /:id');
    expect(names).toContain('DELETE /:id');
  });

  it('extracts nested router prefixes from fixture', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'src/main.rs'), 'utf8');
    const symbols = axumAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'src/main.rs');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('NEST /users');
    expect(names).toContain('NEST /items');
  });

  it('extracts middleware layers from fixture', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'src/main.rs'), 'utf8');
    const symbols = axumAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'src/main.rs');
    const mwNames = symbols.filter((s) => s.kind === 'middleware').map((s) => s.name);
    expect(mwNames).toContain('CorsLayer');
    expect(mwNames).toContain('TraceLayer');
  });

  it('extracts FromRequest extractors from fixture', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'src/main.rs'), 'utf8');
    const symbols = axumAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'src/main.rs');
    const extNames = symbols
      .filter((s) => s.frameworkMeta?.axum_extractor)
      .map((s) => s.name);
    expect(extNames).toContain('CreateUserPayload');
    expect(extNames).toContain('AuthUser');
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('axumAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc',
      name: 'GET /users',
      kind: 'route' as const,
      filePath: 'main.rs',
      startByte: 0,
      endByte: 0,
      signature: '.route("/users", get(...))',
      summary: 'Axum route: GET /users',
      frameworkMeta: { http_method: 'GET', route_path: '/users', axum_route: true },
    };
    expect(axumAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});
