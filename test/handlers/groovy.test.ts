import { describe, it, expect } from 'vitest';
import { groovyHandler } from '../../src/handlers/groovy.js';
import type { Tree } from '../../src/core/types.js';

// Groovy handler is regex-based (grammarPath returns null) — no tree-sitter needed.
// Pass null as the tree; extractSymbols/extractImports ignore it.
function parse(source: string) {
  const buf = Buffer.from(source);
  return { tree: null as unknown as Tree, buf };
}

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Groovy handler — extractSymbols', () => {

  // ── class → 'class' ───────────────────────────────────────────────────────

  it('extracts class as kind "class"', () => {
    const { tree, buf } = parse(`
class MyService {
  def name = "hello"
}
`);
    const syms = groovyHandler.extractSymbols(tree, buf, 'MyService.groovy');
    const sym = syms.find((s) => s.name === 'MyService');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
    expect(sym!.signature).toContain('class MyService');
  });

  it('extracts class with access modifier', () => {
    const { tree, buf } = parse(`
public class UserController {
}
`);
    const syms = groovyHandler.extractSymbols(tree, buf, 'Controller.groovy');
    expect(syms.find((s) => s.name === 'UserController')).toBeDefined();
  });

  it('extracts class with annotation', () => {
    const { tree, buf } = parse(`
@Component
class BeanConfig {
}
`);
    const syms = groovyHandler.extractSymbols(tree, buf, 'Config.groovy');
    // @Component is on a separate line so CLASS_RE sees bare `class BeanConfig`
    expect(syms.find((s) => s.name === 'BeanConfig')).toBeDefined();
  });

  // ── method inside class ───────────────────────────────────────────────────

  it('extracts methods inside a class as kind "method" with ClassName.methodName', () => {
    const { tree, buf } = parse(`
class UserService {
  def getUser(String id) {
    return db.find(id)
  }

  def createUser(String name, String email) {
    return new User(name, email)
  }
}
`);
    const syms = groovyHandler.extractSymbols(tree, buf, 'UserService.groovy');
    const getUser = syms.find((s) => s.name === 'UserService.getUser');
    const createUser = syms.find((s) => s.name === 'UserService.createUser');
    expect(getUser).toBeDefined();
    expect(getUser!.kind).toBe('method');
    expect(getUser!.signature).toContain('getUser');
    expect(createUser).toBeDefined();
    expect(createUser!.kind).toBe('method');
  });

  // ── field inside class ────────────────────────────────────────────────────

  it('extracts def fields inside a class as kind "const" with ClassName.fieldName', () => {
    const { tree, buf } = parse(`
class Config {
  def timeout = 30
  def baseUrl = "http://example.com"
}
`);
    const syms = groovyHandler.extractSymbols(tree, buf, 'Config.groovy');
    const timeout = syms.find((s) => s.name === 'Config.timeout');
    const baseUrl = syms.find((s) => s.name === 'Config.baseUrl');
    expect(timeout).toBeDefined();
    expect(timeout!.kind).toBe('const');
    expect(baseUrl).toBeDefined();
    expect(baseUrl!.kind).toBe('const');
  });

  // ── top-level function ────────────────────────────────────────────────────

  it('extracts top-level def name() as kind "function"', () => {
    const { tree, buf } = parse(`
def greet(String name) {
  println "Hello, $name"
}
`);
    const syms = groovyHandler.extractSymbols(tree, buf, 'script.groovy');
    const sym = syms.find((s) => s.name === 'greet');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
    expect(sym!.signature).toContain('greet');
  });

  // ── top-level const ───────────────────────────────────────────────────────

  it('extracts top-level def name = value as kind "const"', () => {
    const { tree, buf } = parse(`
def VERSION = "1.0.0"
def MAX_RETRIES = 3
`);
    const syms = groovyHandler.extractSymbols(tree, buf, 'script.groovy');
    const ver = syms.find((s) => s.name === 'VERSION');
    const retries = syms.find((s) => s.name === 'MAX_RETRIES');
    expect(ver).toBeDefined();
    expect(ver!.kind).toBe('const');
    expect(retries).toBeDefined();
  });

  // ── Gradle task ───────────────────────────────────────────────────────────

  it('extracts task name { } as kind "function"', () => {
    const { tree, buf } = parse(`
task clean {
  delete buildDir
}
`);
    const syms = groovyHandler.extractSymbols(tree, buf, 'build.gradle');
    const sym = syms.find((s) => s.name === 'clean');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
    expect(sym!.signature).toContain('task clean');
  });

  it('extracts task name(type: ...) { } as kind "function"', () => {
    const { tree, buf } = parse(`
task test(type: Test) {
  useJUnitPlatform()
}
`);
    const syms = groovyHandler.extractSymbols(tree, buf, 'build.gradle');
    const sym = syms.find((s) => s.name === 'test');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
  });

  it('extracts tasks.register("name") { } as kind "function"', () => {
    const { tree, buf } = parse(`
tasks.register('hello') {
  doLast {
    println 'Hello world!'
  }
}
`);
    const syms = groovyHandler.extractSymbols(tree, buf, 'build.gradle');
    const sym = syms.find((s) => s.name === 'hello');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
    expect(sym!.signature).toContain('task hello');
  });

  // ── Groovydoc comment as summary ─────────────────────────────────────────

  it('uses preceding Groovydoc /** */ block as summary', () => {
    const { tree, buf } = parse(
      `/**\n * Sends a notification to the user.\n */\ndef notify(String msg) {\n  println msg\n}\n`,
    );
    const syms = groovyHandler.extractSymbols(tree, buf, 'script.groovy');
    const sym = syms.find((s) => s.name === 'notify');
    expect(sym!.summary).toContain('Sends a notification');
  });

  it('uses preceding // comment as summary', () => {
    const { tree, buf } = parse(
      `// Builds the project artifacts.\ntask build {\n  dependsOn compile\n}\n`,
    );
    const syms = groovyHandler.extractSymbols(tree, buf, 'build.gradle');
    const sym = syms.find((s) => s.name === 'build');
    expect(sym!.summary).toContain('Builds the project');
  });

  it('uses preceding Groovydoc as summary for class method', () => {
    const { tree, buf } = parse(`
class MyClass {
  /**
   * Returns the current count.
   */
  def getCount() {
    return count
  }
}
`);
    const syms = groovyHandler.extractSymbols(tree, buf, 'MyClass.groovy');
    const sym = syms.find((s) => s.name === 'MyClass.getCount');
    expect(sym!.summary).toContain('Returns the current count');
  });

  // ── deterministic ID ──────────────────────────────────────────────────────

  it('generates a deterministic 16-char hex ID', () => {
    const { tree, buf } = parse(`class Foo {\n  def bar() {}\n}\n`);
    const sym = groovyHandler.extractSymbols(tree, buf, 'Foo.groovy').find((s) => s.name === 'Foo')!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = groovyHandler.extractSymbols(tree, buf, 'Foo.groovy').find((s) => s.name === 'Foo')!;
    expect(sym2.id).toBe(sym.id);
  });

  // ── byte offsets ──────────────────────────────────────────────────────────

  it('sets non-zero startByte and endByte for class', () => {
    const { tree, buf } = parse(`\nclass Foo {\n}\n`);
    const sym = groovyHandler.extractSymbols(tree, buf, 'Foo.groovy').find((s) => s.name === 'Foo')!;
    expect(sym.startByte).toBeGreaterThan(0);
    expect(sym.endByte).toBeGreaterThan(sym.startByte);
  });

  // ── multiple symbols in a file ────────────────────────────────────────────

  it('extracts multiple classes and top-level symbols from a single file', () => {
    const { tree, buf } = parse(`
import com.example.Base

class ServiceA {
  def execute() { return "a" }
}

class ServiceB {
  def execute() { return "b" }
}

def VERSION = "2.0"
`);
    const syms = groovyHandler.extractSymbols(tree, buf, 'services.groovy');
    const names = syms.map((s) => s.name);
    expect(names).toContain('ServiceA');
    expect(names).toContain('ServiceA.execute');
    expect(names).toContain('ServiceB');
    expect(names).toContain('ServiceB.execute');
    expect(names).toContain('VERSION');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Groovy handler — extractImports', () => {

  it('extracts import statements', () => {
    const { tree, buf } = parse(`
import com.example.MyClass
import org.springframework.beans.factory.annotation.Autowired
`);
    const imports = groovyHandler.extractImports(tree, buf);
    expect(imports.length).toBeGreaterThanOrEqual(2);
    const specs = imports.map((i) => i.specifier);
    expect(specs).toContain('com.example.MyClass');
    expect(specs).toContain('org.springframework.beans.factory.annotation.Autowired');
  });

  it('extracts static imports', () => {
    const { tree, buf } = parse(`import static java.lang.Math.sqrt\n`);
    const imports = groovyHandler.extractImports(tree, buf);
    expect(imports[0]!.specifier).toBe('java.lang.Math.sqrt');
  });

  it('extracts wildcard imports', () => {
    const { tree, buf } = parse(`import com.example.*\n`);
    const imports = groovyHandler.extractImports(tree, buf);
    expect(imports[0]!.specifier).toBe('com.example.*');
  });

  it('marks all Groovy imports as external (resolvedPath null)', () => {
    const { tree, buf } = parse(`import com.example.Foo\n`);
    const imports = groovyHandler.extractImports(tree, buf);
    expect(imports[0]!.resolvedPath).toBeNull();
  });

  it('deduplicates repeated imports', () => {
    const { tree, buf } = parse(`import com.example.Foo\nimport com.example.Foo\n`);
    const imports = groovyHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
  });

  it('returns empty array for files with no imports', () => {
    const { tree, buf } = parse(`class Foo {}\n`);
    expect(groovyHandler.extractImports(tree, buf)).toHaveLength(0);
  });
});
