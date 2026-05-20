import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { cppHandler } from '../../src/handlers/cpp.js';

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, cppHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

describe('C++ macro_invocation extraction', () => {

  it('extracts identifier from FUNCTION_REGISTER macro', async () => {
    const { tree, buf } = await parse(`FUNCTION_REGISTER(FunctionAbs)\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'src/functions.cpp');
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe('FunctionAbs');
    expect(syms[0]!.kind).toBe('function');
  });

  it('sets frameworkMeta.registeredViaMacro to the macro name', async () => {
    const { tree, buf } = await parse(`FUNCTION_REGISTER(FunctionAbs)\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'src/functions.cpp');
    expect(syms[0]!.frameworkMeta).toBeDefined();
    expect(syms[0]!.frameworkMeta!['registeredViaMacro']).toBe('FUNCTION_REGISTER');
  });

  it('extracts identifier from DEFINE_FOLLY_FUTURE macro (kind type)', async () => {
    const { tree, buf } = await parse(`DEFINE_FOLLY_FUTURE(MyFuture)\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'folly/future.h');
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe('MyFuture');
    expect(syms[0]!.kind).toBe('type');
    expect(syms[0]!.frameworkMeta!['registeredViaMacro']).toBe('DEFINE_FOLLY_FUTURE');
  });

  it('extracts string literal from REGISTER_OP (TensorFlow)', async () => {
    const { tree, buf } = await parse(`REGISTER_OP("Abs")\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'ops.cc');
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe('Abs');
    expect(syms[0]!.kind).toBe('function');
    expect(syms[0]!.frameworkMeta!['registeredViaMacro']).toBe('REGISTER_OP');
  });

  it('does NOT extract from non-registration macros like DCHECK', async () => {
    const { tree, buf } = await parse(`DCHECK(x != nullptr);\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'src/check.cpp');
    expect(syms).toHaveLength(0);
  });

  it('does NOT extract from ASSERT_EQ', async () => {
    const { tree, buf } = await parse(`ASSERT_EQ(a, b);\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'test.cpp');
    expect(syms).toHaveLength(0);
  });

  it('qualifies macro-registered symbol with enclosing namespace', async () => {
    const { tree, buf } = await parse(`
namespace DB {
  REGISTER_FUNCTION(FunctionToString, "String")
}
`);
    const syms = cppHandler.extractSymbols(tree, buf, 'src/db.cpp');
    const sym = syms.find((s) => s.frameworkMeta?.['registeredViaMacro']);
    expect(sym).toBeDefined();
    expect(sym!.name).toBe('DB::FunctionToString');
  });

  it('extracts FOLLY_DEFINE_KERNEL as kind class', async () => {
    const { tree, buf } = await parse(`FOLLY_DEFINE_KERNEL(MyKernel)\n`);
    const syms = cppHandler.extractSymbols(tree, buf, 'folly/kernel.h');
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe('MyKernel');
    expect(syms[0]!.kind).toBe('class');
  });

  it('generates deterministic 16-char hex id', async () => {
    const { tree, buf } = await parse(`FUNCTION_REGISTER(FunctionAbs)\n`);
    const sym = cppHandler.extractSymbols(tree, buf, 'src/fn.cpp')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = cppHandler.extractSymbols(tree, buf, 'src/fn.cpp')[0]!;
    expect(sym2.id).toBe(sym.id);
  });
});
