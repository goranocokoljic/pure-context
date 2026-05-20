import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { rubyHandler } from '../../src/handlers/ruby.js';

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, rubyHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

describe('Ruby metaprogramming detection', () => {
  it('extracts define_method :find_by_email as a method symbol', async () => {
    const src = `class User\n  define_method :find_by_email do |email|\n    nil\n  end\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'app/models/user.rb');
    const sym = syms.find((s) => s.name === 'User#find_by_email');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('method');
    expect(sym!.frameworkMeta!['definedDynamically']).toBe(true);
  });

  it('tags method_missing with dynamicDispatch: true', async () => {
    const src = `class Proxy\n  def method_missing(name, *args)\n    nil\n  end\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'lib/proxy.rb');
    const sym = syms.find((s) => s.name === 'Proxy#method_missing');
    expect(sym).toBeDefined();
    expect(sym!.frameworkMeta!['dynamicDispatch']).toBe(true);
  });

  it('tags respond_to_missing? with dynamicDispatch: true', async () => {
    const src = `class Proxy\n  def respond_to_missing?(name, include_private = false)\n    true\n  end\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'lib/proxy.rb');
    const sym = syms.find((s) => s.name === 'Proxy#respond_to_missing?');
    expect(sym).toBeDefined();
    expect(sym!.frameworkMeta!['dynamicDispatch']).toBe(true);
  });

  it('regular methods do NOT get dynamicDispatch tag', async () => {
    const src = `class Foo\n  def bar\n    42\n  end\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'lib/foo.rb');
    const sym = syms.find((s) => s.name === 'Foo#bar');
    expect(sym).toBeDefined();
    expect(sym!.frameworkMeta?.['dynamicDispatch']).toBeUndefined();
  });

  it('extracts class_eval block as synthetic method symbol', async () => {
    const src = `class Foo\n  class_eval do\n    def helper; end\n  end\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'lib/foo.rb');
    const evalSym = syms.find((s) => s.frameworkMeta?.['metaprogramming'] === 'class_eval');
    expect(evalSym).toBeDefined();
    expect(evalSym!.kind).toBe('method');
  });

  it('define_method at top level (no class) uses bare name', async () => {
    const src = `define_method :greet do\n  "hello"\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'lib/helpers.rb');
    const sym = syms.find((s) => s.name === 'greet');
    expect(sym).toBeDefined();
    expect(sym!.frameworkMeta!['definedDynamically']).toBe(true);
  });

  it('does NOT extract send() call as a definition', async () => {
    const src = `class Foo\n  def bar\n    send(:authenticate)\n  end\nend\n`;
    const { tree, buf } = await parse(src);
    const syms = rubyHandler.extractSymbols(tree, buf, 'lib/foo.rb');
    // Only Foo and Foo#bar should be extracted, not authenticate
    const names = syms.map((s) => s.name);
    expect(names).not.toContain('Foo#authenticate');
    expect(names).not.toContain('authenticate');
  });
});
