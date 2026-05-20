/**
 * Tests for search_symbols cfgFilter parameter (Task 283).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../../src/handlers/handler-registry.js';
import { rustHandler } from '../../../src/handlers/rust.js';
import { typescriptHandler, tsxHandler } from '../../../src/handlers/typescript.js';
import { javascriptHandler } from '../../../src/handlers/javascript.js';
import { initParser } from '../../../src/core/parse-dispatcher.js';
import { handler as searchHandler } from '../../../src/server/tools/search-symbols.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../../fixtures/rust-project');

let repoId: string;

beforeAll(async () => {
  _resetForTesting();
  registerHandler(rustHandler);
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

function parseResult(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('search_symbols cfgFilter', () => {
  it('returns only linux-gated symbols when cfgFilter = target_os = "linux"', async () => {
    const result = await searchHandler({
      repoId,
      query: 'send',
      mode: 'keyword',
      cfgFilter: 'target_os = "linux"',
    });
    const data = parseResult(result);
    const symbols = data['symbols'] as Array<{ name: string }>;
    // linux_send should be present, windows_send should not
    expect(symbols.some((s) => s.name === 'linux_send')).toBe(true);
    expect(symbols.every((s) => s.name !== 'windows_send')).toBe(true);
  });

  it('returns only windows-gated symbols when cfgFilter = target_os = "windows"', async () => {
    const result = await searchHandler({
      repoId,
      query: 'send',
      mode: 'keyword',
      cfgFilter: 'target_os = "windows"',
    });
    const data = parseResult(result);
    const symbols = data['symbols'] as Array<{ name: string }>;
    expect(symbols.some((s) => s.name === 'windows_send')).toBe(true);
    expect(symbols.every((s) => s.name !== 'linux_send')).toBe(true);
  });

  it('returns only feature="io" symbols with cfgFilter object form', async () => {
    const result = await searchHandler({
      repoId,
      query: 'IoStream',
      mode: 'keyword',
      cfgFilter: { kind: 'eq', key: 'feature', value: 'io' },
    });
    const data = parseResult(result);
    const symbols = data['symbols'] as Array<{ name: string }>;
    expect(symbols.some((s) => s.name === 'IoStream')).toBe(true);
  });

  it('ignores cfgFilter when no symbols have cfg metadata (TS repo)', async () => {
    // Index a TS project that has no cfg metadata
    const tsFixture = resolve(__dirname, '../../fixtures/basic-ts-project');
    registerHandler(typescriptHandler);
    const tsResult = await indexFolder(tsFixture, { fileLimit: 50 });
    const tsRepoId = tsResult.repoId;

    try {
      const result = await searchHandler({
        repoId: tsRepoId,
        query: 'function',
        mode: 'keyword',
        cfgFilter: 'target_os = "linux"',
      });
      const data = parseResult(result);
      // Should return unfiltered results (cfgFilter silently ignored)
      const symbols = data['symbols'] as unknown[];
      expect(symbols.length).toBeGreaterThan(0);
      // Should include a diagnostic
      expect(data['_diagnostics']).toBeDefined();
      const diag = data['_diagnostics'] as string[];
      expect(diag[0]).toContain('cfgFilter ignored');
    } finally {
      deleteIndex(tsRepoId);
    }
  }, 30_000);
});
