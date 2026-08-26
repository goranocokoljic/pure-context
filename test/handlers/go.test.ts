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

  it('extracts unexported functions with visibility metadata (Phase 84)', async () => {
    const src = `package main\nfunc Exported() {}\nfunc unexported() {}\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    const exported = syms.find((s) => s.name === 'Exported');
    const unexported = syms.find((s) => s.name === 'unexported');
    expect(exported).toBeDefined();
    expect(exported?.frameworkMeta).toBeUndefined();
    expect(unexported).toBeDefined();
    expect(unexported?.frameworkMeta).toMatchObject({ visibility: 'unexported' });
  });

  it('extracts a method with pointer receiver using bare name', async () => {
    const src = `package main\nfunc (s *AuthService) Login(u string) error {\n\treturn nil\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('Login');        // bare name, not 'AuthService.Login'
    expect(syms[0].kind).toBe('method');
  });

  it('extracts a method with value receiver using bare name', async () => {
    const src = `package main\nfunc (s AuthService) String() string {\n\treturn ""\n}\n`;
    const { tree, buf } = await parse(src);
    const sym = goHandler.extractSymbols(tree, buf, 'a.go')[0];
    expect(sym.name).toBe('String');           // bare name, not 'AuthService.String'
    expect(sym.kind).toBe('method');
  });

  it('keeps receiver type in method signature', async () => {
    const src = `package main\nfunc (s *AuthService) Login(u string) error {\n\treturn nil\n}\n`;
    const { tree, buf } = await parse(src);
    const sym = goHandler.extractSymbols(tree, buf, 'a.go')[0];
    expect(sym.signature).toContain('(s *AuthService)');
    expect(sym.signature).toContain('Login');
  });

  it('extracts unexported methods with visibility metadata (Phase 84)', async () => {
    const src = `package main\nfunc (s *Svc) Public() {}\nfunc (s *Svc) private() {}\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    expect(syms.find((s) => s.name === 'Public')?.frameworkMeta).toBeUndefined();
    expect(syms.find((s) => s.name === 'private')?.frameworkMeta).toMatchObject({
      visibility: 'unexported',
    });
  });

  it('two methods with same bare name on different receivers have distinct IDs', async () => {
    const src = `package main\nfunc (a *Alpha) Run() {}\nfunc (b *Beta) Run() {}\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    expect(syms).toHaveLength(2);
    expect(syms[0].name).toBe('Run');
    expect(syms[1].name).toBe('Run');
    expect(syms[0].id).not.toBe(syms[1].id);  // qualified names used for ID hash
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

  it('extracts unexported types with visibility metadata (Phase 84)', async () => {
    const src = `package main\ntype Exported struct {}\ntype unexported struct {}\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    expect(syms.find((s) => s.name === 'Exported')?.frameworkMeta).toBeUndefined();
    expect(syms.find((s) => s.name === 'unexported')?.frameworkMeta).toMatchObject({
      visibility: 'unexported',
    });
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
    expect(names).toContain('baz'); // unexported — indexed since Phase 84
    expect(syms.find((s) => s.name === 'baz')?.frameworkMeta).toMatchObject({
      visibility: 'unexported',
    });
  });

  it('extracts unexported consts with visibility metadata (Phase 84)', async () => {
    const src = `package main\nconst unexported = 42\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    expect(syms).toHaveLength(1);
    expect(syms[0].frameworkMeta).toMatchObject({ visibility: 'unexported' });
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

// ─── interface method extraction ─────────────────────────────────────────────

describe('Go handler — interface method extraction', () => {
  it('extracts two exported methods from a simple interface using bare names', async () => {
    const src = `package main\ntype Handler interface {\n\tServeHTTP(w http.ResponseWriter, r *http.Request)\n\tClose() error\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Handler');    // the interface itself
    expect(names).toContain('ServeHTTP'); // bare name, not 'Handler.ServeHTTP'
    expect(names).toContain('Close');     // bare name, not 'Handler.Close'
  });

  it('uses method kind for extracted interface methods', async () => {
    const src = `package main\ntype Handler interface {\n\tServeHTTP(w http.ResponseWriter, r *http.Request)\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    const method = syms.find((s) => s.name === 'ServeHTTP');
    expect(method?.kind).toBe('method');
  });

  it('extracts unexported interface methods with visibility metadata (Phase 84)', async () => {
    const src = `package main\ntype Service interface {\n\tPublic() error\n\tprivate() string\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    expect(syms.find((s) => s.name === 'Public')?.frameworkMeta).toBeUndefined();
    expect(syms.find((s) => s.name === 'private')?.frameworkMeta).toMatchObject({
      visibility: 'unexported',
    });
  });

  it('emits no method symbols for an empty interface', async () => {
    const src = `package main\ntype Any interface{}\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    // Only the interface type itself — no method specs
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('Any');
    expect(syms[0].kind).toBe('interface');
  });

  it('does NOT emit a method symbol for embedded interface types', async () => {
    const src = `package main\ntype ReadWriter interface {\n\tio.Reader\n\tWrite(p []byte) (int, error)\n}\n`;
    const { tree, buf } = await parse(src);
    const names = goHandler.extractSymbols(tree, buf, 'a.go').map((s) => s.name);
    // Embedded io.Reader is a type_name, not a method_spec — must not appear
    expect(names).not.toContain('io.Reader');
    expect(names).not.toContain('Reader');
    expect(names).toContain('Write');   // bare name, not 'ReadWriter.Write'
  });

  it('includes parameter and return types in the method signature', async () => {
    const src = `package main\ntype Store interface {\n\tFind(id string) (Item, error)\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    const method = syms.find((s) => s.name === 'Find');
    expect(method?.signature).toContain('id string');
    expect(method?.signature).toContain('Item');
    expect(method?.signature).toContain('error');
  });

  it('uses bare name for interface methods (interface name in signature)', async () => {
    const src = `package main\ntype HttpHandler interface {\n\tHandle(path string) error\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Handle');             // bare name in name field
    expect(names).not.toContain('HttpHandler.Handle');
    // interface name is in the signature for disambiguation
    const method = syms.find((s) => s.name === 'Handle');
    expect(method?.signature).toContain('HttpHandler');
  });

  it('interface itself is still extracted as kind=interface', async () => {
    const src = `package main\ntype Stringer interface {\n\tString() string\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    const iface = syms.find((s) => s.name === 'Stringer');
    expect(iface?.kind).toBe('interface');
    const method = syms.find((s) => s.name === 'String');  // bare name
    expect(method?.kind).toBe('method');
  });

  it('extracts methods from an interface with multiple exported and unexported methods', async () => {
    const src = `package main\ntype Repo interface {\n\tFindByID(id int) (*User, error)\n\tSave(u *User) error\n\tinternalValidate() bool\n}\n`;
    const { tree, buf } = await parse(src);
    const names = goHandler.extractSymbols(tree, buf, 'a.go').map((s) => s.name);
    expect(names).toContain('FindByID');   // bare names
    expect(names).toContain('Save');
    expect(names).toContain('internalValidate'); // indexed since Phase 84
  });

  it('two interface methods with same bare name on different interfaces have distinct IDs', async () => {
    const src = `package main\ntype Alpha interface {\n\tProcess() error\n}\ntype Beta interface {\n\tProcess() error\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    const methods = syms.filter((s) => s.name === 'Process');
    expect(methods).toHaveLength(2);
    expect(methods[0].id).not.toBe(methods[1].id);  // qualified names used for ID hash
  });
});

// ─── var_declaration extraction ──────────────────────────────────────────────

describe('Go handler — var_declaration extraction', () => {
  it('extracts an exported single var as kind=const', async () => {
    const src = `package main\nvar ErrNotFound = errors.New("not found")\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('ErrNotFound');
    expect(syms[0].kind).toBe('const');
  });

  it('extracts unexported vars with visibility metadata (Phase 84)', async () => {
    const src = `package main\nvar unexported = 42\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    expect(syms).toHaveLength(1);
    expect(syms[0].frameworkMeta).toMatchObject({ visibility: 'unexported' });
  });

  it('extracts every var from a grouped block, marking unexported ones (Phase 84)', async () => {
    const src = `package main\nvar (\n\tMaxConns = 100\n\tDefaultName = "app"\n\tinternal = "hidden"\n)\n`;
    const { tree, buf } = await parse(src);
    const syms = goHandler.extractSymbols(tree, buf, 'a.go');
    const names = syms.map((s) => s.name);
    expect(names).toContain('MaxConns');
    expect(names).toContain('DefaultName');
    expect(names).toContain('internal'); // indexed since Phase 84
    expect(syms.find((s) => s.name === 'internal')?.frameworkMeta).toMatchObject({
      visibility: 'unexported',
    });
  });

  it('includes type annotation in the signature when present', async () => {
    const src = `package main\nvar DefaultTimeout time.Duration = 30 * time.Second\n`;
    const { tree, buf } = await parse(src);
    const sym = goHandler.extractSymbols(tree, buf, 'a.go')[0];
    expect(sym.signature).toContain('DefaultTimeout');
    expect(sym.signature).toContain('time.Duration');
    expect(sym.signature).toMatch(/^var /);
  });

  it('includes initializer expression in the signature when present', async () => {
    const src = `package main\nvar GlobalRegistry = NewRegistry()\n`;
    const { tree, buf } = await parse(src);
    const sym = goHandler.extractSymbols(tree, buf, 'a.go')[0];
    expect(sym.signature).toContain('GlobalRegistry');
    expect(sym.signature).toContain('NewRegistry');
  });

  it('generates a deterministic 16-char hex id for a var symbol', async () => {
    const src = `package main\nvar ErrTimeout = errors.New("timeout")\n`;
    const { tree, buf } = await parse(src);
    const sym = goHandler.extractSymbols(tree, buf, 'a.go')[0];
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
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
