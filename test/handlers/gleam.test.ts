import { describe, it, expect } from 'vitest';
import { gleamHandler } from '../../src/handlers/gleam.js';
import type { Tree } from '../../src/core/types.js';

// Gleam handler is regex-based (grammarPath returns null) — no tree-sitter needed.
function parse(source: string) {
  const buf = Buffer.from(source);
  return { tree: null as unknown as Tree, buf };
}

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Gleam handler — extractSymbols', () => {

  // ── pub fn → 'function' ──────────────────────────────────────────────────

  it('extracts pub fn as kind "function"', () => {
    const { tree, buf } = parse(`
pub fn hello(name: String) -> String {
  "Hello, " <> name
}
`);
    const syms = gleamHandler.extractSymbols(tree, buf, 'hello.gleam');
    const sym = syms.find((s) => s.name === 'hello');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
    expect(sym!.signature).toContain('hello');
  });

  it('extracts private fn as kind "function"', () => {
    const { tree, buf } = parse(`
fn internal_helper(x: Int) -> Int {
  x + 1
}
`);
    const syms = gleamHandler.extractSymbols(tree, buf, 'helpers.gleam');
    const sym = syms.find((s) => s.name === 'internal_helper');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
  });

  it('extracts fn with no arguments', () => {
    const { tree, buf } = parse(`
pub fn main() {
  Nil
}
`);
    const syms = gleamHandler.extractSymbols(tree, buf, 'main.gleam');
    expect(syms.find((s) => s.name === 'main')).toBeDefined();
  });

  // ── pub type { } → 'class' (ADT) ─────────────────────────────────────────

  it('extracts pub type with constructors as kind "class"', () => {
    const { tree, buf } = parse(`
pub type Color {
  Red
  Green
  Blue
}
`);
    const syms = gleamHandler.extractSymbols(tree, buf, 'color.gleam');
    const sym = syms.find((s) => s.name === 'Color');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
    expect(sym!.signature).toContain('type Color');
  });

  it('extracts parameterised type as kind "class"', () => {
    const { tree, buf } = parse(`
pub type Tree(a) {
  Leaf
  Node(Tree(a), a, Tree(a))
}
`);
    const syms = gleamHandler.extractSymbols(tree, buf, 'tree.gleam');
    const sym = syms.find((s) => s.name === 'Tree');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
  });

  // ── pub type = → 'type' (alias) ──────────────────────────────────────────

  it('extracts pub type alias as kind "type"', () => {
    const { tree, buf } = parse(`
pub type UserId = Int
`);
    const syms = gleamHandler.extractSymbols(tree, buf, 'types.gleam');
    const sym = syms.find((s) => s.name === 'UserId');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('type');
  });

  // ── pub const → 'const' ──────────────────────────────────────────────────

  it('extracts pub const as kind "const"', () => {
    const { tree, buf } = parse(`
pub const max_size: Int = 100
`);
    const syms = gleamHandler.extractSymbols(tree, buf, 'config.gleam');
    const sym = syms.find((s) => s.name === 'max_size');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
  });

  it('extracts private const as kind "const"', () => {
    const { tree, buf } = parse(`
const internal_limit = 50
`);
    const syms = gleamHandler.extractSymbols(tree, buf, 'config.gleam');
    const sym = syms.find((s) => s.name === 'internal_limit');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
  });

  // ── /// doc comment as summary ────────────────────────────────────────────

  it('uses preceding /// comment as summary', () => {
    const { tree, buf } = parse(
      `/// Adds two integers together.\npub fn add(a: Int, b: Int) -> Int {\n  a + b\n}\n`,
    );
    const syms = gleamHandler.extractSymbols(tree, buf, 'math.gleam');
    const sym = syms.find((s) => s.name === 'add');
    expect(sym!.summary).toContain('Adds two integers');
  });

  it('concatenates multi-line /// doc comments', () => {
    const { tree, buf } = parse(
      `/// Returns the user\n/// from the database.\nfn get_user(id: Int) {\n  Nil\n}\n`,
    );
    const syms = gleamHandler.extractSymbols(tree, buf, 'user.gleam');
    const sym = syms.find((s) => s.name === 'get_user');
    expect(sym!.summary).toContain('Returns the user');
  });

  // ── byte offsets ──────────────────────────────────────────────────────────

  it('sets non-zero startByte and endByte for function', () => {
    const { tree, buf } = parse(`\npub fn greet() {\n  Nil\n}\n`);
    const sym = gleamHandler.extractSymbols(tree, buf, 'greet.gleam').find((s) => s.name === 'greet')!;
    expect(sym.startByte).toBeGreaterThan(0);
    expect(sym.endByte).toBeGreaterThan(sym.startByte);
  });

  // ── deterministic ID ──────────────────────────────────────────────────────

  it('generates a deterministic 16-char hex ID', () => {
    const { tree, buf } = parse(`pub fn foo() {\n  Nil\n}\n`);
    const sym = gleamHandler.extractSymbols(tree, buf, 'foo.gleam').find((s) => s.name === 'foo')!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = gleamHandler.extractSymbols(tree, buf, 'foo.gleam').find((s) => s.name === 'foo')!;
    expect(sym2.id).toBe(sym.id);
  });

  // ── multiple symbols ──────────────────────────────────────────────────────

  it('extracts multiple symbols from a single file', () => {
    const { tree, buf } = parse(`
import gleam/io

pub const version = "1.0.0"

pub type Status {
  Active
  Inactive
}

pub type UserId = Int

pub fn main() {
  io.println("hello")
}

fn helper() {
  Nil
}
`);
    const syms = gleamHandler.extractSymbols(tree, buf, 'app.gleam');
    const names = syms.map((s) => s.name);
    expect(names).toContain('version');
    expect(names).toContain('Status');
    expect(names).toContain('UserId');
    expect(names).toContain('main');
    expect(names).toContain('helper');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Gleam handler — extractImports', () => {

  it('extracts simple import', () => {
    const { tree, buf } = parse(`import gleam/io\n`);
    const imports = gleamHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('gleam/io');
  });

  it('extracts import with destructured symbols', () => {
    const { tree, buf } = parse(`import gleam/string.{concat, length}\n`);
    const imports = gleamHandler.extractImports(tree, buf);
    expect(imports[0]!.specifier).toBe('gleam/string');
    expect(imports[0]!.importedNames).toContain('concat');
    expect(imports[0]!.importedNames).toContain('length');
  });

  it('extracts import with alias', () => {
    const { tree, buf } = parse(`import gleam/list as l\n`);
    const imports = gleamHandler.extractImports(tree, buf);
    expect(imports[0]!.specifier).toBe('gleam/list');
  });

  it('marks external package imports as resolvedPath null', () => {
    const { tree, buf } = parse(`import gleam/io\n`);
    const imports = gleamHandler.extractImports(tree, buf);
    expect(imports[0]!.resolvedPath).toBeNull();
  });

  it('extracts multiple imports', () => {
    const { tree, buf } = parse(
      `import gleam/io\nimport gleam/string.{concat}\nimport myapp/user\n`,
    );
    const imports = gleamHandler.extractImports(tree, buf);
    expect(imports.length).toBeGreaterThanOrEqual(3);
    const specs = imports.map((i) => i.specifier);
    expect(specs).toContain('gleam/io');
    expect(specs).toContain('gleam/string');
    expect(specs).toContain('myapp/user');
  });

  it('deduplicates repeated imports', () => {
    const { tree, buf } = parse(`import gleam/io\nimport gleam/io\n`);
    const imports = gleamHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
  });

  it('returns empty array for files with no imports', () => {
    const { tree, buf } = parse(`pub fn foo() { Nil }\n`);
    expect(gleamHandler.extractImports(tree, buf)).toHaveLength(0);
  });
});
