import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, javascriptHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

describe('JavaScript handler — extractSymbols', () => {
  it('extracts exported function declaration', async () => {
    const { tree, buf } = await parse(`export function greet(name) { return name; }`);
    const syms = javascriptHandler.extractSymbols(tree, buf, 'src/a.js');
    expect(syms[0].name).toBe('greet');
    expect(syms[0].kind).toBe('function');
  });

  it('extracts exported class and methods', async () => {
    const { tree, buf } = await parse(
      `export class Runner {\n  run(x) {}\n  stop() {}\n}`,
    );
    const syms = javascriptHandler.extractSymbols(tree, buf, 'src/a.js');
    expect(syms.map((s) => s.name)).toContain('Runner');
    expect(syms.map((s) => s.name)).toContain('Runner.run');
  });

  it('extracts arrow function const as kind=function', async () => {
    const { tree, buf } = await parse(`export const fn = (x) => x * 2;`);
    const sym = javascriptHandler.extractSymbols(tree, buf, 'src/a.js')[0];
    expect(sym.kind).toBe('function');
    expect(sym.name).toBe('fn');
  });

  it('extracts plain const as kind=const', async () => {
    const { tree, buf } = await parse(`export const MAX = 100;`);
    const sym = javascriptHandler.extractSymbols(tree, buf, 'src/a.js')[0];
    expect(sym.kind).toBe('const');
  });

  it('handles non-exported top-level functions', async () => {
    const { tree, buf } = await parse(`function helper() {}\nexport function main() {}`);
    const names = javascriptHandler.extractSymbols(tree, buf, 'src/a.js').map((s) => s.name);
    expect(names).toContain('helper');
    expect(names).toContain('main');
  });

  it('handles empty file without throwing', async () => {
    const { tree, buf } = await parse('');
    expect(() => javascriptHandler.extractSymbols(tree, buf, 'src/a.js')).not.toThrow();
  });

  it('JSDoc summary is populated', async () => {
    const { tree, buf } = await parse(`/** Does stuff. */\nexport function doStuff() {}`);
    const sym = javascriptHandler.extractSymbols(tree, buf, 'src/a.js')[0];
    expect(sym.summary).toContain('Does stuff');
  });
});

describe('JavaScript handler — extractImports', () => {
  it('extracts named imports', async () => {
    const { tree, buf } = await parse(`import { foo, bar } from './utils.js';`);
    const imports = javascriptHandler.extractImports(tree, buf);
    expect(imports[0].importedNames).toEqual(['foo', 'bar']);
    expect(imports[0].isTypeOnly).toBe(false);
  });

  it('extracts default import', async () => {
    const { tree, buf } = await parse(`import Foo from './foo.js';`);
    expect(javascriptHandler.extractImports(tree, buf)[0].importedNames).toEqual(['Foo']);
  });

  it('extracts namespace import', async () => {
    const { tree, buf } = await parse(`import * as utils from './utils.js';`);
    expect(javascriptHandler.extractImports(tree, buf)[0].importedNames).toEqual(['* as utils']);
  });

  it('extracts side-effect import', async () => {
    const { tree, buf } = await parse(`import './polyfills.js';`);
    const imp = javascriptHandler.extractImports(tree, buf)[0];
    expect(imp.specifier).toBe('./polyfills.js');
    expect(imp.importedNames).toEqual([]);
  });
});

describe('JavaScript handler — metadata', () => {
  it('extensions include .js, .jsx, .mjs, .cjs', () => {
    const exts = javascriptHandler.extensions();
    expect(exts).toContain('.js');
    expect(exts).toContain('.jsx');
    expect(exts).toContain('.mjs');
    expect(exts).toContain('.cjs');
  });

  it('grammarPath points to javascript wasm', () => {
    expect(javascriptHandler.grammarPath()).toContain('tree-sitter-javascript.wasm');
  });
});
