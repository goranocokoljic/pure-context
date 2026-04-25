import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerHandler,
  getHandler,
  getAllHandlers,
  getSupportedExtensions,
  _resetForTesting,
} from '../../src/handlers/handler-registry.js';
import type { LanguageHandler } from '../../src/core/types.js';

function makeHandler(exts: string[], name = 'stub'): LanguageHandler {
  return {
    extensions: () => exts,
    grammarPath: () => `/grammars/${name}.wasm`,
    extractSymbols: () => [],
    extractImports: () => [],
    extractDocstring: () => null,
  };
}

describe('handler-registry', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('getHandler returns null for unknown extension', () => {
    expect(getHandler('src/foo.ts')).toBeNull();
  });

  it('registerHandler makes extension resolvable', () => {
    const h = makeHandler(['.ts', '.tsx']);
    registerHandler(h);
    expect(getHandler('src/foo.ts')).toBe(h);
    expect(getHandler('src/Comp.tsx')).toBe(h);
  });

  it('getHandler is case-insensitive for extension', () => {
    const h = makeHandler(['.ts']);
    registerHandler(h);
    expect(getHandler('src/Foo.TS')).toBe(h);
  });

  it('last registration wins for the same extension', () => {
    const h1 = makeHandler(['.ts'], 'first');
    const h2 = makeHandler(['.ts'], 'second');
    registerHandler(h1);
    registerHandler(h2);
    expect(getHandler('file.ts')).toBe(h2);
  });

  it('getAllHandlers returns all registered handlers', () => {
    const h1 = makeHandler(['.ts']);
    const h2 = makeHandler(['.js']);
    registerHandler(h1);
    registerHandler(h2);
    expect(getAllHandlers()).toEqual([h1, h2]);
  });

  it('getAllHandlers does not include duplicates', () => {
    const h = makeHandler(['.ts']);
    registerHandler(h);
    registerHandler(h);
    expect(getAllHandlers()).toHaveLength(1);
  });

  it('getSupportedExtensions returns all claimed extensions', () => {
    registerHandler(makeHandler(['.ts', '.tsx']));
    registerHandler(makeHandler(['.js', '.mjs']));
    const exts = getSupportedExtensions().sort();
    expect(exts).toEqual(['.js', '.mjs', '.ts', '.tsx']);
  });

  it('_resetForTesting clears all registrations', () => {
    registerHandler(makeHandler(['.ts']));
    _resetForTesting();
    expect(getHandler('file.ts')).toBeNull();
    expect(getAllHandlers()).toHaveLength(0);
  });

  it('getHandler returns null for files without extension', () => {
    registerHandler(makeHandler(['.ts']));
    expect(getHandler('Makefile')).toBeNull();
  });
});
