/**
 * Phase 90 (Task 558) — query-time re-parse tools operate in pure char space.
 *
 * Fixture files put emoji + em-dash preambles BEFORE the match so any
 * char/byte mixing shifts snippets and line numbers. Assertions pin the
 * exact snippet text and exact line numbers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as searchAstHandler } from '../../src/server/tools/search-ast.js';
import { handler as decoratorHandler } from '../../src/server/tools/search-by-decorator.js';
import { handler as lexicalHandler } from '../../src/server/tools/get-lexical-scope-matches.js';

let root: string;
let repoId: string;

function parse(result: { content: Array<{ type: string }> }): any {
  return JSON.parse((result.content[0] as unknown as { text: string }).text);
}

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  await initParser();

  root = resolve(mkdtempSync(join(tmpdir(), 'pc-charspace-')));
  mkdirSync(join(root, 'src'), { recursive: true });

  // Line 1: emoji + em-dash preamble (26 chars but far more bytes)
  // Line 2: decorated class with an arrow function inside
  writeFileSync(
    join(root, 'src', 'uni.ts'),
    '/* 🎉🎉 — préambule — 日本語 */\n' + // line 1
      'const arrowFn = () => 42;\n' + // line 2 (arrow_function)
      '\n' + // line 3
      'function Injectable(): ClassDecorator { return () => {}; }\n' + // line 4
      '@Injectable()\n' + // line 5 (decorator)
      'class UniService {\n' + // line 6
      '  run() {\n' + // line 7
      '    describe("x", () => {});\n' + // line 8 (call)
      '  }\n' +
      '}\n',
    'utf8',
  );

  const result = await indexFolder(root, { fileLimit: 20 });
  repoId = result.repoId;
}, 30_000);

afterAll(() => {
  try {
    deleteIndex(repoId);
  } catch {
    /* ignore */
  }
  rmSync(root, { recursive: true, force: true });
});

describe('search_ast on a file with an emoji/em-dash preamble', () => {
  it('returns the exact snippet and exact line numbers', async () => {
    const out = parse(
      await searchAstHandler({ repoId, nodeType: 'arrow_function', includeText: true }),
    );
    const m = out.matches.find((x: { startLine: number }) => x.startLine === 2);
    expect(m).toBeDefined();
    expect(m.text).toBe('() => 42');
    expect(m.endLine).toBe(2);
  });
});

describe('search_by_decorator on the same file', () => {
  it('reports the decorator on the exact line', async () => {
    const out = parse(
      await decoratorHandler({ repoId, decoratorName: 'Injectable' }),
    );
    expect(out.matches.length).toBeGreaterThan(0);
    const m = out.matches[0];
    expect(m.startLine).toBe(5);
    expect(m.decoratedName ?? m.symbolName ?? m.name).toContain('UniService');
  });
});

describe('get_lexical_scope_matches on the same file', () => {
  it('returns exact snippet and line for a call after the preamble', async () => {
    const out = parse(
      await lexicalHandler({ repoId, childCall: 'describe', parentCall: 'UniService' }),
    );
    expect(out.matches.length).toBeGreaterThan(0);
    const m = out.matches[0];
    expect(m.startLine).toBe(8);
    expect(m.snippet).toContain('describe("x", () => {})');
  });
});
