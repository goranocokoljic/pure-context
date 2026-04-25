import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  initParser,
  parseFile,
  isInitialized,
  GRAMMARS_DIR,
  _resetForTesting,
} from '../../src/core/parse-dispatcher.js';
import type { LanguageHandler } from '../../src/core/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = resolve(__dirname, '../fixtures/basic-ts-project');

// Minimal stub handler pointing at the TypeScript grammar
function makeTsHandler(): LanguageHandler {
  return {
    extensions: () => ['.ts', '.tsx'],
    grammarPath: () => resolve(GRAMMARS_DIR, 'tree-sitter-typescript.wasm'),
    extractSymbols: () => [],
    extractImports: () => [],
    extractDocstring: () => null,
  };
}

describe('parse-dispatcher', () => {
  beforeAll(async () => {
    _resetForTesting();
    await initParser();
  });

  afterEach(() => {
    // Don't reset after each — re-init is expensive. Tests share the parser.
  });

  it('isInitialized() is true after initParser()', () => {
    expect(isInitialized()).toBe(true);
  });

  it('initParser() is idempotent — second call is a no-op', async () => {
    await expect(initParser()).resolves.toBeUndefined();
    expect(isInitialized()).toBe(true);
  });

  it('GRAMMARS_DIR points to a directory containing wasm files', () => {
    const { existsSync } = require('fs');
    expect(existsSync(resolve(GRAMMARS_DIR, 'tree-sitter-typescript.wasm'))).toBe(true);
    expect(existsSync(resolve(GRAMMARS_DIR, 'tree-sitter-tsx.wasm'))).toBe(true);
    expect(existsSync(resolve(GRAMMARS_DIR, 'tree-sitter-javascript.wasm'))).toBe(true);
  });

  it('parseFile produces a tree with root node type "program"', async () => {
    const source = Buffer.from('const x = 1;');
    const tree = await parseFile(source, makeTsHandler());
    expect(tree.rootNode.type).toBe('program');
  });

  it('parses a real fixture file and returns a non-empty tree', async () => {
    const source = readFileSync(resolve(FIXTURE_DIR, 'src/utils.ts'));
    const tree = await parseFile(source, makeTsHandler());
    expect(tree.rootNode.type).toBe('program');
    expect(tree.rootNode.childCount).toBeGreaterThan(0);
  });

  it('node startIndex/endIndex are byte offsets into the source buffer', async () => {
    // ASCII-only source: byte offsets == char offsets
    const source = Buffer.from('export function hello() {}');
    const tree = await parseFile(source, makeTsHandler());
    const fnNode = tree.rootNode.children.find(
      (n) => n.type === 'export_statement',
    );
    expect(fnNode).toBeDefined();
    expect(fnNode!.startIndex).toBe(0);
    expect(fnNode!.endIndex).toBe(source.length);
  });

  it('caches language — repeated parseFile calls work without re-loading grammar', async () => {
    const source = Buffer.from('const a = 1;');
    const handler = makeTsHandler();
    const t1 = await parseFile(source, handler);
    const t2 = await parseFile(source, handler);
    expect(t1.rootNode.type).toBe('program');
    expect(t2.rootNode.type).toBe('program');
  });

  it('parses an empty file without throwing', async () => {
    const tree = await parseFile(Buffer.from(''), makeTsHandler());
    expect(tree.rootNode.type).toBe('program');
    expect(tree.rootNode.childCount).toBe(0);
  });
});
