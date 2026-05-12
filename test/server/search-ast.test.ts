/**
 * Tests for the search_ast tool (Task 191).
 *
 * Fixture: test/fixtures/search-ast-fixture/
 *   src/auth.ts         — arrow_function, try_statement, await_expression, template_string
 *   src/data-service.ts — class_declaration, interface_declaration, try_statement, arrow_function
 *   src/utils.ts        — arrow_function, await_expression, template_string, try_statement
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as searchAstHandler } from '../../src/server/tools/search-ast.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/search-ast-fixture');

let repoId: string;

// ─── Output types ─────────────────────────────────────────────────────────────

interface AstMatch {
  filePath: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  nodeType: string;
  text: string;
}

interface SearchAstOutput {
  matches: AstMatch[];
  totalFound: number;
  truncated: boolean;
  nodeTypeSearched: string;
  filesSearched: number;
  skippedFiles?: string[];
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  const result = await indexFolder(FIXTURE, { fileLimit: 50 });
  repoId = result.repoId;
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

// ─── Helper ───────────────────────────────────────────────────────────────────

async function search(args: {
  nodeType: string;
  language?: string;
  filePath?: string;
  includeText?: boolean;
  maxTextLength?: number;
  limit?: number;
}): Promise<SearchAstOutput> {
  const result = await searchAstHandler({ repoId, ...args });
  expect(result.isError).toBeFalsy();
  const text = (result.content[0] as { type: string; text: string }).text;
  return JSON.parse(text) as SearchAstOutput;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('search_ast — repo not found', () => {
  it('returns an error when repoId does not exist', async () => {
    const result = await searchAstHandler({ repoId: 'deadbeef00000000', nodeType: 'arrow_function' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const body = JSON.parse(text) as { error: string };
    expect(body.error).toContain('not found');
  });
});

describe('search_ast — arrow_function', () => {
  it('finds arrow functions across all files', async () => {
    const out = await search({ nodeType: 'arrow_function' });
    // fixture has many arrow functions across 3 files
    expect(out.matches.length).toBeGreaterThan(5);
    expect(out.nodeTypeSearched).toBe('arrow_function');
    expect(out.totalFound).toBeGreaterThan(5);
  });

  it('each match has required fields', async () => {
    const out = await search({ nodeType: 'arrow_function' });
    for (const m of out.matches) {
      expect(m.filePath).toBeTruthy();
      expect(m.startLine).toBeGreaterThan(0);
      expect(m.endLine).toBeGreaterThanOrEqual(m.startLine);
      expect(m.startByte).toBeGreaterThanOrEqual(0);
      expect(m.endByte).toBeGreaterThan(m.startByte);
      expect(m.nodeType).toBe('arrow_function');
    }
  });

  it('startLine is accurate (auth.ts arrow functions start after line 1)', async () => {
    const out = await search({ nodeType: 'arrow_function', filePath: 'src/auth.ts' });
    expect(out.matches.length).toBeGreaterThan(0);
    // All arrow functions in auth.ts are after line 1
    for (const m of out.matches) {
      expect(m.startLine).toBeGreaterThan(1);
    }
  });
});

describe('search_ast — try_statement', () => {
  it('finds try/catch blocks', async () => {
    const out = await search({ nodeType: 'try_statement' });
    expect(out.matches.length).toBeGreaterThan(3);
    expect(out.nodeTypeSearched).toBe('try_statement');
  });

  it('all matches have nodeType try_statement', async () => {
    const out = await search({ nodeType: 'try_statement' });
    for (const m of out.matches) {
      expect(m.nodeType).toBe('try_statement');
    }
  });
});

describe('search_ast — await_expression', () => {
  it('finds await expressions', async () => {
    const out = await search({ nodeType: 'await_expression' });
    expect(out.matches.length).toBeGreaterThan(2);
    expect(out.nodeTypeSearched).toBe('await_expression');
  });
});

describe('search_ast — class_declaration', () => {
  it('finds class declarations', async () => {
    const out = await search({ nodeType: 'class_declaration' });
    // data-service.ts has DataService class
    expect(out.matches.length).toBeGreaterThanOrEqual(1);
  });
});

describe('search_ast — interface_declaration', () => {
  it('finds interface declarations', async () => {
    const out = await search({ nodeType: 'interface_declaration' });
    // auth.ts has AuthConfig + User; data-service.ts has Repository + FilterFn (type alias)
    expect(out.matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('search_ast — template_string', () => {
  it('finds template literals', async () => {
    const out = await search({ nodeType: 'template_string' });
    expect(out.matches.length).toBeGreaterThan(0);
    expect(out.nodeTypeSearched).toBe('template_string');
  });

  it('matched text contains backtick', async () => {
    const out = await search({ nodeType: 'template_string', includeText: true });
    for (const m of out.matches) {
      expect(m.text).toContain('`');
    }
  });
});

describe('search_ast — unknown node type', () => {
  it('returns empty results for a non-existent node type', async () => {
    const out = await search({ nodeType: 'nonexistent_node_type_xyz' });
    expect(out.matches).toHaveLength(0);
    expect(out.totalFound).toBe(0);
    expect(out.truncated).toBe(false);
  });
});

describe('search_ast — filePath filter', () => {
  it('restricts results to a specific file', async () => {
    const out = await search({ nodeType: 'arrow_function', filePath: 'src/auth.ts' });
    expect(out.matches.length).toBeGreaterThan(0);
    for (const m of out.matches) {
      expect(m.filePath).toBe('src/auth.ts');
    }
  });

  it('restricts results to a directory prefix', async () => {
    const out = await search({ nodeType: 'try_statement', filePath: 'src/' });
    expect(out.matches.length).toBeGreaterThan(0);
    for (const m of out.matches) {
      expect(m.filePath.startsWith('src/')).toBe(true);
    }
  });

  it('returns empty results when file path matches nothing', async () => {
    const out = await search({ nodeType: 'arrow_function', filePath: 'nonexistent/' });
    expect(out.matches).toHaveLength(0);
  });
});

describe('search_ast — language filter', () => {
  it('limits to typescript files', async () => {
    const out = await search({ nodeType: 'arrow_function', language: 'typescript' });
    expect(out.matches.length).toBeGreaterThan(0);
    for (const m of out.matches) {
      expect(m.filePath.endsWith('.ts') || m.filePath.endsWith('.tsx')).toBe(true);
    }
  });

  it('returns zero results for a language not in the fixture', async () => {
    const out = await search({ nodeType: 'arrow_function', language: 'python' });
    expect(out.matches).toHaveLength(0);
  });
});

describe('search_ast — limit', () => {
  it('respects the limit parameter', async () => {
    const out = await search({ nodeType: 'arrow_function', limit: 3 });
    expect(out.matches.length).toBeLessThanOrEqual(3);
  });

  it('sets truncated=true when limit is hit', async () => {
    // There are many arrow functions across 3 files; limit to 1
    const out = await search({ nodeType: 'arrow_function', limit: 1 });
    expect(out.matches).toHaveLength(1);
    expect(out.truncated).toBe(true);
  });

  it('sets truncated=false when results fit within limit', async () => {
    // Use a rare node type with few matches
    const out = await search({ nodeType: 'class_declaration', limit: 50 });
    expect(out.truncated).toBe(false);
  });
});

describe('search_ast — includeText', () => {
  it('includes text by default', async () => {
    const out = await search({ nodeType: 'arrow_function', limit: 5 });
    for (const m of out.matches) {
      expect(m.text.length).toBeGreaterThan(0);
    }
  });

  it('omits text when includeText is false', async () => {
    const out = await search({ nodeType: 'arrow_function', limit: 5, includeText: false });
    for (const m of out.matches) {
      expect(m.text).toBe('');
    }
  });

  it('truncates text to maxTextLength', async () => {
    const out = await search({ nodeType: 'arrow_function', maxTextLength: 20 });
    for (const m of out.matches) {
      expect(m.text.length).toBeLessThanOrEqual(21); // 20 chars + ellipsis char
    }
  });
});

describe('search_ast — response metadata', () => {
  it('includes _tokenEstimate', async () => {
    const out = await search({ nodeType: 'arrow_function' });
    expect(typeof out._tokenEstimate).toBe('number');
    expect(out._tokenEstimate).toBeGreaterThanOrEqual(0);
  });

  it('includes _meta with timing_ms', async () => {
    const out = await search({ nodeType: 'arrow_function' });
    expect(out._meta).toBeDefined();
    expect(typeof out._meta.timing_ms).toBe('number');
  });

  it('reports filesSearched count', async () => {
    const out = await search({ nodeType: 'arrow_function' });
    expect(out.filesSearched).toBeGreaterThanOrEqual(3);
  });

  it('skippedFiles is undefined when no files were skipped', async () => {
    const out = await search({ nodeType: 'arrow_function' });
    // All fixture files are TypeScript with WASM grammars — nothing skipped
    expect(out.skippedFiles).toBeUndefined();
  });
});
