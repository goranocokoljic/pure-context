import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { elixirHandler } from '../../src/handlers/elixir.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/elixir-project');

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, elixirHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Elixir handler — extractSymbols', () => {
  it('extracts defmodule as kind class', async () => {
    const { tree, buf } = await parse(`defmodule MyApp.User do\nend\n`);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/my_app/user.ex');
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe('MyApp.User');
    expect(syms[0]!.kind).toBe('class');
  });

  it('generates a deterministic 16-char hex id', async () => {
    const { tree, buf } = await parse(`defmodule Foo do\nend\n`);
    const sym = elixirHandler.extractSymbols(tree, buf, 'lib/foo.ex')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = elixirHandler.extractSymbols(tree, buf, 'lib/foo.ex')[0]!;
    expect(sym2.id).toBe(sym.id);
  });

  it('extracts defmodule signature as "defmodule ModuleName"', async () => {
    const { tree, buf } = await parse(`defmodule MyApp do\nend\n`);
    const sym = elixirHandler.extractSymbols(tree, buf, 'lib/my_app.ex')[0]!;
    expect(sym.signature).toBe('defmodule MyApp');
  });

  it('extracts def as kind function', async () => {
    const src = `defmodule Mod do\n  def greet(name) do\n    name\n  end\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/mod.ex');
    const fn = syms.find((s) => s.name === 'Mod.greet');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('skips defp (private function)', async () => {
    const src = `defmodule Mod do\n  def public(x), do: x\n  defp private(x), do: x\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/mod.ex');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Mod.public');
    expect(names.some((n) => n.includes('private'))).toBe(false);
  });

  it('extracts defmacro as kind function with elixir_macro metadata', async () => {
    const src = `defmodule Mod do\n  defmacro say_hello(name) do\n    quote do: :ok\n  end\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/mod.ex');
    const macro = syms.find((s) => s.name === 'Mod.say_hello');
    expect(macro).toBeDefined();
    expect(macro!.kind).toBe('function');
    expect(macro!.frameworkMeta?.['elixir_macro']).toBe(true);
  });

  it('skips defmacrop (private macro)', async () => {
    const src = `defmodule Mod do\n  defmacrop secret(x) do\n    quote do: :ok\n  end\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/mod.ex');
    expect(syms.filter((s) => s.name.includes('secret'))).toHaveLength(0);
  });

  it('extracts defstruct as kind type with module name', async () => {
    const src = `defmodule MyApp.User do\n  defstruct [:name, :email, age: 0]\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/user.ex');
    const struct = syms.find((s) => s.kind === 'type');
    expect(struct).toBeDefined();
    expect(struct!.name).toBe('MyApp.User');
    expect(struct!.signature).toMatch(/defstruct/);
    expect(struct!.signature).toMatch(/name/);
  });

  it('extracts defprotocol as kind interface', async () => {
    const src = `defprotocol Serializable do\n  def serialize(value)\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/serializable.ex');
    const proto = syms.find((s) => s.kind === 'interface');
    expect(proto).toBeDefined();
    expect(proto!.name).toBe('Serializable');
    expect(proto!.signature).toMatch(/defprotocol/);
  });

  it('extracts defimpl as kind class with elixir_impl metadata', async () => {
    const src = `defimpl Serializable, for: Integer do\n  def serialize(int), do: to_string(int)\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/impl.ex');
    const impl = syms.find((s) => s.kind === 'class' && s.name.includes('Serializable'));
    expect(impl).toBeDefined();
    expect(impl!.frameworkMeta?.['elixir_impl']).toBe(true);
    expect(impl!.name).toBe('Serializable.Integer');
  });

  it('extracts @callback as kind method', async () => {
    const src = `defmodule MyBehaviour do\n  @callback notify(term()) :: :ok\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/behaviour.ex');
    const cb = syms.find((s) => s.kind === 'method');
    expect(cb).toBeDefined();
    expect(cb!.name).toBe('MyBehaviour.notify');
  });

  it('extracts @type as kind type', async () => {
    const src = `defmodule Mod do\n  @type t :: map()\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/mod.ex');
    const type = syms.find((s) => s.kind === 'type');
    expect(type).toBeDefined();
    expect(type!.name).toBe('Mod.t');
  });

  it('uses @spec as signature when present', async () => {
    const src = `defmodule Mod do\n  @spec greet(String.t()) :: String.t()\n  def greet(name) do\n    name\n  end\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/mod.ex');
    const fn = syms.find((s) => s.name === 'Mod.greet');
    expect(fn).toBeDefined();
    expect(fn!.signature).toMatch(/String\.t\(\)/);
  });

  it('includes guard in signature when no @spec', async () => {
    const src = `defmodule Mod do\n  def valid?(x) when is_binary(x), do: true\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/mod.ex');
    const fn = syms.find((s) => s.name === 'Mod.valid?');
    expect(fn).toBeDefined();
    expect(fn!.signature).toMatch(/when/);
  });

  it('extracts functions from protocol body', async () => {
    const src = `defprotocol Serializable do\n  def serialize(value)\n  def to_string(value)\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/s.ex');
    expect(syms.find((s) => s.name === 'Serializable.serialize')).toBeDefined();
    expect(syms.find((s) => s.name === 'Serializable.to_string')).toBeDefined();
  });

  it('extracts symbols from fixture lib/my_app.ex', async () => {
    const src = readFileSync(`${FIXTURE_ROOT}/lib/my_app.ex`, 'utf8');
    const buf = Buffer.from(src);
    const tree = await parseFile(buf, elixirHandler);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/my_app.ex');
    const names = syms.map((s) => s.name);

    expect(names).toContain('MyApp');
    expect(syms.find((s) => s.name === 'MyApp')!.kind).toBe('class');
    expect(names).toContain('MyApp.start_link');
    expect(names).toContain('MyApp.version');
    expect(names).toContain('MyApp.with_logging');
    // defp init_state should be excluded
    expect(names.some((n) => n.includes('init_state'))).toBe(false);
  });

  it('extracts symbols from fixture lib/my_app/user.ex', async () => {
    const src = readFileSync(`${FIXTURE_ROOT}/lib/my_app/user.ex`, 'utf8');
    const buf = Buffer.from(src);
    const tree = await parseFile(buf, elixirHandler);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/my_app/user.ex');
    const names = syms.map((s) => s.name);

    expect(names).toContain('MyApp.User');
    expect(names).toContain('MyApp.User.new');
    expect(names).toContain('MyApp.User.display_name');
    expect(names).toContain('MyApp.User.valid?');
    // defp sanitize should be excluded
    expect(names.some((n) => n.includes('sanitize'))).toBe(false);
    // struct type
    const struct = syms.find((s) => s.kind === 'type' && s.name === 'MyApp.User');
    expect(struct).toBeDefined();
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('Elixir handler — extractDocstring', () => {
  it('captures @doc before a function', async () => {
    const src = `defmodule Mod do\n  @doc "Greets the user."\n  def greet(name), do: name\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/mod.ex');
    const fn = syms.find((s) => s.name === 'Mod.greet');
    expect(fn!.summary).toBeTruthy();
    expect(fn!.summary).toContain('Greets');
  });

  it('captures @doc heredoc before a function', async () => {
    const src = `defmodule Mod do\n  @doc """\n  Creates a thing.\n  """\n  def create(x), do: x\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/mod.ex');
    const fn = syms.find((s) => s.name === 'Mod.create');
    expect(fn!.summary).toBeTruthy();
    expect(fn!.summary).toContain('Creates');
  });

  it('captures @moduledoc for the module', async () => {
    const src = `defmodule Mod do\n  @moduledoc "The main module."\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/mod.ex');
    const mod = syms.find((s) => s.name === 'Mod');
    expect(mod!.summary).toBeTruthy();
    expect(mod!.summary).toContain('main module');
  });

  it('returns null when no @doc present', async () => {
    const src = `defmodule Mod do\n  def bare(x), do: x\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/mod.ex');
    const fn = syms.find((s) => s.name === 'Mod.bare');
    expect(fn!.summary).toBe('');
  });

  it('captures @doc from fixture user.ex', async () => {
    const src = readFileSync(`${FIXTURE_ROOT}/lib/my_app/user.ex`, 'utf8');
    const buf = Buffer.from(src);
    const tree = await parseFile(buf, elixirHandler);
    const syms = elixirHandler.extractSymbols(tree, buf, 'lib/my_app/user.ex');
    const newFn = syms.find((s) => s.name === 'MyApp.User.new');
    expect(newFn!.summary).toBeTruthy();
    expect(newFn!.summary.toLowerCase()).toContain('user');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Elixir handler — extractImports', () => {
  it('extracts alias directive', async () => {
    const { tree, buf } = await parse(`alias Foo.Bar\n`);
    const imports = elixirHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('Foo.Bar');
    expect(imports[0]!.resolvedPath).toBeNull();
    expect(imports[0]!.isTypeOnly).toBe(false);
  });

  it('extracts import directive', async () => {
    const { tree, buf } = await parse(`import Foo.Bar\n`);
    const imports = elixirHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('Foo.Bar');
  });

  it('extracts use directive', async () => {
    const { tree, buf } = await parse(`use GenServer\n`);
    const imports = elixirHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('GenServer');
  });

  it('extracts require directive', async () => {
    const { tree, buf } = await parse(`require Logger\n`);
    const imports = elixirHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('Logger');
  });

  it('extracts alias with as: modifier (just the module name)', async () => {
    const { tree, buf } = await parse(`alias Foo.Bar, as: B\n`);
    const imports = elixirHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('Foo.Bar');
  });

  it('extracts multiple directives', async () => {
    const src = `alias Foo.Bar\nimport Baz.Qux\nuse GenServer\nrequire Logger\n`;
    const { tree, buf } = await parse(src);
    const imports = elixirHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(4);
    const specifiers = imports.map((i) => i.specifier);
    expect(specifiers).toContain('Foo.Bar');
    expect(specifiers).toContain('Baz.Qux');
    expect(specifiers).toContain('GenServer');
    expect(specifiers).toContain('Logger');
  });

  it('extracts imports inside module body', async () => {
    const src = `defmodule Mod do\n  alias Foo.Bar\n  import Baz\nend\n`;
    const { tree, buf } = await parse(src);
    const imports = elixirHandler.extractImports(tree, buf);
    const specifiers = imports.map((i) => i.specifier);
    expect(specifiers).toContain('Foo.Bar');
    expect(specifiers).toContain('Baz');
  });

  it('extracts imports from fixture lib/my_app.ex', async () => {
    const src = readFileSync(`${FIXTURE_ROOT}/lib/my_app.ex`, 'utf8');
    const buf = Buffer.from(src);
    const tree = await parseFile(buf, elixirHandler);
    const imports = elixirHandler.extractImports(tree, buf);
    const specifiers = imports.map((i) => i.specifier);
    expect(specifiers).toContain('MyApp.User');
    expect(specifiers).toContain('MyApp.Helpers');
    expect(specifiers).toContain('GenServer');
    expect(specifiers).toContain('Logger');
  });
});

// ─── Handler metadata ─────────────────────────────────────────────────────────

describe('Elixir handler — metadata', () => {
  it('claims .ex and .exs extensions', () => {
    expect(elixirHandler.extensions()).toContain('.ex');
    expect(elixirHandler.extensions()).toContain('.exs');
  });

  it('grammarPath points to tree-sitter-elixir.wasm', () => {
    expect(elixirHandler.grammarPath()).toMatch(/tree-sitter-elixir\.wasm$/);
  });
});
