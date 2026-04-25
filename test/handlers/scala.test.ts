import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { scalaHandler } from '../../src/handlers/scala.js';

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, scalaHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Scala handler — extractSymbols', () => {
  it('extracts class_definition as kind class', async () => {
    const src = `class Foo(x: Int) {}`;
    const { tree, buf } = await parse(src);
    const syms = scalaHandler.extractSymbols(tree, buf, 'src/Foo.scala');
    const cls = syms.find((s) => s.name === 'Foo');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
  });

  it('extracts trait_definition as kind interface', async () => {
    const src = `trait Greeter { def greet(): String }`;
    const { tree, buf } = await parse(src);
    const syms = scalaHandler.extractSymbols(tree, buf, 'src/Greeter.scala');
    const trait_ = syms.find((s) => s.name === 'Greeter');
    expect(trait_).toBeDefined();
    expect(trait_!.kind).toBe('interface');
  });

  it('extracts object_definition as kind class with scala_object metadata', async () => {
    const src = `object Config { val timeout = 30 }`;
    const { tree, buf } = await parse(src);
    const syms = scalaHandler.extractSymbols(tree, buf, 'src/Config.scala');
    const obj = syms.find((s) => s.name === 'Config');
    expect(obj).toBeDefined();
    expect(obj!.kind).toBe('class');
    expect(obj!.frameworkMeta?.scala_object).toBe(true);
  });

  it('extracts case class with scala_case_class metadata', async () => {
    const src = `case class User(name: String, age: Int)`;
    const { tree, buf } = await parse(src);
    const syms = scalaHandler.extractSymbols(tree, buf, 'src/User.scala');
    const cls = syms.find((s) => s.name === 'User');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.frameworkMeta?.scala_case_class).toBe(true);
  });

  it('includes case class fields in signature', async () => {
    const src = `case class Point(x: Double, y: Double)`;
    const { tree, buf } = await parse(src);
    const syms = scalaHandler.extractSymbols(tree, buf, 'src/Point.scala');
    const cls = syms.find((s) => s.name === 'Point');
    expect(cls!.signature).toContain('case class');
    expect(cls!.signature).toContain('Point');
  });

  it('extracts def in object as kind function', async () => {
    const src = `object MathUtils {\n  def square(n: Int): Int = n * n\n}`;
    const { tree, buf } = await parse(src);
    const syms = scalaHandler.extractSymbols(tree, buf, 'src/MathUtils.scala');
    const fn = syms.find((s) => s.name === 'square');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('extracts def in class as kind method', async () => {
    const src = `class Service {\n  def process(x: String): String = x.trim\n}`;
    const { tree, buf } = await parse(src);
    const syms = scalaHandler.extractSymbols(tree, buf, 'src/Service.scala');
    const m = syms.find((s) => s.name === 'process');
    expect(m).toBeDefined();
    expect(m!.kind).toBe('method');
  });

  it('extracts def in trait as kind method', async () => {
    const src = `trait Repo {\n  def findById(id: String): Option[String]\n}`;
    const { tree, buf } = await parse(src);
    const syms = scalaHandler.extractSymbols(tree, buf, 'src/Repo.scala');
    const m = syms.find((s) => s.name === 'findById');
    expect(m).toBeDefined();
    expect(m!.kind).toBe('method');
  });

  it('skips private methods', async () => {
    const src = `class Foo {\n  private def secret(): Unit = ()\n  def visible(): Unit = ()\n}`;
    const { tree, buf } = await parse(src);
    const syms = scalaHandler.extractSymbols(tree, buf, 'src/Foo.scala');
    expect(syms.find((s) => s.name === 'secret')).toBeUndefined();
    expect(syms.find((s) => s.name === 'visible')).toBeDefined();
  });

  it('skips protected methods', async () => {
    const src = `class Foo {\n  protected def internal(): Unit = ()\n  def pub(): Unit = ()\n}`;
    const { tree, buf } = await parse(src);
    const syms = scalaHandler.extractSymbols(tree, buf, 'src/Foo.scala');
    expect(syms.find((s) => s.name === 'internal')).toBeUndefined();
    expect(syms.find((s) => s.name === 'pub')).toBeDefined();
  });

  it('extracts top-level val_definition as kind const', async () => {
    const src = `object Cfg {\n  val MaxRetries: Int = 3\n}`;
    const { tree, buf } = await parse(src);
    const syms = scalaHandler.extractSymbols(tree, buf, 'src/Cfg.scala');
    const v = syms.find((s) => s.name === 'MaxRetries');
    expect(v).toBeDefined();
    expect(v!.kind).toBe('const');
  });

  it('extracts type_definition as kind type', async () => {
    const src = `type UserId = String`;
    const { tree, buf } = await parse(src);
    const syms = scalaHandler.extractSymbols(tree, buf, 'src/Types.scala');
    const t = syms.find((s) => s.name === 'UserId');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('type');
  });

  it('extracts enum_definition (Scala 3) as kind enum', async () => {
    const src = `enum Color:\n  case Red, Green, Blue\n`;
    const { tree, buf } = await parse(src);
    const syms = scalaHandler.extractSymbols(tree, buf, 'src/Color.scala');
    const e = syms.find((s) => s.name === 'Color');
    expect(e).toBeDefined();
    expect(e!.kind).toBe('enum');
  });

  it('extracts given_definition (Scala 3) as kind const with scala_given metadata', async () => {
    const src = `given defaultOrd: Ordering[String] = Ordering.String\n`;
    const { tree, buf } = await parse(src);
    const syms = scalaHandler.extractSymbols(tree, buf, 'src/Givens.scala');
    const g = syms.find((s) => s.frameworkMeta?.scala_given === true);
    expect(g).toBeDefined();
    expect(g!.kind).toBe('const');
  });

  it('extracts extension_definition (Scala 3) with scala_extension metadata', async () => {
    const src = `extension (s: String)\n  def shout: String = s.toUpperCase\n`;
    const { tree, buf } = await parse(src);
    const syms = scalaHandler.extractSymbols(tree, buf, 'src/Ext.scala');
    const ext = syms.find((s) => s.frameworkMeta?.scala_extension === true);
    expect(ext).toBeDefined();
    expect(ext!.kind).toBe('class');
  });

  it('function signature includes def, name, params, and return type', async () => {
    const src = `object M {\n  def add(a: Int, b: Int): Int = a + b\n}`;
    const { tree, buf } = await parse(src);
    const syms = scalaHandler.extractSymbols(tree, buf, 'src/M.scala');
    const fn = syms.find((s) => s.name === 'add');
    expect(fn!.signature).toContain('def add');
    expect(fn!.signature).toContain('Int');
  });

  it('generates a deterministic 16-char hex id', async () => {
    const src = `class Widget {}`;
    const { tree, buf } = await parse(src);
    const sym = scalaHandler.extractSymbols(tree, buf, 'src/Widget.scala')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = scalaHandler.extractSymbols(tree, buf, 'src/Widget.scala')[0]!;
    expect(sym2.id).toBe(sym.id);
  });

  it('captures Scaladoc as docstring', async () => {
    const src = `/** A very important class. */\nclass Important {}`;
    const { tree, buf } = await parse(src);
    const syms = scalaHandler.extractSymbols(tree, buf, 'src/Important.scala');
    const cls = syms.find((s) => s.name === 'Important');
    expect(cls!.summary).toContain('important');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Scala handler — extractImports', () => {
  it('extracts simple import', async () => {
    const src = `import scala.collection.mutable.ListBuffer\nclass Foo {}`;
    const { tree, buf } = await parse(src);
    const imports = scalaHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toContain('scala.collection.mutable.ListBuffer');
  });

  it('extracts wildcard import', async () => {
    const src = `import java.io._\nclass Foo {}`;
    const { tree, buf } = await parse(src);
    const imports = scalaHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toContain('java.io._');
  });

  it('extracts import with renaming syntax', async () => {
    const src = `import scala.util.{ Try, Success => Ok }\nclass Foo {}`;
    const { tree, buf } = await parse(src);
    const imports = scalaHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
  });

  it('resolvedPath is always null', async () => {
    const src = `import scala.math.max\nclass Foo {}`;
    const { tree, buf } = await parse(src);
    const imports = scalaHandler.extractImports(tree, buf);
    expect(imports[0]!.resolvedPath).toBeNull();
  });

  it('isTypeOnly is always false', async () => {
    const src = `import scala.math.max\nclass Foo {}`;
    const { tree, buf } = await parse(src);
    const imports = scalaHandler.extractImports(tree, buf);
    expect(imports[0]!.isTypeOnly).toBe(false);
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('Scala handler — extractDocstring', () => {
  it('returns null when no preceding comment', async () => {
    const src = `class Foo {}`;
    const { tree, buf } = await parse(src);
    const root = tree.rootNode;
    const cls = root.children.find((c) => c.type === 'class_definition');
    expect(scalaHandler.extractDocstring(cls!)).toBeNull();
  });

  it('strips Scaladoc markers and returns cleaned text', async () => {
    const src = `/** Processes a widget.\n  * @param x the widget\n  */\nclass Widget {}`;
    const { tree, buf } = await parse(src);
    const root = tree.rootNode;
    const cls = root.children.find((c) => c.type === 'class_definition');
    const doc = scalaHandler.extractDocstring(cls!);
    expect(doc).toBeTruthy();
    expect(doc).toContain('Processes');
    // @param tags should be stripped from the summary
    expect(doc).not.toContain('@param');
  });
});
