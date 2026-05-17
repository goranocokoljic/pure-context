import { describe, it, expect, beforeAll } from 'vitest';
import { resolve, dirname } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = resolve(__dirname, '../fixtures/basic-ts-project');

// Helper: parse source with the TS handler
async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, typescriptHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('TypeScript handler — extractSymbols', () => {
  it('extracts an exported function declaration', async () => {
    const { tree, buf } = await parse(`export function greet(name: string): string { return name; }`);
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts');
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('greet');
    expect(syms[0].kind).toBe('function');
    expect(syms[0].filePath).toBe('src/a.ts');
    expect(syms[0].startByte).toBe(0);
    expect(syms[0].endByte).toBeGreaterThan(0);
  });

  it('generates a deterministic 16-char hex id', async () => {
    const { tree, buf } = await parse(`export function foo() {}`);
    const sym = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts')[0];
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    // Same inputs → same id
    const sym2 = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts')[0];
    expect(sym2.id).toBe(sym.id);
  });

  it('extracts an exported class and its methods', async () => {
    const { tree, buf } = await parse(`
export class MyRunner {
  run(input: string): void {}
  stop(): void {}
}`.trim());
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts');
    const names = syms.map((s) => s.name);
    expect(names).toContain('MyRunner');
    expect(names).toContain('MyRunner.run');
    expect(names).toContain('MyRunner.stop');
    expect(syms.find((s) => s.name === 'MyRunner')?.kind).toBe('class');
    expect(syms.find((s) => s.name === 'MyRunner.run')?.kind).toBe('method');
  });

  it('extracts a decorated exported class and its methods (NestJS @Injectable pattern)', async () => {
    const { tree, buf } = await parse(`
@Injectable()
export class AuthService {
  async register(dto: any): Promise<void> { return; }
  async login(dto: any): Promise<string> { return ''; }
}`.trim());
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/auth.service.ts');
    const names = syms.map((s) => s.name);
    expect(names).toContain('AuthService');
    expect(names).toContain('AuthService.register');
    expect(names).toContain('AuthService.login');
    expect(syms.find((s) => s.name === 'AuthService')?.kind).toBe('class');
    expect(syms.find((s) => s.name === 'AuthService.register')?.kind).toBe('method');
  });

  it('extracts an exported const', async () => {
    const { tree, buf } = await parse(`export const VERSION = '1.0.0';`);
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts');
    expect(syms).toHaveLength(1);
    expect(syms[0].kind).toBe('const');
    expect(syms[0].name).toBe('VERSION');
  });

  it('extracts an exported arrow function as kind=function', async () => {
    const { tree, buf } = await parse(`export const greet = (name: string): string => name;`);
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts');
    expect(syms[0].kind).toBe('function');
    expect(syms[0].name).toBe('greet');
  });

  it('extracts interface declaration', async () => {
    const { tree, buf } = await parse(`export interface IFoo { bar: string; }`);
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts');
    expect(syms[0].kind).toBe('interface');
    expect(syms[0].name).toBe('IFoo');
  });

  it('extracts type alias declaration', async () => {
    const { tree, buf } = await parse(`export type MyId = string | number;`);
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts');
    expect(syms[0].kind).toBe('type');
    expect(syms[0].name).toBe('MyId');
  });

  it('extracts enum declaration', async () => {
    const { tree, buf } = await parse(`export enum Status { Pending, Done }`);
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts');
    expect(syms[0].kind).toBe('enum');
    expect(syms[0].name).toBe('Status');
  });

  it('extracts non-exported top-level functions too', async () => {
    const { tree, buf } = await parse(`function internal() {}\nexport function external() {}`);
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts');
    const names = syms.map((s) => s.name);
    expect(names).toContain('internal');
    expect(names).toContain('external');
  });

  it('extracts export default function', async () => {
    const { tree, buf } = await parse(`export default function main() {}`);
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts');
    expect(syms.some((s) => s.name === 'main')).toBe(true);
  });

  it('byte offsets allow slicing the exact source', async () => {
    const src = `const x = 1;\nexport function foo(): number { return 42; }`;
    const { tree, buf } = await parse(src);
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts');
    const fnSym = syms.find((s) => s.name === 'foo')!;
    expect(fnSym).toBeDefined();
    const slice = buf.toString('utf8', fnSym.startByte, fnSym.endByte);
    expect(slice).toContain('function foo');
  });

  it('signature strips the function body', async () => {
    const { tree, buf } = await parse(`export function add(a: number, b: number): number { return a + b; }`);
    const sym = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts')[0];
    expect(sym.signature).not.toContain('return');
    expect(sym.signature).toContain('add');
    expect(sym.signature.length).toBeLessThanOrEqual(120);
  });

  it('signature strips the class body and includes export keyword', async () => {
    const { tree, buf } = await parse(`export class Foo { private x = 1; constructor() {} }`);
    const cls = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts').find((s) => s.kind === 'class')!;
    expect(cls.signature).toBe('export class Foo');
  });

  it('populates summary from JSDoc comment', async () => {
    const { tree, buf } = await parse(`/** Computes the sum. */\nexport function sum(a: number, b: number): number { return a + b; }`);
    const sym = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts')[0];
    expect(sym.summary).toContain('Computes the sum');
  });

  it('returns empty summary when no JSDoc present', async () => {
    const { tree, buf } = await parse(`// plain comment\nexport function foo() {}`);
    const sym = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts')[0];
    expect(sym.summary).toBe('');
  });

  it('handles an empty file without throwing', async () => {
    const { tree, buf } = await parse('');
    expect(() => typescriptHandler.extractSymbols(tree, buf, 'src/a.ts')).not.toThrow();
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('TypeScript handler — extractImports', () => {
  it('extracts named imports', async () => {
    const { tree, buf } = await parse(`import { foo, bar } from './utils';`);
    const imports = typescriptHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('./utils');
    expect(imports[0].importedNames).toEqual(['foo', 'bar']);
    expect(imports[0].isTypeOnly).toBe(false);
  });

  it('extracts aliased named imports (reports original name)', async () => {
    const { tree, buf } = await parse(`import { bar as baz } from './utils';`);
    const imports = typescriptHandler.extractImports(tree, buf);
    expect(imports[0].importedNames).toEqual(['bar']);
  });

  it('extracts default import', async () => {
    const { tree, buf } = await parse(`import Foo from './foo';`);
    const imports = typescriptHandler.extractImports(tree, buf);
    expect(imports[0].importedNames).toEqual(['Foo']);
  });

  it('extracts namespace import', async () => {
    const { tree, buf } = await parse(`import * as ns from './ns';`);
    const imports = typescriptHandler.extractImports(tree, buf);
    expect(imports[0].importedNames).toEqual(['* as ns']);
  });

  it('detects import type', async () => {
    const { tree, buf } = await parse(`import type { Baz } from './types';`);
    const imports = typescriptHandler.extractImports(tree, buf);
    expect(imports[0].isTypeOnly).toBe(true);
  });

  it('extracts side-effect import (no names)', async () => {
    const { tree, buf } = await parse(`import './polyfills';`);
    const imports = typescriptHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('./polyfills');
    expect(imports[0].importedNames).toEqual([]);
  });

  it('resolvedPath is null (filled by path-resolver later)', async () => {
    const { tree, buf } = await parse(`import { x } from './x';`);
    expect(typescriptHandler.extractImports(tree, buf)[0].resolvedPath).toBeNull();
  });

  it('extracts multiple import statements', async () => {
    const { tree, buf } = await parse(
      `import { a } from './a';\nimport type { B } from './b';`,
    );
    const imports = typescriptHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(2);
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('TypeScript handler — extractDocstring', () => {
  it('extracts first sentence from multi-line JSDoc', async () => {
    const { tree, buf } = await parse(
      `/**\n * Computes the sum.\n * @param a first\n */\nexport function sum() {}`,
    );
    // extractSymbols calls extractDocstring internally — verify via the summary field
    const sym = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts')[0];
    expect(sym.summary).toContain('Computes the sum');
  });

  it('returns null for regular line comment', async () => {
    const { tree, buf } = await parse(`// not jsdoc\nexport function foo() {}`);
    const sym = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts')[0];
    expect(sym.summary).toBe('');
  });

  it('returns null when no preceding comment', async () => {
    const { tree, buf } = await parse(`export function foo() {}`);
    const sym = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts')[0];
    expect(sym.summary).toBe('');
  });
});

// ─── Real fixture file ────────────────────────────────────────────────────────

describe('TypeScript handler — real fixture files', () => {
  it('indexes src/utils.ts from the fixture project', async () => {
    const source = readFileSync(resolve(FIXTURE_DIR, 'src/utils.ts'));
    const tree = await parseFile(source, typescriptHandler);
    const syms = typescriptHandler.extractSymbols(tree, source, 'src/utils.ts');
    const names = syms.map((s) => s.name);
    expect(names).toContain('formatDiagnostic');
    expect(names).toContain('filterBySeverity');
    expect(names).toContain('MAX_DIAGNOSTICS');
  });

  it('indexes src/types.ts — extracts interface, type, and enum', async () => {
    const source = readFileSync(resolve(FIXTURE_DIR, 'src/types.ts'));
    const tree = await parseFile(source, typescriptHandler);
    const syms = typescriptHandler.extractSymbols(tree, source, 'src/types.ts');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Severity');
    expect(names).toContain('Diagnostic');
    expect(names).toContain('Status');
  });

  it('extracts imports from src/index.ts', async () => {
    const source = readFileSync(resolve(FIXTURE_DIR, 'src/index.ts'));
    const tree = await parseFile(source, typescriptHandler);
    const imports = typescriptHandler.extractImports(tree, source);
    const specifiers = imports.map((i) => i.specifier);
    expect(specifiers).toContain('./utils.js');
    expect(specifiers).toContain('./types.js');
  });
});

// ─── TSX handler ─────────────────────────────────────────────────────────────

describe('TSX handler', () => {
  it('extensions include .tsx', () => {
    expect(tsxHandler.extensions()).toContain('.tsx');
  });

  it('grammarPath points to tsx wasm', () => {
    expect(tsxHandler.grammarPath()).toContain('tree-sitter-tsx.wasm');
  });

  it('parses a TSX file with a component function', async () => {
    const src = `export function Button({ label }: { label: string }) { return null; }`;
    const buf = Buffer.from(src);
    const tree = await parseFile(buf, tsxHandler);
    const syms = tsxHandler.extractSymbols(tree, buf, 'src/Button.tsx');
    expect(syms.some((s) => s.name === 'Button')).toBe(true);
  });
});
