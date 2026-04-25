import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fastifyAdapter } from '../../src/adapters/fastify.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';
import { readFileSync } from 'fs';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/fastify-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-fastify-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('fastifyAdapter metadata', () => {
  it('has name "fastify"', () => {
    expect(fastifyAdapter.name).toBe('fastify');
  });

  it('declares no extra extensions', () => {
    expect(fastifyAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ───────────────────────────────────────────────────────────────

describe('fastifyAdapter.detect', () => {
  it('detects fastify in dependencies', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { fastify: '^4.0.0' },
    }));
    expect(await fastifyAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when fastify is absent', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { express: '^4.18.0' },
    }));
    expect(await fastifyAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false for missing package.json', async () => {
    const dir = tmpDir();
    expect(await fastifyAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture fastify project', async () => {
    expect(await fastifyAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ─────────────────────────────────────────────────────────────

describe('fastifyAdapter.fileFilter', () => {
  it('accepts .ts files', () => {
    expect(fastifyAdapter.fileFilter('src/app.ts')).toBe(true);
  });

  it('accepts .js files', () => {
    expect(fastifyAdapter.fileFilter('src/routes/users.js')).toBe(true);
  });

  it('rejects .json files', () => {
    expect(fastifyAdapter.fileFilter('package.json')).toBe(false);
  });
});

// ─── Route extraction ────────────────────────────────────────────────────────

describe('fastifyAdapter — route extraction', () => {
  it('extracts fastify.get route', () => {
    const source = `
import Fastify from 'fastify';
const fastify = Fastify();
fastify.get('/health', async () => ({ status: 'ok' }));
`;
    const symbols = fastifyAdapter.extractFrameworkSymbols(null, buf(source), 'src/app.ts');
    const route = symbols.find((s) => s.name === 'GET /health');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.http_framework).toBe('fastify');
  });

  it('extracts multiple HTTP methods', () => {
    const source = `
import Fastify from 'fastify';
const fastify = Fastify();
fastify.get('/items', handler);
fastify.post('/items', handler);
fastify.put('/items/:id', handler);
fastify.delete('/items/:id', handler);
`;
    const symbols = fastifyAdapter.extractFrameworkSymbols(null, buf(source), 'src/app.ts');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /items');
    expect(names).toContain('POST /items');
    expect(names).toContain('PUT /items/:id');
    expect(names).toContain('DELETE /items/:id');
  });

  it('extracts routes from fixture app.ts', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/app.ts'),
      'utf8',
    );
    const b = Buffer.from(source, 'utf8');
    const symbols = fastifyAdapter.extractFrameworkSymbols(null, b, 'src/app.ts');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /health');
    expect(names).toContain('POST /webhook');
  });

  it('extracts routes from plugin file (uses fastify param name)', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/users.ts'),
      'utf8',
    );
    const b = Buffer.from(source, 'utf8');
    const symbols = fastifyAdapter.extractFrameworkSymbols(null, b, 'src/users.ts');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /users');
    expect(names).toContain('GET /users/:id');
    expect(names).toContain('POST /users');
    expect(names).toContain('DELETE /users/:id');
  });
});

// ─── Plugin/middleware extraction ─────────────────────────────────────────────

describe('fastifyAdapter — plugin extraction', () => {
  it('extracts fastify.register with prefix as middleware', () => {
    const source = `
import Fastify from 'fastify';
const fastify = Fastify();
fastify.register(usersPlugin, { prefix: '/users' });
`;
    const symbols = fastifyAdapter.extractFrameworkSymbols(null, buf(source), 'src/app.ts');
    const plugin = symbols.find((s) => s.name === 'PLUGIN /users');
    expect(plugin).toBeDefined();
    expect(plugin!.kind).toBe('middleware');
    expect(plugin!.frameworkMeta?.route_prefix).toBe('/users');
  });

  it('extracts multiple register calls from fixture app.ts', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/app.ts'),
      'utf8',
    );
    const b = Buffer.from(source, 'utf8');
    const symbols = fastifyAdapter.extractFrameworkSymbols(null, b, 'src/app.ts');
    const plugins = symbols.filter((s) => s.kind === 'middleware');
    expect(plugins.length).toBeGreaterThanOrEqual(1);
    const names = plugins.map((s) => s.name);
    expect(names).toContain('PLUGIN /users');
  });
});

// ─── Heuristic filtering ──────────────────────────────────────────────────────

describe('fastifyAdapter — heuristic filtering', () => {
  it('skips files without fastify import/require', () => {
    const source = `
const server = { get: () => {} };
server.get('/path', handler);
`;
    const symbols = fastifyAdapter.extractFrameworkSymbols(null, buf(source), 'src/utils.ts');
    expect(symbols).toHaveLength(0);
  });

  it('skips unknown variable names even with fastify import', () => {
    const source = `
import Fastify from 'fastify';
const myCustom = Fastify();
myCustom.get('/path', handler);
`;
    const symbols = fastifyAdapter.extractFrameworkSymbols(null, buf(source), 'src/app.ts');
    // 'myCustom' is not in the Fastify allow-list
    expect(symbols).toHaveLength(0);
  });

  it('deduplicates identical routes', () => {
    const source = `
import Fastify from 'fastify';
const fastify = Fastify();
fastify.get('/ping', handler1);
fastify.get('/ping', handler2);
`;
    const symbols = fastifyAdapter.extractFrameworkSymbols(null, buf(source), 'src/app.ts');
    const pingRoutes = symbols.filter((s) => s.name === 'GET /ping');
    expect(pingRoutes).toHaveLength(1);
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('fastifyAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc',
      name: 'GET /health',
      kind: 'route' as const,
      filePath: 'src/app.ts',
      startByte: 0,
      endByte: 0,
      signature: "fastify.get('/health', ...)",
      summary: 'Fastify route: GET /health',
      frameworkMeta: { http_method: 'GET', http_framework: 'fastify' },
    };
    expect(fastifyAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});
