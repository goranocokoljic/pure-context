import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { flaskAdapter } from '../../src/adapters/flask.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/flask-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-flask-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('flaskAdapter metadata', () => {
  it('has name "flask"', () => {
    expect(flaskAdapter.name).toBe('flask');
  });

  it('declares no extra extensions', () => {
    expect(flaskAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('flaskAdapter.detect', () => {
  it('detects Flask in requirements.txt', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'requirements.txt'), 'Flask>=3.0\n');
    expect(await flaskAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects flask (lowercase) in requirements.txt', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'requirements.txt'), 'flask==2.3.0\n');
    expect(await flaskAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects Flask in pyproject.toml', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\ndependencies = ["flask>=3.0"]\n');
    expect(await flaskAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when Flask is absent', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'requirements.txt'), 'fastapi>=0.100\n');
    expect(await flaskAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false for empty project', async () => {
    const dir = tmpDir();
    expect(await flaskAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture flask project', async () => {
    expect(await flaskAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('flaskAdapter.fileFilter', () => {
  it('accepts .py files', () => {
    expect(flaskAdapter.fileFilter('app.py')).toBe(true);
  });

  it('accepts .py files in subdirectories', () => {
    expect(flaskAdapter.fileFilter('blueprints/users.py')).toBe(true);
  });

  it('rejects non-Python files', () => {
    expect(flaskAdapter.fileFilter('requirements.txt')).toBe(false);
    expect(flaskAdapter.fileFilter('app.ts')).toBe(false);
    expect(flaskAdapter.fileFilter('config.json')).toBe(false);
  });
});

// ─── @app.route extraction ────────────────────────────────────────────────────

describe('flaskAdapter — @app.route extraction', () => {
  it('extracts a basic @app.route as GET by default', () => {
    const source = `
from flask import Flask
app = Flask(__name__)

@app.route('/health')
def health():
    return 'ok'
`;
    const symbols = flaskAdapter.extractFrameworkSymbols(null, buf(source), 'app.py');
    const route = symbols.find((s) => s.name === 'GET /health');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('route');
    expect(route!.frameworkMeta?.http_method).toBe('GET');
    expect(route!.frameworkMeta?.route_path).toBe('/health');
    expect(route!.frameworkMeta?.flask_route).toBe(true);
  });

  it('extracts multiple methods from methods=[...]', () => {
    const source = `
from flask import Flask
app = Flask(__name__)

@app.route('/items', methods=['GET', 'POST'])
def items():
    pass
`;
    const symbols = flaskAdapter.extractFrameworkSymbols(null, buf(source), 'app.py');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /items');
    expect(names).toContain('POST /items');
    expect(symbols.find((s) => s.name === 'GET /items')!.kind).toBe('route');
    expect(symbols.find((s) => s.name === 'POST /items')!.kind).toBe('route');
  });

  it('normalises Flask path parameters to :param format', () => {
    const source = `
from flask import Flask
app = Flask(__name__)

@app.route('/users/<int:user_id>')
def get_user(user_id):
    pass
`;
    const symbols = flaskAdapter.extractFrameworkSymbols(null, buf(source), 'app.py');
    const route = symbols.find((s) => s.name === 'GET /users/:user_id');
    expect(route).toBeDefined();
    expect(route!.frameworkMeta?.route_path).toBe('/users/<int:user_id>');
  });

  it('normalises untyped path parameters', () => {
    const source = `
from flask import Flask
app = Flask(__name__)

@app.route('/posts/<slug>')
def post(slug):
    pass
`;
    const symbols = flaskAdapter.extractFrameworkSymbols(null, buf(source), 'app.py');
    expect(symbols.find((s) => s.name === 'GET /posts/:slug')).toBeDefined();
  });
});

// ─── Shorthand decorator extraction ──────────────────────────────────────────

describe('flaskAdapter — shorthand decorators', () => {
  it('extracts @app.get', () => {
    const source = `
from flask import Flask
app = Flask(__name__)

@app.get('/users')
def list_users():
    pass
`;
    const symbols = flaskAdapter.extractFrameworkSymbols(null, buf(source), 'app.py');
    expect(symbols.find((s) => s.name === 'GET /users')).toBeDefined();
  });

  it('extracts @app.post', () => {
    const source = `
from flask import Flask
app = Flask(__name__)

@app.post('/users')
def create_user():
    pass
`;
    const symbols = flaskAdapter.extractFrameworkSymbols(null, buf(source), 'app.py');
    expect(symbols.find((s) => s.name === 'POST /users')).toBeDefined();
  });

  it('extracts @app.put', () => {
    const source = `
from flask import Flask
app = Flask(__name__)

@app.put('/users/<int:id>')
def update_user(id):
    pass
`;
    const symbols = flaskAdapter.extractFrameworkSymbols(null, buf(source), 'app.py');
    expect(symbols.find((s) => s.name === 'PUT /users/:id')).toBeDefined();
  });

  it('extracts @app.delete', () => {
    const source = `
from flask import Flask
app = Flask(__name__)

@app.delete('/users/<int:id>')
def delete_user(id):
    pass
`;
    const symbols = flaskAdapter.extractFrameworkSymbols(null, buf(source), 'app.py');
    expect(symbols.find((s) => s.name === 'DELETE /users/:id')).toBeDefined();
  });

  it('extracts @app.patch', () => {
    const source = `
from flask import Flask
app = Flask(__name__)

@app.patch('/users/<int:id>')
def patch_user(id):
    pass
`;
    const symbols = flaskAdapter.extractFrameworkSymbols(null, buf(source), 'app.py');
    expect(symbols.find((s) => s.name === 'PATCH /users/:id')).toBeDefined();
  });
});

// ─── Blueprint routes ─────────────────────────────────────────────────────────

describe('flaskAdapter — Blueprint routes', () => {
  it('extracts blueprint @bp.route', () => {
    const source = `
from flask import Blueprint
bp = Blueprint('users', __name__)

@bp.route('/')
def list_users():
    pass
`;
    const symbols = flaskAdapter.extractFrameworkSymbols(null, buf(source), 'blueprints/users.py');
    expect(symbols.find((s) => s.name === 'GET /')).toBeDefined();
  });

  it('extracts blueprint shorthand @bp.post', () => {
    const source = `
from flask import Blueprint
bp = Blueprint('users', __name__)

@bp.post('/')
def create_user():
    pass
`;
    const symbols = flaskAdapter.extractFrameworkSymbols(null, buf(source), 'blueprints/users.py');
    expect(symbols.find((s) => s.name === 'POST /')).toBeDefined();
  });

  it('extracts routes from fixture blueprints/users.py', () => {
    const { readFileSync } = require('fs');
    const source = readFileSync(join(FIXTURE_ROOT, 'blueprints/users.py'), 'utf8');
    const symbols = flaskAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'blueprints/users.py');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('GET /');
    expect(names).toContain('GET /:user_id');
    expect(names).toContain('POST /');
    expect(names).toContain('PUT /:user_id');
    expect(names).toContain('DELETE /:user_id');
  });
});

// ─── Class-based views ────────────────────────────────────────────────────────

describe('flaskAdapter — class-based views', () => {
  it('extracts MethodView subclass as view symbol', () => {
    const source = `
from flask import Flask
from flask.views import MethodView
app = Flask(__name__)

class TokenView(MethodView):
    def get(self):
        pass
`;
    const symbols = flaskAdapter.extractFrameworkSymbols(null, buf(source), 'app.py');
    const view = symbols.find((s) => s.kind === 'view');
    expect(view).toBeDefined();
    expect(view!.name).toBe('TokenView');
    expect(view!.frameworkMeta?.flask_class_view).toBe(true);
  });

  it('extracts plain View subclass as view symbol', () => {
    const source = `
from flask import Flask
from flask.views import View
app = Flask(__name__)

class MyView(View):
    pass
`;
    const symbols = flaskAdapter.extractFrameworkSymbols(null, buf(source), 'app.py');
    expect(symbols.find((s) => s.name === 'MyView' && s.kind === 'view')).toBeDefined();
  });
});

// ─── Guard: no Flask import ───────────────────────────────────────────────────

describe('flaskAdapter — Flask import guard', () => {
  it('skips files that do not import Flask', () => {
    const source = `
app = SomeOtherFramework()

@app.route('/path')
def handler():
    pass
`;
    const symbols = flaskAdapter.extractFrameworkSymbols(null, buf(source), 'app.py');
    expect(symbols).toHaveLength(0);
  });

  it('processes files that import flask (lowercase)', () => {
    const source = `
import flask
app = flask.Flask(__name__)

@app.route('/ping')
def ping():
    pass
`;
    const symbols = flaskAdapter.extractFrameworkSymbols(null, buf(source), 'app.py');
    expect(symbols.find((s) => s.name === 'GET /ping')).toBeDefined();
  });
});

// ─── Deduplication ───────────────────────────────────────────────────────────

describe('flaskAdapter — deduplication', () => {
  it('deduplicates identical routes', () => {
    const source = `
from flask import Flask
app = Flask(__name__)

@app.route('/ping')
def ping1():
    pass

@app.route('/ping')
def ping2():
    pass
`;
    const symbols = flaskAdapter.extractFrameworkSymbols(null, buf(source), 'app.py');
    const pings = symbols.filter((s) => s.name === 'GET /ping');
    expect(pings).toHaveLength(1);
  });
});

// ─── Fixture: app.py ─────────────────────────────────────────────────────────

describe('flaskAdapter — fixture app.py', () => {
  it('extracts all expected routes from fixture', () => {
    const { readFileSync } = require('fs');
    const source = readFileSync(join(FIXTURE_ROOT, 'app.py'), 'utf8');
    const symbols = flaskAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'app.py');
    const names = symbols.map((s) => s.name);

    expect(names).toContain('GET /health');
    expect(names).toContain('GET /items');
    expect(names).toContain('POST /items');
    expect(names).toContain('GET /items/:item_id');
    expect(names).toContain('PUT /items/:item_id');
    expect(names).toContain('DELETE /items/:item_id');
  });

  it('extracts class-based view from fixture', () => {
    const { readFileSync } = require('fs');
    const source = readFileSync(join(FIXTURE_ROOT, 'app.py'), 'utf8');
    const symbols = flaskAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'app.py');
    expect(symbols.find((s) => s.name === 'TokenView' && s.kind === 'view')).toBeDefined();
  });

  it('does not extract plain helper function as route', () => {
    const { readFileSync } = require('fs');
    const source = readFileSync(join(FIXTURE_ROOT, 'app.py'), 'utf8');
    const symbols = flaskAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'app.py');
    expect(symbols.find((s) => s.name === 'plain_helper')).toBeUndefined();
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('flaskAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc',
      name: 'GET /health',
      kind: 'route' as const,
      filePath: 'app.py',
      startByte: 0,
      endByte: 0,
      signature: "@app.route('/health')",
      summary: 'Flask route: GET /health',
      frameworkMeta: { http_method: 'GET', flask_route: true },
    };
    expect(flaskAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});
