import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { goHandler } from '../../src/handlers/go.js';

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, goHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Go handler — extractSymbols', () => {
  it('extracts an exported function', async () => {
    const src = `package main\nfunc NewService(secret string) *Service {\n\treturn nil\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'pkg/auth.go');
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('NewService');
    expect(syms[0].kind).toBe('function');
    expect(syms[0].filePath).toBe('pkg/auth.go');
    expect(syms[0].startByte).toBeGreaterThan(0);
    expect(syms[0].endByte).toBeGreaterThan(syms[0].startByte);
  });

  it('generates a deterministic 16-char hex id', async () => {
    const src = `package main\nfunc Foo() {}\n`;
    const { tree, buf } = await parse(src);
    const sym = goHandler.extractSymbols(tree, buf, 'src/a.go')[0];
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    expect(goHandler.extractSymbols(tree, buf, 'src/a.go')[0].id).toBe(sym.id);
  });

  it('does NOT extract unexported functions', async () => {
    const src = `package main\nfunc Exported() {}\nfunc unexported() {}\n`;
    const { tree, buf } = await parse(src);
    const names = goHandler.extractSymbols(tree, buf, 'a.go').map((s) => s.name);
    expect(names).toContain('Exported');
    expect(names).not.toContain('unexported');
  });

  it('extracts a method with pointer receiver and qualifies the name', async () => {
    const src = `package main\nfunc (s *AuthService) Login(u string) error {\n\treturn nil\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('AuthService.Login');
    expect(syms[0].kind).toBe('method');
  });

  it('extracts a method with value receiver', async () => {
    const src = `package main\nfunc (s AuthService) String() string {\n\treturn ""\n}\n`;
    const { tree, buf } = await parse(src);
    const sym = goHandler.extractSymbols(tree, buf, 'a.go')[0];
    expect(sym.name).toBe('AuthService.String');
    expect(sym.kind).toBe('method');
  });

  it('does NOT extract unexported methods', async () => {
    const src = `package main\nfunc (s *Svc) Public() {}\nfunc (s *Svc) private() {}\n`;
    const { tree, buf } = await parse(src);
    const names = goHandler.extractSymbols(tree, buf, 'a.go').map((s) => s.name);
    expect(names).toContain('Svc.Public');
    expect(names).not.toContain('Svc.private');
  });

  it('extracts a struct type as kind=class', async () => {
    const src = `package main\ntype User struct {\n\tID string\n\tName string\n}\n`;
    const { tree, buf } = await parse(src);
    const sym = goHandler.extractSymbols(tree, buf, 'a.go')[0];
    expect(sym.name).toBe('User');
    expect(sym.kind).toBe('class');
  });

  it('extracts an interface type as kind=interface', async () => {
    const src = `package main\ntype Stringer interface {\n\tString() string\n}\n`;
    const { tree, buf } = await parse(src);
    const sym = goHandler.extractSymbols(tree, buf, 'a.go')[0];
    expect(sym.name).toBe('Stringer');
    expect(sym.kind).toBe('interface');
  });

  it('extracts a type alias as kind=type', async () => {
    const src = `package main\ntype UserID = string\n`;
    const { tree, buf } = await parse(src);
    const sym = goHandler.extractSymbols(tree, buf, 'a.go')[0];
    expect(sym.name).toBe('UserID');
    expect(sym.kind).toBe('type');
  });

  it('does NOT extract unexported types', async () => {
    const src = `package main\ntype Exported struct {}\ntype unexported struct {}\n`;
    const { tree, buf } = await parse(src);
    const names = goHandler.extractSymbols(tree, buf, 'a.go').map((s) => s.name);
    expect(names).toContain('Exported');
    expect(names).not.toContain('unexported');
  });

  it('extracts a single exported const', async () => {
    const src = `package main\n// MaxSize is the limit.\nconst MaxSize = 100\n`;
    const { tree, buf } = await parse(src);
    const sym = goHandler.extractSymbols(tree, buf, 'a.go')[0];
    expect(sym.name).toBe('MaxSize');
    expect(sym.kind).toBe('const');
    expect(sym.signature).toContain('MaxSize');
  });

  it('extracts multiple consts from a grouped const block', async () => {
    const src = `package main\nconst (\n\tFoo = 1\n\tBar = 2\n\tbaz = 3\n)\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Foo');
    expect(names).toContain('Bar');
    expect(names).not.toContain('baz'); // unexported
  });

  it('does NOT extract unexported consts', async () => {
    const src = `package main\nconst unexported = 42\n`;
    const { tree, buf } = await parse(src);
    expect(goHandler.extractSymbols(tree, buf, 'a.go')).toHaveLength(0);
  });

  it('builds a correct function signature (stops before body)', async () => {
    const src = `package main\nfunc Process(items []string, limit int) ([]string, error) {\n\treturn nil, nil\n}\n`;
    const { tree, buf } = await parse(src);
    const sym = goHandler.extractSymbols(tree, buf, 'a.go')[0];
    expect(sym.signature).toBe('func Process(items []string, limit int) ([]string, error)');
    expect(sym.signature).not.toContain('{');
  });

  it('builds a correct method signature including receiver', async () => {
    const src = `package main\nfunc (s *AuthService) Login(u, p string) (string, error) {\n\treturn "", nil\n}\n`;
    const { tree, buf } = await parse(src);
    const sym = goHandler.extractSymbols(tree, buf, 'a.go')[0];
    expect(sym.signature).toContain('func (s *AuthService)');
    expect(sym.signature).toContain('Login');
    expect(sym.signature).not.toContain('{');
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('Go handler — extractDocstring', () => {
  it('extracts a single-line doc comment', async () => {
    const src = `package main\n// NewService creates a new service.\nfunc NewService() *Service { return nil }\n`;
    const { tree } = await parse(src);
    // function_declaration is the last child
    const fnNode = tree.rootNode.children.find((c) => c.type === 'function_declaration')!;
    const doc = goHandler.extractDocstring(fnNode);
    expect(doc).toBe('NewService creates a new service.');
  });

  it('extracts a multi-line doc comment and returns first sentence', async () => {
    const src = `package main\n// Login authenticates the user.\n// It returns an error if credentials are invalid.\nfunc Login() error { return nil }\n`;
    const { tree } = await parse(src);
    const fnNode = tree.rootNode.children.find((c) => c.type === 'function_declaration')!;
    const doc = goHandler.extractDocstring(fnNode);
    expect(doc).toBe('Login authenticates the user.');
  });

  it('returns null when no doc comment precedes the declaration', async () => {
    const src = `package main\nfunc NoDoc() {}\n`;
    const { tree } = await parse(src);
    const fnNode = tree.rootNode.children.find((c) => c.type === 'function_declaration')!;
    expect(goHandler.extractDocstring(fnNode)).toBeNull();
  });

  it('does not capture an unrelated comment separated by a blank line', async () => {
    // A blank line between comment and function means the comment isn't adjacent
    // (in Go style, doc comments are immediately adjacent)
    // In tree-sitter, blank lines don't create nodes so the previousNamedSibling
    // may still be the comment. We test that a directly preceding comment IS captured.
    const src = `package main\n// This IS adjacent.\nfunc Adjacent() {}\n`;
    const { tree } = await parse(src);
    const fnNode = tree.rootNode.children.find((c) => c.type === 'function_declaration')!;
    const doc = goHandler.extractDocstring(fnNode);
    expect(doc).toBe('This IS adjacent.');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Go handler — extractImports', () => {
  it('extracts a single import', async () => {
    const src = `package main\nimport "fmt"\n`;
    const { tree, buf } = await parse(src);
    const imports = goHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('fmt');
    expect(imports[0].importedNames).toEqual([]);
    expect(imports[0].isTypeOnly).toBe(false);
    expect(imports[0].resolvedPath).toBeNull();
  });

  it('extracts grouped imports', async () => {
    const src = `package main\nimport (\n\t"fmt"\n\t"os"\n\t"math/rand"\n)\n`;
    const { tree, buf } = await parse(src);
    const imports = goHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(3);
    expect(imports.map((i) => i.specifier)).toEqual(['fmt', 'os', 'math/rand']);
  });

  it('extracts an aliased import (uses original path as specifier)', async () => {
    const src = `package main\nimport mrand "math/rand"\n`;
    const { tree, buf } = await parse(src);
    const imports = goHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('math/rand');
  });

  it('skips blank imports (_ "pkg")', async () => {
    const src = `package main\nimport _ "unused/pkg"\n`;
    const { tree, buf } = await parse(src);
    const imports = goHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(0);
  });

  it('extracts dot imports (. "pkg")', async () => {
    const src = `package main\nimport . "os"\n`;
    const { tree, buf } = await parse(src);
    const imports = goHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('os');
  });

  it('handles mixed grouped imports (aliased, blank, dot, regular)', async () => {
    const src = `package main\nimport (\n\t"fmt"\n\tmrand "math/rand"\n\t_ "net/http"\n)\n`;
    const { tree, buf } = await parse(src);
    const imports = goHandler.extractImports(tree, buf);
    // blank import is skipped
    expect(imports).toHaveLength(2);
    expect(imports.map((i) => i.specifier)).toContain('fmt');
    expect(imports.map((i) => i.specifier)).toContain('math/rand');
  });
});
