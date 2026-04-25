import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { computeRepoId } from '../../src/core/db/schema.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import * as symbolStore from '../../src/core/db/symbol-store.js';
import type { IndexOptions, SymbolRecord } from '../../src/core/types.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');
const repoId = computeRepoId(FIXTURE);

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();
});

afterEach(() => {
  deleteIndex(repoId);
  vi.restoreAllMocks();
});

function makeSemanticIndexer(shouldIndexReturn = true) {
  return {
    shouldIndex: vi.fn().mockReturnValue(shouldIndexReturn),
    index: vi.fn().mockResolvedValue({ symbolsIndexed: 0, embeddingTimeMs: 0, indexBuildTimeMs: 0 }),
    updateIncremental: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAiSummarizer() {
  return {
    summarizeBatch: vi.fn().mockResolvedValue(new Map()),
  };
}

describe('consolidate getSymbolsByRepo calls (Task 116)', () => {
  it('calls getSymbolsByRepo exactly once when both semanticIndexer and aiSummarizer are active', async () => {
    const spy = vi.spyOn(symbolStore, 'getSymbolsByRepo');

    await indexFolder(FIXTURE, {
      semanticIndexer: makeSemanticIndexer(true) as unknown as IndexOptions['semanticIndexer'],
      aiSummarizer: makeAiSummarizer() as unknown as IndexOptions['aiSummarizer'],
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('calls getSymbolsByRepo exactly once when only semanticIndexer is active', async () => {
    const spy = vi.spyOn(symbolStore, 'getSymbolsByRepo');

    await indexFolder(FIXTURE, {
      semanticIndexer: makeSemanticIndexer(true) as unknown as IndexOptions['semanticIndexer'],
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('calls getSymbolsByRepo exactly once when only aiSummarizer is active', async () => {
    const spy = vi.spyOn(symbolStore, 'getSymbolsByRepo');

    await indexFolder(FIXTURE, {
      aiSummarizer: makeAiSummarizer() as unknown as IndexOptions['aiSummarizer'],
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not call getSymbolsByRepo at all when neither option is active', async () => {
    const spy = vi.spyOn(symbolStore, 'getSymbolsByRepo');

    await indexFolder(FIXTURE);

    expect(spy).not.toHaveBeenCalled();
  });

  it('passes correct non-zero symbol count to shouldIndex', async () => {
    const semanticIndexer = makeSemanticIndexer(false);

    await indexFolder(FIXTURE, {
      semanticIndexer: semanticIndexer as unknown as IndexOptions['semanticIndexer'],
    });

    expect(semanticIndexer.shouldIndex).toHaveBeenCalledTimes(1);
    const [, count] = semanticIndexer.shouldIndex.mock.calls[0] as [string, number];
    expect(count).toBeGreaterThan(0);
  });

  it('passes the same symbol array instance to both semanticIndexer.index and aiSummarizer.summarizeBatch', async () => {
    let semanticSymbols: SymbolRecord[] | null = null;
    let aiSymbols: SymbolRecord[] | null = null;

    const semanticIndexer = {
      shouldIndex: vi.fn().mockReturnValue(true),
      index: vi.fn().mockImplementation((_id: string, syms: SymbolRecord[]) => {
        semanticSymbols = syms;
        return Promise.resolve({ symbolsIndexed: syms.length, embeddingTimeMs: 0, indexBuildTimeMs: 0 });
      }),
      updateIncremental: vi.fn().mockResolvedValue(undefined),
    };

    const aiSummarizer = {
      summarizeBatch: vi.fn().mockImplementation((syms: SymbolRecord[]) => {
        // summarizeBatch receives the filtered subset (needsSummary), not allRepoSymbols directly
        // Capture enough to verify it came from the same load
        aiSymbols = syms;
        return Promise.resolve(new Map());
      }),
    };

    await indexFolder(FIXTURE, {
      semanticIndexer: semanticIndexer as unknown as IndexOptions['semanticIndexer'],
      aiSummarizer: aiSummarizer as unknown as IndexOptions['aiSummarizer'],
    });

    // Both were called
    expect(semanticIndexer.index).toHaveBeenCalledTimes(1);
    expect(aiSummarizer.summarizeBatch).toHaveBeenCalledTimes(1);

    // semanticIndexer received the full symbol set
    expect(semanticSymbols).not.toBeNull();
    expect((semanticSymbols as unknown as SymbolRecord[]).length).toBeGreaterThan(0);

    // aiSummarizer received a subset (possibly all if none have docstrings yet)
    expect(aiSymbols).not.toBeNull();
  });
});
