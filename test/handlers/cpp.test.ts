import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { cppHandler } from '../../src/handlers/cpp.js';

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, cppHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('C++ handler — extractSymbols', () => {

  // ── Namespace ───────────────────────────────────────────────────────────────

  it('emits a namespace symbol with qualified name', async () => {
    const { tree, buf } = await parse(`namespace Auth { int x; }\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'auth.cpp');
    const ns = syms.find((s) => s.kind === 'namespace');
    expect(ns).toBeDefined();
    expect(ns!.name).toBe('Auth');
    expect(ns!.signature).toContain('namespace Auth');
  });

  it('qualifies names inside a namespace', async () => {
    const { tree, buf } = await parse(`
namespace Auth {
  void login() {}
}
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'auth.cpp');
    const fn = syms.find((s) => s.kind === 'function');
    expect(fn).toBeDefined();
    expect(fn!.name).toBe('Auth::login');
  });

  it('qualifies nested namespaces with :: separator', async () => {
    const { tree, buf } = await parse(`
namespace App {
  namespace Models {
    class User {};
  }
}
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'models.cpp');
    // Should have: App (namespace), App::Models (namespace), App::Models::User (class)
    const app = syms.find((s) => s.name === 'App');
    const models = syms.find((s) => s.name === 'App::Models');
    const user = syms.find((s) => s.name === 'App::Models::User');
    expect(app?.kind).toBe('namespace');
    expect(models?.kind).toBe('namespace');
    expect(user?.kind).toBe('class');
  });

  it('skips anonymous namespaces', async () => {
    const { tree, buf } = await parse(`namespace { void internal() {} }\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'util.cpp');
    expect(syms.filter((s) => s.kind === 'namespace')).toHaveLength(0);
    expect(syms.filter((s) => s.kind === 'function')).toHaveLength(0);
  });

  // ── Top-level function ──────────────────────────────────────────────────────

  it('extracts a top-level function', async () => {
    const { tree, buf } = await parse(`int add(int a, int b) { return a + b; }\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'math.cpp');
    const fn = syms.find((s) => s.name === 'add');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.signature).toContain('add');
  });

  // ── Class ───────────────────────────────────────────────────────────────────

  it('extracts a class with kind "class"', async () => {
    const { tree, buf } = await parse(`class Foo {};\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'foo.cpp');
    const cls = syms.find((s) => s.name === 'Foo');
    expect(cls?.kind).toBe('class');
  });

  it('qualifies class inside namespace', async () => {
    const { tree, buf } = await parse(`
namespace Auth {
  class AuthService {};
}
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'auth.hpp');
    const cls = syms.find((s) => s.kind === 'class');
    expect(cls!.name).toBe('Auth::AuthService');
  });

  it('skips forward-declared class (no body)', async () => {
    const { tree, buf } = await parse(`class Foo;\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'fwd.hpp');
    expect(syms.filter((s) => s.kind === 'class')).toHaveLength(0);
  });

  it('includes base class in class signature', async () => {
    const { tree, buf } = await parse(`class Derived : public Base {};\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'derived.hpp');
    const cls = syms.find((s) => s.kind === 'class');
    expect(cls!.signature).toContain(': public Base');
  });

  // ── Struct ──────────────────────────────────────────────────────────────────

  it('extracts a struct with kind "struct"', async () => {
    const { tree, buf } = await parse(`struct Point { int x; int y; };\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'point.hpp');
    const st = syms.find((s) => s.name === 'Point');
    expect(st?.kind).toBe('struct');
    expect(st!.signature).toContain('struct Point');
  });

  it('struct is distinct from class', async () => {
    const { tree, buf } = await parse(`struct Pos {}; class Node {};\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'types.hpp');
    expect(syms.find((s) => s.name === 'Pos')?.kind).toBe('struct');
    expect(syms.find((s) => s.name === 'Node')?.kind).toBe('class');
  });

  // ── Class body: public / private methods ────────────────────────────────────

  it('extracts public methods from class body', async () => {
    const { tree, buf } = await parse(`
class AuthService {
public:
  void login();
};
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'auth.hpp');
    const method = syms.find((s) => s.kind === 'method');
    expect(method).toBeDefined();
    expect(method!.name).toBe('AuthService::login');
  });

  it('skips private methods', async () => {
    const { tree, buf } = await parse(`
class AuthService {
public:
  void login();
private:
  void helper();
};
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'auth.hpp');
    const methods = syms.filter((s) => s.kind === 'method');
    expect(methods.map((m) => m.name)).toContain('AuthService::login');
    expect(methods.map((m) => m.name)).not.toContain('AuthService::helper');
  });

  it('emits public method with fully qualified name (namespace + class)', async () => {
    const { tree, buf } = await parse(`
namespace Auth {
  class Service {
  public:
    bool check();
  };
}
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'auth.hpp');
    const method = syms.find((s) => s.kind === 'method');
    expect(method!.name).toBe('Auth::Service::check');
  });

  it('struct methods are public by default', async () => {
    const { tree, buf } = await parse(`
struct Point {
  void reset();
};
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'point.hpp');
    const method = syms.find((s) => s.kind === 'method');
    expect(method).toBeDefined();
    expect(method!.name).toBe('Point::reset');
  });

  it('class methods are private by default (no access specifier)', async () => {
    const { tree, buf } = await parse(`
class Foo {
  void hidden();
};
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'foo.hpp');
    expect(syms.filter((s) => s.kind === 'method')).toHaveLength(0);
  });

  // ── Constructor and destructor ───────────────────────────────────────────────

  it('extracts a constructor', async () => {
    const { tree, buf } = await parse(`
class Foo {
public:
  Foo(int x) {}
};
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'foo.cpp');
    const ctor = syms.find((s) => s.kind === 'method' && s.name.includes('Foo::Foo'));
    expect(ctor).toBeDefined();
  });

  it('extracts a destructor with ~ in name', async () => {
    const { tree, buf } = await parse(`
class Foo {
public:
  ~Foo() {}
};
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'foo.cpp');
    const dtor = syms.find((s) => s.kind === 'method' && s.name.includes('~Foo'));
    expect(dtor).toBeDefined();
  });

  // ── Operator overload ───────────────────────────────────────────────────────

  it('extracts operator overload with operator name', async () => {
    const { tree, buf } = await parse(`
class Vec {
public:
  Vec operator+(const Vec& other) const {}
};
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'vec.cpp');
    const op = syms.find((s) => s.kind === 'method' && s.name.includes('operator+'));
    expect(op).toBeDefined();
    expect(op!.name).toBe('Vec::operator+');
  });

  // ── Template ────────────────────────────────────────────────────────────────

  it('extracts template class with template prefix in signature', async () => {
    const { tree, buf } = await parse(`
template<typename T>
class Cache {};
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'cache.hpp');
    const cls = syms.find((s) => s.name === 'Cache');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.signature).toContain('template');
    expect(cls!.signature).toContain('Cache');
  });

  it('extracts template function', async () => {
    const { tree, buf } = await parse(`
template<typename T>
T max(T a, T b) { return a > b ? a : b; }
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'util.hpp');
    const fn = syms.find((s) => s.name === 'max');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.signature).toContain('template');
  });

  it('skips explicit template specialization template<>', async () => {
    const { tree, buf } = await parse(`
template<typename T>
class Cache {};

template<>
class Cache<int> {};
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'cache.hpp');
    // Only the primary template should be extracted, not the specialization
    const caches = syms.filter((s) => s.kind === 'class');
    expect(caches).toHaveLength(1);
    expect(caches[0]!.name).toBe('Cache');
  });

  // ── using alias (type alias) ─────────────────────────────────────────────────

  it('extracts using type alias as kind "type"', async () => {
    const { tree, buf } = await parse(`using StringVec = std::vector<std::string>;\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'types.hpp');
    const alias = syms.find((s) => s.name === 'StringVec');
    expect(alias).toBeDefined();
    expect(alias!.kind).toBe('type');
    expect(alias!.signature).toContain('StringVec');
  });

  it('qualifies type alias inside namespace', async () => {
    const { tree, buf } = await parse(`
namespace Foo {
  using Bar = int;
}
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'foo.hpp');
    const alias = syms.find((s) => s.kind === 'type');
    expect(alias!.name).toBe('Foo::Bar');
  });

  // ── #define macro ────────────────────────────────────────────────────────────

  it('extracts object-like macro', async () => {
    const { tree, buf } = await parse(`#define MAX_SIZE 1024\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'config.h');
    const mac = syms.find((s) => s.name === 'MAX_SIZE');
    expect(mac).toBeDefined();
    expect(mac!.kind).toBe('macro');
    expect(mac!.signature).toBe('#define MAX_SIZE 1024');
  });

  it('skips header guard macros (no value)', async () => {
    const { tree, buf } = await parse(`#define AUTH_H\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'auth.h');
    expect(syms.filter((s) => s.kind === 'macro')).toHaveLength(0);
  });

  // ── Enum ─────────────────────────────────────────────────────────────────────

  it('extracts enum with kind "enum"', async () => {
    const { tree, buf } = await parse(`enum Status { OK, Error, Timeout };\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'status.hpp');
    const en = syms.find((s) => s.name === 'Status');
    expect(en?.kind).toBe('enum');
  });

  it('qualifies enum inside namespace', async () => {
    const { tree, buf } = await parse(`
namespace Net {
  enum Protocol { TCP, UDP };
}
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'net.hpp');
    const en = syms.find((s) => s.kind === 'enum');
    expect(en!.name).toBe('Net::Protocol');
  });

  // ── Deterministic ID ─────────────────────────────────────────────────────────

  it('generates a deterministic 16-char hex ID', async () => {
    const { tree, buf } = await parse(`void foo() {}\n`);
    const sym = cppHandler.extractSymbols(tree, buf, 'test.cpp')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = cppHandler.extractSymbols(tree, buf, 'test.cpp')[0]!;
    expect(sym2.id).toBe(sym.id);
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('C++ handler — extractImports', () => {
  it('extracts local #include as resolved path', async () => {
    const { tree, buf } = await parse(`#include "auth.hpp"\n`);
    const imports = cppHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('auth.hpp');
    expect(imports[0]!.resolvedPath).toBe('auth.hpp');
  });

  it('extracts system #include with null resolvedPath', async () => {
    const { tree, buf } = await parse(`#include <vector>\n`);
    const imports = cppHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('vector');
    expect(imports[0]!.resolvedPath).toBeNull();
  });

  it('extracts using_declaration with imported name', async () => {
    const { tree, buf } = await parse(`using std::vector;\n`);
    const imports = cppHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('std::vector');
    expect(imports[0]!.importedNames).toContain('vector');
  });

  it('extracts using_directive with empty importedNames', async () => {
    const { tree, buf } = await parse(`using namespace std;\n`);
    const imports = cppHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('std');
    expect(imports[0]!.importedNames).toHaveLength(0);
  });

  it('extracts multiple imports from the same file', async () => {
    const { tree, buf } = await parse(`
#include <iostream>
#include "utils.hpp"
using std::string;
using namespace fmt;
`);
    const imports = cppHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(4);
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('C++ handler — extractDocstring', () => {
  it('extracts // line comment preceding a function', async () => {
    const { tree, buf } = await parse(`
// Adds two numbers together.
int add(int a, int b) { return a + b; }
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'math.cpp');
    const fn = syms.find((s) => s.name === 'add');
    expect(fn!.summary).toContain('Adds two numbers');
  });

  it('extracts Doxygen /// comment', async () => {
    const { tree, buf } = await parse(`
/// Authenticates the user session.
void login() {}
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'auth.cpp');
    const fn = syms.find((s) => s.name === 'login');
    expect(fn!.summary).toContain('Authenticates');
  });

  it('extracts /* */ block comment', async () => {
    const { tree, buf } = await parse(`
/* Validates the token. */
bool validate() { return true; }
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'auth.cpp');
    const fn = syms.find((s) => s.name === 'validate');
    expect(fn!.summary).toContain('Validates');
  });
});
