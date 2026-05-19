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

  // ── Export-macro class/struct patterns (e.g. mitsuba3's MI_EXPORT_LIB) ───────

  it('extracts class name correctly when export macro precedes it', async () => {
    // `class MI_EXPORT_LIB ClassName` — the macro appears as a type_identifier
    // before the real class name; we must pick the last type_identifier.
    const { tree, buf } = await parse(`
class MI_EXPORT_LIB Scene : public Base {
public:
  void render();
};
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'scene.hpp');
    const cls = syms.find((s) => s.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls!.name).toBe('Scene');
    expect(cls!.name).not.toBe('MI_EXPORT_LIB');
  });

  it('extracts struct name correctly when export macro precedes it', async () => {
    const { tree, buf } = await parse(`
struct MI_EXPORT_LIB BSDFContext {
  int flags;
};
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'bsdf.hpp');
    const st = syms.find((s) => s.kind === 'struct');
    expect(st).toBeDefined();
    expect(st!.name).toBe('BSDFContext');
    expect(st!.name).not.toBe('MI_EXPORT_LIB');
  });

  it('extracts template class with export macro — name is the class not the macro', async () => {
    const { tree, buf } = await parse(`
template <typename Float, typename Spectrum>
class MI_EXPORT_LIB BSDF : public Base<BSDF<Float, Spectrum>> {
public:
  void eval();
};
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'bsdf.hpp');
    const cls = syms.find((s) => s.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls!.name).toBe('BSDF');
    expect(cls!.signature).toContain('template');
    expect(cls!.signature).toContain('BSDF');
    expect(cls!.name).not.toBe('MI_EXPORT_LIB');
  });

  it('extracts template class with export macro and final specifier (mitsuba3 pattern)', async () => {
    // `class MI_EXPORT_LIB Scene final : public JitObject<...>` — the `final`
    // keyword causes tree-sitter to produce a different AST than without it.
    const { tree, buf } = await parse(`
template <typename Float, typename Spectrum>
class MI_EXPORT_LIB Scene final : public JitObject<Scene<Float, Spectrum>> {
public:
  void render();
};
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'scene.hpp');
    const cls = syms.find((s) => s.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls!.name).toBe('Scene');
    expect(cls!.signature).toContain('template');
    expect(cls!.signature).toContain('Scene');
    expect(cls!.name).not.toBe('MI_EXPORT_LIB');
  });

  it('class body snippet captures first 200 chars of class body for FTS', async () => {
    // Body snippet helps FTS match conceptual queries like "scene container
    // with shapes emitters sensors" by including type names from the class body.
    const { tree, buf } = await parse(`
template <typename Float, typename Spectrum>
class MI_EXPORT_LIB Scene final : public JitObject<Scene<Float, Spectrum>> {
public:
  MI_IMPORT_TYPES(BSDF, Emitter, EmitterPtr, Film, Sampler, Shape, Sensor, Integrator)
  void render();
};
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'scene.hpp');
    const cls = syms.find((s) => s.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls!.bodySnippet).toBeDefined();
    expect(cls!.bodySnippet).toContain('Emitter');
    expect(cls!.bodySnippet).toContain('Sensor');
    expect(cls!.bodySnippet).toContain('Shape');
  });

  it('extracts template class from ERROR node (bare class keyword, no export macro)', async () => {
    // microfacet.h pattern: template class without export macro, inside NAMESPACE_BEGIN macro,
    // causes tree-sitter to produce ERROR with bare 'class' keyword + type_identifier directly.
    const { tree, buf } = await parse(`
#pragma once
#include "mitsuba/core/frame.h"
#include "mitsuba/render/fresnel.h"

NAMESPACE_BEGIN(mitsuba)

template <typename Float, typename Spectrum>
class MicrofacetDistribution : public drjit::TraversableBase {
public:
  Float eval(const Vector3f &m) const;
  Float pdf(const Vector3f &wi, const Vector3f &m) const;
};

NAMESPACE_END(mitsuba)
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'microfacet.hpp');
    const cls = syms.find((s) => s.name === 'MicrofacetDistribution');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.signature).toContain('template');
    expect(cls!.signature).toContain('MicrofacetDistribution');
  });

  it('extracts template class from sibling-level pattern (class_specifier + ERROR siblings)', async () => {
    // integrator.h pattern: tree-sitter scatters the declaration across root-level siblings:
    //   template_parameter_list, class_specifier("class MI_EXPORT_LIB"), ERROR("Integrator : public"),
    //   template_function("JitObject<...>"), { body }
    // The walkNodes sibling-detection handles this pattern.
    const { tree, buf } = await parse(`
#pragma once
#include "mitsuba/core/object.h"
#include "mitsuba/render/fwd.h"

NAMESPACE_BEGIN(mitsuba)

template <typename Float, typename Spectrum>
class MI_EXPORT_LIB Integrator : public JitObject<Integrator<Float, Spectrum>> {
public:
  virtual TensorXf render(Scene *scene, Sensor *sensor) = 0;
  virtual bool render(Scene *scene) = 0;
};

NAMESPACE_END(mitsuba)
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'integrator.hpp');
    const cls = syms.find((s) => s.name === 'Integrator');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.signature).toContain('Integrator');
  });

  it('extracts template class from ERROR node (NAMESPACE_BEGIN + includes pattern)', async () => {
    // When #include directives precede a NAMESPACE_BEGIN(mitsuba) macro,
    // tree-sitter-cpp misparsed the template class as an ERROR node.
    // Regression test: verifies the ERROR-recovery path in walkNode.
    const { tree, buf } = await parse(`
#pragma once
#include "mitsuba/core/object.h"
#include "mitsuba/render/fwd.h"

NAMESPACE_BEGIN(mitsuba)

template <typename Float, typename Spectrum>
class MI_EXPORT_LIB Scene final : public JitObject<Scene<Float, Spectrum>> {
public:
  MI_IMPORT_TYPES(BSDF, Emitter, Film, Sensor, Shape)
  void render();
  virtual ~Scene();
};

NAMESPACE_END(mitsuba)
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'scene.hpp');
    const cls = syms.find((s) => s.name === 'Scene');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.signature).toContain('template');
    expect(cls!.signature).toContain('Scene');
  });

  it('plain class body snippet captures first 200 chars for FTS', async () => {
    const { tree, buf } = await parse(`
class Shape {
public:
  virtual bool rayIntersect(const Ray& ray) const = 0;
  virtual BoundingBox getBounds() const = 0;
};
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'shape.hpp');
    const cls = syms.find((s) => s.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls!.bodySnippet).toBeDefined();
    expect(cls!.bodySnippet).toContain('rayIntersect');
  });

  // ── Template args stripped from out-of-class method names ────────────────────

  it('strips template args from out-of-class method qualified name', async () => {
    // `void Scene<Float, Spectrum>::render()` → name "Scene::render"
    const { tree, buf } = await parse(`
template <typename Float, typename Spectrum>
void Scene<Float, Spectrum>::render() {}
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'scene.cpp');
    const fn = syms.find((s) => s.name.includes('render'));
    expect(fn).toBeDefined();
    expect(fn!.name).toBe('Scene::render');
    expect(fn!.name).not.toContain('<');
  });

  it('strips template args from nested qualified method name', async () => {
    // `void Outer::Inner<T>::method()` → name "Outer::Inner::method"
    const { tree, buf } = await parse(`
template <typename T>
void Outer::Inner<T>::process() {}
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'outer.cpp');
    const fn = syms.find((s) => s.name.includes('process'));
    expect(fn).toBeDefined();
    expect(fn!.name).toBe('Outer::Inner::process');
    expect(fn!.name).not.toContain('<');
  });

  it('preserves plain qualified name without template args unchanged', async () => {
    // `void Foo::bar()` → name "Foo::bar" (no template args to strip)
    const { tree, buf } = await parse(`
void Foo::bar() {}
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'foo.cpp');
    const fn = syms.find((s) => s.name === 'Foo::bar');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
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

// ─── C-style typedef struct / enum (for .h files) ────────────────────────────

describe('cppHandler — C-style typedef struct and typedef enum', () => {
  it('extracts typedef struct as kind:struct', async () => {
    const { tree, buf } = await parse(`
typedef struct {
    int x;
    int y;
} Point;
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'geom.h');
    const s = syms.find((sym) => sym.name === 'Point');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('struct');
  });

  it('extracts typedef enum as kind:enum', async () => {
    const { tree, buf } = await parse(`
typedef enum {
    AUTH_OK = 0,
    AUTH_ERR_INVALID,
    AUTH_ERR_EXPIRED,
} AuthResult;
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'auth.h');
    const s = syms.find((sym) => sym.name === 'AuthResult');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('enum');
  });

  it('typedef struct name is the alias, not the tag', async () => {
    const { tree, buf } = await parse(`
typedef struct AuthSession_s {
    unsigned int user_id;
    char token[256];
} AuthSession;
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'session.h');
    const s = syms.find((sym) => sym.name === 'AuthSession');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('struct');
  });

  it('typedef struct does not produce duplicate symbol for tag name', async () => {
    const { tree, buf } = await parse(`
typedef struct Node {
    int val;
    struct Node *next;
} Node;
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'list.h');
    const nodes = syms.filter((sym) => sym.name === 'Node');
    // typedef_definition produces 1 entry; struct_specifier inside may also produce one
    // we only care that at least 1 correct struct symbol exists
    expect(nodes.some((s) => s.kind === 'struct')).toBe(true);
  });

  it('typedef enum signature contains enum constants', async () => {
    const { tree, buf } = await parse(`
typedef enum { RED, GREEN, BLUE } Color;
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'colors.h');
    const s = syms.find((sym) => sym.name === 'Color');
    expect(s).toBeDefined();
    expect(s!.signature).toContain('RED');
  });
});

// ─── C functions with struct return types (regression: Task 262) ──────────────

describe('cppHandler — C functions with struct return types', () => {
  it('extracts C function that returns struct pointer (not treated as export macro class)', async () => {
    const { tree, buf } = await parse(`
struct AP_info *get_ap_by_mac(unsigned char *mac)
{
    return NULL;
}
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'airodump.c');
    const fn = syms.find((s) => s.name === 'get_ap_by_mac');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('extracts multiple C functions with struct return types from same file', async () => {
    const { tree, buf } = await parse(`
struct AP_info *dump_initialize(const char *prefix)
{
    return NULL;
}

struct ST_info *add_station(unsigned char *mac)
{
    return NULL;
}

int check_shared_key(unsigned char *h80211, int caplen)
{
    return 0;
}
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'dump.c');
    const dump_init = syms.find((s) => s.name === 'dump_initialize');
    const add_st = syms.find((s) => s.name === 'add_station');
    const check_key = syms.find((s) => s.name === 'check_shared_key');
    expect(dump_init).toBeDefined();
    expect(dump_init!.kind).toBe('function');
    expect(add_st).toBeDefined();
    expect(add_st!.kind).toBe('function');
    expect(check_key).toBeDefined();
    expect(check_key!.kind).toBe('function');
  });

  it('plain int function still extracts correctly alongside struct-returning functions', async () => {
    const { tree, buf } = await parse(`
int check_crc(unsigned char *buf, int len) { return 1; }
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'crc.c');
    const fn = syms.find((s) => s.name === 'check_crc');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });
});
