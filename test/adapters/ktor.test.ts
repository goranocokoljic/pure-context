import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { ktorAdapter } from '../../src/adapters/ktor.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/ktor-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-ktor-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('ktorAdapter metadata', () => {
  it('has name "ktor"', () => {
    expect(ktorAdapter.name).toBe('ktor');
  });

  it('declares no extra extensions', () => {
    expect(ktorAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('ktorAdapter.detect', () => {
  it('detects ktor in build.gradle.kts', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'build.gradle.kts'), 'implementation("io.ktor:ktor-server-core:2.3.7")\n');
    expect(await ktorAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects ktor in build.gradle', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'build.gradle'), "implementation 'io.ktor:ktor-server-core:2.3.7'\n");
    expect(await ktorAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects ktor in pom.xml', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'pom.xml'),
      '<dependency><groupId>io.ktor</groupId><artifactId>ktor-server-core</artifactId></dependency>\n',
    );
    expect(await ktorAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when ktor is absent', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'build.gradle.kts'), 'implementation("org.springframework.boot:spring-boot-starter")\n');
    expect(await ktorAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false without build files', async () => {
    const dir = tmpDir();
    expect(await ktorAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture ktor project', async () => {
    expect(await ktorAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('ktorAdapter.fileFilter', () => {
  it('accepts .kt files', () => {
    expect(ktorAdapter.fileFilter('Application.kt')).toBe(true);
    expect(ktorAdapter.fileFilter('routes/Users.kt')).toBe(true);
  });

  it('rejects non-Kotlin files', () => {
    expect(ktorAdapter.fileFilter('build.gradle.kts')).toBe(false);
    expect(ktorAdapter.fileFilter('main.go')).toBe(false);
    expect(ktorAdapter.fileFilter('App.ts')).toBe(false);
  });
});

// ─── Basic route extraction ───────────────────────────────────────────────────

describe('ktorAdapter — basic routes', () => {
  it('extracts get route', () => {
    const source = `
routing {
  get("/users") {
    call.respondText("ok")
  }
}
`;
    const symbols = ktorAdapter.extractFrameworkSymbols(null, buf(source), 'App.kt');
    const route = symbols.find((s) => s.name === 'GET /users');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.route_path).toBe('/users');
    expect(route!.frameworkMeta?.ktor_route).toBe(true);
  });

  it('extracts post route', () => {
    const source = `routing { post("/users") { } }`;
    const symbols = ktorAdapter.extractFrameworkSymbols(null, buf(source), 'App.kt');
    expect(symbols.find((s) => s.name === 'POST /users')).toBeDefined();
  });

  it('extracts put, delete, patch routes', () => {
    const source = `
routing {
  put("/users/{id}") { }
  delete("/users/{id}") { }
  patch("/users/{id}") { }
}
`;
    const symbols = ktorAdapter.extractFrameworkSymbols(null, buf(source), 'App.kt');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('PUT /users/{id}');
    expect(names).toContain('DELETE /users/{id}');
    expect(names).toContain('PATCH /users/{id}');
  });

  it('extracts head and options routes', () => {
    const source = `
routing {
  head("/ping") { }
  options("/ping") { }
}
`;
    const symbols = ktorAdapter.extractFrameworkSymbols(null, buf(source), 'App.kt');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('HEAD /ping');
    expect(names).toContain('OPTIONS /ping');
  });

  it('preserves {param} path parameters', () => {
    const source = `routing { get("/items/{id}/reviews/{reviewId}") { } }`;
    const symbols = ktorAdapter.extractFrameworkSymbols(null, buf(source), 'App.kt');
    expect(symbols.find((s) => s.name === 'GET /items/{id}/reviews/{reviewId}')).toBeDefined();
  });
});

// ─── Nested route prefix ──────────────────────────────────────────────────────

describe('ktorAdapter — nested route prefix', () => {
  it('combines route() prefix with nested get()', () => {
    const source = `
routing {
  route("/api") {
    get("/users") { }
  }
}
`;
    const symbols = ktorAdapter.extractFrameworkSymbols(null, buf(source), 'App.kt');
    expect(symbols.find((s) => s.name === 'GET /api/users')).toBeDefined();
  });

  it('combines nested route() prefixes', () => {
    const source = `
routing {
  route("/v1") {
    route("/items") {
      get("/") { }
      get("/{id}") { }
    }
  }
}
`;
    const symbols = ktorAdapter.extractFrameworkSymbols(null, buf(source), 'App.kt');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /v1/items/');
    expect(names).toContain('GET /v1/items/{id}');
  });

  it('does not bleed prefix to routes outside the block', () => {
    const source = `
routing {
  route("/api") {
    post("/login") { }
  }
  get("/health") { }
}
`;
    const symbols = ktorAdapter.extractFrameworkSymbols(null, buf(source), 'App.kt');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('POST /api/login');
    expect(names).toContain('GET /health');
    expect(names).not.toContain('GET /api/health');
  });
});

// ─── authenticate block ───────────────────────────────────────────────────────

describe('ktorAdapter — authenticate block', () => {
  it('marks routes inside authenticate as authenticated', () => {
    const source = `
routing {
  authenticate("jwt") {
    get("/profile") { }
  }
}
`;
    const symbols = ktorAdapter.extractFrameworkSymbols(null, buf(source), 'App.kt');
    const route = symbols.find((s) => s.name === 'GET /profile');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.authenticated).toBe(true);
  });

  it('does not mark routes outside authenticate as authenticated', () => {
    const source = `
routing {
  get("/public") { }
  authenticate {
    get("/private") { }
  }
}
`;
    const symbols = ktorAdapter.extractFrameworkSymbols(null, buf(source), 'App.kt');
    const pub = symbols.find((s) => s.name === 'GET /public');
    const priv = symbols.find((s) => s.name === 'GET /private');
    expect(pub!.frameworkMeta?.authenticated).toBeUndefined();
    expect(priv!.frameworkMeta?.authenticated).toBe(true);
  });

  it('combines route() prefix with authenticate block', () => {
    const source = `
routing {
  route("/api") {
    authenticate("jwt") {
      get("/profile") { }
      post("/logout") { }
    }
  }
}
`;
    const symbols = ktorAdapter.extractFrameworkSymbols(null, buf(source), 'App.kt');
    const profile = symbols.find((s) => s.name === 'GET /api/profile');
    expect(profile).toBeDefined();
    expect(profile!.frameworkMeta?.authenticated).toBe(true);
    expect(symbols.find((s) => s.name === 'POST /api/logout')).toBeDefined();
  });
});

// ─── Non-route calls are not extracted ───────────────────────────────────────

describe('ktorAdapter — non-route calls', () => {
  it('does not extract non-routing function calls', () => {
    const source = `
fun Application.module() {
  install(ContentNegotiation) { json() }
  routing {
    get("/health") { }
  }
}
`;
    const symbols = ktorAdapter.extractFrameworkSymbols(null, buf(source), 'App.kt');
    expect(symbols.every((s) => s.kind === 'route')).toBe(true);
    expect(symbols).toHaveLength(1);
  });
});

// ─── Deduplication ───────────────────────────────────────────────────────────

describe('ktorAdapter — deduplication', () => {
  it('deduplicates identical routes', () => {
    const source = `
routing {
  get("/ping") { }
  get("/ping") { }
}
`;
    const symbols = ktorAdapter.extractFrameworkSymbols(null, buf(source), 'App.kt');
    expect(symbols.filter((s) => s.name === 'GET /ping')).toHaveLength(1);
  });
});

// ─── Fixture project ─────────────────────────────────────────────────────────

describe('ktorAdapter — fixture project', () => {
  it('extracts routes from Application.kt fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/kotlin/com/example/Application.kt'),
      'utf8',
    );
    const symbols = ktorAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'Application.kt');
    const names = symbols.map((s) => s.name);

    expect(names).toContain('GET /health');
    expect(names).toContain('GET /api/users');
    expect(names).toContain('POST /api/users');
    expect(names).toContain('GET /api/users/{id}');
    expect(names).toContain('PUT /api/users/{id}');
    expect(names).toContain('DELETE /api/users/{id}');
    expect(names).toContain('GET /api/profile');
    expect(names).toContain('POST /api/logout');
  });

  it('marks authenticated routes in fixture', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/main/kotlin/com/example/Application.kt'),
      'utf8',
    );
    const symbols = ktorAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'Application.kt');
    const profile = symbols.find((s) => s.name === 'GET /api/profile');
    const logout = symbols.find((s) => s.name === 'POST /api/logout');
    const health = symbols.find((s) => s.name === 'GET /health');

    expect(profile!.frameworkMeta?.authenticated).toBe(true);
    expect(logout!.frameworkMeta?.authenticated).toBe(true);
    expect(health!.frameworkMeta?.authenticated).toBeUndefined();
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('ktorAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc',
      name: 'GET /users',
      kind: 'route' as const,
      filePath: 'App.kt',
      startByte: 0,
      endByte: 0,
      signature: 'get("/users") { ... }',
      summary: 'Ktor route: GET /users',
      frameworkMeta: { http_method: 'GET', route_path: '/users', ktor_route: true },
    };
    expect(ktorAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});
