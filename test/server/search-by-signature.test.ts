/**
 * Tests for the search_by_signature tool (Task 192).
 *
 * Fixture: test/fixtures/search-by-signature-fixture/
 *   src/auth.ts          — async functions with Request/Response types, Promise returns
 *   src/user-service.ts  — class with async/sync methods
 *   src/models.ts        — interface, type alias, exported functions
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as searchBySignatureHandler } from '../../src/server/tools/search-by-signature.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/search-by-signature-fixture');

let repoId: string;

// ─── Types ────────────────────────────────────────────────────────────────────

interface SignatureSymbol {
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  signature: string;
  summary: string;
}

interface SearchBySignatureOutput {
  symbols: SignatureSymbol[];
  totalFound: number;
  patternUsed: string;
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
  pattern: string;
  mode?: 'contains' | 'startsWith' | 'regex';
  kind?: string;
  filePath?: string;
  limit?: number;
}): Promise<SearchBySignatureOutput> {
  const result = await searchBySignatureHandler({ repoId, ...args });
  expect(result.isError).toBeFalsy();
  const text = (result.content[0] as { type: string; text: string }).text;
  return JSON.parse(text) as SearchBySignatureOutput;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('search_by_signature — contains mode (default)', () => {
  it('finds symbols whose signature contains "Promise<void>"', async () => {
    const out = await search({ pattern: 'Promise<void>' });
    expect(out.symbols.length).toBeGreaterThan(0);
    for (const sym of out.symbols) {
      expect(sym.signature).toContain('Promise<void>');
    }
    const names = out.symbols.map((s) => s.name);
    expect(names).toContain('logout');
    // Methods are stored with their class prefix (e.g. UserService.createUser)
    expect(names.some((n) => n === 'createUser' || n === 'UserService.createUser')).toBe(true);
  });

  it('finds all async functions by matching "async"', async () => {
    const out = await search({ pattern: 'async' });
    expect(out.symbols.length).toBeGreaterThan(0);
    for (const sym of out.symbols) {
      expect(sym.signature.toLowerCase()).toContain('async');
    }
  });

  it('finds functions taking a Request parameter', async () => {
    const out = await search({ pattern: '(req: Request' });
    expect(out.symbols.length).toBeGreaterThan(0);
    const names = out.symbols.map((s) => s.name);
    expect(names).toContain('authenticate');
    expect(names).toContain('logout');
  });

  it('finds functions returning string[]', async () => {
    const out = await search({ pattern: ': string[]' });
    expect(out.symbols.length).toBeGreaterThan(0);
    const names = out.symbols.map((s) => s.name);
    expect(names).toContain('parseToken');
  });

  it('returns patternUsed in response', async () => {
    const out = await search({ pattern: 'Promise<' });
    expect(out.patternUsed).toBe('Promise<');
  });

  it('returns _tokenEstimate > 0 when results found', async () => {
    const out = await search({ pattern: 'Promise<' });
    expect(out.totalFound).toBeGreaterThan(0);
    expect(out._tokenEstimate).toBeGreaterThan(0);
  });

  it('returns empty array for a pattern that matches nothing', async () => {
    const out = await search({ pattern: 'XYZNONEXISTENTPATTERNQWERTY' });
    expect(out.symbols).toHaveLength(0);
    expect(out.totalFound).toBe(0);
  });
});

describe('search_by_signature — kind filter', () => {
  it('returns only method symbols when kind="method"', async () => {
    const out = await search({ pattern: 'Promise<', kind: 'method' });
    for (const sym of out.symbols) {
      expect(sym.kind).toBe('method');
    }
  });

  it('returns only function symbols when kind="function"', async () => {
    const out = await search({ pattern: 'Promise<', kind: 'function' });
    for (const sym of out.symbols) {
      expect(sym.kind).toBe('function');
    }
  });

  it('returns both functions and methods when no kind filter', async () => {
    const out = await search({ pattern: 'Promise<' });
    const kinds = new Set(out.symbols.map((s) => s.kind));
    expect(kinds.size).toBeGreaterThan(1);
  });
});

describe('search_by_signature — startsWith mode', () => {
  it('finds exported symbols with startsWith "export"', async () => {
    const out = await search({ pattern: 'export', mode: 'startsWith' });
    expect(out.symbols.length).toBeGreaterThan(0);
    for (const sym of out.symbols) {
      expect(sym.signature).toMatch(/^export/);
    }
  });

  it('finds async functions with startsWith "export async"', async () => {
    const out = await search({ pattern: 'export async', mode: 'startsWith' });
    expect(out.symbols.length).toBeGreaterThan(0);
    for (const sym of out.symbols) {
      expect(sym.signature).toMatch(/^export async/);
    }
  });
});

describe('search_by_signature — regex mode', () => {
  it('finds async functions with Request param via regex', async () => {
    const out = await search({ pattern: 'async.*Request', mode: 'regex' });
    expect(out.symbols.length).toBeGreaterThan(0);
    for (const sym of out.symbols) {
      expect(sym.signature).toMatch(/async.*Request/);
    }
  });

  it('finds functions returning Promise of any type via regex', async () => {
    const out = await search({ pattern: 'Promise<.+>', mode: 'regex' });
    expect(out.symbols.length).toBeGreaterThan(0);
    for (const sym of out.symbols) {
      expect(sym.signature).toMatch(/Promise<.+>/);
    }
  });

  it('returns an error for invalid regex', async () => {
    const result = await searchBySignatureHandler({
      repoId,
      pattern: '[invalid(regex',
      mode: 'regex',
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toContain('Invalid regular expression');
  });

  it('regex with anchors finds exact async keyword at word boundary', async () => {
    // \basync\b matches "async" as a whole word
    const out = await search({ pattern: '\\basync\\b', mode: 'regex' });
    expect(out.symbols.length).toBeGreaterThan(0);
    for (const sym of out.symbols) {
      expect(sym.signature).toMatch(/\basync\b/);
    }
  });
});

describe('search_by_signature — limit', () => {
  it('respects limit parameter', async () => {
    const out = await search({ pattern: 'export', limit: 2 });
    expect(out.symbols.length).toBeLessThanOrEqual(2);
  });

  it('default limit is 50', async () => {
    const out = await search({ pattern: '' });
    expect(out.symbols.length).toBeLessThanOrEqual(50);
  });
});

describe('search_by_signature — filePath filter', () => {
  it('restricts results to the specified file', async () => {
    const out = await search({ pattern: 'Promise<', filePath: 'src/auth.ts' });
    expect(out.symbols.length).toBeGreaterThan(0);
    for (const sym of out.symbols) {
      expect(sym.filePath).toBe('src/auth.ts');
    }
  });
});

describe('search_by_signature — output shape', () => {
  it('returns required fields on each symbol', async () => {
    const out = await search({ pattern: 'async' });
    for (const sym of out.symbols) {
      expect(sym).toHaveProperty('symbolId');
      expect(sym).toHaveProperty('name');
      expect(sym).toHaveProperty('kind');
      expect(sym).toHaveProperty('filePath');
      expect(sym).toHaveProperty('startLine');
      expect(sym).toHaveProperty('signature');
      expect(sym).toHaveProperty('summary');
      expect(typeof sym.startLine).toBe('number');
      expect(sym.startLine).toBeGreaterThanOrEqual(1);
    }
  });

  it('returns _meta with timing_ms', async () => {
    const out = await search({ pattern: 'async' });
    expect(out._meta).toBeDefined();
    expect(out._meta.timing_ms).toBeGreaterThanOrEqual(0);
    expect(out._meta.powered_by).toBe('PureContext MCP');
  });
});
