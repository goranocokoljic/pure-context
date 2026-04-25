import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fiberAdapter } from '../../src/adapters/fiber.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/fiber-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-fiber-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('fiberAdapter metadata', () => {
  it('has name "fiber"', () => {
    expect(fiberAdapter.name).toBe('fiber');
  });

  it('declares no extra extensions', () => {
    expect(fiberAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('fiberAdapter.detect', () => {
  it('detects fiber in go.mod', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'go.mod'), 'module example\n\nrequire github.com/gofiber/fiber/v2 v2.52.0\n');
    expect(await fiberAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when fiber is absent', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'go.mod'), 'module example\n\nrequire github.com/gin-gonic/gin v1.9.1\n');
    expect(await fiberAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false without go.mod', async () => {
    const dir = tmpDir();
    expect(await fiberAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture fiber project', async () => {
    expect(await fiberAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('fiberAdapter.fileFilter', () => {
  it('accepts .go files', () => {
    expect(fiberAdapter.fileFilter('main.go')).toBe(true);
    expect(fiberAdapter.fileFilter('handlers/users.go')).toBe(true);
  });

  it('rejects non-Go files', () => {
    expect(fiberAdapter.fileFilter('go.mod')).toBe(false);
    expect(fiberAdapter.fileFilter('main.ts')).toBe(false);
  });
});

// ─── Route extraction ─────────────────────────────────────────────────────────

describe('fiberAdapter — route extraction', () => {
  it('extracts app.Get route', () => {
    const source = `
package main

import "github.com/gofiber/fiber/v2"

func main() {
	app := fiber.New()
	app.Get("/health", func(c *fiber.Ctx) error { return nil })
}
`;
    const symbols = fiberAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    const route = symbols.find((s) => s.name === 'GET /health');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.route_path).toBe('/health');
    expect(route!.frameworkMeta?.fiber_route).toBe(true);
  });

  it('extracts app.Post route', () => {
    const source = `
package main
import "github.com/gofiber/fiber/v2"
func main() {
	app := fiber.New()
	app.Post("/users", createUser)
}
`;
    const symbols = fiberAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.find((s) => s.name === 'POST /users')).toBeDefined();
  });

  it('extracts all HTTP methods (title-case)', () => {
    const source = `
package main
import "github.com/gofiber/fiber/v2"
func main() {
	app := fiber.New()
	app.Get("/x", h)
	app.Post("/x", h)
	app.Put("/x/:id", h)
	app.Patch("/x/:id", h)
	app.Delete("/x/:id", h)
	app.Head("/x", h)
	app.Options("/x", h)
}
`;
    const symbols = fiberAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /x');
    expect(names).toContain('POST /x');
    expect(names).toContain('PUT /x/:id');
    expect(names).toContain('PATCH /x/:id');
    expect(names).toContain('DELETE /x/:id');
    expect(names).toContain('HEAD /x');
    expect(names).toContain('OPTIONS /x');
  });

  it('normalises All to ALL in route name', () => {
    const source = `
package main
import "github.com/gofiber/fiber/v2"
func main() {
	app := fiber.New()
	app.All("/ping", pingHandler)
}
`;
    const symbols = fiberAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.find((s) => s.name === 'ALL /ping')).toBeDefined();
  });

  it('accepts "srv" variable name', () => {
    const source = `
package main
import "github.com/gofiber/fiber/v2"
func main() {
	srv := fiber.New()
	srv.Get("/users", listUsers)
}
`;
    const symbols = fiberAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.find((s) => s.name === 'GET /users')).toBeDefined();
  });

  it('accepts group variable name', () => {
    const source = `
package main
import "github.com/gofiber/fiber/v2"
func main() {
	app := fiber.New()
	api := app.Group("/api")
	api.Get("/items", listItems)
}
`;
    const symbols = fiberAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.find((s) => s.name === 'GET /items')).toBeDefined();
  });

  it('extracts routes from fixture main.go', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'main.go'), 'utf8');
    const symbols = fiberAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'main.go');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /health');
    expect(names).toContain('GET /users');
    expect(names).toContain('POST /users');
    expect(names).toContain('GET /users/:id');
    expect(names).toContain('PUT /users/:id');
    expect(names).toContain('DELETE /users/:id');
    expect(names).toContain('GET /items');
    expect(names).toContain('GET /items/:id');
  });
});

// ─── Middleware extraction ────────────────────────────────────────────────────

describe('fiberAdapter — middleware extraction', () => {
  it('extracts app.Use as middleware symbol', () => {
    const source = `
package main
import "github.com/gofiber/fiber/v2"
func main() {
	app := fiber.New()
	app.Use(AuthMiddleware)
}
`;
    const symbols = fiberAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    const mw = symbols.find((s) => s.kind === 'middleware');
    expect(mw).toBeDefined();
    expect(mw!.name).toBe('AuthMiddleware');
    expect(mw!.frameworkMeta?.fiber_middleware).toBe(true);
  });

  it('extracts middleware from fixture main.go', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'main.go'), 'utf8');
    const symbols = fiberAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'main.go');
    const mwNames = symbols.filter((s) => s.kind === 'middleware').map((s) => s.name);
    expect(mwNames).toContain('AuthMiddleware');
  });
});

// ─── Fiber import guard ───────────────────────────────────────────────────────

describe('fiberAdapter — Fiber import guard', () => {
  it('skips files that do not import fiber', () => {
    const source = `
package main

func main() {
	app := someOtherFramework.New()
	app.Get("/users", handler)
}
`;
    const symbols = fiberAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols).toHaveLength(0);
  });

  it('skips unknown variable names even with fiber import', () => {
    const source = `
package main
import "github.com/gofiber/fiber/v2"
func main() {
	connection := fiber.New()
	connection.Get("/path", handler)
}
`;
    const symbols = fiberAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.filter((s) => s.kind === 'route')).toHaveLength(0);
  });
});

// ─── Deduplication ───────────────────────────────────────────────────────────

describe('fiberAdapter — deduplication', () => {
  it('deduplicates identical routes', () => {
    const source = `
package main
import "github.com/gofiber/fiber/v2"
func main() {
	app := fiber.New()
	app.Get("/ping", handler1)
	app.Get("/ping", handler2)
}
`;
    const symbols = fiberAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.filter((s) => s.name === 'GET /ping')).toHaveLength(1);
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('fiberAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc',
      name: 'GET /users',
      kind: 'route' as const,
      filePath: 'main.go',
      startByte: 0,
      endByte: 0,
      signature: 'app.Get("/users", ...)',
      summary: 'Fiber route: GET /users',
      frameworkMeta: { http_method: 'GET', fiber_route: true },
    };
    expect(fiberAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});
