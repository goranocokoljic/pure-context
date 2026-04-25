/**
 * Tool handler unit tests.
 *
 * Strategy: index the basic-ts-project fixture once in beforeAll,
 * then run all tool handlers against the resulting DB.
 * Tests are read-only after setup — no mutations to the index.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { computeRepoId } from '../../src/core/db/schema.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

import { handler as searchHandler } from '../../src/server/tools/search-symbols.js';
import { handler as fileOutlineHandler } from '../../src/server/tools/get-file-outline.js';
import { handler as repoOutlineHandler } from '../../src/server/tools/get-repo-outline.js';
import { handler as fileTreeHandler } from '../../src/server/tools/get-file-tree.js';
import { handler as symbolSourceHandler } from '../../src/server/tools/get-symbol-source.js';
import { handler as contextBundleHandler } from '../../src/server/tools/get-context-bundle.js';
import { handler as blastRadiusHandler } from '../../src/server/tools/get-blast-radius.js';
import { handler as findImportersHandler } from '../../src/server/tools/find-importers.js';
import { handler as deadCodeHandler } from '../../src/server/tools/find-dead-code.js';
import { handler as listReposHandler } from '../../src/server/tools/list-repos.js';
import { handler as resolveRepoHandler } from '../../src/server/tools/resolve-repo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

// ─── Setup ────────────────────────────────────────────────────────────────────

let repoId: string;

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  const result = await indexFolder(FIXTURE, { fileLimit: 50 });
  repoId = result.repoId;

  expect(result.symbolsFound).toBeGreaterThan(0);
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseResult(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

// ─── search_symbols ────────────────────────────────────────────────────────────

describe('search_symbols', () => {
  it('finds symbols by name fragment', async () => {
    const result = await searchHandler({ repoId, query: 'format' });
    const data = parseResult(result) as { symbols: { name: string }[] };
    expect(data.symbols.some((s) => s.name === 'formatDiagnostic')).toBe(true);
  });

  it('returns _meta with savings fields', async () => {
    const result = await searchHandler({ repoId, query: '' });
    const data = parseResult(result) as { _meta: { tokens_saved: number; total_tokens_saved: number } };
    expect(typeof data._meta.tokens_saved).toBe('number');
    expect(data._meta.tokens_saved).toBeGreaterThanOrEqual(0);
    expect(typeof data._meta.total_tokens_saved).toBe('number');
  });

  it('filters by kind', async () => {
    const result = await searchHandler({ repoId, query: '', kind: 'class' });
    const data = parseResult(result) as { symbols: { kind: string }[] };
    expect(data.symbols.every((s) => s.kind === 'class')).toBe(true);
  });

  it('filters by filePath', async () => {
    const result = await searchHandler({ repoId, query: '', filePath: 'src/utils.ts' });
    const data = parseResult(result) as { symbols: { filePath: string }[] };
    expect(data.symbols.every((s) => s.filePath === 'src/utils.ts')).toBe(true);
  });

  it('respects limit', async () => {
    const result = await searchHandler({ repoId, query: '', limit: 2 });
    const data = parseResult(result) as { symbols: unknown[] };
    expect(data.symbols.length).toBeLessThanOrEqual(2);
  });
});

// ─── get_file_outline ─────────────────────────────────────────────────────────

describe('get_file_outline', () => {
  it('returns all symbols in a file', () => {
    const result = fileOutlineHandler({ repoId, filePath: 'src/utils.ts' });
    const data = parseResult(result) as { symbols: { name: string }[] };
    expect(data.symbols.some((s) => s.name === 'formatDiagnostic')).toBe(true);
    expect(data.symbols.some((s) => s.name === 'filterBySeverity')).toBe(true);
  });

  it('returns empty for a file with no symbols', () => {
    const result = fileOutlineHandler({ repoId, filePath: 'nonexistent.ts' });
    const data = parseResult(result) as { symbols: unknown[] };
    expect(data.symbols).toHaveLength(0);
  });
});

// ─── get_repo_outline ────────────────────────────────────────────────────────

describe('get_repo_outline', () => {
  it('returns files with symbols', () => {
    const result = repoOutlineHandler({ repoId });
    const data = parseResult(result) as { files: { filePath: string }[]; totalSymbols: number };
    expect(data.files.length).toBeGreaterThan(0);
    expect(data.totalSymbols).toBeGreaterThan(0);
    expect(data.files.some((f) => f.filePath === 'src/utils.ts')).toBe(true);
  });

  it('includes _meta with timing and powered_by', () => {
    const result = repoOutlineHandler({ repoId });
    const data = parseResult(result) as { _meta: { timing_ms: number; powered_by: string } };
    expect(typeof data._meta.timing_ms).toBe('number');
    expect(data._meta.powered_by).toBe('PureContext MCP');
  });
});

// ─── get_file_tree ────────────────────────────────────────────────────────────

describe('get_file_tree', () => {
  it('returns a tree with correct file count', () => {
    const result = fileTreeHandler({ repoId });
    const data = parseResult(result) as { totalFiles: number; tree: Record<string, unknown> };
    expect(data.totalFiles).toBeGreaterThan(0);
    expect(typeof data.tree).toBe('object');
    expect(data.tree['src']).toBeDefined();
  });
});

// ─── get_symbol_source ────────────────────────────────────────────────────────

describe('get_symbol_source', () => {
  it('returns source code for a known symbol', async () => {
    // First find the symbol ID
    const search = await searchHandler({ repoId, query: 'formatDiagnostic' });
    const searchData = parseResult(search) as { symbols: { id: string }[] };
    const symbolId = searchData.symbols[0]?.id;
    expect(symbolId).toBeDefined();

    const result = symbolSourceHandler({ repoId, symbolId: symbolId! });
    const data = parseResult(result) as { symbol: { source: string; name: string } };
    expect(data.symbol.name).toBe('formatDiagnostic');
    expect(data.symbol.source).toContain('formatDiagnostic');
  });

  it('returns isError for unknown symbolId', () => {
    const result = symbolSourceHandler({ repoId, symbolId: 'does-not-exist' });
    expect(result.isError).toBe(true);
  });
});

// ─── get_context_bundle ──────────────────────────────────────────────────────

describe('get_context_bundle', () => {
  it('returns forward dependencies from a symbol', async () => {
    const search = await searchHandler({ repoId, query: 'DiagnosticRunner' });
    const searchData = parseResult(search) as { symbols: { id: string }[] };
    const symbolId = searchData.symbols[0]?.id;
    expect(symbolId).toBeDefined();

    const result = contextBundleHandler({ repoId, symbolId: symbolId! });
    const data = parseResult(result) as { files: string[]; _tokenEstimate: number };
    expect(data.files).toContain('src/index.ts');
    expect(data._tokenEstimate).toBeGreaterThanOrEqual(0);
  });
});

// ─── get_blast_radius ─────────────────────────────────────────────────────────

describe('get_blast_radius', () => {
  it('returns reverse dependencies', async () => {
    // formatDiagnostic is in utils.ts which is imported by index.ts
    const search = await searchHandler({ repoId, query: 'formatDiagnostic' });
    const searchData = parseResult(search) as { symbols: { id: string }[] };
    const symbolId = searchData.symbols[0]?.id;
    expect(symbolId).toBeDefined();

    const result = blastRadiusHandler({ repoId, symbolId: symbolId! });
    const data = parseResult(result) as { files: string[] };
    expect(data.files).toContain('src/utils.ts');
    expect(data.files).toContain('src/index.ts');
  });
});

// ─── find_importers ───────────────────────────────────────────────────────────

describe('find_importers', () => {
  it('finds files that import utils.ts', () => {
    const result = findImportersHandler({ repoId, filePath: 'src/utils.ts' });
    const data = parseResult(result) as { importers: { file: string }[] };
    expect(data.importers.some((i) => i.file === 'src/index.ts')).toBe(true);
  });

  it('returns empty for a file with no importers', () => {
    const result = findImportersHandler({ repoId, filePath: 'src/index.ts' });
    const data = parseResult(result) as { importers: unknown[] };
    expect(data.importers).toHaveLength(0);
  });
});

// ─── find_dead_code ───────────────────────────────────────────────────────────

describe('find_dead_code', () => {
  it('returns symbols from files with no importers', () => {
    const result = deadCodeHandler({ repoId });
    const data = parseResult(result) as { files: { filePath: string }[] };
    // src/index.ts is never imported — it's an entry point
    expect(data.files.some((f) => f.filePath === 'src/index.ts')).toBe(true);
  });

  it('does not include utils.ts (it is imported by index.ts)', () => {
    const result = deadCodeHandler({ repoId });
    const data = parseResult(result) as { files: { filePath: string }[] };
    expect(data.files.every((f) => f.filePath !== 'src/utils.ts')).toBe(true);
  });
});

// ─── list_repos ───────────────────────────────────────────────────────────────

describe('list_repos', () => {
  it('includes the fixture repo in the list', () => {
    const result = listReposHandler();
    const data = parseResult(result) as { repos: { id: string }[] };
    expect(data.repos.some((r) => r.id === repoId)).toBe(true);
  });
});

// ─── resolve_repo ─────────────────────────────────────────────────────────────

describe('resolve_repo', () => {
  it('resolves an indexed path', () => {
    const result = resolveRepoHandler({ path: FIXTURE });
    const data = parseResult(result) as { id: string; indexed: boolean };
    expect(data.id).toBe(repoId);
    expect(data.indexed).toBe(true);
  });

  it('returns indexed:false for un-indexed path', () => {
    const result = resolveRepoHandler({ path: '/tmp/definitely-not-indexed-abc123' });
    const data = parseResult(result) as { indexed: boolean; hint: string };
    expect(data.indexed).toBe(false);
    expect(data.hint).toContain('index_folder');
  });
});
