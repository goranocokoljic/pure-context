import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { rubyHandler } from '../../src/handlers/ruby.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/ruby-project');

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, rubyHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Ruby handler — extractSymbols', () => {
  it('extracts a top-level function', async () => {
    const { tree, buf } = await parse(`def greet(name)\n  "Hello, #{name}!"\nend\n`);
    const syms = rubyHandler.extractSymbols(tree, buf, 'lib/helper.rb');
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe('greet');
    expect(syms[0]!.kind).toBe('function');
    expect(syms[0]!.startByte).toBeGreaterThanOrEqual(0);
    expect(syms[0]!.endByte).toBeGreaterThan(0);
  });

  it('generates a deterministic 16-char hex id', async () => {
    const { tree, buf } = await parse(`def foo\nend\n`);
    const sym = rubyHandler.extractSymbols(tree, buf, 'lib/a.rb')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = rubyHandler.extractSymbols(tree, buf, 'lib/a.rb')[0]!;
    expect(sym2.id).toBe(sym.id);
  });

  it('extracts a class with instance methods', async () => {
    const src = `class User\n  def initialize(name)\n    @name = name\n  end\n\n  def display_name\n    @name\n  end\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'lib/user.rb');
    const names = syms.map((s) => s.name);
    expect(names).toContain('User');
    expect(syms.find((s) => s.name === 'User')!.kind).toBe('class');
    expect(names).toContain('User#initialize');
    expect(names).toContain('User#display_name');
    expect(syms.find((s) => s.name === 'User#initialize')!.kind).toBe('method');
  });

  it('extracts singleton methods as kind method with ClassName.name', async () => {
    const src = `class Repo\n  def self.find(id)\n    nil\n  end\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'lib/repo.rb');
    const singleton = syms.find((s) => s.name === 'Repo.find');
    expect(singleton).toBeDefined();
    expect(singleton!.kind).toBe('method');
  });

  it('extracts a module as kind type', async () => {
    const src = `module Serializable\n  def to_json\n    {}.to_json\n  end\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'lib/serializable.rb');
    const mod = syms.find((s) => s.name === 'Serializable');
    expect(mod).toBeDefined();
    expect(mod!.kind).toBe('type');
    // Methods inside module are extracted as methods
    expect(syms.find((s) => s.name === 'Serializable#to_json')).toBeDefined();
  });

  it('extracts constants at class scope as kind const', async () => {
    const src = `class Config\n  MAX_RETRIES = 3\n  API_URL = 'https://api.example.com'\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'lib/config.rb');
    const max = syms.find((s) => s.name === 'Config::MAX_RETRIES');
    expect(max).toBeDefined();
    expect(max!.kind).toBe('const');
    expect(syms.find((s) => s.name === 'Config::API_URL')).toBeDefined();
  });

  it('does not extract top-level constants', async () => {
    const src = `TOP_LEVEL = 'value'\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'lib/a.rb');
    expect(syms.filter((s) => s.kind === 'const')).toHaveLength(0);
  });

  it('does not extract attr_accessor as symbols', async () => {
    const src = `class User\n  attr_accessor :name, :email\n  def initialize(name)\n    @name = name\n  end\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'lib/user.rb');
    // Only class + initialize method — no attr symbols
    const names = syms.map((s) => s.name);
    expect(names).not.toContain('name');
    expect(names).not.toContain('email');
    expect(names).toContain('User#initialize');
  });

  it('includes signature for a method', async () => {
    const src = `def greet(name, greeting = 'Hello')\n  "#{greeting}, #{name}!"\nend\n`;
    const { tree, buf } = await parse(src);
    const sym = rubyHandler.extractSymbols(tree, buf, 'lib/a.rb')[0]!;
    expect(sym.signature).toMatch(/def greet/);
    expect(sym.signature).not.toContain('end');
  });

  it('includes signature for a class', async () => {
    const src = `class Admin < User\nend\n`;
    const { tree, buf } = await parse(src);
    const sym = rubyHandler.extractSymbols(tree, buf, 'lib/admin.rb').find((s) => s.name === 'Admin')!;
    expect(sym.signature).toMatch(/class Admin/);
  });

  it('includes signature for a module', async () => {
    const src = `module Logging\nend\n`;
    const { tree, buf } = await parse(src);
    const sym = rubyHandler.extractSymbols(tree, buf, 'lib/logging.rb')[0]!;
    expect(sym.signature).toMatch(/module Logging/);
  });

  it('handles nested class: inner class methods use inner class name', async () => {
    const src = `class Outer\n  class Inner\n    def foo\n    end\n  end\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'lib/outer.rb');
    // Method is qualified with Inner, not Outer
    expect(syms.find((s) => s.name === 'Inner#foo')).toBeDefined();
    expect(syms.find((s) => s.name === 'Outer#foo')).toBeUndefined();
  });

  it('extracts symbols from fixture lib/models/user.rb', async () => {
    const src = readFileSync(`${FIXTURE_ROOT}/lib/models/user.rb`, 'utf8');
    const buf = Buffer.from(src);
    const tree = await parseFile(buf, rubyHandler);
    const syms = rubyHandler.extractSymbols(tree, buf, 'lib/models/user.rb');
    const names = syms.map((s) => s.name);

    // Class
    expect(names).toContain('User');
    expect(syms.find((s) => s.name === 'User')!.kind).toBe('class');

    // Instance methods
    expect(names).toContain('User#initialize');
    expect(names).toContain('User#display_name');
    expect(names).toContain('User#validate_email');

    // Singleton methods
    expect(names).toContain('User.find');
    expect(names).toContain('User.all_to_json');

    // Class-scope constant
    expect(names).toContain('User::MAX_LOGIN_ATTEMPTS');

    // Module
    expect(names).toContain('Serializable');
    expect(syms.find((s) => s.name === 'Serializable')!.kind).toBe('type');
    expect(names).toContain('Serializable::VERSION');
    expect(names).toContain('Serializable#to_hash');
    expect(names).toContain('Serializable#to_json_string');

    // Top-level function
    expect(names).toContain('greet');
    expect(syms.find((s) => s.name === 'greet')!.kind).toBe('function');

    // attr_accessor should NOT produce symbols
    expect(names).not.toContain('name');
    expect(names).not.toContain('email');
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('Ruby handler — extractDocstring', () => {
  it('captures a single # comment preceding a method', async () => {
    const src = `# Greets the user.\ndef greet(name)\nend\n`;
    const { tree } = await parse(src);
    const methodNode = tree.rootNode.children.find((c) => c.type === 'method');
    expect(methodNode).toBeDefined();
    const doc = rubyHandler.extractDocstring!(methodNode!);
    expect(doc).toBeTruthy();
    expect(doc).toContain('Greets');
  });

  it('captures multiple consecutive # comments', async () => {
    const src = `# Returns the user.\n# This is a detailed description.\ndef find_user\nend\n`;
    const { tree } = await parse(src);
    const methodNode = tree.rootNode.children.find((c) => c.type === 'method');
    expect(methodNode).toBeDefined();
    const doc = rubyHandler.extractDocstring!(methodNode!);
    expect(doc).toBeTruthy();
  });

  it('returns null when no preceding comment', async () => {
    const src = `def bare_method\nend\n`;
    const { tree } = await parse(src);
    const methodNode = tree.rootNode.children.find((c) => c.type === 'method');
    expect(methodNode).toBeDefined();
    const doc = rubyHandler.extractDocstring!(methodNode!);
    expect(doc).toBeNull();
  });

  it('captures docstring from fixture user.rb User class', async () => {
    const src = readFileSync(`${FIXTURE_ROOT}/lib/models/user.rb`, 'utf8');
    const buf = Buffer.from(src);
    const tree = await parseFile(buf, rubyHandler);
    const syms = rubyHandler.extractSymbols(tree, buf, 'lib/models/user.rb');
    const user = syms.find((s) => s.name === 'User');
    expect(user!.summary).toBeTruthy();
    expect(user!.summary).toContain('user');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Ruby handler — extractImports', () => {
  it('extracts a require call', async () => {
    const { tree, buf } = await parse(`require 'json'\n`);
    const imports = rubyHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('json');
    expect(imports[0]!.resolvedPath).toBeNull();
    expect(imports[0]!.importedNames).toEqual([]);
    expect(imports[0]!.isTypeOnly).toBe(false);
  });

  it('extracts a require_relative call', async () => {
    const { tree, buf } = await parse(`require_relative './base_model'\n`);
    const imports = rubyHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('./base_model');
    expect(imports[0]!.resolvedPath).toBeNull(); // interface doesn't pass filePath
  });

  it('extracts multiple require calls', async () => {
    const { tree, buf } = await parse(`require 'json'\nrequire 'net/http'\nrequire_relative './helper'\n`);
    const imports = rubyHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(3);
    const specifiers = imports.map((i) => i.specifier);
    expect(specifiers).toContain('json');
    expect(specifiers).toContain('net/http');
    expect(specifiers).toContain('./helper');
  });

  it('ignores non-require calls', async () => {
    const { tree, buf } = await parse(`puts 'hello'\nload 'other.rb'\n`);
    const imports = rubyHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(0);
  });

  it('extracts imports from fixture user.rb', async () => {
    const src = readFileSync(`${FIXTURE_ROOT}/lib/models/user.rb`, 'utf8');
    const buf = Buffer.from(src);
    const tree = await parseFile(buf, rubyHandler);
    const imports = rubyHandler.extractImports(tree, buf);
    const specifiers = imports.map((i) => i.specifier);
    expect(specifiers).toContain('json');
    expect(specifiers).toContain('./base_model');
  });
});

// ─── Handler metadata ─────────────────────────────────────────────────────────

describe('Ruby handler — metadata', () => {
  it('claims .rb extension', () => {
    expect(rubyHandler.extensions()).toEqual(['.rb']);
  });

  it('grammarPath points to tree-sitter-ruby.wasm', () => {
    expect(rubyHandler.grammarPath()).toMatch(/tree-sitter-ruby\.wasm$/);
  });
});
