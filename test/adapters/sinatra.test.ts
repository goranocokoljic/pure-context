import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sinatraAdapter } from '../../src/adapters/sinatra.js';
import type { SymbolRecord } from '../../src/core/types.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/sinatra-project');

function buf(source: string): Buffer {
  return Buffer.from(source);
}

function readFixture(rel: string): Buffer {
  return Buffer.from(readFileSync(resolve(FIXTURE_ROOT, rel), 'utf8'));
}

function extractFrom(rel: string): SymbolRecord[] {
  return sinatraAdapter.extractFrameworkSymbols(null, readFixture(rel), rel);
}

// ─── detect ──────────────────────────────────────────────────────────────────

describe('sinatraAdapter — detect', () => {
  it('returns true for Gemfile with sinatra gem', async () => {
    expect(await sinatraAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });

  it('returns true when root .rb file has require sinatra', async () => {
    // The fixture app.rb has require 'sinatra'
    expect(await sinatraAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });

  it('returns false when no Gemfile and no require sinatra', async () => {
    expect(await sinatraAdapter.detect('/nonexistent/path')).toBe(false);
  });
});

// ─── metadata ─────────────────────────────────────────────────────────────────

describe('sinatraAdapter metadata', () => {
  it('name is sinatra', () => {
    expect(sinatraAdapter.name).toBe('sinatra');
  });

  it('extensions returns empty array', () => {
    expect(sinatraAdapter.extensions()).toEqual([]);
  });
});

// ─── fileFilter ───────────────────────────────────────────────────────────────

describe('sinatraAdapter.fileFilter', () => {
  it('accepts .rb files', () => {
    expect(sinatraAdapter.fileFilter('app.rb')).toBe(true);
    expect(sinatraAdapter.fileFilter('lib/routes.rb')).toBe(true);
    expect(sinatraAdapter.fileFilter('app/api.rb')).toBe(true);
  });

  it('rejects non-rb files', () => {
    expect(sinatraAdapter.fileFilter('app.js')).toBe(false);
    expect(sinatraAdapter.fileFilter('config.yml')).toBe(false);
    expect(sinatraAdapter.fileFilter('Gemfile')).toBe(false);
  });
});

// ─── classic-style routes ─────────────────────────────────────────────────────

describe('sinatraAdapter — classic style routes (app.rb fixture)', () => {
  it('extracts GET route', () => {
    const syms = extractFrom('app.rb');
    const route = syms.find((s) => s.name === 'GET /users');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.sinatra_route).toBe(true);
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.route_path).toBe('/users');
  });

  it('extracts GET route with dynamic segment', () => {
    const syms = extractFrom('app.rb');
    const route = syms.find((s) => s.name === 'GET /users/:id');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.route_path).toBe('/users/:id');
  });

  it('extracts POST route', () => {
    const syms = extractFrom('app.rb');
    expect(syms.find((s) => s.name === 'POST /users')).toBeDefined();
  });

  it('extracts PUT route', () => {
    const syms = extractFrom('app.rb');
    expect(syms.find((s) => s.name === 'PUT /users/:id')).toBeDefined();
  });

  it('extracts DELETE route', () => {
    const syms = extractFrom('app.rb');
    expect(syms.find((s) => s.name === 'DELETE /users/:id')).toBeDefined();
  });

  it('extracts PATCH route', () => {
    const syms = extractFrom('app.rb');
    expect(syms.find((s) => s.name === 'PATCH /users/:id')).toBeDefined();
  });

  it('all extracted symbols have kind route', () => {
    const syms = extractFrom('app.rb');
    expect(syms.every((s) => s.kind === 'route')).toBe(true);
  });
});

// ─── modular-style routes ─────────────────────────────────────────────────────

describe('sinatraAdapter — modular style routes (api.rb fixture)', () => {
  it('extracts GET /items inside class body', () => {
    const syms = extractFrom('api.rb');
    const route = syms.find((s) => s.name === 'GET /items');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.sinatra_route).toBe(true);
  });

  it('extracts POST /items inside class body', () => {
    const syms = extractFrom('api.rb');
    expect(syms.find((s) => s.name === 'POST /items')).toBeDefined();
  });

  it('extracts GET /items/:id inside class body', () => {
    const syms = extractFrom('api.rb');
    expect(syms.find((s) => s.name === 'GET /items/:id')).toBeDefined();
  });

  it('extracts DELETE /items/:id inside class body', () => {
    const syms = extractFrom('api.rb');
    expect(syms.find((s) => s.name === 'DELETE /items/:id')).toBeDefined();
  });
});

// ─── inline source tests ──────────────────────────────────────────────────────

describe('sinatraAdapter — extractFrameworkSymbols inline', () => {
  it('extracts a single get route', () => {
    const source = `get '/health' do\n  'ok'\nend\n`;
    const syms = sinatraAdapter.extractFrameworkSymbols(null, buf(source), 'app.rb');
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe('GET /health');
    expect(syms[0]!.kind).toBe('route');
  });

  it('extracts a post route with double-quoted path', () => {
    const source = `post "/login" do\n  # ...\nend\n`;
    const syms = sinatraAdapter.extractFrameworkSymbols(null, buf(source), 'app.rb');
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe('POST /login');
  });

  it('does not extract plain method calls that are not routes', () => {
    const source = `def greet(name)\n  "Hello"\nend\nputs 'hello'\n`;
    const syms = sinatraAdapter.extractFrameworkSymbols(null, buf(source), 'app.rb');
    expect(syms).toHaveLength(0);
  });

  it('does not extract require statements', () => {
    const source = `require 'sinatra'\nget '/users' do\n  '[]'\nend\n`;
    const syms = sinatraAdapter.extractFrameworkSymbols(null, buf(source), 'app.rb');
    // Only the route, not the require
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe('GET /users');
  });

  it('handles nested path segments', () => {
    const source = `get '/api/v1/users/:id/posts' do\n  '[]'\nend\n`;
    const syms = sinatraAdapter.extractFrameworkSymbols(null, buf(source), 'app.rb');
    expect(syms[0]!.name).toBe('GET /api/v1/users/:id/posts');
    expect(syms[0]!.frameworkMeta?.route_path).toBe('/api/v1/users/:id/posts');
  });

  it('gives route a deterministic 16-char hex id', () => {
    const source = `get '/ping' do\n  'pong'\nend\n`;
    const s1 = sinatraAdapter.extractFrameworkSymbols(null, buf(source), 'app.rb')[0]!;
    const s2 = sinatraAdapter.extractFrameworkSymbols(null, buf(source), 'app.rb')[0]!;
    expect(s1.id).toHaveLength(16);
    expect(s1.id).toMatch(/^[0-9a-f]+$/);
    expect(s1.id).toBe(s2.id);
  });

  it('route signature contains the http method and path', () => {
    const source = `post '/orders' do\n  '{}'\nend\n`;
    const sym = sinatraAdapter.extractFrameworkSymbols(null, buf(source), 'app.rb')[0]!;
    expect(sym.signature).toContain('post');
    expect(sym.signature).toContain('/orders');
  });

  it('extracts multiple routes from one file', () => {
    const source = `get '/a' do\nend\npost '/b' do\nend\ndelete '/c' do\nend\n`;
    const syms = sinatraAdapter.extractFrameworkSymbols(null, buf(source), 'app.rb');
    expect(syms).toHaveLength(3);
    const names = syms.map((s) => s.name);
    expect(names).toContain('GET /a');
    expect(names).toContain('POST /b');
    expect(names).toContain('DELETE /c');
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('sinatraAdapter.enrichMetadata', () => {
  it('returns the symbol unchanged', () => {
    const sym: SymbolRecord = {
      id: 'abc123def456789a',
      name: 'GET /users',
      kind: 'route',
      filePath: 'app.rb',
      startByte: 0,
      endByte: 0,
      signature: "get '/users'",
      summary: 'Sinatra route: GET /users',
    };
    expect(sinatraAdapter.enrichMetadata!(sym)).toBe(sym);
  });
});
