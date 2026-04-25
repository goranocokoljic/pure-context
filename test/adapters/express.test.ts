import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { expressAdapter } from '../../src/adapters/express.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';
import { readFileSync } from 'fs';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/express-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-express-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('expressAdapter metadata', () => {
  it('has name "express"', () => {
    expect(expressAdapter.name).toBe('express');
  });

  it('declares no extra extensions', () => {
    expect(expressAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ───────────────────────────────────────────────────────────────

describe('expressAdapter.detect', () => {
  it('detects express in dependencies', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { express: '^4.18.0' },
    }));
    expect(await expressAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects express in devDependencies', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      devDependencies: { express: '^4.18.0' },
    }));
    expect(await expressAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when express is absent', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { fastify: '^4.0.0' },
    }));
    expect(await expressAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false for missing package.json', async () => {
    const dir = tmpDir();
    expect(await expressAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture express project', async () => {
    expect(await expressAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ─────────────────────────────────────────────────────────────

describe('expressAdapter.fileFilter', () => {
  it('accepts .ts files', () => {
    expect(expressAdapter.fileFilter('src/app.ts')).toBe(true);
  });

  it('accepts .js files', () => {
    expect(expressAdapter.fileFilter('src/routes/users.js')).toBe(true);
  });

  it('rejects .json files', () => {
    expect(expressAdapter.fileFilter('package.json')).toBe(false);
  });
});

// ─── Route extraction — app variable ─────────────────────────────────────────

describe('expressAdapter — route extraction with app', () => {
  it('extracts app.get route', () => {
    const source = `
import express from 'express';
const app = express();
app.get('/health', (req, res) => res.json({ ok: true }));
`;
    const symbols = expressAdapter.extractFrameworkSymbols(null, buf(source), 'src/app.ts');
    const route = symbols.find((s) => s.name === 'GET /health');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.http_framework).toBe('express');
  });

  it('extracts app.post route', () => {
    const source = `
import express from 'express';
const app = express();
app.post('/users', (req, res) => res.json(req.body));
`;
    const symbols = expressAdapter.extractFrameworkSymbols(null, buf(source), 'src/app.ts');
    const route = symbols.find((s) => s.name === 'POST /users');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
  });

  it('extracts multiple HTTP methods', () => {
    const source = `
import express from 'express';
const app = express();
app.get('/items', handler);
app.post('/items', handler);
app.put('/items/:id', handler);
app.patch('/items/:id', handler);
app.delete('/items/:id', handler);
`;
    const symbols = expressAdapter.extractFrameworkSymbols(null, buf(source), 'src/app.ts');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /items');
    expect(names).toContain('POST /items');
    expect(names).toContain('PUT /items/:id');
    expect(names).toContain('PATCH /items/:id');
    expect(names).toContain('DELETE /items/:id');
  });
});

// ─── Route extraction — router variable ──────────────────────────────────────

describe('expressAdapter — route extraction with router', () => {
  it('extracts router.get route', () => {
    const source = `
import { Router } from 'express';
const router = Router();
router.get('/users', handler);
`;
    const symbols = expressAdapter.extractFrameworkSymbols(null, buf(source), 'src/routes/users.ts');
    const route = symbols.find((s) => s.name === 'GET /users');
    expect(route).toBeDefined();
  });

  it('extracts routes from fixture users route file', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/routes/users.ts'),
      'utf8',
    );
    const b = Buffer.from(source, 'utf8');
    const symbols = expressAdapter.extractFrameworkSymbols(null, b, 'src/routes/users.ts');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /users');
    expect(names).toContain('GET /users/:id');
    expect(names).toContain('POST /users');
    expect(names).toContain('PUT /users/:id');
    expect(names).toContain('DELETE /users/:id');
  });
});

// ─── Middleware extraction ────────────────────────────────────────────────────

describe('expressAdapter — middleware extraction', () => {
  it('extracts app.use as middleware symbol', () => {
    const source = `
import express from 'express';
const app = express();
app.use('/api', apiRouter);
`;
    const symbols = expressAdapter.extractFrameworkSymbols(null, buf(source), 'src/app.ts');
    const mw = symbols.find((s) => s.name === 'MW /api');
    expect(mw).toBeDefined();
    expect(mw!.kind).toBe('middleware');
  });

  it('extracts middleware from fixture app.ts', () => {
    const source = readFileSync(
      join(FIXTURE_ROOT, 'src/app.ts'),
      'utf8',
    );
    const b = Buffer.from(source, 'utf8');
    const symbols = expressAdapter.extractFrameworkSymbols(null, b, 'src/app.ts');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /health');
    expect(names.some((n) => n.startsWith('MW '))).toBe(true);
  });
});

// ─── Heuristic filtering ──────────────────────────────────────────────────────

describe('expressAdapter — heuristic filtering', () => {
  it('skips files without express import/require', () => {
    const source = `
const myObj = { get: () => {} };
myObj.get('/path', handler);
`;
    const symbols = expressAdapter.extractFrameworkSymbols(null, buf(source), 'src/utils.ts');
    expect(symbols).toHaveLength(0);
  });

  it('skips unknown variable names even with express import', () => {
    const source = `
import express from 'express';
const connection = express();
connection.get('/path', handler);
`;
    const symbols = expressAdapter.extractFrameworkSymbols(null, buf(source), 'src/db.ts');
    expect(symbols).toHaveLength(0);
  });

  it('accepts custom Router variable ending in "Router"', () => {
    const source = `
import { Router } from 'express';
const usersRouter = Router();
usersRouter.get('/list', handler);
`;
    const symbols = expressAdapter.extractFrameworkSymbols(null, buf(source), 'src/routes/users.ts');
    const route = symbols.find((s) => s.name === 'GET /list');
    expect(route).toBeDefined();
  });

  it('deduplicates identical routes', () => {
    const source = `
import express from 'express';
const app = express();
app.get('/ping', handler1);
app.get('/ping', handler2);
`;
    const symbols = expressAdapter.extractFrameworkSymbols(null, buf(source), 'src/app.ts');
    const pingRoutes = symbols.filter((s) => s.name === 'GET /ping');
    expect(pingRoutes).toHaveLength(1);
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('expressAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc',
      name: 'GET /health',
      kind: 'route' as const,
      filePath: 'src/app.ts',
      startByte: 0,
      endByte: 0,
      signature: "app.get('/health', ...)",
      summary: 'Express route: GET /health',
      frameworkMeta: { http_method: 'GET', http_framework: 'express' },
    };
    expect(expressAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});
