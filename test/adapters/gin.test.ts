import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { ginAdapter } from '../../src/adapters/gin.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/gin-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-gin-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('ginAdapter metadata', () => {
  it('has name "gin"', () => {
    expect(ginAdapter.name).toBe('gin');
  });

  it('declares no extra extensions', () => {
    expect(ginAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('ginAdapter.detect', () => {
  it('detects gin in go.mod', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'go.mod'), 'module example\n\nrequire github.com/gin-gonic/gin v1.9.1\n');
    expect(await ginAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when gin is absent', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'go.mod'), 'module example\n\nrequire github.com/labstack/echo v4.0.0\n');
    expect(await ginAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false without go.mod', async () => {
    const dir = tmpDir();
    expect(await ginAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture gin project', async () => {
    expect(await ginAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('ginAdapter.fileFilter', () => {
  it('accepts .go files', () => {
    expect(ginAdapter.fileFilter('main.go')).toBe(true);
    expect(ginAdapter.fileFilter('handlers/users.go')).toBe(true);
  });

  it('rejects non-Go files', () => {
    expect(ginAdapter.fileFilter('go.mod')).toBe(false);
    expect(ginAdapter.fileFilter('main.ts')).toBe(false);
  });
});

// ─── Route extraction ─────────────────────────────────────────────────────────

describe('ginAdapter — route extraction', () => {
  it('extracts r.GET route', () => {
    const source = `
package main

import "github.com/gin-gonic/gin"

func main() {
	r := gin.Default()
	r.GET("/health", func(c *gin.Context) {})
}
`;
    const symbols = ginAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    const route = symbols.find((s) => s.name === 'GET /health');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.route_path).toBe('/health');
    expect(route!.frameworkMeta?.gin_route).toBe(true);
  });

  it('extracts r.POST route', () => {
    const source = `
package main
import "github.com/gin-gonic/gin"
func main() {
	r := gin.Default()
	r.POST("/users", createUser)
}
`;
    const symbols = ginAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.find((s) => s.name === 'POST /users')).toBeDefined();
  });

  it('extracts all HTTP methods', () => {
    const source = `
package main
import "github.com/gin-gonic/gin"
func main() {
	r := gin.Default()
	r.GET("/x", h)
	r.POST("/x", h)
	r.PUT("/x/:id", h)
	r.PATCH("/x/:id", h)
	r.DELETE("/x/:id", h)
	r.HEAD("/x", h)
	r.OPTIONS("/x", h)
}
`;
    const symbols = ginAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /x');
    expect(names).toContain('POST /x');
    expect(names).toContain('PUT /x/:id');
    expect(names).toContain('PATCH /x/:id');
    expect(names).toContain('DELETE /x/:id');
    expect(names).toContain('HEAD /x');
    expect(names).toContain('OPTIONS /x');
  });

  it('extracts r.Any route', () => {
    const source = `
package main
import "github.com/gin-gonic/gin"
func main() {
	r := gin.Default()
	r.Any("/ping", pingHandler)
}
`;
    const symbols = ginAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.find((s) => s.name === 'ANY /ping')).toBeDefined();
  });

  it('accepts router variable name', () => {
    const source = `
package main
import "github.com/gin-gonic/gin"
func main() {
	router := gin.New()
	router.GET("/users", listUsers)
}
`;
    const symbols = ginAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.find((s) => s.name === 'GET /users')).toBeDefined();
  });

  it('accepts engine variable name', () => {
    const source = `
package main
import "github.com/gin-gonic/gin"
func main() {
	engine := gin.Default()
	engine.POST("/items", createItem)
}
`;
    const symbols = ginAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.find((s) => s.name === 'POST /items')).toBeDefined();
  });

  it('accepts v1 group variable name', () => {
    const source = `
package main
import "github.com/gin-gonic/gin"
func main() {
	r := gin.Default()
	v1 := r.Group("/v1")
	v1.GET("/users", listUsers)
}
`;
    const symbols = ginAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.find((s) => s.name === 'GET /users')).toBeDefined();
  });

  it('accepts variable ending in Router', () => {
    const source = `
package main
import "github.com/gin-gonic/gin"
func main() {
	userRouter := gin.Default()
	userRouter.GET("/users", listUsers)
}
`;
    const symbols = ginAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.find((s) => s.name === 'GET /users')).toBeDefined();
  });

  it('extracts routes from fixture main.go', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'main.go'), 'utf8');
    const symbols = ginAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'main.go');
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

describe('ginAdapter — middleware extraction', () => {
  it('extracts r.Use as middleware symbol', () => {
    const source = `
package main
import "github.com/gin-gonic/gin"
func main() {
	r := gin.Default()
	r.Use(AuthMiddleware)
}
`;
    const symbols = ginAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    const mw = symbols.find((s) => s.kind === 'middleware');
    expect(mw).toBeDefined();
    expect(mw!.name).toBe('AuthMiddleware');
    expect(mw!.frameworkMeta?.gin_middleware).toBe(true);
  });

  it('extracts middleware from fixture main.go', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'main.go'), 'utf8');
    const symbols = ginAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'main.go');
    const mwNames = symbols.filter((s) => s.kind === 'middleware').map((s) => s.name);
    expect(mwNames).toContain('AuthMiddleware');
    expect(mwNames).toContain('Logger');
  });
});

// ─── Gin import guard ─────────────────────────────────────────────────────────

describe('ginAdapter — Gin import guard', () => {
  it('skips files that do not import gin', () => {
    const source = `
package main

func main() {
	r := someOtherFramework.New()
	r.GET("/users", handler)
}
`;
    const symbols = ginAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols).toHaveLength(0);
  });

  it('skips unknown variable names even with gin import', () => {
    const source = `
package main
import "github.com/gin-gonic/gin"
func main() {
	connection := gin.Default()
	connection.GET("/path", handler)
}
`;
    const symbols = ginAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    // 'connection' is not a recognised Gin variable name
    expect(symbols.filter((s) => s.kind === 'route')).toHaveLength(0);
  });
});

// ─── Deduplication ───────────────────────────────────────────────────────────

describe('ginAdapter — deduplication', () => {
  it('deduplicates identical routes', () => {
    const source = `
package main
import "github.com/gin-gonic/gin"
func main() {
	r := gin.Default()
	r.GET("/ping", handler1)
	r.GET("/ping", handler2)
}
`;
    const symbols = ginAdapter.extractFrameworkSymbols(null, buf(source), 'main.go');
    expect(symbols.filter((s) => s.name === 'GET /ping')).toHaveLength(1);
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('ginAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc',
      name: 'GET /users',
      kind: 'route' as const,
      filePath: 'main.go',
      startByte: 0,
      endByte: 0,
      signature: 'r.GET("/users", ...)',
      summary: 'Gin route: GET /users',
      frameworkMeta: { http_method: 'GET', gin_route: true },
    };
    expect(ginAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});
