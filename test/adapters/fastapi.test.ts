import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fastapiAdapter } from '../../src/adapters/fastapi.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/fastapi-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-fastapi-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('fastapiAdapter metadata', () => {
  it('has name "fastapi"', () => {
    expect(fastapiAdapter.name).toBe('fastapi');
  });

  it('declares no extra extensions', () => {
    expect(fastapiAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('fastapiAdapter.detect', () => {
  it('detects fastapi in requirements.txt', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'requirements.txt'), 'fastapi>=0.100\n');
    expect(await fastapiAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects fastapi with no version specifier', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'requirements.txt'), 'fastapi\n');
    expect(await fastapiAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects fastapi in pyproject.toml', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\ndependencies = ["fastapi>=0.100"]\n');
    expect(await fastapiAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when fastapi is absent', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'requirements.txt'), 'Flask>=3.0\n');
    expect(await fastapiAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false for empty project', async () => {
    const dir = tmpDir();
    expect(await fastapiAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture fastapi project', async () => {
    expect(await fastapiAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('fastapiAdapter.fileFilter', () => {
  it('accepts .py files', () => {
    expect(fastapiAdapter.fileFilter('main.py')).toBe(true);
  });

  it('accepts .py files in subdirectories', () => {
    expect(fastapiAdapter.fileFilter('routers/users.py')).toBe(true);
  });

  it('rejects non-Python files', () => {
    expect(fastapiAdapter.fileFilter('requirements.txt')).toBe(false);
    expect(fastapiAdapter.fileFilter('main.ts')).toBe(false);
  });
});

// ─── Route extraction ─────────────────────────────────────────────────────────

describe('fastapiAdapter — @app.get/post/etc. extraction', () => {
  it('extracts @app.get', () => {
    const source = `
from fastapi import FastAPI
app = FastAPI()

@app.get("/health")
async def health():
    return {"status": "ok"}
`;
    const symbols = fastapiAdapter.extractFrameworkSymbols(null, buf(source), 'main.py');
    const route = symbols.find((s) => s.name === 'GET /health');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.route_path).toBe('/health');
    expect(route!.frameworkMeta?.fastapi_route).toBe(true);
  });

  it('extracts @app.post', () => {
    const source = `
from fastapi import FastAPI
app = FastAPI()

@app.post("/users")
async def create_user():
    return {"created": True}
`;
    const symbols = fastapiAdapter.extractFrameworkSymbols(null, buf(source), 'main.py');
    expect(symbols.find((s) => s.name === 'POST /users')).toBeDefined();
  });

  it('extracts @app.put', () => {
    const source = `
from fastapi import FastAPI
app = FastAPI()

@app.put("/users/{user_id}")
async def update_user(user_id: int):
    pass
`;
    const symbols = fastapiAdapter.extractFrameworkSymbols(null, buf(source), 'main.py');
    expect(symbols.find((s) => s.name === 'PUT /users/:user_id')).toBeDefined();
  });

  it('extracts @app.delete', () => {
    const source = `
from fastapi import FastAPI
app = FastAPI()

@app.delete("/users/{user_id}")
async def delete_user(user_id: int):
    pass
`;
    const symbols = fastapiAdapter.extractFrameworkSymbols(null, buf(source), 'main.py');
    expect(symbols.find((s) => s.name === 'DELETE /users/:user_id')).toBeDefined();
  });

  it('extracts @app.patch', () => {
    const source = `
from fastapi import FastAPI
app = FastAPI()

@app.patch("/users/{user_id}")
async def patch_user(user_id: int):
    pass
`;
    const symbols = fastapiAdapter.extractFrameworkSymbols(null, buf(source), 'main.py');
    expect(symbols.find((s) => s.name === 'PATCH /users/:user_id')).toBeDefined();
  });

  it('handles async and sync functions equally', () => {
    const source = `
from fastapi import FastAPI
app = FastAPI()

@app.get("/sync")
def sync_route():
    return {}

@app.get("/async")
async def async_route():
    return {}
`;
    const symbols = fastapiAdapter.extractFrameworkSymbols(null, buf(source), 'main.py');
    expect(symbols.find((s) => s.name === 'GET /sync')).toBeDefined();
    expect(symbols.find((s) => s.name === 'GET /async')).toBeDefined();
  });
});

// ─── Path parameter normalisation ────────────────────────────────────────────

describe('fastapiAdapter — path parameter normalisation', () => {
  it('normalises {param} to :param', () => {
    const source = `
from fastapi import FastAPI
app = FastAPI()

@app.get("/users/{user_id}")
async def get_user(user_id: int):
    pass
`;
    const symbols = fastapiAdapter.extractFrameworkSymbols(null, buf(source), 'main.py');
    const route = symbols.find((s) => s.name === 'GET /users/:user_id');
    expect(route).toBeDefined();
    // Raw path preserved in metadata
    expect(route!.frameworkMeta?.route_path).toBe('/users/{user_id}');
  });

  it('normalises multiple path params', () => {
    const source = `
from fastapi import FastAPI
app = FastAPI()

@app.get("/items/{item_id}/tags/{tag_id}")
async def get_tag(item_id: int, tag_id: int):
    pass
`;
    const symbols = fastapiAdapter.extractFrameworkSymbols(null, buf(source), 'main.py');
    expect(symbols.find((s) => s.name === 'GET /items/:item_id/tags/:tag_id')).toBeDefined();
  });
});

// ─── APIRouter routes ─────────────────────────────────────────────────────────

describe('fastapiAdapter — APIRouter routes', () => {
  it('extracts @router.get', () => {
    const source = `
from fastapi import APIRouter
router = APIRouter()

@router.get("/")
async def list_users():
    return []
`;
    const symbols = fastapiAdapter.extractFrameworkSymbols(null, buf(source), 'routers/users.py');
    expect(symbols.find((s) => s.name === 'GET /')).toBeDefined();
  });

  it('extracts @router.post', () => {
    const source = `
from fastapi import APIRouter
router = APIRouter()

@router.post("/")
async def create_user():
    return {"created": True}
`;
    const symbols = fastapiAdapter.extractFrameworkSymbols(null, buf(source), 'routers/users.py');
    expect(symbols.find((s) => s.name === 'POST /')).toBeDefined();
  });

  it('extracts routes from fixture routers/users.py', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'routers/users.py'), 'utf8');
    const symbols = fastapiAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'routers/users.py');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /');
    expect(names).toContain('GET /:user_id');
    expect(names).toContain('POST /');
    expect(names).toContain('PUT /:user_id');
    expect(names).toContain('DELETE /:user_id');
    expect(names).toContain('PATCH /:user_id');
  });

  it('extracts nested path param from fixture routers/items.py', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'routers/items.py'), 'utf8');
    const symbols = fastapiAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'routers/items.py');
    expect(symbols.find((s) => s.name === 'GET /:item_id/tags')).toBeDefined();
  });
});

// ─── FastAPI import guard ─────────────────────────────────────────────────────

describe('fastapiAdapter — FastAPI import guard', () => {
  it('skips files that do not import FastAPI', () => {
    const source = `
app = SomeOtherFramework()

@app.get('/path')
def handler():
    pass
`;
    const symbols = fastapiAdapter.extractFrameworkSymbols(null, buf(source), 'app.py');
    expect(symbols).toHaveLength(0);
  });

  it('does not confuse Flask files with FastAPI', () => {
    const source = `
from flask import Flask
app = Flask(__name__)

@app.get('/path')
def handler():
    pass
`;
    // Flask file — no fastapi import, should return empty
    const symbols = fastapiAdapter.extractFrameworkSymbols(null, buf(source), 'app.py');
    expect(symbols).toHaveLength(0);
  });

  it('processes files using import fastapi directly', () => {
    const source = `
import fastapi
app = fastapi.FastAPI()

@app.get('/ping')
async def ping():
    pass
`;
    const symbols = fastapiAdapter.extractFrameworkSymbols(null, buf(source), 'app.py');
    expect(symbols.find((s) => s.name === 'GET /ping')).toBeDefined();
  });
});

// ─── Deduplication ───────────────────────────────────────────────────────────

describe('fastapiAdapter — deduplication', () => {
  it('deduplicates identical routes', () => {
    const source = `
from fastapi import FastAPI
app = FastAPI()

@app.get("/ping")
async def ping1():
    pass

@app.get("/ping")
async def ping2():
    pass
`;
    const symbols = fastapiAdapter.extractFrameworkSymbols(null, buf(source), 'main.py');
    expect(symbols.filter((s) => s.name === 'GET /ping')).toHaveLength(1);
  });
});

// ─── Fixture: main.py ────────────────────────────────────────────────────────

describe('fastapiAdapter — fixture main.py', () => {
  it('extracts all routes from fixture main.py', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'main.py'), 'utf8');
    const symbols = fastapiAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'main.py');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /health');
    expect(names).toContain('GET /');
  });

  it('does not extract plain helper function', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'main.py'), 'utf8');
    const symbols = fastapiAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'main.py');
    expect(symbols.find((s) => s.name === 'plain_helper')).toBeUndefined();
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('fastapiAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc',
      name: 'GET /health',
      kind: 'route' as const,
      filePath: 'main.py',
      startByte: 0,
      endByte: 0,
      signature: "@app.get('/health', ...)",
      summary: 'FastAPI route: GET /health',
      frameworkMeta: { http_method: 'GET', fastapi_route: true },
    };
    expect(fastapiAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});
