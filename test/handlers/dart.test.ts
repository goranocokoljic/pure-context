import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { dartHandler } from '../../src/handlers/dart.js';

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, dartHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols — class ───────────────────────────────────────────────────

describe('Dart handler — class', () => {
  it('extracts a top-level class as kind "class"', async () => {
    const { tree, buf } = await parse(`class User {\n  User();\n}\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'user.dart');
    const cls = syms.find((s) => s.name === 'User' && s.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls!.signature).toContain('class User');
  });

  it('includes extends clause in class signature', async () => {
    const { tree, buf } = await parse(`class Admin extends User {\n  Admin();\n}\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'admin.dart');
    const cls = syms.find((s) => s.name === 'Admin');
    expect(cls).toBeDefined();
    expect(cls!.signature).toContain('extends User');
  });

  it('skips a private class (name starts with _)', async () => {
    const { tree, buf } = await parse(`class _Internal {\n  _Internal();\n}\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'impl.dart');
    expect(syms.find((s) => s.name === '_Internal')).toBeUndefined();
  });
});

// ─── extractSymbols — mixin ───────────────────────────────────────────────────

describe('Dart handler — mixin', () => {
  it('extracts a mixin as kind "class" with dart_mixin meta', async () => {
    const { tree, buf } = await parse(`mixin Serializable {\n  String toJson();\n}\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'mixins.dart');
    const mixin = syms.find((s) => s.name === 'Serializable');
    expect(mixin).toBeDefined();
    expect(mixin!.kind).toBe('class');
    expect(mixin!.frameworkMeta?.dart_mixin).toBe(true);
    expect(mixin!.signature).toContain('mixin Serializable');
  });
});

// ─── extractSymbols — extension ──────────────────────────────────────────────

describe('Dart handler — extension', () => {
  it('extracts a named extension as kind "class" with dart_extension meta', async () => {
    const { tree, buf } = await parse(`extension StringExt on String {\n  bool get isEmail => contains('@');\n}\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'extensions.dart');
    const ext = syms.find((s) => s.name === 'StringExt');
    expect(ext).toBeDefined();
    expect(ext!.kind).toBe('class');
    expect(ext!.frameworkMeta?.dart_extension).toBe(true);
  });

  it('extracts an anonymous extension with Extension:Type name', async () => {
    const { tree, buf } = await parse(`extension on int {\n  bool get isEven => this % 2 == 0;\n}\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'extensions.dart');
    const ext = syms.find((s) => s.name.startsWith('Extension:'));
    expect(ext).toBeDefined();
    expect(ext!.frameworkMeta?.dart_extension).toBe(true);
  });
});

// ─── extractSymbols — enum ───────────────────────────────────────────────────

describe('Dart handler — enum', () => {
  it('extracts enum as kind "enum"', async () => {
    const { tree, buf } = await parse(`enum Status { active, inactive, pending }\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'status.dart');
    const e = syms.find((s) => s.name === 'Status');
    expect(e).toBeDefined();
    expect(e!.kind).toBe('enum');
    expect(e!.signature).toContain('enum Status');
    expect(e!.signature).toContain('active');
  });

  it('enum signature shows first 3 values', async () => {
    const { tree, buf } = await parse(`enum Color { red, green, blue, yellow, purple }\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'color.dart');
    const e = syms.find((s) => s.name === 'Color');
    expect(e).toBeDefined();
    // Should not include all 5 values — truncated to 3
    expect(e!.signature).toContain('red');
    expect(e!.signature).toContain('green');
    expect(e!.signature).toContain('blue');
  });
});

// ─── extractSymbols — typedef ────────────────────────────────────────────────

describe('Dart handler — typedef', () => {
  it('extracts typedef as kind "type"', async () => {
    const { tree, buf } = await parse(`typedef Callback = void Function(String);\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'types.dart');
    const td = syms.find((s) => s.name === 'Callback');
    expect(td).toBeDefined();
    expect(td!.kind).toBe('type');
    expect(td!.signature).toContain('Callback');
  });
});

// ─── extractSymbols — top-level functions ────────────────────────────────────

describe('Dart handler — top-level functions', () => {
  it('extracts a top-level function as kind "function"', async () => {
    const { tree, buf } = await parse(`String formatName(String first, String last) {\n  return first + last;\n}\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'utils.dart');
    const fn = syms.find((s) => s.name === 'formatName');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.signature).toContain('formatName');
  });

  it('skips a private top-level function', async () => {
    const { tree, buf } = await parse(`String _helper() => 'x';\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'utils.dart');
    expect(syms.find((s) => s.name === '_helper')).toBeUndefined();
  });

  it('includes async in signature when function body is async', async () => {
    const { tree, buf } = await parse(`Future<void> fetchData() async {\n}\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'utils.dart');
    const fn = syms.find((s) => s.name === 'fetchData');
    expect(fn).toBeDefined();
    expect(fn!.signature).toContain('async');
  });
});

// ─── extractSymbols — top-level const/final ──────────────────────────────────

describe('Dart handler — top-level constants', () => {
  it('extracts a top-level const as kind "const"', async () => {
    const { tree, buf } = await parse(`const String VERSION = '1.0.0';\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'constants.dart');
    const c = syms.find((s) => s.name === 'VERSION');
    expect(c).toBeDefined();
    expect(c!.kind).toBe('const');
    expect(c!.signature).toContain('const');
    expect(c!.signature).toContain('VERSION');
  });

  it('extracts a top-level final as kind "const"', async () => {
    const { tree, buf } = await parse(`final int MAX_RETRIES = 3;\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'constants.dart');
    const c = syms.find((s) => s.name === 'MAX_RETRIES');
    expect(c).toBeDefined();
    expect(c!.kind).toBe('const');
  });

  it('skips a private top-level const', async () => {
    const { tree, buf } = await parse(`const String _secret = 'x';\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'constants.dart');
    expect(syms.find((s) => s.name === '_secret')).toBeUndefined();
  });
});

// ─── extractSymbols — class methods ──────────────────────────────────────────

describe('Dart handler — class methods', () => {
  const classCode = `
class Calculator {
  /// Add two numbers.
  int add(int a, int b) => a + b;

  static int multiply(int a, int b) => a * b;

  int get value => _value;

  set value(int v) { _value = v; }

  bool operator ==(Object other) => other is Calculator;

  String toString() => 'Calculator';

  // Private — should not be extracted
  int _compute(int n) => n * 2;
}
`;

  it('extracts public instance method with qualified name', async () => {
    const { tree, buf } = await parse(classCode);
    const syms = dartHandler.extractSymbols(tree, buf, 'calc.dart');
    const m = syms.find((s) => s.name === 'Calculator.add');
    expect(m).toBeDefined();
    expect(m!.kind).toBe('method');
  });

  it('extracts static method', async () => {
    const { tree, buf } = await parse(classCode);
    const syms = dartHandler.extractSymbols(tree, buf, 'calc.dart');
    const m = syms.find((s) => s.name === 'Calculator.multiply');
    expect(m).toBeDefined();
    expect(m!.signature).toContain('static');
  });

  it('extracts getter as method', async () => {
    const { tree, buf } = await parse(classCode);
    const syms = dartHandler.extractSymbols(tree, buf, 'calc.dart');
    const m = syms.find((s) => s.name === 'Calculator.value');
    expect(m).toBeDefined();
    expect(m!.kind).toBe('method');
  });

  it('extracts operator overload as method', async () => {
    const { tree, buf } = await parse(classCode);
    const syms = dartHandler.extractSymbols(tree, buf, 'calc.dart');
    const m = syms.find((s) => s.name.includes('operator'));
    expect(m).toBeDefined();
    expect(m!.kind).toBe('method');
  });

  it('skips private method', async () => {
    const { tree, buf } = await parse(classCode);
    const syms = dartHandler.extractSymbols(tree, buf, 'calc.dart');
    expect(syms.find((s) => s.name === 'Calculator._compute')).toBeUndefined();
  });
});

// ─── extractSymbols — constructors ───────────────────────────────────────────

describe('Dart handler — constructors', () => {
  it('extracts default constructor', async () => {
    const { tree, buf } = await parse(`class Point {\n  double x;\n  double y;\n  Point(this.x, this.y);\n}\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'point.dart');
    const ctor = syms.find((s) => s.kind === 'method' && s.name.includes('Point.Point'));
    expect(ctor).toBeDefined();
  });

  it('extracts named constructor', async () => {
    const { tree, buf } = await parse(`class User {\n  String name;\n  User.fromJson(Map<String, dynamic> json) : name = json['name'];\n}\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'user.dart');
    const ctor = syms.find((s) => s.name === 'User.fromJson');
    expect(ctor).toBeDefined();
    expect(ctor!.kind).toBe('method');
    expect(ctor!.signature).toContain('fromJson');
  });

  it('extracts factory constructor', async () => {
    const { tree, buf } = await parse(`class Service {\n  factory Service.create() => Service._();\n  Service._();\n}\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'service.dart');
    const factory = syms.find((s) => s.name === 'Service.create');
    expect(factory).toBeDefined();
    expect(factory!.signature).toContain('factory');
  });
});

// ─── extractSymbols — docstrings ─────────────────────────────────────────────

describe('Dart handler — docstrings', () => {
  it('captures /// triple-slash doc comment for a class', async () => {
    const { tree, buf } = await parse(`/// Manages user data.\nclass UserRepo {\n  UserRepo();\n}\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'repo.dart');
    const cls = syms.find((s) => s.name === 'UserRepo');
    expect(cls).toBeDefined();
    expect(cls!.summary).toContain('Manages user data');
  });

  it('captures /// doc comment for a method', async () => {
    const { tree, buf } = await parse(`class Repo {\n  /// Finds by id.\n  String find(int id) => '';\n}\n`);
    const syms = dartHandler.extractSymbols(tree, buf, 'repo.dart');
    const m = syms.find((s) => s.name === 'Repo.find');
    expect(m).toBeDefined();
    expect(m!.summary).toContain('Finds by id');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Dart handler — extractImports', () => {
  it('extracts a dart: standard library import', async () => {
    const { tree, buf } = await parse(`import 'dart:async';\n`);
    const imports = dartHandler.extractImports(tree, buf);
    const imp = imports.find((i) => i.specifier === 'dart:async');
    expect(imp).toBeDefined();
    expect(imp!.resolvedPath).toBeNull();
    expect(imp!.importedNames).toEqual([]);
  });

  it('extracts a package: import', async () => {
    const { tree, buf } = await parse(`import 'package:http/http.dart';\n`);
    const imports = dartHandler.extractImports(tree, buf);
    const imp = imports.find((i) => i.specifier === 'package:http/http.dart');
    expect(imp).toBeDefined();
    expect(imp!.resolvedPath).toBeNull();
  });

  it('extracts a relative import with resolvedPath', async () => {
    const { tree, buf } = await parse(`import '../utils.dart';\n`);
    const imports = dartHandler.extractImports(tree, buf);
    const imp = imports.find((i) => i.specifier === '../utils.dart');
    expect(imp).toBeDefined();
    expect(imp!.resolvedPath).toBe('../utils.dart');
  });

  it('extracts show clause identifiers', async () => {
    const { tree, buf } = await parse(`import 'package:http/http.dart' show Client, Response;\n`);
    const imports = dartHandler.extractImports(tree, buf);
    const imp = imports.find((i) => i.specifier === 'package:http/http.dart');
    expect(imp).toBeDefined();
    expect(imp!.importedNames).toContain('Client');
    expect(imp!.importedNames).toContain('Response');
  });

  it('isTypeOnly is always false for Dart imports', async () => {
    const { tree, buf } = await parse(`import 'dart:core';\n`);
    const imports = dartHandler.extractImports(tree, buf);
    expect(imports[0]!.isTypeOnly).toBe(false);
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('Dart handler — extractDocstring', () => {
  it('returns null when no preceding comment', async () => {
    const { tree, buf } = await parse(`class Foo {\n  Foo();\n}\n`);
    const classNode = tree.rootNode.children.find((c) => c.type === 'class_definition')!;
    expect(dartHandler.extractDocstring(classNode)).toBeNull();
  });

  it('strips /// prefix from triple-slash comment', async () => {
    const { tree, buf } = await parse(`/// The main service.\nclass MainService {\n  MainService();\n}\n`);
    const classNode = tree.rootNode.children.find((c) => c.type === 'class_definition')!;
    const doc = dartHandler.extractDocstring(classNode);
    expect(doc).toBeTruthy();
    expect(doc).not.toContain('///');
    expect(doc).toContain('main service');
  });
});

// ─── handler metadata ─────────────────────────────────────────────────────────

describe('Dart handler — metadata', () => {
  it('reports .dart extension', () => {
    expect(dartHandler.extensions()).toContain('.dart');
  });

  it('grammarPath points to dart wasm file', () => {
    expect(dartHandler.grammarPath()).toContain('tree-sitter-dart.wasm');
  });
});
