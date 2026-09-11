/**
 * Phase 101 (Task 630): the symbol-edge builder, rule by rule, over fake
 * index views (no database, no parser). Each case pins one row of the
 * matching-rule table in dev-docs/in-progress/phase101-design.md §3.
 */
import { describe, it, expect } from 'vitest';
import { buildSymbolEdges, type RefIndexView } from '../../src/graph/symbol-edges.js';
import type { DepEdge, ImportRecord, SymbolRecord, SymbolKind } from '../../src/core/types.js';

// ─── Fake index ───────────────────────────────────────────────────────────────

interface FakeFile {
  content: string;
  /** name → kind; spans are located by searching the content for `<kind> <name>` or a marker. */
  symbols: SymbolRecord[];
  imports: ImportRecord[];
  edges: DepEdge[];
}

class FakeIndex implements RefIndexView {
  readonly files = new Map<string, FakeFile>();
  constructor(readonly repoId: string) {}

  /** Add a file. `spans` = [name, kind, startText, endText]: the span runs from startText to the end of endText. */
  file(
    path: string,
    content: string,
    spans: Array<[string, SymbolKind, string, string?]>,
    imports: Array<{ specifier: string; names: string[]; target?: string; targetRepo?: string }> = [],
  ): this {
    const symbols: SymbolRecord[] = spans.map(([name, kind, startText, endText]) => {
      const start = content.indexOf(startText);
      if (start < 0) throw new Error(`span start "${startText}" not in ${path}`);
      const endMarker = endText ?? startText;
      const endAt = content.indexOf(endMarker, start);
      if (endAt < 0) throw new Error(`span end "${endMarker}" not in ${path}`);
      return {
        id: `${path}:${name}:${kind}`,
        name,
        kind,
        filePath: path,
        startByte: Buffer.byteLength(content.slice(0, start)),
        endByte: Buffer.byteLength(content.slice(0, endAt + endMarker.length)),
        signature: name,
        summary: '',
      };
    });
    const recs: ImportRecord[] = imports.map((i) => ({
      sourceFile: path,
      specifier: i.specifier,
      resolvedPath: null,
      importedNames: i.names,
      isTypeOnly: false,
    }));
    const edges: DepEdge[] = imports
      .filter((i) => i.target)
      .map((i) => ({
        repoId: this.repoId,
        sourceFile: path,
        sourceSymbolId: null,
        targetFile: i.target!,
        targetSymbolId: null,
        edgeType: 'import',
        specifier: i.specifier,
        ...(i.targetRepo ? { targetRepoId: i.targetRepo } : {}),
      }));
    this.files.set(path, { content, symbols, imports: recs, edges });
    return this;
  }
  symbolsByFile(path: string) { return this.files.get(path)?.symbols ?? []; }
  importRecordsByFile(path: string) { return this.files.get(path)?.imports ?? []; }
  forwardDeps(path: string) { return this.files.get(path)?.edges ?? []; }
  fileContent(path: string) { const f = this.files.get(path); return f ? Buffer.from(f.content) : null; }
}

function build(idx: FakeIndex, files: string[], links?: Map<string, RefIndexView>, fanout = 100) {
  const r = buildSymbolEdges(idx, files, { maxWildcardFanout: fanout, links });
  return r.refs.map((x) => ({
    from: x.sourceSymbolId,
    to: x.targetSymbolId,
    repo: x.targetRepoId,
    name: x.name,
    n: x.refCount,
  }));
}

// ─── TypeScript ───────────────────────────────────────────────────────────────

describe('symbol edges — TypeScript shapes', () => {
  const lib = `export function helper() {}\nexport const CONST = 1;\nexport class Widget {}\nexport default function main() {}\n`;
  const libSpans: Array<[string, SymbolKind, string, string?]> = [
    ['helper', 'function', 'export function helper', '{}'],
    ['CONST', 'const', 'export const CONST', '= 1;'],
    ['Widget', 'class', 'export class Widget', '{}'],
    ['main', 'function', 'export default function main', '{}'],
  ];

  it('named import: the referencing symbol gets an edge; a symbol that never mentions it does not', () => {
    const app = `import { helper, CONST } from './lib';\nfunction a() { return helper(); }\nfunction b() { return 2; }\nconst c = CONST + 1;\n`;
    const idx = new FakeIndex('R')
      .file('lib.ts', lib, libSpans)
      .file('app.ts', app, [
        ['a', 'function', 'function a()', '}'],
        ['b', 'function', 'function b()', '}'],
        ['c', 'const', 'const c', '+ 1;'],
      ], [{ specifier: './lib', names: ['helper', 'CONST'], target: 'lib.ts' }]);
    const refs = build(idx, ['app.ts']);
    expect(refs).toEqual([
      { from: 'app.ts:a:function', to: 'lib.ts:helper:function', repo: null, name: 'helper', n: 1 },
      { from: 'app.ts:c:const', to: 'lib.ts:CONST:const', repo: null, name: 'CONST', n: 1 },
    ]);
  });

  it('the import line itself (outside every span) produces nothing; refCount counts occurrences', () => {
    const app = `import { helper } from './lib';\nfunction a() { helper(); helper(); return helper; }\n`;
    const idx = new FakeIndex('R')
      .file('lib.ts', lib, libSpans)
      .file('app.ts', app, [['a', 'function', 'function a()', '}']], [{ specifier: './lib', names: ['helper'], target: 'lib.ts' }]);
    expect(build(idx, ['app.ts'])).toEqual([
      { from: 'app.ts:a:function', to: 'lib.ts:helper:function', repo: null, name: 'helper', n: 3 },
    ]);
  });

  it('default import of a symbol the target declares under that name → bare match', () => {
    const app = `import main from './lib';\nfunction run() { main(); }\n`;
    const idx = new FakeIndex('R')
      .file('lib.ts', lib, libSpans)
      .file('app.ts', app, [['run', 'function', 'function run()', '}']], [{ specifier: './lib', names: ['main'], target: 'lib.ts' }]);
    expect(build(idx, ['app.ts']).map((r) => r.to)).toEqual(['lib.ts:main:function']);
  });

  it('namespace import `* as ns` matches ns.member, not the bare member', () => {
    const app = `import * as lib from './lib';\nfunction run() { lib.helper(); helper(); return lib .Widget; }\n`;
    const idx = new FakeIndex('R')
      .file('lib.ts', lib, libSpans)
      .file('app.ts', app, [['run', 'function', 'function run()', '}']], [{ specifier: './lib', names: ['* as lib'], target: 'lib.ts' }]);
    expect(build(idx, ['app.ts']).map((r) => r.to).sort()).toEqual(['lib.ts:Widget:class', 'lib.ts:helper:function']);
  });

  it('shadow rule: a name the source file declares itself is never matched', () => {
    const app = `import { helper } from './lib';\nfunction helper() {}\nfunction run() { helper(); }\n`;
    const idx = new FakeIndex('R')
      .file('lib.ts', lib, libSpans)
      .file('app.ts', app, [
        ['helper', 'function', 'function helper()', '{}'],
        ['run', 'function', 'function run()', '}'],
      ], [{ specifier: './lib', names: ['helper'], target: 'lib.ts' }]);
    expect(build(idx, ['app.ts'])).toEqual([]);
  });

  it('member access on another object (`obj.helper`) is not a reference to the import', () => {
    const app = `import { helper } from './lib';\nfunction run(obj: any) { obj.helper(); obj?.helper; }\n`;
    const idx = new FakeIndex('R')
      .file('lib.ts', lib, libSpans)
      .file('app.ts', app, [['run', 'function', 'function run(', '}']], [{ specifier: './lib', names: ['helper'], target: 'lib.ts' }]);
    expect(build(idx, ['app.ts'])).toEqual([]);
  });

  it('innermost attribution: a hit inside a method belongs to the method, not the class', () => {
    const app = `import { helper } from './lib';\nclass Svc {\n  run() { helper(); }\n  other() {}\n}\n`;
    const idx = new FakeIndex('R')
      .file('lib.ts', lib, libSpans)
      .file('app.ts', app, [
        ['Svc', 'class', 'class Svc', '\n}'],
        ['Svc.run', 'method', 'run() { helper(); }'],
        ['Svc.other', 'method', 'other() {}'],
      ], [{ specifier: './lib', names: ['helper'], target: 'lib.ts' }]);
    expect(build(idx, ['app.ts']).map((r) => r.from)).toEqual(['app.ts:Svc.run:method']);
  });

  it('re-export chain: `import { helper } from "./index"` where index re-exports lib → target is lib.helper', () => {
    const barrel = `export { helper } from './lib';\nexport * from './lib';\n`;
    const app = `import { helper, Widget } from './index';\nfunction run() { helper(); new Widget(); }\n`;
    const idx = new FakeIndex('R')
      .file('lib.ts', lib, libSpans)
      .file('index.ts', barrel, [], [
        { specifier: './lib', names: ['helper'], target: 'lib.ts' },
        { specifier: './lib', names: ['*'], target: 'lib.ts' },
      ])
      .file('app.ts', app, [['run', 'function', 'function run()', '}']], [{ specifier: './index', names: ['helper', 'Widget'], target: 'index.ts' }]);
    expect(build(idx, ['app.ts']).map((r) => r.to).sort()).toEqual(['lib.ts:Widget:class', 'lib.ts:helper:function']);
  });

  it('imported name the target neither declares nor re-exports → the name is a module: qualified form', () => {
    const utils = `export const a = 1;\nexport const b = 2;\n`;
    const app = `import utils from './utils';\nfunction run() { return utils.a + utils.b; }\n`;
    const idx = new FakeIndex('R')
      .file('utils.ts', utils, [['a', 'const', 'export const a', '1;'], ['b', 'const', 'export const b', '2;']])
      .file('app.ts', app, [['run', 'function', 'function run()', '}']], [{ specifier: './utils', names: ['utils'], target: 'utils.ts' }]);
    expect(build(idx, ['app.ts']).map((r) => r.to).sort()).toEqual(['utils.ts:a:const', 'utils.ts:b:const']);
  });

  it('a source file with no symbols, or no file edges, is skipped', () => {
    const idx = new FakeIndex('R')
      .file('lib.ts', lib, libSpans)
      .file('empty.ts', `import { helper } from './lib';\nhelper();\n`, [], [{ specifier: './lib', names: ['helper'], target: 'lib.ts' }])
      .file('island.ts', `function x() { helper(); }`, [['x', 'function', 'function x()', '}']]);
    const r = buildSymbolEdges(idx, ['empty.ts', 'island.ts'], { maxWildcardFanout: 100 });
    expect(r.refs).toEqual([]);
    expect(r.filesScanned).toBe(0);
  });
});

// ─── Other families ───────────────────────────────────────────────────────────

describe('symbol edges — per-language rules', () => {
  it('Java: wildcard import `*` expands to the target file\'s top-level names; a method name is not a candidate', () => {
    const util = `package a;\npublic class Util {\n  public static void run() {}\n}\nclass Helper {}\n`;
    const app = `package b;\nimport a.*;\nclass App {\n  void go() { Util.run(); new Helper(); run(); }\n}\n`;
    const idx = new FakeIndex('R')
      .file('a/Util.java', util, [
        ['Util', 'class', 'public class Util', '\n}'],
        ['run', 'method', 'public static void run() {}'],
        ['Helper', 'class', 'class Helper {}'],
      ])
      .file('b/App.java', app, [
        ['App', 'class', 'class App', '\n}'],
        ['go', 'method', 'void go() {', '}'],
      ], [{ specifier: 'a', names: ['*'], target: 'a/Util.java' }]);
    const refs = build(idx, ['b/App.java']);
    expect(refs.map((r) => `${r.from}->${r.to}`).sort()).toEqual([
      'b/App.java:go:method->a/Util.java:Helper:class',
      'b/App.java:go:method->a/Util.java:Util:class',
    ]);
  });

  it('Java: static import of a method targets the method symbol', () => {
    const util = `package a;\npublic class Util {\n  public static void run() {}\n}\n`;
    const app = `package b;\nimport static a.Util.run;\nclass App {\n  void go() { run(); }\n}\n`;
    const idx = new FakeIndex('R')
      .file('a/Util.java', util, [['Util', 'class', 'public class Util', '\n}'], ['run', 'method', 'public static void run() {}']])
      .file('b/App.java', app, [['App', 'class', 'class App', '\n}'], ['go', 'method', 'void go() {', '}']],
        [{ specifier: 'a.Util', names: ['run'], target: 'a/Util.java' }]);
    expect(build(idx, ['b/App.java']).map((r) => r.to)).toEqual(['a/Util.java:run:method']);
  });

  it('Kotlin: an empty name list is a wildcard (bare names)', () => {
    const lib = `package a\nfun helper() {}\nclass Thing\n`;
    const app = `package b\nimport a.*\nfun go() { helper(); Thing() }\n`;
    const idx = new FakeIndex('R')
      .file('a/Lib.kt', lib, [['helper', 'function', 'fun helper() {}'], ['Thing', 'class', 'class Thing']])
      .file('b/App.kt', app, [['go', 'function', 'fun go()', '}']], [{ specifier: 'a.*', names: [], target: 'a/Lib.kt' }]);
    expect(build(idx, ['b/App.kt']).map((r) => r.to).sort()).toEqual(['a/Lib.kt:Thing:class', 'a/Lib.kt:helper:function']);
  });

  it('Go: package import matches `pkg.Name` only, never the bare name; alias `* as x` uses the alias', () => {
    const lib = `package util\n\nfunc Run() {}\nfunc Other() {}\n`;
    const app = `package main\n\nimport "example.com/m/util"\nimport u "example.com/m/util"\n\nfunc main() { util.Run(); Run(); u.Other() }\n`;
    const idx = new FakeIndex('R')
      .file('util/util.go', lib, [['Run', 'function', 'func Run() {}'], ['Other', 'function', 'func Other() {}']])
      .file('main.go', app, [['main', 'function', 'func main()', '}']], [
        { specifier: 'example.com/m/util', names: [], target: 'util/util.go' },
        { specifier: 'example.com/m/util', names: ['* as u'], target: 'util/util.go' },
      ]);
    const refs = build(idx, ['main.go']);
    expect(refs.map((r) => r.to).sort()).toEqual(['util/util.go:Other:function', 'util/util.go:Run:function']);
    expect(refs.find((r) => r.name === 'Run')!.n).toBe(1); // the bare `Run()` did not count
  });

  it('Rust: `use a::m;` then `m::f()` resolves through the module qualifier with `::`', () => {
    const m = `pub fn f() {}\npub fn g() {}\n`;
    const app = `use crate::m;\nfn run() { m::f(); m :: g(); }\n`;
    const idx = new FakeIndex('R')
      .file('src/m.rs', m, [['f', 'function', 'pub fn f() {}'], ['g', 'function', 'pub fn g() {}']])
      .file('src/app.rs', app, [['run', 'function', 'fn run()', '}']], [{ specifier: 'crate::m', names: ['m'], target: 'src/m.rs' }]);
    expect(build(idx, ['src/app.rs']).map((r) => r.to).sort()).toEqual(['src/m.rs:f:function', 'src/m.rs:g:function']);
  });

  it('Python: `from m import x` is bare; `import pkg.mod` is the dotted qualifier; `from m import *` is open', () => {
    const mod = `def x():\n    pass\n\ndef y():\n    pass\n`;
    const app = `from pkg.mod import x\nimport pkg.mod\nfrom other import *\n\ndef run():\n    x()\n    pkg.mod.y()\n    y()\n    zed()\n`;
    const other = `def zed():\n    pass\n`;
    const idx = new FakeIndex('R')
      .file('pkg/mod.py', mod, [['x', 'function', 'def x():', 'pass'], ['y', 'function', 'def y():', 'pass']])
      .file('other.py', other, [['zed', 'function', 'def zed():', 'pass']])
      .file('app.py', app, [['run', 'function', 'def run():', 'zed()']], [
        { specifier: 'pkg.mod', names: ['x'], target: 'pkg/mod.py' },
        { specifier: 'pkg.mod', names: [], target: 'pkg/mod.py' },
        { specifier: 'other', names: ['*'], target: 'other.py' },
      ]);
    const refs = build(idx, ['app.py']);
    expect(refs.map((r) => `${r.name}:${r.n}`).sort()).toEqual(['x:1', 'y:1', 'zed:1']);
  });

  it('fanout cap: an open import expands to at most maxWildcardFanout names', () => {
    const big = Array.from({ length: 5 }, (_, i) => `class C${i} {}`).join('\n');
    const app = `import a.*;\nclass App { void go() { new C0(); new C4(); } }\n`;
    const idx = new FakeIndex('R')
      .file('a/Big.java', big, Array.from({ length: 5 }, (_, i) => [`C${i}`, 'class', `class C${i} {}`] as [string, SymbolKind, string]))
      .file('App.java', app, [['App', 'class', 'class App', '} }'], ['go', 'method', 'void go() {', '}']], [{ specifier: 'a', names: ['*'], target: 'a/Big.java' }]);
    const r = buildSymbolEdges(idx, ['App.java'], { maxWildcardFanout: 2 });
    expect(r.cappedExpansions).toBe(1);
    expect(r.refs.map((x) => x.name)).toEqual(['C0']); // C4 fell past the cap
  });
});

// ─── Cross-index ──────────────────────────────────────────────────────────────

describe('symbol edges — across a link', () => {
  it('a cross file edge yields a cross ref (targetRepoId set) using the LINKED index\'s symbol table', () => {
    const libs = new FakeIndex('LIBS').file('src/core.ts', `export function core() {}\n`, [['core', 'function', 'export function core() {}']]);
    const app = new FakeIndex('APP').file('main.ts', `import { core } from '@acme/core';\nfunction run() { core(); }\n`,
      [['run', 'function', 'function run()', '}']],
      [{ specifier: '@acme/core', names: ['core'], target: 'src/core.ts', targetRepo: 'LIBS' }]);
    const refs = build(app, ['main.ts'], new Map([['LIBS', libs]]));
    expect(refs).toEqual([{ from: 'main.ts:run:function', to: 'src/core.ts:core:function', repo: 'LIBS', name: 'core', n: 1 }]);
  });

  it('a cross edge into an index that is NOT in the workspace yields nothing (file edge only)', () => {
    const app = new FakeIndex('APP').file('main.ts', `import { core } from '@acme/core';\nfunction run() { core(); }\n`,
      [['run', 'function', 'function run()', '}']],
      [{ specifier: '@acme/core', names: ['core'], target: 'src/core.ts', targetRepo: 'GONE' }]);
    expect(build(app, ['main.ts'], new Map())).toEqual([]);
  });

  it('a re-export chain that crosses the seam is followed into the linked index', () => {
    const libs = new FakeIndex('LIBS')
      .file('src/impl.ts', `export function core() {}\n`, [['core', 'function', 'export function core() {}']])
      .file('src/index.ts', `export * from './impl';\n`, [], [{ specifier: './impl', names: ['*'], target: 'src/impl.ts' }]);
    const app = new FakeIndex('APP').file('main.ts', `import { core } from '@acme/core';\nfunction run() { core(); }\n`,
      [['run', 'function', 'function run()', '}']],
      [{ specifier: '@acme/core', names: ['core'], target: 'src/index.ts', targetRepo: 'LIBS' }]);
    const refs = build(app, ['main.ts'], new Map([['LIBS', libs]]));
    expect(refs.map((r) => `${r.repo}/${r.to}`)).toEqual(['LIBS/src/impl.ts:core:function']);
  });
});

// ─── Offsets ──────────────────────────────────────────────────────────────────

describe('symbol edges — byte spans', () => {
  it('attributes correctly when multi-byte characters precede the hit (spans are TRUE bytes)', () => {
    const lib = `export function helper() {}\n`;
    const app = `import { helper } from './lib';\n// héllo wörld — ünïcode ✓\nfunction a() { helper(); }\nfunction b() { return 1; }\n`;
    const idx = new FakeIndex('R')
      .file('lib.ts', lib, [['helper', 'function', 'export function helper() {}']])
      .file('app.ts', app, [['a', 'function', 'function a()', '}'], ['b', 'function', 'function b()', '}']],
        [{ specifier: './lib', names: ['helper'], target: 'lib.ts' }]);
    expect(build(idx, ['app.ts']).map((r) => r.from)).toEqual(['app.ts:a:function']);
  });
});
