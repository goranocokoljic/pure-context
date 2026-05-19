import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { kotlinHandler } from '../../src/handlers/kotlin.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/kotlin-project');

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, kotlinHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Kotlin handler — extractSymbols', () => {
  it('extracts a top-level function', async () => {
    const { tree, buf } = await parse(`fun greet(name: String): String = "Hello"\n`);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Main.kt');
    const fn = syms.find((s) => s.name === 'greet');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.startByte).toBeGreaterThanOrEqual(0);
    expect(fn!.endByte).toBeGreaterThan(0);
  });

  it('generates a deterministic 16-char hex id', async () => {
    const { tree, buf } = await parse(`fun foo() {}\n`);
    const sym = kotlinHandler.extractSymbols(tree, buf, 'Main.kt')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = kotlinHandler.extractSymbols(tree, buf, 'Main.kt')[0]!;
    expect(sym2.id).toBe(sym.id);
  });

  it('extracts a plain class', async () => {
    const { tree, buf } = await parse(`class OrderService {\n  fun process() {}\n}\n`);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'OrderService.kt');
    const cls = syms.find((s) => s.name === 'OrderService');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.signature).toContain('class OrderService');
  });

  it('extracts a data class', async () => {
    const src = `data class User(val name: String, val email: String)\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'User.kt');
    const cls = syms.find((s) => s.name === 'User');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.signature).toContain('data class User');
  });

  it('extracts class methods as kind method', async () => {
    const src = `class Greeter {\n  fun hello(name: String): String = "Hello"\n  fun bye(): String = "Bye"\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Greeter.kt');
    expect(syms.find((s) => s.name === 'Greeter.hello')).toBeDefined();
    expect(syms.find((s) => s.name === 'Greeter.bye')).toBeDefined();
    expect(syms.find((s) => s.name === 'Greeter.hello')!.kind).toBe('method');
  });

  it('does not extract private methods', async () => {
    const src = `class Service {\n  fun publicMethod() {}\n  private fun secret() {}\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Service.kt');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Service.publicMethod');
    expect(names).not.toContain('Service.secret');
  });

  it('does not extract internal functions', async () => {
    const src = `internal fun internalHelper(): String = ""\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Helper.kt');
    expect(syms.filter((s) => s.name === 'internalHelper')).toHaveLength(0);
  });

  it('extracts companion object functions as ClassName.methodName', async () => {
    const src = `class Repo {\n  companion object {\n    fun create(): Repo = Repo()\n  }\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Repo.kt');
    const method = syms.find((s) => s.name === 'Repo.create');
    expect(method).toBeDefined();
    expect(method!.kind).toBe('method');
  });

  it('extracts interface as kind interface', async () => {
    const src = `interface Repository {\n  fun findById(id: Long): String?\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Repository.kt');
    const iface = syms.find((s) => s.name === 'Repository');
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe('interface');
    expect(iface!.signature).toContain('interface Repository');
  });

  it('extracts object declaration as kind class with kotlin_object meta', async () => {
    const src = `object Singleton {\n  fun doWork() {}\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Singleton.kt');
    const obj = syms.find((s) => s.name === 'Singleton');
    expect(obj).toBeDefined();
    expect(obj!.kind).toBe('class');
    expect(obj!.frameworkMeta?.kotlin_object).toBe(true);
    expect(obj!.signature).toContain('object Singleton');
  });

  it('extracts object methods as kind method', async () => {
    const src = `object AppRegistry {\n  fun register(name: String) {}\n  fun lookup(name: String): String? = null\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'AppRegistry.kt');
    expect(syms.find((s) => s.name === 'AppRegistry.register')).toBeDefined();
    expect(syms.find((s) => s.name === 'AppRegistry.lookup')).toBeDefined();
  });

  it('extracts enum class as kind enum', async () => {
    const src = `enum class Status {\n  ACTIVE,\n  INACTIVE,\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Status.kt');
    const en = syms.find((s) => s.name === 'Status');
    expect(en).toBeDefined();
    expect(en!.kind).toBe('enum');
    expect(en!.signature).toContain('enum class Status');
  });

  it('extracts typealias as kind type', async () => {
    const src = `typealias UserId = Long\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Types.kt');
    const alias = syms.find((s) => s.name === 'UserId');
    expect(alias).toBeDefined();
    expect(alias!.kind).toBe('type');
    expect(alias!.signature).toContain('typealias UserId');
  });

  it('extracts top-level val with UPPER_CASE name as kind const', async () => {
    const src = `val MAX_SIZE: Int = 100\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Config.kt');
    const c = syms.find((s) => s.name === 'MAX_SIZE');
    expect(c).toBeDefined();
    expect(c!.kind).toBe('const');
    expect(c!.signature).toContain('val MAX_SIZE');
  });

  it('does not extract lowercase top-level val as const', async () => {
    const src = `val lowercase = "value"\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Config.kt');
    expect(syms.filter((s) => s.kind === 'const')).toHaveLength(0);
  });

  it('does not extract class-level properties as const', async () => {
    const src = `class Config {\n  val MAX_RETRIES: Int = 3\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Config.kt');
    expect(syms.filter((s) => s.kind === 'const')).toHaveLength(0);
  });

  it('function signature contains parameter types', async () => {
    const src = `fun process(id: Long, name: String): Boolean = true\n`;
    const { tree, buf } = await parse(src);
    const sym = kotlinHandler.extractSymbols(tree, buf, 'Main.kt')[0]!;
    expect(sym.signature).toContain('fun process');
    expect(sym.signature).not.toContain('{');
  });

  it('extracts symbols from fixture User.kt', async () => {
    const src = readFileSync(`${FIXTURE_ROOT}/src/main/kotlin/com/example/models/User.kt`, 'utf8');
    const buf = Buffer.from(src);
    const tree = await parseFile(buf, kotlinHandler);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'User.kt');
    const names = syms.map((s) => s.name);

    // data class
    expect(names).toContain('User');
    expect(syms.find((s) => s.name === 'User')!.kind).toBe('class');

    // public instance methods
    expect(names).toContain('User.displayName');
    expect(names).toContain('User.isValid');

    // private method should NOT be extracted
    expect(names).not.toContain('User.internalSecret');

    // companion object functions
    expect(names).toContain('User.guest');
    expect(names).toContain('User.fromMap');
  });

  it('extracts symbols from fixture Main.kt', async () => {
    const src = readFileSync(`${FIXTURE_ROOT}/src/main/kotlin/com/example/Main.kt`, 'utf8');
    const buf = Buffer.from(src);
    const tree = await parseFile(buf, kotlinHandler);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Main.kt');
    const names = syms.map((s) => s.name);

    expect(names).toContain('MAX_CONNECTIONS');
    expect(syms.find((s) => s.name === 'MAX_CONNECTIONS')!.kind).toBe('const');

    expect(names).toContain('greet');
    expect(syms.find((s) => s.name === 'greet')!.kind).toBe('function');

    expect(names).toContain('UserId');
    expect(syms.find((s) => s.name === 'UserId')!.kind).toBe('type');

    expect(names).toContain('Repository');
    expect(syms.find((s) => s.name === 'Repository')!.kind).toBe('interface');

    expect(names).toContain('AppRegistry');
    expect(syms.find((s) => s.name === 'AppRegistry')!.kind).toBe('class');
    expect(syms.find((s) => s.name === 'AppRegistry')!.frameworkMeta?.kotlin_object).toBe(true);

    expect(names).toContain('Status');
    expect(syms.find((s) => s.name === 'Status')!.kind).toBe('enum');

    // lowercase val should NOT be extracted as const
    expect(names).not.toContain('internalOnly');
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('Kotlin handler — extractDocstring', () => {
  it('captures KDoc comment preceding a function', async () => {
    const src = `/** Greets the user. */\nfun greet(name: String): String = "Hello"\n`;
    const { tree } = await parse(src);
    const fnNode = tree.rootNode.children.find((c) => c.type === 'function_declaration');
    expect(fnNode).toBeDefined();
    const doc = kotlinHandler.extractDocstring!(fnNode!);
    expect(doc).toBeTruthy();
    expect(doc).toContain('Greets');
  });

  it('captures line comment preceding a function', async () => {
    const src = `// A helper function\nfun helper(): Unit {}\n`;
    const { tree } = await parse(src);
    const fnNode = tree.rootNode.children.find((c) => c.type === 'function_declaration');
    expect(fnNode).toBeDefined();
    const doc = kotlinHandler.extractDocstring!(fnNode!);
    expect(doc).toBeTruthy();
    expect(doc).toContain('helper');
  });

  it('returns null when no preceding comment', async () => {
    const src = `fun bare(): Unit {}\n`;
    const { tree } = await parse(src);
    const fnNode = tree.rootNode.children.find((c) => c.type === 'function_declaration');
    expect(fnNode).toBeDefined();
    const doc = kotlinHandler.extractDocstring!(fnNode!);
    expect(doc).toBeNull();
  });

  it('captures KDoc from fixture User.kt User class', async () => {
    const src = readFileSync(`${FIXTURE_ROOT}/src/main/kotlin/com/example/models/User.kt`, 'utf8');
    const buf = Buffer.from(src);
    const tree = await parseFile(buf, kotlinHandler);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'User.kt');
    const user = syms.find((s) => s.name === 'User');
    expect(user!.summary).toBeTruthy();
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Kotlin handler — extractImports', () => {
  it('extracts a single import', async () => {
    const { tree, buf } = await parse(`import java.io.Serializable\n`);
    const imports = kotlinHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('java.io.Serializable');
    expect(imports[0]!.importedNames).toContain('Serializable');
    expect(imports[0]!.isTypeOnly).toBe(false);
    expect(imports[0]!.resolvedPath).toBeNull();
  });

  it('extracts multiple imports', async () => {
    const src = `import java.io.Serializable\nimport kotlin.collections.List\nimport io.ktor.server.application.Application\n`;
    const { tree, buf } = await parse(src);
    const imports = kotlinHandler.extractImports(tree, buf);
    expect(imports.length).toBeGreaterThanOrEqual(3);
    const specifiers = imports.map((i) => i.specifier);
    expect(specifiers).toContain('java.io.Serializable');
    expect(specifiers).toContain('kotlin.collections.List');
    expect(specifiers).toContain('io.ktor.server.application.Application');
  });

  it('extracts imports from fixture User.kt', async () => {
    const src = readFileSync(`${FIXTURE_ROOT}/src/main/kotlin/com/example/models/User.kt`, 'utf8');
    const buf = Buffer.from(src);
    const tree = await parseFile(buf, kotlinHandler);
    const imports = kotlinHandler.extractImports(tree, buf);
    const specifiers = imports.map((i) => i.specifier);
    expect(specifiers).toContain('java.io.Serializable');
    expect(specifiers).toContain('com.example.util.DateUtils');
  });
});

// ─── Task 272: Extension functions ────────────────────────────────────────────

describe('Kotlin handler — extension functions', () => {
  it('extracts a simple extension function with receiver type as kind method', async () => {
    const { tree, buf } = await parse(`fun String.greet(name: String): String = "Hello"\n`);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Ext.kt');
    const fn = syms.find((s) => s.name === 'String.greet');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('method');
    expect(fn!.signature).toContain('fun String.greet');
  });

  it('strips generic type parameters from extension receiver type', async () => {
    const { tree, buf } = await parse(`fun List<Int>.sumAll(): Int = fold(0) { a, b -> a + b }\n`);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Ext.kt');
    const fn = syms.find((s) => s.name === 'List.sumAll');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('method');
  });

  it('extracts extension function on nested type (Companion)', async () => {
    const src = `fun CartesianChartModel.Companion.empty(): String = ""\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Ext.kt');
    const fn = syms.find((s) => s.name === 'CartesianChartModel.Companion.empty');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('method');
  });

  it('does not confuse regular function with extension function', async () => {
    const { tree, buf } = await parse(`fun regularFun(name: String): String = name\n`);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Reg.kt');
    const fn = syms.find((s) => s.name === 'regularFun');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('extension function does not appear with bare short name', async () => {
    const { tree, buf } = await parse(`fun CartesianChart.draw(): Unit {}\n`);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Ext.kt');
    expect(syms.find((s) => s.name === 'draw')).toBeUndefined();
    expect(syms.find((s) => s.name === 'CartesianChart.draw')).toBeDefined();
  });

  it('does not extract private extension function', async () => {
    const { tree, buf } = await parse(`private fun String.secret(): String = this\n`);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Ext.kt');
    expect(syms.find((s) => s.name.endsWith('.secret'))).toBeUndefined();
  });
});

// ─── Task 272: Data class primary constructor properties ──────────────────────

describe('Kotlin handler — data class primary constructor properties', () => {
  it('extracts val constructor properties as kind property', async () => {
    const src = `data class User(val name: String, val email: String)\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'User.kt');
    expect(syms.find((s) => s.name === 'User.name' && s.kind === 'property')).toBeDefined();
    expect(syms.find((s) => s.name === 'User.email' && s.kind === 'property')).toBeDefined();
  });

  it('extracts var constructor properties as kind property', async () => {
    const src = `data class MutableModel(var count: Int = 0, var label: String = "")\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Model.kt');
    expect(syms.find((s) => s.name === 'MutableModel.count' && s.kind === 'property')).toBeDefined();
    expect(syms.find((s) => s.name === 'MutableModel.label' && s.kind === 'property')).toBeDefined();
  });

  it('does not extract private constructor properties', async () => {
    const src = `data class Secure(val name: String, private val secret: String)\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Secure.kt');
    expect(syms.find((s) => s.name === 'Secure.name')).toBeDefined();
    expect(syms.find((s) => s.name === 'Secure.secret')).toBeUndefined();
  });

  it('does not extract constructor parameters without val/var', async () => {
    const src = `class NotDataClass(name: String, count: Int)\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Plain.kt');
    expect(syms.filter((s) => s.kind === 'property')).toHaveLength(0);
  });

  it('property signature contains the parameter declaration', async () => {
    const src = `data class Entry(val x: Float, val y: Float)\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Entry.kt');
    const xProp = syms.find((s) => s.name === 'Entry.x');
    expect(xProp).toBeDefined();
    expect(xProp!.signature).toContain('val x');
  });

  it('extracts properties from a class with both primary constructor and body methods', async () => {
    const src = `data class Order(val id: Long, val total: Double) {\n  fun isValid(): Boolean = total > 0\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Order.kt');
    expect(syms.find((s) => s.name === 'Order.id' && s.kind === 'property')).toBeDefined();
    expect(syms.find((s) => s.name === 'Order.total' && s.kind === 'property')).toBeDefined();
    expect(syms.find((s) => s.name === 'Order.isValid' && s.kind === 'method')).toBeDefined();
  });
});

// ─── Task 272: Interface method stubs ─────────────────────────────────────────

describe('Kotlin handler — interface method stubs', () => {
  it('extracts interface method declarations as kind method', async () => {
    const src = `interface CartesianLayer {\n  fun draw(canvas: String)\n  fun update()\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Layer.kt');
    expect(syms.find((s) => s.name === 'CartesianLayer.draw' && s.kind === 'method')).toBeDefined();
    expect(syms.find((s) => s.name === 'CartesianLayer.update' && s.kind === 'method')).toBeDefined();
  });

  it('interface itself is extracted as kind interface', async () => {
    const src = `interface Repository {\n  fun findById(id: Long): String?\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Repo.kt');
    const iface = syms.find((s) => s.name === 'Repository');
    expect(iface!.kind).toBe('interface');
    const method = syms.find((s) => s.name === 'Repository.findById');
    expect(method).toBeDefined();
    expect(method!.kind).toBe('method');
  });

  it('multiple interface methods are all extracted', async () => {
    const src = `interface Chart {\n  fun draw()\n  fun update(model: String)\n  fun clear()\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = kotlinHandler.extractSymbols(tree, buf, 'Chart.kt');
    const methods = syms.filter((s) => s.kind === 'method');
    expect(methods.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── Handler metadata ─────────────────────────────────────────────────────────

describe('Kotlin handler — metadata', () => {
  it('claims .kt and .kts extensions', () => {
    expect(kotlinHandler.extensions()).toContain('.kt');
    expect(kotlinHandler.extensions()).toContain('.kts');
  });

  it('grammarPath points to tree-sitter-kotlin.wasm', () => {
    expect(kotlinHandler.grammarPath()).toMatch(/tree-sitter-kotlin\.wasm$/);
  });
});
