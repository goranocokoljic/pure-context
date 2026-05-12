/**
 * Tests for the search_by_decorator tool (Task 193).
 *
 * Fixture: test/fixtures/search-by-decorator-fixture/
 *   src/app-controller.ts  — @Controller, @Get, @Post, @Put, @Delete, @UseGuards
 *   src/user-service.ts    — @Injectable, @Singleton, @Memoize, @Deprecated, @Log
 *   src/entity.ts          — @Entity, @PrimaryGeneratedColumn, @Column, @BeforeInsert, @AfterInsert
 *   src/standalone.ts      — @Retry, @Throttle, stacked decorator scenarios
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as searchByDecoratorHandler } from '../../src/server/tools/search-by-decorator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/search-by-decorator-fixture');

let repoId: string;

// ─── Types ────────────────────────────────────────────────────────────────────

interface DecoratorMatch {
  symbolId?: string;
  symbolName: string;
  symbolKind: string;
  filePath: string;
  startLine: number;
  decoratorName: string;
  decoratorText?: string;
  signature?: string;
  summary?: string;
}

interface SearchByDecoratorOutput {
  matches: DecoratorMatch[];
  totalFound: number;
  truncated: boolean;
  decoratorQueried: string;
  matchMode: string;
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
  decoratorName: string;
  matchMode?: 'exact' | 'contains' | 'prefix';
  language?: string;
  filePath?: string;
  includeDecoratorText?: boolean;
  limit?: number;
}): Promise<SearchByDecoratorOutput> {
  const result = await searchByDecoratorHandler({ repoId, ...args });
  expect(result.isError).toBeFalsy();
  const text = (result.content[0] as { type: string; text: string }).text;
  return JSON.parse(text) as SearchByDecoratorOutput;
}

// ─── Exact match mode (default) ───────────────────────────────────────────────

describe('search_by_decorator — exact mode (default)', () => {
  it('finds all @Injectable classes', async () => {
    const out = await search({ decoratorName: 'Injectable' });
    expect(out.matches.length).toBeGreaterThan(0);
    for (const m of out.matches) {
      expect(m.decoratorName).toBe('Injectable');
    }
    const names = out.matches.map((m) => m.symbolName);
    expect(names).toContain('UserService');
    expect(names).toContain('CacheService');
  });

  it('finds @Entity classes', async () => {
    const out = await search({ decoratorName: 'Entity' });
    expect(out.matches.length).toBeGreaterThan(0);
    const names = out.matches.map((m) => m.symbolName);
    expect(names).toContain('UserEntity');
    expect(names).toContain('PostEntity');
    for (const m of out.matches) {
      expect(m.symbolKind).toBe('class');
    }
  });

  it('finds @Controller classes', async () => {
    const out = await search({ decoratorName: 'Controller' });
    expect(out.matches.length).toBeGreaterThan(0);
    const names = out.matches.map((m) => m.symbolName);
    expect(names).toContain('UserController');
    expect(names).toContain('AdminController');
  });

  it('finds @Get route methods', async () => {
    const out = await search({ decoratorName: 'Get' });
    expect(out.matches.length).toBeGreaterThan(0);
    for (const m of out.matches) {
      expect(m.decoratorName).toBe('Get');
    }
    const names = out.matches.map((m) => m.symbolName);
    expect(names.some((n) => n.includes('getUsers') || n.includes('UserController.getUsers'))).toBe(true);
  });

  it('finds @BeforeInsert lifecycle methods', async () => {
    const out = await search({ decoratorName: 'BeforeInsert' });
    expect(out.matches.length).toBeGreaterThan(0);
    const names = out.matches.map((m) => m.symbolName);
    expect(names.some((n) => n.includes('normalizeEmail'))).toBe(true);
    expect(names.some((n) => n.includes('validateTitle'))).toBe(true);
  });

  it('returns empty array when decorator does not exist', async () => {
    const out = await search({ decoratorName: 'XYZNonExistentDecoratorQWERTY' });
    expect(out.matches).toHaveLength(0);
    expect(out.totalFound).toBe(0);
  });

  it('exact match excludes partial matches', async () => {
    // "Log" should NOT match "@Log" if mode is exact... wait @Log IS exact "Log"
    // "Memo" should NOT match "@Memoize" in exact mode
    const out = await search({ decoratorName: 'Memo' });
    expect(out.matches).toHaveLength(0);
  });
});

// ─── Contains mode ────────────────────────────────────────────────────────────

describe('search_by_decorator — contains mode', () => {
  it('finds decorators whose name contains "ate" (Get, Delete, CreateDateColumn, UpdateDateColumn)', async () => {
    const out = await search({ decoratorName: 'ate', matchMode: 'contains' });
    expect(out.matches.length).toBeGreaterThan(0);
    for (const m of out.matches) {
      expect(m.decoratorName).toContain('ate');
    }
  });

  it('finds all @Deprecated usages via contains', async () => {
    const out = await search({ decoratorName: 'Deprecated', matchMode: 'contains' });
    expect(out.matches.length).toBeGreaterThan(0);
    for (const m of out.matches) {
      expect(m.decoratorName).toContain('Deprecated');
    }
  });

  it('finds @Memoize via contains "memo" (case-sensitive)', async () => {
    // Note: contains is case-sensitive — "memo" won't match "Memoize"
    const outLower = await search({ decoratorName: 'memo', matchMode: 'contains' });
    expect(outLower.matches).toHaveLength(0);

    // "Memo" matches "Memoize"
    const out = await search({ decoratorName: 'Memo', matchMode: 'contains' });
    expect(out.matches.length).toBeGreaterThan(0);
    for (const m of out.matches) {
      expect(m.decoratorName).toContain('Memo');
    }
  });

  it('reports matchMode in response', async () => {
    const out = await search({ decoratorName: 'Column', matchMode: 'contains' });
    expect(out.matchMode).toBe('contains');
  });
});

// ─── Prefix mode ──────────────────────────────────────────────────────────────

describe('search_by_decorator — prefix mode', () => {
  it('finds all @Column* decorators via prefix "Column"', async () => {
    const out = await search({ decoratorName: 'Column', matchMode: 'prefix' });
    expect(out.matches.length).toBeGreaterThan(0);
    for (const m of out.matches) {
      expect(m.decoratorName).toMatch(/^Column/);
    }
    const names = out.matches.map((m) => m.decoratorName);
    expect(names).toContain('Column');
  });

  it('finds all @*DateColumn decorators NOT via prefix "Date" (decorators start with Create/Update)', async () => {
    const out = await search({ decoratorName: 'Date', matchMode: 'prefix' });
    // CreateDateColumn and UpdateDateColumn do NOT start with "Date"
    expect(out.matches).toHaveLength(0);
  });

  it('prefix "Create" finds @CreateDateColumn', async () => {
    const out = await search({ decoratorName: 'Create', matchMode: 'prefix' });
    expect(out.matches.length).toBeGreaterThan(0);
    for (const m of out.matches) {
      expect(m.decoratorName).toMatch(/^Create/);
    }
  });

  it('prefix "Get" does NOT match @GetMapping (not present) but matches @Get', async () => {
    const out = await search({ decoratorName: 'Get', matchMode: 'prefix' });
    expect(out.matches.length).toBeGreaterThan(0);
    for (const m of out.matches) {
      expect(m.decoratorName).toMatch(/^Get/);
    }
  });

  it('reports matchMode "prefix" in response', async () => {
    const out = await search({ decoratorName: 'Entity', matchMode: 'prefix' });
    expect(out.matchMode).toBe('prefix');
  });
});

// ─── filePath filter ──────────────────────────────────────────────────────────

describe('search_by_decorator — filePath filter', () => {
  it('restricts results to a specific file', async () => {
    const out = await search({
      decoratorName: 'Deprecated',
      matchMode: 'contains',
      filePath: 'src/user-service.ts',
    });
    expect(out.matches.length).toBeGreaterThan(0);
    for (const m of out.matches) {
      expect(m.filePath).toBe('src/user-service.ts');
    }
  });

  it('restricts results to a directory prefix', async () => {
    const out = await search({
      decoratorName: 'Column',
      matchMode: 'prefix',
      filePath: 'src/',
    });
    for (const m of out.matches) {
      expect(m.filePath).toMatch(/^src\//);
    }
  });

  it('returns empty when file has no matching decorators', async () => {
    // entity.ts has no @Injectable
    const out = await search({
      decoratorName: 'Injectable',
      filePath: 'src/entity.ts',
    });
    expect(out.matches).toHaveLength(0);
  });
});

// ─── stacked decorators ───────────────────────────────────────────────────────

describe('search_by_decorator — stacked decorators', () => {
  it('finds each decorator separately when a symbol has multiple decorators', async () => {
    // CacheService has @Injectable and @Singleton
    const injectableMatches = await search({ decoratorName: 'Injectable' });
    const singletonMatches = await search({ decoratorName: 'Singleton' });

    const injectableNames = injectableMatches.matches.map((m) => m.symbolName);
    const singletonNames = singletonMatches.matches.map((m) => m.symbolName);

    expect(injectableNames).toContain('CacheService');
    expect(singletonNames).toContain('CacheService');
  });

  it('finds @Retry on methods that also have @Deprecated', async () => {
    const out = await search({ decoratorName: 'Retry' });
    expect(out.matches.length).toBeGreaterThan(0);
    const methodNames = out.matches.map((m) => m.symbolName);
    expect(methodNames.some((n) => n.includes('runTask') || n.includes('executeTask'))).toBe(true);
  });
});

// ─── Output shape ─────────────────────────────────────────────────────────────

describe('search_by_decorator — output shape', () => {
  it('returns required fields on each match', async () => {
    const out = await search({ decoratorName: 'Injectable' });
    for (const m of out.matches) {
      expect(m).toHaveProperty('symbolName');
      expect(m).toHaveProperty('symbolKind');
      expect(m).toHaveProperty('filePath');
      expect(m).toHaveProperty('startLine');
      expect(m).toHaveProperty('decoratorName');
      expect(typeof m.startLine).toBe('number');
      expect(m.startLine).toBeGreaterThanOrEqual(1);
      expect(m.decoratorName).toBe('Injectable');
    }
  });

  it('includes decoratorText when includeDecoratorText is true (default)', async () => {
    const out = await search({ decoratorName: 'Controller' });
    for (const m of out.matches) {
      expect(m.decoratorText).toBeDefined();
      expect(m.decoratorText).toMatch(/@Controller/);
    }
  });

  it('omits decoratorText when includeDecoratorText is false', async () => {
    const out = await search({ decoratorName: 'Injectable', includeDecoratorText: false });
    for (const m of out.matches) {
      expect(m.decoratorText).toBeUndefined();
    }
  });

  it('decoratorText includes decorator arguments', async () => {
    const out = await search({ decoratorName: 'Entity' });
    const entityMatch = out.matches.find((m) => m.symbolName === 'UserEntity');
    expect(entityMatch).toBeDefined();
    expect(entityMatch?.decoratorText).toContain('users');
  });

  it('decoratorText for bare decorator has no parentheses (or just the name)', async () => {
    const out = await search({ decoratorName: 'Singleton' });
    for (const m of out.matches) {
      expect(m.decoratorText).toMatch(/@Singleton/);
    }
  });

  it('returns _meta with timing_ms and powered_by', async () => {
    const out = await search({ decoratorName: 'Get' });
    expect(out._meta).toBeDefined();
    expect(out._meta.timing_ms).toBeGreaterThanOrEqual(0);
    expect(out._meta.powered_by).toBe('PureContext MCP');
  });

  it('returns _tokenEstimate > 0 when results found', async () => {
    const out = await search({ decoratorName: 'Injectable' });
    expect(out.totalFound).toBeGreaterThan(0);
    expect(out._tokenEstimate).toBeGreaterThan(0);
  });

  it('returns filesSearched count', async () => {
    const out = await search({ decoratorName: 'Injectable' });
    expect(out.filesSearched).toBeGreaterThan(0);
  });

  it('returns decoratorQueried in response', async () => {
    const out = await search({ decoratorName: 'Column' });
    expect(out.decoratorQueried).toBe('Column');
  });
});

// ─── limit ────────────────────────────────────────────────────────────────────

describe('search_by_decorator — limit', () => {
  it('respects the limit parameter', async () => {
    const out = await search({ decoratorName: 'Column', matchMode: 'prefix', limit: 2 });
    expect(out.matches.length).toBeLessThanOrEqual(2);
  });

  it('sets truncated=true when limit is hit', async () => {
    // @Column appears on many properties — limit 1 should truncate
    const out = await search({ decoratorName: 'Column', matchMode: 'prefix', limit: 1 });
    expect(out.matches.length).toBe(1);
    expect(out.truncated).toBe(true);
  });

  it('sets truncated=false when all results fit within limit', async () => {
    // @Entity appears on exactly 2 classes
    const out = await search({ decoratorName: 'Entity', limit: 50 });
    expect(out.truncated).toBe(false);
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe('search_by_decorator — error handling', () => {
  it('returns error for unknown repoId', async () => {
    const result = await searchByDecoratorHandler({
      repoId: 'deadbeef00000000',
      decoratorName: 'Injectable',
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toContain('not found');
  });

  it('returns error for empty decoratorName', async () => {
    const result = await searchByDecoratorHandler({
      repoId,
      decoratorName: '',
    });
    expect(result.isError).toBe(true);
  });
});
