/**
 * Task 517 (Phase 84): Python import resolver.
 *
 * Seeds an in-memory DB with .py files (+ symbols for the tiebreak) and
 * asserts that absolute, from-import, and relative specifiers resolve to the
 * right repo files. Python module identity IS the path — no stored header.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createPythonResolver,
  isPythonSourceFile,
} from '../../src/graph/python-resolver.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { upsertFile } from '../../src/core/db/file-store.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import type { SymbolRecord, SymbolKind } from '../../src/core/types.js';

const REPO = 'pytest01';

function sym(name: string, filePath: string, kind: SymbolKind = 'function'): SymbolRecord {
  return {
    id: `${name}-${filePath}`.replace(/[^a-z0-9]/gi, '').slice(0, 16).padEnd(16, '0'),
    name,
    kind,
    filePath,
    startByte: 0,
    endByte: 10,
    signature: name,
    summary: name,
  };
}

function seedDb() {
  const db = openInMemoryDatabase();
  upsertRepo(db, {
    id: REPO,
    rootPath: '/tmp/pytest01',
    symbolCount: 0,
    fileCount: 0,
    languages: [],
    indexedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
    clonePath: null,
    tenantId: 'local',
  });
  return db;
}

function addFile(db: ReturnType<typeof seedDb>, path: string) {
  upsertFile(db, REPO, path, 'hash', undefined, 'local');
}

describe('isPythonSourceFile', () => {
  it('accepts .py and rejects others', () => {
    expect(isPythonSourceFile('a/b.py')).toBe(true);
    expect(isPythonSourceFile('a/B.PY')).toBe(true);
    expect(isPythonSourceFile('a/b.go')).toBe(false);
    expect(isPythonSourceFile('a/noext')).toBe(false);
  });
});

describe('createPythonResolver', () => {
  let db: ReturnType<typeof seedDb>;

  beforeEach(() => {
    db = seedDb();
  });

  afterEach(() => {
    db.close();
  });

  it('resolves a plain absolute import to the module file', () => {
    addFile(db, 'pkg/__init__.py');
    addFile(db, 'pkg/util.py');
    addFile(db, 'main.py');
    const r = createPythonResolver(db, REPO);
    expect(r.resolve('pkg.util', 'main.py', [])).toEqual(['pkg/util.py']);
  });

  it('resolves a package import to its __init__.py', () => {
    addFile(db, 'pkg/__init__.py');
    addFile(db, 'main.py');
    const r = createPythonResolver(db, REPO);
    expect(r.resolve('pkg', 'main.py', [])).toEqual(['pkg/__init__.py']);
  });

  it('from-import prefers the submodule over the package __init__', () => {
    addFile(db, 'pkg/__init__.py');
    addFile(db, 'pkg/models.py');
    addFile(db, 'main.py');
    const r = createPythonResolver(db, REPO);
    // from pkg import models → pkg/models.py, not pkg/__init__.py
    expect(r.resolve('pkg', 'main.py', ['models'])).toEqual(['pkg/models.py']);
  });

  it('from-import of a plain member resolves to the module file', () => {
    addFile(db, 'pkg/__init__.py');
    addFile(db, 'pkg/util.py');
    addFile(db, 'main.py');
    const r = createPythonResolver(db, REPO);
    // from pkg.util import format_number → pkg/util.py
    expect(r.resolve('pkg.util', 'main.py', ['format_number'])).toEqual(['pkg/util.py']);
  });

  it('resolves a single-dot relative import (from . import sibling)', () => {
    addFile(db, 'pkg/__init__.py');
    addFile(db, 'pkg/a.py');
    addFile(db, 'pkg/b.py');
    const r = createPythonResolver(db, REPO);
    expect(r.resolve('.', 'pkg/a.py', ['b'])).toEqual(['pkg/b.py']);
  });

  it('from . import falls back to the package __init__ for plain members', () => {
    addFile(db, 'pkg/__init__.py');
    addFile(db, 'pkg/a.py');
    const r = createPythonResolver(db, REPO);
    // from . import helper — no pkg/helper.py, so the member lives in __init__
    expect(r.resolve('.', 'pkg/a.py', ['helper'])).toEqual(['pkg/__init__.py']);
  });

  it('resolves a two-dot relative import (from ..util import x)', () => {
    addFile(db, 'pkg/util.py');
    addFile(db, 'pkg/sub/deep.py');
    const r = createPythonResolver(db, REPO);
    expect(r.resolve('..util', 'pkg/sub/deep.py', ['x'])).toEqual(['pkg/util.py']);
  });

  it('resolves a dotted relative import (from .models import User)', () => {
    addFile(db, 'app/models.py');
    addFile(db, 'app/views.py');
    const r = createPythonResolver(db, REPO);
    expect(r.resolve('.models', 'app/views.py', ['User'])).toEqual(['app/models.py']);
  });

  it('relative import ascending above the repo root resolves to nothing', () => {
    addFile(db, 'a.py');
    addFile(db, 'b.py');
    const r = createPythonResolver(db, REPO);
    expect(r.resolve('..missing', 'a.py', ['x'])).toEqual([]);
  });

  it('resolves through a src/ layout root', () => {
    addFile(db, 'src/mypkg/__init__.py');
    addFile(db, 'src/mypkg/core.py');
    addFile(db, 'tests/test_core.py');
    const r = createPythonResolver(db, REPO);
    // tests import mypkg.core without the src/ prefix
    expect(r.resolve('mypkg.core', 'tests/test_core.py', ['run'])).toEqual([
      'src/mypkg/core.py',
    ]);
  });

  it('does not strip a first-level dir that is itself a package', () => {
    addFile(db, 'mypkg/__init__.py');
    addFile(db, 'mypkg/core.py');
    addFile(db, 'main.py');
    const r = createPythonResolver(db, REPO);
    // `import core` must NOT resolve — mypkg is a package, so core is only
    // importable as mypkg.core
    expect(r.resolve('core', 'main.py', [])).toEqual([]);
    expect(r.resolve('mypkg.core', 'main.py', [])).toEqual(['mypkg/core.py']);
  });

  it('external modules (numpy, django) resolve to nothing', () => {
    addFile(db, 'main.py');
    const r = createPythonResolver(db, REPO);
    expect(r.resolve('numpy', 'main.py', [])).toEqual([]);
    expect(r.resolve('django.db', 'main.py', ['models'])).toEqual([]);
  });

  it('uses the symbol table as a tiebreak when a module name is ambiguous', () => {
    // Both register under the stripped name "util" (lib/ and tools/ are not packages)
    addFile(db, 'lib/util.py');
    addFile(db, 'tools/util.py');
    addFile(db, 'main.py');
    insertSymbols(db, REPO, [sym('format_number', 'lib/util.py')]);
    const r = createPythonResolver(db, REPO);
    expect(r.resolve('util', 'main.py', ['format_number'])).toEqual(['lib/util.py']);
  });

  it('never emits a self-edge', () => {
    addFile(db, 'pkg/__init__.py');
    addFile(db, 'pkg/a.py');
    const r = createPythonResolver(db, REPO);
    expect(r.resolve('pkg.a', 'pkg/a.py', [])).toEqual([]);
  });

  it('wildcard from-import resolves to the module file', () => {
    addFile(db, 'pkg/__init__.py');
    addFile(db, 'pkg/util.py');
    addFile(db, 'main.py');
    const r = createPythonResolver(db, REPO);
    expect(r.resolve('pkg.util', 'main.py', ['*'])).toEqual(['pkg/util.py']);
  });
});
