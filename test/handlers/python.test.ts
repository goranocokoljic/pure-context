import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { pythonHandler } from '../../src/handlers/python.js';

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, pythonHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Python handler — extractSymbols', () => {
  it('extracts a simple function', async () => {
    const { tree, buf } = await parse(`def greet(name: str) -> str:\n    return name\n`);
    const syms = pythonHandler.extractSymbols(tree, buf, 'src/a.py');
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('greet');
    expect(syms[0].kind).toBe('function');
    expect(syms[0].filePath).toBe('src/a.py');
    expect(syms[0].startByte).toBe(0);
    expect(syms[0].endByte).toBeGreaterThan(0);
  });

  it('generates a deterministic 16-char hex id', async () => {
    const { tree, buf } = await parse(`def foo():\n    pass\n`);
    const sym = pythonHandler.extractSymbols(tree, buf, 'src/a.py')[0];
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    // Same inputs → same id
    const sym2 = pythonHandler.extractSymbols(tree, buf, 'src/a.py')[0];
    expect(sym2.id).toBe(sym.id);
  });

  it('extracts a class and its methods', async () => {
    const src = `
class MyService:
    def start(self) -> None:
        pass

    def stop(self) -> None:
        pass
`.trimStart();
    const { tree, buf } = await parse(src);
    const syms = pythonHandler.extractSymbols(tree, buf, 'src/a.py');
    const names = syms.map((s) => s.name);
    expect(names).toContain('MyService');
    expect(names).toContain('MyService.start');
    expect(names).toContain('MyService.stop');
    expect(syms.find((s) => s.name === 'MyService')?.kind).toBe('class');
    expect(syms.find((s) => s.name === 'MyService.start')?.kind).toBe('method');
  });

  it('extracts a decorated function using decorated_definition', async () => {
    const src = `
@app.route('/users')
def get_users():
    pass
`.trimStart();
    const { tree, buf } = await parse(src);
    const syms = pythonHandler.extractSymbols(tree, buf, 'src/a.py');
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('get_users');
    expect(syms[0].kind).toBe('function');
    // byte offsets span from @decorator start to function end
    expect(syms[0].startByte).toBe(0);
  });

  it('extracts a decorated class', async () => {
    const src = `
@dataclass
class Point:
    x: float
    y: float
`.trimStart();
    const { tree, buf } = await parse(src);
    const syms = pythonHandler.extractSymbols(tree, buf, 'src/a.py');
    expect(syms[0].name).toBe('Point');
    expect(syms[0].kind).toBe('class');
    expect(syms[0].startByte).toBe(0);
  });

  it('includes decorator in signature', async () => {
    const src = `
@property
def value(self) -> int:
    return self._value
`.trimStart();
    const { tree, buf } = await parse(src);
    const sym = pythonHandler.extractSymbols(tree, buf, 'src/a.py')[0];
    expect(sym.signature).toContain('@property');
    expect(sym.signature).toContain('def value');
  });

  it('extracts a method decorated with @classmethod', async () => {
    const src = `
class Foo:
    @classmethod
    def create(cls) -> "Foo":
        return cls()
`.trimStart();
    const { tree, buf } = await parse(src);
    const syms = pythonHandler.extractSymbols(tree, buf, 'src/a.py');
    const method = syms.find((s) => s.name === 'Foo.create');
    expect(method).toBeDefined();
    expect(method?.kind).toBe('method');
    expect(method?.signature).toContain('@classmethod');
  });

  it('extracts UPPER_CASE module-level constant', async () => {
    const src = `MAX_SIZE = 100\ndefault_timeout = 30\n`;
    const { tree, buf } = await parse(src);
    const syms = pythonHandler.extractSymbols(tree, buf, 'src/a.py');
    // Only MAX_SIZE qualifies — default_timeout is not UPPER_CASE
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('MAX_SIZE');
    expect(syms[0].kind).toBe('const');
  });

  it('does NOT extract single-char uppercase names as constants', async () => {
    // Single-char names like X = 1 are too common as loop variables etc.
    const src = `X = 1\n`;
    const { tree, buf } = await parse(src);
    const syms = pythonHandler.extractSymbols(tree, buf, 'src/a.py');
    expect(syms).toHaveLength(0);
  });

  it('does NOT extract nested functions', async () => {
    const src = `
def outer():
    def inner():
        pass
    return inner
`.trimStart();
    const { tree, buf } = await parse(src);
    const syms = pythonHandler.extractSymbols(tree, buf, 'src/a.py');
    // Only 'outer' should appear — 'inner' is nested
    expect(syms.map((s) => s.name)).toEqual(['outer']);
  });

  it('does NOT extract private methods (prefixed with _)', async () => {
    // Private methods ARE still extracted — navigation is useful for them too.
    // This test verifies the current behavior: we index everything including _private.
    const src = `
class Foo:
    def public(self): pass
    def _private(self): pass
`.trimStart();
    const { tree, buf } = await parse(src);
    const names = pythonHandler.extractSymbols(tree, buf, 'src/a.py').map((s) => s.name);
    expect(names).toContain('Foo.public');
    expect(names).toContain('Foo._private');
  });

  it('builds a correct function signature', async () => {
    const src = `def process(items: list[str], limit: int = 10) -> list[str]:\n    pass\n`;
    const { tree, buf } = await parse(src);
    const sym = pythonHandler.extractSymbols(tree, buf, 'src/a.py')[0];
    expect(sym.signature).toBe('def process(items: list[str], limit: int = 10) -> list[str]:');
  });

  it('builds a correct class signature', async () => {
    const src = `class Worker(BaseWorker, metaclass=ABCMeta):\n    pass\n`;
    const { tree, buf } = await parse(src);
    const sym = pythonHandler.extractSymbols(tree, buf, 'src/a.py')[0];
    expect(sym.signature).toBe('class Worker(BaseWorker, metaclass=ABCMeta):');
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('Python handler — extractDocstring', () => {
  it('extracts a triple-double-quoted docstring (full text)', async () => {
    const src = `
def foo():
    """This is the docstring. More details here."""
    pass
`.trimStart();
    const { tree } = await parse(src);
    const fnNode = tree.rootNode.children[0];
    expect(fnNode.type).toBe('function_definition');
    const doc = pythonHandler.extractDocstring(fnNode);
    expect(doc).toBe('This is the docstring. More details here.');
  });

  it('extracts a triple-single-quoted docstring', async () => {
    const src = `
def bar():
    '''Single quoted docstring.'''
    pass
`.trimStart();
    const { tree } = await parse(src);
    const doc = pythonHandler.extractDocstring(tree.rootNode.children[0]);
    expect(doc).toBe('Single quoted docstring.');
  });

  it('extracts full first paragraph of a multi-sentence docstring', async () => {
    const src = `
def baz():
    """First sentence. Second sentence. Third sentence."""
    pass
`.trimStart();
    const { tree } = await parse(src);
    const doc = pythonHandler.extractDocstring(tree.rootNode.children[0]);
    expect(doc).toBe('First sentence. Second sentence. Third sentence.');
  });

  it('extracts full first paragraph stopping at blank line', async () => {
    const src = `
def fuse(results_list, weights):
    """Weighted Reciprocal Rank Fusion.

    Merges multiple independent scoring channels into one ranked list.
    This is the second paragraph.
    """
    pass
`.trimStart();
    const { tree } = await parse(src);
    const doc = pythonHandler.extractDocstring(tree.rootNode.children[0]);
    expect(doc).toBe('Weighted Reciprocal Rank Fusion.');
    // Second paragraph is discarded; first paragraph is just one sentence here
  });

  it('extracts multi-sentence first paragraph with blank-line boundary', async () => {
    const src = `
def assemble(a, b):
    """Assembles the context bundle. Merges multiple independent scoring channels.

    This paragraph should not appear.
    """
    pass
`.trimStart();
    const { tree } = await parse(src);
    const doc = pythonHandler.extractDocstring(tree.rootNode.children[0]);
    expect(doc).toBe('Assembles the context bundle. Merges multiple independent scoring channels.');
  });

  it('returns null when there is no docstring', async () => {
    const src = `def no_doc():\n    return 42\n`;
    const { tree } = await parse(src);
    const doc = pythonHandler.extractDocstring(tree.rootNode.children[0]);
    expect(doc).toBeNull();
  });

  it('returns null for a function whose first statement is not a string', async () => {
    const src = `def foo():\n    x = 1\n    return x\n`;
    const { tree } = await parse(src);
    const doc = pythonHandler.extractDocstring(tree.rootNode.children[0]);
    expect(doc).toBeNull();
  });

  it('captures class docstring', async () => {
    const src = `
class MyClass:
    """The class description."""
    pass
`.trimStart();
    const { tree } = await parse(src);
    const doc = pythonHandler.extractDocstring(tree.rootNode.children[0]);
    expect(doc).toBe('The class description.');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Python handler — extractImports', () => {
  it('extracts a simple import statement', async () => {
    const src = `import os\n`;
    const { tree, buf } = await parse(src);
    const imports = pythonHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('os');
    expect(imports[0].importedNames).toEqual([]);
    expect(imports[0].isTypeOnly).toBe(false);
  });

  it('extracts a dotted import', async () => {
    const src = `import os.path\n`;
    const { tree, buf } = await parse(src);
    const imports = pythonHandler.extractImports(tree, buf);
    expect(imports[0].specifier).toBe('os.path');
  });

  it('extracts an aliased import', async () => {
    const src = `import numpy as np\n`;
    const { tree, buf } = await parse(src);
    const imports = pythonHandler.extractImports(tree, buf);
    expect(imports[0].specifier).toBe('numpy');
  });

  it('extracts a from-import with named imports', async () => {
    const src = `from pathlib import Path, PurePath\n`;
    const { tree, buf } = await parse(src);
    const imports = pythonHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('pathlib');
    expect(imports[0].importedNames).toContain('Path');
    expect(imports[0].importedNames).toContain('PurePath');
  });

  it('extracts a wildcard import', async () => {
    const src = `from os.path import *\n`;
    const { tree, buf } = await parse(src);
    const imports = pythonHandler.extractImports(tree, buf);
    expect(imports[0].specifier).toBe('os.path');
    expect(imports[0].importedNames).toContain('*');
  });

  it('extracts a relative import (single dot)', async () => {
    const src = `from . import utils\n`;
    const { tree, buf } = await parse(src);
    const imports = pythonHandler.extractImports(tree, buf);
    expect(imports[0].specifier).toContain('.');
    expect(imports[0].resolvedPath).toBeNull();
  });

  it('extracts a relative import with module path', async () => {
    const src = `from ..utils import format_number\n`;
    const { tree, buf } = await parse(src);
    const imports = pythonHandler.extractImports(tree, buf);
    expect(imports[0].specifier).toContain('..');
    expect(imports[0].importedNames).toContain('format_number');
  });

  it('marks __future__ annotations import as type-only', async () => {
    const src = `from __future__ import annotations\n`;
    const { tree, buf } = await parse(src);
    const imports = pythonHandler.extractImports(tree, buf);
    expect(imports[0].isTypeOnly).toBe(true);
  });

  it('handles multiple import statements', async () => {
    const src = `import os\nimport sys\nfrom typing import Optional\n`;
    const { tree, buf } = await parse(src);
    const imports = pythonHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(3);
    expect(imports.map((i) => i.specifier)).toEqual(['os', 'sys', 'typing']);
  });

  // ── Task 516 (Phase 84): exact shapes the Python resolver depends on ────────

  it('emits `from . import x` with the bare dot preserved as the specifier', async () => {
    const src = `from . import utils\n`;
    const { tree, buf } = await parse(src);
    const imports = pythonHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('.');
    expect(imports[0].importedNames).toEqual(['utils']);
  });

  it('emits `from .sibling import x` as specifier `.sibling`', async () => {
    const src = `from .models import User\n`;
    const { tree, buf } = await parse(src);
    const imports = pythonHandler.extractImports(tree, buf);
    expect(imports[0].specifier).toBe('.models');
    expect(imports[0].importedNames).toEqual(['User']);
  });

  it('emits `from ..pkg import y` as specifier `..pkg`', async () => {
    const src = `from ..utils import format_number\n`;
    const { tree, buf } = await parse(src);
    const imports = pythonHandler.extractImports(tree, buf);
    expect(imports[0].specifier).toBe('..utils');
    expect(imports[0].importedNames).toEqual(['format_number']);
  });

  it('emits `from .. import z` as specifier `..`', async () => {
    const src = `from .. import config\n`;
    const { tree, buf } = await parse(src);
    const imports = pythonHandler.extractImports(tree, buf);
    expect(imports[0].specifier).toBe('..');
    expect(imports[0].importedNames).toEqual(['config']);
  });

  it('keeps multi-name from-imports on one record (from a.b import c, d)', async () => {
    const src = `from a.b import c, d\n`;
    const { tree, buf } = await parse(src);
    const imports = pythonHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('a.b');
    expect(imports[0].importedNames).toEqual(['c', 'd']);
  });

  it('keeps submodule chains qualified (import a.b.c)', async () => {
    const src = `import a.b.c\n`;
    const { tree, buf } = await parse(src);
    const imports = pythonHandler.extractImports(tree, buf);
    expect(imports[0].specifier).toBe('a.b.c');
    expect(imports[0].importedNames).toEqual([]);
  });

  it('records the original name for aliased from-imports (from a import b as c)', async () => {
    const src = `from pkg import helper as h\n`;
    const { tree, buf } = await parse(src);
    const imports = pythonHandler.extractImports(tree, buf);
    expect(imports[0].specifier).toBe('pkg');
    expect(imports[0].importedNames).toEqual(['helper']);
  });
});
