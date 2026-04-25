import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { luaHandler } from '../../src/handlers/lua.js';

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, luaHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Lua handler — extractSymbols', () => {

  // ── Named function declaration ───────────────────────────────────────────────

  it('extracts a top-level named function', async () => {
    const { tree, buf } = await parse(`function foo(a, b)\n  return a + b\nend\n`);
    const syms = luaHandler.extractSymbols(tree, buf, 'utils.lua');
    const fn = syms.find((s) => s.name === 'foo');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.signature).toContain('function foo');
    expect(fn!.signature).toContain('(a, b)');
  });

  it('extracts dot-notation table method as kind "method"', async () => {
    const { tree, buf } = await parse(`function M.bar(x)\n  return x\nend\n`);
    const syms = luaHandler.extractSymbols(tree, buf, 'auth.lua');
    const sym = syms.find((s) => s.name === 'M.bar');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('method');
    expect(sym!.signature).toContain('M.bar');
  });

  it('extracts colon-notation table method as kind "method"', async () => {
    const { tree, buf } = await parse(`function M:baz(x)\n  return x\nend\n`);
    const syms = luaHandler.extractSymbols(tree, buf, 'auth.lua');
    const sym = syms.find((s) => s.name === 'M:baz');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('method');
    expect(sym!.signature).toContain('M:baz');
  });

  // ── Local function declaration ────────────────────────────────────────────────

  it('extracts a local function as kind "function"', async () => {
    const { tree, buf } = await parse(`local function helper(n)\n  return n * 2\nend\n`);
    const syms = luaHandler.extractSymbols(tree, buf, 'utils.lua');
    const fn = syms.find((s) => s.name === 'helper');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.signature).toContain('local function helper');
  });

  // ── Variable assignment to function literal ───────────────────────────────────

  it('extracts variable assignment to function literal', async () => {
    const { tree, buf } = await parse(`M.login = function(user, pass)\n  return true\nend\n`);
    const syms = luaHandler.extractSymbols(tree, buf, 'auth.lua');
    const sym = syms.find((s) => s.name === 'M.login');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('method');
    expect(sym!.signature).toContain('M.login');
  });

  it('extracts simple identifier assignment to function literal as "function"', async () => {
    const { tree, buf } = await parse(`greet = function(name)\n  print(name)\nend\n`);
    const syms = luaHandler.extractSymbols(tree, buf, 'utils.lua');
    const sym = syms.find((s) => s.name === 'greet');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
  });

  // ── Local variable assignment to function literal ─────────────────────────────

  it('extracts local variable assignment to function literal as "function"', async () => {
    const { tree, buf } = await parse(`local validate = function(x)\n  return x ~= nil\nend\n`);
    const syms = luaHandler.extractSymbols(tree, buf, 'utils.lua');
    const fn = syms.find((s) => s.name === 'validate');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  // ── Module table constant ────────────────────────────────────────────────────

  it('extracts uppercase local table as kind "const"', async () => {
    const { tree, buf } = await parse(`local M = {}\n`);
    const syms = luaHandler.extractSymbols(tree, buf, 'module.lua');
    const sym = syms.find((s) => s.name === 'M');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
    expect(sym!.signature).toContain('local M = {');
  });

  it('skips lowercase local table (not a module constant)', async () => {
    const { tree, buf } = await parse(`local opts = {}\n`);
    const syms = luaHandler.extractSymbols(tree, buf, 'module.lua');
    expect(syms.filter((s) => s.kind === 'const')).toHaveLength(0);
  });

  // ── Skip nested functions ────────────────────────────────────────────────────

  it('does not extract nested function definitions', async () => {
    const { tree, buf } = await parse(
      `function outer()\n  local function inner() end\n  return inner\nend\n`,
    );
    const syms = luaHandler.extractSymbols(tree, buf, 'utils.lua');
    // Only outer should be extracted (top-level); inner is nested
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe('outer');
  });

  // ── Deterministic ID ─────────────────────────────────────────────────────────

  it('generates a deterministic 16-char hex ID', async () => {
    const { tree, buf } = await parse(`function foo() end\n`);
    const sym = luaHandler.extractSymbols(tree, buf, 'test.lua')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = luaHandler.extractSymbols(tree, buf, 'test.lua')[0]!;
    expect(sym2.id).toBe(sym.id);
  });

  // ── Multiple symbols ─────────────────────────────────────────────────────────

  it('extracts multiple symbols from the same file', async () => {
    const { tree, buf } = await parse(`
local M = {}

function M.login(user, pass)
  return true
end

function M:logout()
  -- nothing
end

local function helper()
  return nil
end

return M
`);
    const syms = luaHandler.extractSymbols(tree, buf, 'auth.lua');
    expect(syms.length).toBeGreaterThanOrEqual(4);
    expect(syms.find((s) => s.name === 'M')?.kind).toBe('const');
    expect(syms.find((s) => s.name === 'M.login')?.kind).toBe('method');
    expect(syms.find((s) => s.name === 'M:logout')?.kind).toBe('method');
    expect(syms.find((s) => s.name === 'helper')?.kind).toBe('function');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Lua handler — extractImports', () => {

  it('extracts local require as import with resolved path', async () => {
    const { tree, buf } = await parse(`local socket = require("socket")\n`);
    const imports = luaHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('socket');
    expect(imports[0]!.importedNames).toContain('socket');
    expect(imports[0]!.isTypeOnly).toBe(false);
  });

  it('converts dot-separated module path to file path', async () => {
    const { tree, buf } = await parse(`local utils = require("mymodule.utils")\n`);
    const imports = luaHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('mymodule.utils');
    expect(imports[0]!.resolvedPath).toBe('mymodule/utils.lua');
    expect(imports[0]!.importedNames).toContain('utils');
  });

  it('extracts non-local require assignment', async () => {
    const { tree, buf } = await parse(`json = require("json")\n`);
    const imports = luaHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('json');
  });

  it('does not extract non-require function calls', async () => {
    const { tree, buf } = await parse(`local x = pcall(foo, bar)\n`);
    const imports = luaHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(0);
  });

  it('extracts multiple requires from a file', async () => {
    const { tree, buf } = await parse(`
local socket = require("socket")
local json = require("dkjson")
local utils = require("app.utils")
`);
    const imports = luaHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(3);
    const specs = imports.map((i) => i.specifier);
    expect(specs).toContain('socket');
    expect(specs).toContain('dkjson');
    expect(specs).toContain('app.utils');
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('Lua handler — extractDocstring', () => {

  it('extracts a -- line comment preceding a function', async () => {
    const { tree, buf } = await parse(`
-- Formats a number with padding.
function format(n)
  return tostring(n)
end
`);
    const syms = luaHandler.extractSymbols(tree, buf, 'utils.lua');
    const fn = syms.find((s) => s.name === 'format');
    expect(fn!.summary).toContain('Formats');
  });

  it('extracts multiple consecutive -- comments', async () => {
    const { tree, buf } = await parse(`
-- Authenticates the user.
-- Returns true on success.
function M.login(user)
  return true
end
`);
    const syms = luaHandler.extractSymbols(tree, buf, 'auth.lua');
    const fn = syms.find((s) => s.name === 'M.login');
    expect(fn!.summary).toContain('Authenticates');
  });

  it('extracts a block comment --[[ ... ]]', async () => {
    const { tree, buf } = await parse(`
--[[ Validates the input token. ]]
function validate(tok)
  return tok ~= nil
end
`);
    const syms = luaHandler.extractSymbols(tree, buf, 'auth.lua');
    const fn = syms.find((s) => s.name === 'validate');
    expect(fn!.summary).toContain('Validates');
  });

  it('falls back to generated summary when no comment exists', async () => {
    const { tree, buf } = await parse(`function bar() end\n`);
    const syms = luaHandler.extractSymbols(tree, buf, 'test.lua');
    expect(syms[0]!.summary).toMatch(/Lua function: bar/);
  });
});
