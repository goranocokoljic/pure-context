/**
 * Tests for src/server/tools/get-symbol-history.ts
 *
 * Strategy: mock all external dependencies (better-sqlite3, git-log-reader,
 * git-metadata-store, file-store) so tests never need a real git repo or DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoist mocks before any imports ──────────────────────────────────────────

const {
  mockOpenDatabase,
  mockGetRepo,
  mockGetSymbolById,
  mockGetFileContent,
  mockGetFileCommits,
  mockIsGitRepo,
  mockReadSymbolHistory,
} = vi.hoisted(() => ({
  mockOpenDatabase: vi.fn(),
  mockGetRepo: vi.fn(),
  mockGetSymbolById: vi.fn(),
  mockGetFileContent: vi.fn(),
  mockGetFileCommits: vi.fn(),
  mockIsGitRepo: vi.fn(),
  mockReadSymbolHistory: vi.fn(),
}));

vi.mock('../../src/core/db/schema.js', () => ({
  openDatabase: mockOpenDatabase,
  getRepo: mockGetRepo,
}));

vi.mock('../../src/core/db/symbol-store.js', () => ({
  getSymbolById: mockGetSymbolById,
}));

vi.mock('../../src/core/db/file-store.js', () => ({
  getFileContent: mockGetFileContent,
}));

vi.mock('../../src/core/db/git-metadata-store.js', () => ({
  getFileCommits: mockGetFileCommits,
}));

vi.mock('../../src/core/git-log-reader.js', () => ({
  isGitRepo: mockIsGitRepo,
  readSymbolHistory: mockReadSymbolHistory,
}));

import { handler } from '../../src/server/tools/get-symbol-history.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FAKE_REPO_ID = 'abc123def456abc1';
const FAKE_SYMBOL_ID = 'sym0001sym0001sy';

const FAKE_SYMBOL = {
  id: FAKE_SYMBOL_ID,
  name: 'processFile',
  kind: 'function' as const,
  filePath: 'src/core/file-processor.ts',
  startByte: 0,
  endByte: 300,
  signature: 'async function processFile(path: string): Promise<void>',
  summary: 'Processes a single file',
};

const FAKE_REPO = {
  id: FAKE_REPO_ID,
  rootPath: '/repo',
  clonePath: null,
  symbolCount: 100,
  fileCount: 10,
  languages: ['typescript'],
  indexedAt: Date.now(),
  schemaVersion: 1,
  tenantId: 'local',
};

// A Buffer with 10 newlines — byteOffsetToLine(buf, 0) = 1, byteOffsetToLine(buf, 300) = 11
const FAKE_CONTENT = Buffer.from('a\n'.repeat(150)); // 300 bytes, 150 newlines

const NOW_UNIX = Math.floor(Date.now() / 1000);

const COMMIT_A = {
  sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  authorName: 'Alice',
  authorEmail: 'alice@example.com',
  date: NOW_UNIX - 86400 * 10,  // 10 days ago
  message: 'feat: add processFile',
};

const COMMIT_B = {
  sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  authorName: 'Bob',
  authorEmail: 'bob@example.com',
  date: NOW_UNIX - 86400 * 5,   // 5 days ago
  message: 'fix: handle edge case in processFile',
};

// Shared fake DB object
const fakeDb = { close: vi.fn() };

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockOpenDatabase.mockReturnValue(fakeDb);
  mockGetRepo.mockReturnValue(FAKE_REPO);
  mockGetSymbolById.mockReturnValue(FAKE_SYMBOL);
  mockGetFileContent.mockReturnValue(FAKE_CONTENT);
  mockIsGitRepo.mockResolvedValue(true);
  mockReadSymbolHistory.mockResolvedValue({
    history: [COMMIT_B, COMMIT_A],
    firstSeen: COMMIT_A,
    totalCount: 2,
  });
  mockGetFileCommits.mockReturnValue([]);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('get_symbol_history handler', () => {
  it('returns commits touching the symbol line range', async () => {
    const result = await handler({ repoId: FAKE_REPO_ID, symbolId: FAKE_SYMBOL_ID });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content[0] as { text: string }).text);

    expect(data.symbol.name).toBe('processFile');
    expect(data.symbol.kind).toBe('function');
    expect(data.symbol.filePath).toBe('src/core/file-processor.ts');

    expect(data.history).toHaveLength(2);
    expect(data.history[0].sha).toBe(COMMIT_B.sha);
    expect(data.history[0].shortSha).toBe(COMMIT_B.sha.slice(0, 8));
    expect(data.history[0].author).toBe('Bob');
    expect(data.history[0].message).toBe('fix: handle edge case in processFile');
    expect(typeof data.history[0].daysAgo).toBe('number');
    expect(typeof data.history[0].date).toBe('string'); // ISO 8601
  });

  it('populates firstSeen with the oldest commit', async () => {
    const result = await handler({ repoId: FAKE_REPO_ID, symbolId: FAKE_SYMBOL_ID });
    const data = JSON.parse((result.content[0] as { text: string }).text);

    expect(data.firstSeen).not.toBeNull();
    expect(data.firstSeen.sha).toBe(COMMIT_A.sha);
    expect(data.firstSeen.author).toBe('Alice');
  });

  it('populates lastChanged with the newest commit', async () => {
    const result = await handler({ repoId: FAKE_REPO_ID, symbolId: FAKE_SYMBOL_ID });
    const data = JSON.parse((result.content[0] as { text: string }).text);

    expect(data.lastChanged.sha).toBe(COMMIT_B.sha);
  });

  it('calculates churnScore correctly', async () => {
    // totalCount=2, firstSeen 10 days ago → churnScore ≈ (2/10)*90 = 18
    const result = await handler({ repoId: FAKE_REPO_ID, symbolId: FAKE_SYMBOL_ID });
    const data = JSON.parse((result.content[0] as { text: string }).text);

    expect(data.churnScore).toBeGreaterThan(0);
    // Approximately 18, allow ±2 for timing
    expect(data.churnScore).toBeCloseTo(18, 0);
  });

  it('returns error when symbol not found', async () => {
    mockGetSymbolById.mockReturnValue(null);

    const result = await handler({ repoId: FAKE_REPO_ID, symbolId: 'nonexistent' });

    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.error).toMatch(/not found/i);
  });

  it('returns graceful empty response when not a git repo', async () => {
    mockIsGitRepo.mockResolvedValue(false);
    mockGetFileCommits.mockReturnValue([]); // no fallback data either

    const result = await handler({ repoId: FAKE_REPO_ID, symbolId: FAKE_SYMBOL_ID });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content[0] as { text: string }).text);

    expect(data.history).toHaveLength(0);
    expect(data.totalCommits).toBe(0);
    expect(data.firstSeen).toBeNull();
    expect(data.lastChanged).toBeNull();
    expect(data.churnScore).toBe(0);
    expect(data.note).toMatch(/no git history/i);
  });

  it('falls back to file-level history when git log -L returns nothing', async () => {
    mockReadSymbolHistory.mockResolvedValue({ history: [], firstSeen: null, totalCount: 0 });
    mockGetFileCommits.mockReturnValue([COMMIT_B, COMMIT_A]);

    const result = await handler({ repoId: FAKE_REPO_ID, symbolId: FAKE_SYMBOL_ID });
    const data = JSON.parse((result.content[0] as { text: string }).text);

    expect(data.history).toHaveLength(2);
    expect(data.note).toMatch(/file-level history/i);
  });

  it('respects the limit parameter', async () => {
    await handler({ repoId: FAKE_REPO_ID, symbolId: FAKE_SYMBOL_ID, limit: 25 });

    expect(mockReadSymbolHistory).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Number),
      expect.any(Number),
      25,
    );
  });

  it('includes totalCommits in response', async () => {
    mockReadSymbolHistory.mockResolvedValue({
      history: [COMMIT_B],
      firstSeen: COMMIT_A,
      totalCount: 42,
    });

    const result = await handler({ repoId: FAKE_REPO_ID, symbolId: FAKE_SYMBOL_ID });
    const data = JSON.parse((result.content[0] as { text: string }).text);

    expect(data.totalCommits).toBe(42);
  });

  it('includes _meta with timing', async () => {
    const result = await handler({ repoId: FAKE_REPO_ID, symbolId: FAKE_SYMBOL_ID });
    const data = JSON.parse((result.content[0] as { text: string }).text);

    expect(data._meta).toBeDefined();
    expect(typeof data._meta.timing_ms).toBe('number');
    expect(data._meta.powered_by).toBe('PureContext MCP');
  });
});

// ─── readSymbolHistory unit-level tests ───────────────────────────────────────
// (The git-log-reader function itself is tested via git-log-reader.test.ts;
//  here we verify the integration contract from the tool's perspective.)

describe('churnScore edge cases', () => {
  it('returns 0 when there is no firstSeen date', async () => {
    mockReadSymbolHistory.mockResolvedValue({
      history: [COMMIT_B],
      firstSeen: null,
      totalCount: 1,
    });

    const result = await handler({ repoId: FAKE_REPO_ID, symbolId: FAKE_SYMBOL_ID });
    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.churnScore).toBe(0);
  });

  it('handles brand-new symbol (firstSeen today)', async () => {
    const todayCommit = { ...COMMIT_B, date: NOW_UNIX - 10 }; // 10 seconds ago
    mockReadSymbolHistory.mockResolvedValue({
      history: [todayCommit],
      firstSeen: todayCommit,
      totalCount: 1,
    });

    const result = await handler({ repoId: FAKE_REPO_ID, symbolId: FAKE_SYMBOL_ID });
    const data = JSON.parse((result.content[0] as { text: string }).text);
    // Brand new → high churn score
    expect(data.churnScore).toBeGreaterThan(0);
  });
});
