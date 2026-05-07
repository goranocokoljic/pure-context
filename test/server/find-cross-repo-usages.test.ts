/**
 * Tests for find_cross_repo_usages tool (Task 152 — Cross-Repo Dependency Tracking).
 *
 * Strategy: mock openDatabase, resolveRepoScope, and getAllFilesWithContent so the
 * handler runs without I/O while exercising all branching logic.
 *
 * Scenarios:
 *  - Symbol found in a target repo file
 *  - Source repo excluded from search results
 *  - targetRepoIds scope filter respected
 *  - Common name with kind filter reduces false positives (symbol not found in source → error)
 *  - Symbol not found in source repo → error
 *  - Symbol not found in any target repo → empty usages, usageCount: 0
 *  - Import specifier extracted when line contains from/require
 *  - limit cap honoured
 *  - _meta present in response
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPrepare = vi.fn();
const mockClose = vi.fn();

vi.mock('../../src/core/db/schema.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/db/schema.js')>();
  return {
    ...real,
    openDatabase: vi.fn(),
    getRepo: vi.fn(),
  };
});

vi.mock('../../src/core/db/repo-scope.js', () => ({
  resolveRepoScope: vi.fn(),
}));

vi.mock('../../src/core/db/file-store.js', () => ({
  getAllFilesWithContent: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { handler } from '../../src/server/tools/find-cross-repo-usages.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { resolveRepoScope } from '../../src/core/db/repo-scope.js';
import { getAllFilesWithContent } from '../../src/core/db/file-store.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SOURCE_REPO = 'source-repo-id';
const TARGET_A = 'target-repo-a';
const TARGET_B = 'target-repo-b';

function makeFakeDb(symbolCount: number): Partial<Database> {
  return {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue({ cnt: symbolCount }),
    }),
    close: vi.fn(),
  } as unknown as Partial<Database>;
}

function makeTargetDb(): Partial<Database> {
  return {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue({ cnt: 0 }),
    }),
    close: vi.fn(),
  } as unknown as Partial<Database>;
}

function fileEntry(path: string, content: string) {
  return { path, rawContent: Buffer.from(content, 'utf8') };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('find_cross_repo_usages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns usages when symbol found in a target repo file', () => {
    vi.mocked(openDatabase)
      .mockReturnValueOnce(makeFakeDb(1) as Database)   // source repo lookup
      .mockReturnValueOnce(makeTargetDb() as Database); // target repo files

    vi.mocked(resolveRepoScope).mockReturnValue([
      { id: TARGET_A, name: 'target-a' },
    ]);
    vi.mocked(getAllFilesWithContent).mockReturnValue([
      fileEntry('src/app.ts', "import { parseConfig } from 'my-lib';\nparseConfig(opts);"),
    ]);

    const result = handler({ sourceRepoId: SOURCE_REPO, symbolName: 'parseConfig' });
    const body = JSON.parse((result.content[0] as { type: string; text: string }).text);

    expect(body.symbol).toBe('parseConfig');
    expect(body.usageCount).toBeGreaterThan(0);
    expect(body.usages[0]).toMatchObject({
      targetRepoId: TARGET_A,
      targetRepoName: 'target-a',
      filePath: 'src/app.ts',
    });
    expect(body._meta).toBeDefined();
  });

  it('excludes the source repo from results', () => {
    vi.mocked(openDatabase).mockReturnValueOnce(makeFakeDb(1) as Database);

    // resolveRepoScope returns both source and another repo — source must be filtered
    vi.mocked(resolveRepoScope).mockReturnValue([
      { id: SOURCE_REPO, name: 'source' },
      { id: TARGET_A, name: 'target-a' },
    ]);
    vi.mocked(getAllFilesWithContent).mockReturnValue([
      fileEntry('main.ts', 'parseConfig();'),
    ]);
    vi.mocked(openDatabase).mockReturnValue(makeTargetDb() as Database);

    const result = handler({ sourceRepoId: SOURCE_REPO, symbolName: 'parseConfig' });
    const body = JSON.parse((result.content[0] as { type: string; text: string }).text);

    const sourceUsages = body.usages.filter(
      (u: { targetRepoId: string }) => u.targetRepoId === SOURCE_REPO,
    );
    expect(sourceUsages).toHaveLength(0);
  });

  it('respects targetRepoIds scope filter', () => {
    vi.mocked(openDatabase).mockReturnValueOnce(makeFakeDb(1) as Database);
    vi.mocked(resolveRepoScope).mockReturnValue([{ id: TARGET_A, name: 'target-a' }]);
    vi.mocked(getAllFilesWithContent).mockReturnValue([]);
    vi.mocked(openDatabase).mockReturnValue(makeTargetDb() as Database);

    handler({ sourceRepoId: SOURCE_REPO, symbolName: 'parseConfig', targetRepoIds: [TARGET_A] });

    // resolveRepoScope should have been called with repoIds
    expect(resolveRepoScope).toHaveBeenCalledWith({ repoIds: [TARGET_A] });
  });

  it('throws an error when symbol not found in source repo', () => {
    vi.mocked(openDatabase).mockReturnValueOnce(makeFakeDb(0) as Database);
    vi.mocked(resolveRepoScope).mockReturnValue([]);

    expect(() =>
      handler({ sourceRepoId: SOURCE_REPO, symbolName: 'unknownFn' }),
    ).toThrow(/not found in source repo/);
  });

  it('returns empty usages when symbol absent from all target repos', () => {
    vi.mocked(openDatabase).mockReturnValueOnce(makeFakeDb(1) as Database);
    vi.mocked(resolveRepoScope).mockReturnValue([{ id: TARGET_A, name: 'target-a' }]);
    vi.mocked(getAllFilesWithContent).mockReturnValue([
      fileEntry('utils.ts', 'function unrelated() {}'),
    ]);
    vi.mocked(openDatabase).mockReturnValue(makeTargetDb() as Database);

    const result = handler({ sourceRepoId: SOURCE_REPO, symbolName: 'parseConfig' });
    const body = JSON.parse((result.content[0] as { type: string; text: string }).text);

    expect(body.usageCount).toBe(0);
    expect(body.usages).toHaveLength(0);
    expect(body.reposWithUsages).toBe(0);
  });

  it('extracts importPath from import-statement lines', () => {
    vi.mocked(openDatabase)
      .mockReturnValueOnce(makeFakeDb(1) as Database)
      .mockReturnValue(makeTargetDb() as Database);
    vi.mocked(resolveRepoScope).mockReturnValue([{ id: TARGET_A, name: 'target-a' }]);
    vi.mocked(getAllFilesWithContent).mockReturnValue([
      fileEntry('index.ts', "import { parseConfig } from 'my-shared-lib';"),
    ]);

    const result = handler({ sourceRepoId: SOURCE_REPO, symbolName: 'parseConfig' });
    const body = JSON.parse((result.content[0] as { type: string; text: string }).text);

    expect(body.usages[0].importPath).toBe('my-shared-lib');
  });

  it('honours the limit cap', () => {
    vi.mocked(openDatabase)
      .mockReturnValueOnce(makeFakeDb(1) as Database)
      .mockReturnValue(makeTargetDb() as Database);
    vi.mocked(resolveRepoScope).mockReturnValue([
      { id: TARGET_A, name: 'target-a' },
      { id: TARGET_B, name: 'target-b' },
    ]);
    // 10 matching lines in each file
    const manyLines = Array.from({ length: 10 }, (_, i) => `parseConfig(opt${i});`).join('\n');
    vi.mocked(getAllFilesWithContent).mockReturnValue([fileEntry('big.ts', manyLines)]);

    const result = handler({ sourceRepoId: SOURCE_REPO, symbolName: 'parseConfig', limit: 5 });
    const body = JSON.parse((result.content[0] as { type: string; text: string }).text);

    expect(body.usages.length).toBeLessThanOrEqual(5);
  });

  it('searches all repos (excluding source) when targetRepoIds omitted', () => {
    vi.mocked(openDatabase).mockReturnValueOnce(makeFakeDb(1) as Database);
    vi.mocked(resolveRepoScope).mockReturnValue([]);
    vi.mocked(openDatabase).mockReturnValue(makeTargetDb() as Database);

    handler({ sourceRepoId: SOURCE_REPO, symbolName: 'parseConfig' });

    // resolveRepoScope should be called with empty object (no repoIds)
    expect(resolveRepoScope).toHaveBeenCalledWith({});
  });

  it('reports reposWithUsages correctly across multiple repos', () => {
    vi.mocked(openDatabase)
      .mockReturnValueOnce(makeFakeDb(1) as Database)
      .mockReturnValue(makeTargetDb() as Database);
    vi.mocked(resolveRepoScope).mockReturnValue([
      { id: TARGET_A, name: 'target-a' },
      { id: TARGET_B, name: 'target-b' },
    ]);
    vi.mocked(getAllFilesWithContent).mockReturnValue([
      fileEntry('src/main.ts', 'parseConfig();'),
    ]);

    const result = handler({ sourceRepoId: SOURCE_REPO, symbolName: 'parseConfig' });
    const body = JSON.parse((result.content[0] as { type: string; text: string }).text);

    expect(body.reposWithUsages).toBe(2);
  });
});
