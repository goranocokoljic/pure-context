import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { haskellHandler } from '../../src/handlers/haskell.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/haskell-project');

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, haskellHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Haskell handler — extractSymbols', () => {
  it('extracts a function with type signature', async () => {
    const src = `module M where\ngreet :: String -> String\ngreet name = "Hello " ++ name\n`;
    const { tree, buf } = await parse(src);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/M.hs');
    const fn = syms.find((s) => s.name === 'greet');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.signature).toContain('greet :: String -> String');
  });

  it('extracts a function without type signature', async () => {
    const src = `module M where\nnoSig x = x + 1\n`;
    const { tree, buf } = await parse(src);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/M.hs');
    const fn = syms.find((s) => s.name === 'noSig');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('deduplicates multiple equations for the same function', async () => {
    const src = `module M where\nfactorial :: Int -> Int\nfactorial 0 = 1\nfactorial n = n * factorial (n - 1)\n`;
    const { tree, buf } = await parse(src);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/M.hs');
    const fns = syms.filter((s) => s.name === 'factorial');
    expect(fns).toHaveLength(1);
  });

  it('extracts a pattern binding (no-arg) with sig as function', async () => {
    const src = `module M where\nmaxRetries :: Int\nmaxRetries = 3\n`;
    const { tree, buf } = await parse(src);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/M.hs');
    const sym = syms.find((s) => s.name === 'maxRetries');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
    expect(sym!.signature).toContain('maxRetries :: Int');
  });

  it('extracts a pattern binding without sig as const', async () => {
    const src = `module M where\nmagicNumber = 42\n`;
    const { tree, buf } = await parse(src);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/M.hs');
    const sym = syms.find((s) => s.name === 'magicNumber');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
  });

  it('extracts data type as class with constructors as const', async () => {
    const src = `module M where\ndata Color = Red | Green | Blue\n`;
    const { tree, buf } = await parse(src);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/M.hs');
    const type_ = syms.find((s) => s.name === 'Color');
    expect(type_).toBeDefined();
    expect(type_!.kind).toBe('class');
    const ctors = syms.filter((s) => s.kind === 'const');
    const ctorNames = ctors.map((s) => s.name);
    expect(ctorNames).toContain('Red');
    expect(ctorNames).toContain('Green');
    expect(ctorNames).toContain('Blue');
  });

  it('extracts record data type with constructors', async () => {
    const src = `module M where\ndata User = User { userId :: Int, userName :: String }\n`;
    const { tree, buf } = await parse(src);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/M.hs');
    expect(syms.some((s) => s.name === 'User' && s.kind === 'class')).toBe(true);
    expect(syms.some((s) => s.name === 'User' && s.kind === 'const')).toBe(true);
  });

  it('extracts newtype as type', async () => {
    const src = `module M where\nnewtype UserId = UserId Int\n`;
    const { tree, buf } = await parse(src);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/M.hs');
    const sym = syms.find((s) => s.name === 'UserId');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('type');
    expect(sym!.signature).toContain('newtype UserId');
  });

  it('extracts type synonym as type', async () => {
    const src = `module M where\ntype Name = String\n`;
    const { tree, buf } = await parse(src);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/M.hs');
    const sym = syms.find((s) => s.name === 'Name');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('type');
    expect(sym!.signature).toContain('type Name = String');
  });

  it('extracts typeclass as interface', async () => {
    const src = `module M where\nclass Printable a where\n  prettyPrint :: a -> String\n`;
    const { tree, buf } = await parse(src);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/M.hs');
    const sym = syms.find((s) => s.name === 'Printable');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('interface');
    expect(sym!.signature).toContain('class Printable a where');
  });

  it('extracts instance as class with haskell_instance metadata', async () => {
    const src = `module M where\ninstance Printable Color where\n  prettyPrint Red = "red"\n`;
    const { tree, buf } = await parse(src);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/M.hs');
    const sym = syms.find((s) => s.kind === 'class' && s.frameworkMeta?.haskell_instance);
    expect(sym).toBeDefined();
    expect(sym!.name).toContain('Printable');
    expect(sym!.name).toContain('Color');
  });

  it('generates deterministic 16-char hex id', async () => {
    const src = `module M where\nfoo :: Int\nfoo = 1\n`;
    const { tree, buf } = await parse(src);
    const sym = haskellHandler.extractSymbols(tree, buf, 'src/M.hs').find((s) => s.name === 'foo')!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = haskellHandler.extractSymbols(tree, buf, 'src/M.hs').find((s) => s.name === 'foo')!;
    expect(sym2.id).toBe(sym.id);
  });

  it('skips local bindings inside where clauses', async () => {
    const src = `module M where\ncompute :: Int -> Int\ncompute x = result\n  where\n    result = x * 2\n    helper z = z + 1\n`;
    const { tree, buf } = await parse(src);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/M.hs');
    const names = syms.map((s) => s.name);
    expect(names).toContain('compute');
    expect(names).not.toContain('result');
    expect(names).not.toContain('helper');
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('Haskell handler — extractDocstring', () => {
  it('captures Haddock "-- |" before a function', async () => {
    const src = `module M where\n-- | Greet someone.\ngreet :: String -> String\ngreet name = name\n`;
    const { tree, buf } = await parse(src);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/M.hs');
    const fn = syms.find((s) => s.name === 'greet');
    expect(fn!.summary).toContain('Greet someone');
  });

  it('captures Haddock "-- |" before a non-first declaration', async () => {
    const src = `module M where\nfoo = 1\n-- | The bar function.\nbar :: Int -> Int\nbar x = x\n`;
    const { tree, buf } = await parse(src);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/M.hs');
    const fn = syms.find((s) => s.name === 'bar');
    expect(fn!.summary).toContain('The bar function');
  });

  it('captures Haddock "-- |" before a data type', async () => {
    const src = `module M where\n-- | A colour value.\ndata Color = Red | Green\n`;
    const { tree, buf } = await parse(src);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/M.hs');
    const sym = syms.find((s) => s.name === 'Color');
    expect(sym!.summary).toContain('A colour value');
  });

  it('returns empty summary when no haddock present', async () => {
    const src = `module M where\nfoo = 1\n`;
    const { tree, buf } = await parse(src);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/M.hs');
    expect(syms[0]!.summary).toBe('');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Haskell handler — extractImports', () => {
  it('extracts a plain import', async () => {
    const src = `module M where\nimport Data.List\n`;
    const { tree, buf } = await parse(src);
    const imps = haskellHandler.extractImports(tree, buf);
    expect(imps.some((i) => i.specifier === 'Data.List')).toBe(true);
  });

  it('extracts import with explicit names', async () => {
    const src = `module M where\nimport Data.List (sort, nub)\n`;
    const { tree, buf } = await parse(src);
    const imps = haskellHandler.extractImports(tree, buf);
    const imp = imps.find((i) => i.specifier === 'Data.List');
    expect(imp).toBeDefined();
    expect(imp!.importedNames).toContain('sort');
    expect(imp!.importedNames).toContain('nub');
  });

  it('extracts qualified import', async () => {
    const src = `module M where\nimport qualified Data.Map as M\n`;
    const { tree, buf } = await parse(src);
    const imps = haskellHandler.extractImports(tree, buf);
    expect(imps.some((i) => i.specifier === 'Data.Map')).toBe(true);
  });

  it('extracts hiding import without listing hidden names', async () => {
    const src = `module M where\nimport Data.Maybe hiding (fromJust)\n`;
    const { tree, buf } = await parse(src);
    const imps = haskellHandler.extractImports(tree, buf);
    const imp = imps.find((i) => i.specifier === 'Data.Maybe');
    expect(imp).toBeDefined();
    // hiding list should not be treated as importedNames
    expect(imp!.importedNames).toHaveLength(0);
  });

  it('resolvedPath is always null', async () => {
    const src = `module M where\nimport Data.List\n`;
    const { tree, buf } = await parse(src);
    const imps = haskellHandler.extractImports(tree, buf);
    expect(imps[0]!.resolvedPath).toBeNull();
  });

  it('isTypeOnly is always false', async () => {
    const src = `module M where\nimport Data.List\n`;
    const { tree, buf } = await parse(src);
    const imps = haskellHandler.extractImports(tree, buf);
    expect(imps[0]!.isTypeOnly).toBe(false);
  });
});

// ─── Fixture files ────────────────────────────────────────────────────────────

describe('Haskell handler — fixture files', () => {
  it('extracts symbols from src/Main.hs', async () => {
    const src = readFileSync(`${FIXTURE_ROOT}/src/Main.hs`, 'utf8');
    const buf = Buffer.from(src);
    const tree = await parseFile(buf, haskellHandler);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/Main.hs');
    const names = syms.map((s) => s.name);
    expect(names).toContain('maxRetries');
    expect(names).toContain('greet');
    expect(names).toContain('factorial');
    expect(names).toContain('applyTwice');
    expect(names).toContain('revUniq');
    expect(names).toContain('processItems');
    // Local where-clause bindings must be absent
    expect(names).not.toContain('transform');
    expect(names).not.toContain('offset');
    // factorial deduplication: only one entry
    expect(names.filter((n) => n === 'factorial')).toHaveLength(1);
  });

  it('extracts symbols from src/Types.hs', async () => {
    const src = readFileSync(`${FIXTURE_ROOT}/src/Types.hs`, 'utf8');
    const buf = Buffer.from(src);
    const tree = await parseFile(buf, haskellHandler);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/Types.hs');
    const names = syms.map((s) => s.name);
    expect(names).toContain('User');
    expect(names).toContain('GuestUser');
    expect(names).toContain('Color');
    expect(names).toContain('Red');
    expect(names).toContain('Green');
    expect(names).toContain('Blue');
    expect(names).toContain('UserId');
    expect(names).toContain('Name');
    expect(names).toContain('Version');
    // User is both class and constructor — both should exist
    const userSyms = syms.filter((s) => s.name === 'User');
    const kinds = userSyms.map((s) => s.kind);
    expect(kinds).toContain('class');
    expect(kinds).toContain('const');
  });

  it('extracts symbols from src/Typeclass.hs', async () => {
    const src = readFileSync(`${FIXTURE_ROOT}/src/Typeclass.hs`, 'utf8');
    const buf = Buffer.from(src);
    const tree = await parseFile(buf, haskellHandler);
    const syms = haskellHandler.extractSymbols(tree, buf, 'src/Typeclass.hs');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Printable');
    expect(names).toContain('Serialisable');
    expect(syms.find((s) => s.name === 'Printable')!.kind).toBe('interface');
    // instances
    const instances = syms.filter((s) => s.frameworkMeta?.haskell_instance);
    expect(instances.length).toBeGreaterThanOrEqual(3);
    expect(instances.some((s) => s.name.includes('Printable') && s.name.includes('User'))).toBe(true);
    expect(instances.some((s) => s.name.includes('Printable') && s.name.includes('Color'))).toBe(true);
  });
});

// ─── extensions / grammarPath ─────────────────────────────────────────────────

describe('Haskell handler — metadata', () => {
  it('claims .hs and .lhs extensions', () => {
    expect(haskellHandler.extensions()).toContain('.hs');
    expect(haskellHandler.extensions()).toContain('.lhs');
  });

  it('grammarPath ends with tree-sitter-haskell.wasm', () => {
    expect(haskellHandler.grammarPath()).toMatch(/tree-sitter-haskell\.wasm$/);
  });
});
