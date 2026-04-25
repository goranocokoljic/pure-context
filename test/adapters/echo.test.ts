import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { echoAdapter } from '../../src/adapters/echo.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/echo-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-echo-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('echoAdapter metadata', () => {
  it('has name "echo"', () => {
    expect(echoAdapter.name).toBe('echo');
  });

  it('declares no extra extensions', () => {
    expect(echoAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('echoAdapter.detect', () => {
  it('detects echo in go.mod', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'go.mod'), 'module example\n\nrequire github.com/labstack/echo/v4 v4.11.4\n');
    expect(await echoAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when echo is absent', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'go.mod'), 'module example\n\nrequire github.com/gin-gonic/gin v1.9.1\n');
    expect(await echoAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false without go.mod', async () => {
    const dir = tmpDir();
    expect(await echoAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture echo project', async () => {
    expect(await echoAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('echoAdapter.fileFilter', () => {
  it('accepts .go files', () => {
    expect(echoAdapter.fileFilter('main.go')).toBe(true);
    expect(echoAdapter.fileFilter('handlers/users.go')).toBe(true);
  });

  it('rejects non-Go files', () => {
    expect(echoAdapter.fileFilter('go.mod')).toBe(false);
    expect(echoAdapter.fileFilter('main.ts')).toBe(false);
  });
});

// ─── Route extraction ─────────────────────────────────────────────────────────

describe('echoAdapter — route extraction', () => {
  it('extracts e.GET route', () => {
    const source = `
package main

import "github.com/labstack/echo/v4"

func main() {
	e := echo.New()
	e.GET("/health", func(c echo.Context) error { return nil })
}
`;
    const symbols = echoAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    const route = symbols.find((s) => s.name === 'GET /health');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.route_path).toBe('/health');
    expect(route!.frameworkMeta?.echo_route).toBe(true);
  });

  it('extracts e.POST route', () => {
    const source = `
package main
import "github.com/labstack/echo/v4"
func main() {
	e := echo.New()
	e.POST("/users", createUser)
}
`;
    const symbols = echoAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.find((s) => s.name === 'POST /users')).toBeDefined();
  });

  it('extracts all HTTP methods', () => {
    const source = `
package main
import "github.com/labstack/echo/v4"
func main() {
	e := echo.New()
	e.GET("/x", h)
	e.POST("/x", h)
	e.PUT("/x/:id", h)
	e.PATCH("/x/:id", h)
	e.DELETE("/x/:id", h)
	e.HEAD("/x", h)
	e.OPTIONS("/x", h)
}
`;
    const symbols = echoAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /x');
    expect(names).toContain('POST /x');
    expect(names).toContain('PUT /x/:id');
    expect(names).toContain('PATCH /x/:id');
    expect(names).toContain('DELETE /x/:id');
    expect(names).toContain('HEAD /x');
    expect(names).toContain('OPTIONS /x');
  });

  it('extracts e.Any route', () => {
    const source = `
package main
import "github.com/labstack/echo/v4"
func main() {
	e := echo.New()
	e.Any("/ping", pingHandler)
}
`;
    const symbols = echoAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.find((s) => s.name === 'ANY /ping')).toBeDefined();
  });

  it('accepts "server" variable name', () => {
    const source = `
package main
import "github.com/labstack/echo/v4"
func main() {
	server := echo.New()
	server.GET("/users", listUsers)
}
`;
    const symbols = echoAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.find((s) => s.name === 'GET /users')).toBeDefined();
  });

  it('accepts "api" variable name', () => {
    const source = `
package main
import "github.com/labstack/echo/v4"
func main() {
	api := echo.New()
	api.POST("/items", createItem)
}
`;
    const symbols = echoAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.find((s) => s.name === 'POST /items')).toBeDefined();
  });

  it('accepts group variable name', () => {
    const source = `
package main
import "github.com/labstack/echo/v4"
func main() {
	e := echo.New()
	g := e.Group("/api")
	g.GET("/users", listUsers)
}
`;
    const symbols = echoAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.find((s) => s.name === 'GET /users')).toBeDefined();
  });

  it('extracts routes from fixture main.go', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'main.go'), 'utf8');
    const symbols = echoAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'main.go');
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

describe('echoAdapter — middleware extraction', () => {
  it('extracts e.Use as middleware symbol', () => {
    const source = `
package main
import "github.com/labstack/echo/v4"
func main() {
	e := echo.New()
	e.Use(AuthMiddleware)
}
`;
    const symbols = echoAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    const mw = symbols.find((s) => s.kind === 'middleware');
    expect(mw).toBeDefined();
    expect(mw!.name).toBe('AuthMiddleware');
    expect(mw!.frameworkMeta?.echo_middleware).toBe(true);
  });

  it('extracts middleware from fixture main.go', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'main.go'), 'utf8');
    const symbols = echoAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'main.go');
    const mwNames = symbols.filter((s) => s.kind === 'middleware').map((s) => s.name);
    expect(mwNames).toContain('AuthMiddleware');
  });
});

// ─── Echo import guard ────────────────────────────────────────────────────────

describe('echoAdapter — Echo import guard', () => {
  it('skips files that do not import echo', () => {
    const source = `
package main

func main() {
	e := someOtherFramework.New()
	e.GET("/users", handler)
}
`;
    const symbols = echoAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols).toHaveLength(0);
  });

  it('skips unknown variable names even with echo import', () => {
    const source = `
package main
import "github.com/labstack/echo/v4"
func main() {
	connection := echo.New()
	connection.GET("/path", handler)
}
`;
    const symbols = echoAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.filter((s) => s.kind === 'route')).toHaveLength(0);
  });
});

// ─── Deduplication ───────────────────────────────────────────────────────────

describe('echoAdapter — deduplication', () => {
  it('deduplicates identical routes', () => {
    const source = `
package main
import "github.com/labstack/echo/v4"
func main() {
	e := echo.New()
	e.GET("/ping", handler1)
	e.GET("/ping", handler2)
}
`;
    const symbols = echoAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.filter((s) => s.name === 'GET /ping')).toHaveLength(1);
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('echoAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc',
      name: 'GET /users',
      kind: 'route' as const,
      filePath: 'main.go',
      startByte: 0,
      endByte: 0,
      signature: 'e.GET("/users", ...)',
      summary: 'Echo route: GET /users',
      frameworkMeta: { http_method: 'GET', echo_route: true },
    };
    expect(echoAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});
