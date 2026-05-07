/**
 * Tests for MCP Resources Exposure (Task 153 — Phase 23).
 *
 * Resources tested:
 *  - purecontext://repos              → readReposResource
 *  - purecontext://repos/{id}/outline → readRepoOutlineResource
 *  - purecontext://repos/{id}/files/{path} → readFileOutlineResource
 *  - purecontext://repos/{id}/symbols/{sym} → readSymbolSourceResource
 *
 * Strategy: mock DB helpers so tests run without real I/O, then verify
 * each handler builds the correct ReadResourceResult shape.
 *
 * Watcher notification: createResourceNotifier is tested by asserting that
 * sendResourceUpdated is called for repo outline + per-file URIs + repo list.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockClose = vi.fn();
const mockDb = { close: mockClose } as never;

vi.mock('../../src/core/db/schema.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/db/schema.js')>();
  return {
    ...real,
    getIndexDir: vi.fn(() => '/mock/index'),
    openDatabase: vi.fn(() => mockDb),
    getRepo: vi.fn(),
  };
});

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return {
    ...real,
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn(() => ['abc123.db', 'def456.db']),
  };
});

vi.mock('../../src/core/db/symbol-store.js', () => ({
  getSymbolsByRepo: vi.fn(),
  getSymbolsByFile: vi.fn(),
  getSymbolById: vi.fn(),
}));

vi.mock('../../src/core/db/file-store.js', () => ({
  getFileContent: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  readReposResource,
  readRepoOutlineResource,
  readFileOutlineResource,
  readSymbolSourceResource,
} from '../../src/server/resources.js';
import { createResourceNotifier } from '../../src/server/mcp-server.js';
import { getRepo, openDatabase } from '../../src/core/db/schema.js';
import { getSymbolsByRepo, getSymbolsByFile, getSymbolById } from '../../src/core/db/symbol-store.js';
import { getFileContent } from '../../src/core/db/file-store.js';
import { existsSync, readdirSync } from 'fs';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const REPO_ID = 'abc123def456';

const MOCK_REPO = {
  id: REPO_ID,
  rootPath: '/projects/myapp',
  symbolCount: 42,
  fileCount: 10,
  languages: ['typescript'],
  indexedAt: 1714000000,
  schemaVersion: 1,
  clonePath: null,
  tenantId: 'local',
};

const MOCK_SYMBOL = {
  id: 'sym001',
  name: 'authenticate',
  kind: 'function' as const,
  filePath: 'src/auth.ts',
  startByte: 100,
  endByte: 200,
  signature: 'function authenticate(token: string): boolean',
  summary: 'Validates a JWT token',
};

// ─── readReposResource ────────────────────────────────────────────────────────

describe('readReposResource', () => {
  beforeEach(() => {
    vi.mocked(getRepo).mockImplementation((_db, repoId) => {
      if (repoId === 'abc123') return { ...MOCK_REPO, id: 'abc123' };
      if (repoId === 'def456') return { ...MOCK_REPO, id: 'def456' };
      return null;
    });
  });

  it('returns all repos from the index directory', () => {
    const result = readReposResource('purecontext://repos');
    expect(result.contents).toHaveLength(1);
    const text = result.contents[0]!.text as string;
    const data = JSON.parse(text) as { repos: { id: string }[] };
    expect(data.repos).toHaveLength(2);
    expect(data.repos.map((r) => r.id)).toContain('abc123');
    expect(data.repos.map((r) => r.id)).toContain('def456');
  });

  it('returns correct mimeType', () => {
    const result = readReposResource('purecontext://repos');
    expect(result.contents[0]!.mimeType).toBe('application/json');
  });

  it('returns empty repo list when index directory does not exist', () => {
    vi.mocked(existsSync).mockReturnValueOnce(false);
    const result = readReposResource('purecontext://repos');
    const data = JSON.parse(result.contents[0]!.text as string) as { repos: unknown[] };
    expect(data.repos).toHaveLength(0);
  });

  it('skips repos where getRepo returns null', () => {
    vi.mocked(getRepo).mockReturnValue(null);
    const result = readReposResource('purecontext://repos');
    const data = JSON.parse(result.contents[0]!.text as string) as { repos: unknown[] };
    expect(data.repos).toHaveLength(0);
  });

  it('preserves the uri in contents', () => {
    const result = readReposResource('purecontext://repos');
    expect(result.contents[0]!.uri).toBe('purecontext://repos');
  });
});

// ─── readRepoOutlineResource ──────────────────────────────────────────────────

describe('readRepoOutlineResource', () => {
  beforeEach(() => {
    vi.mocked(getSymbolsByRepo).mockReturnValue([
      { ...MOCK_SYMBOL, kind: 'function' },
      { ...MOCK_SYMBOL, id: 'sym002', name: 'MyClass', kind: 'class', filePath: 'src/models.ts' },
      { ...MOCK_SYMBOL, id: 'sym003', name: 'render', kind: 'method', filePath: 'src/models.ts' },
    ]);
  });

  it('returns a JSON outline grouped by file', () => {
    const result = readRepoOutlineResource(`purecontext://repos/${REPO_ID}/outline`, REPO_ID);
    const text = result.contents[0]!.text as string;
    const data = JSON.parse(text) as { repoId: string; fileCount: number; files: { filePath: string; symbols: { name: string }[] }[] };
    expect(data.repoId).toBe(REPO_ID);
    expect(data.fileCount).toBe(2);
    const authFile = data.files.find((f) => f.filePath === 'src/auth.ts');
    expect(authFile?.symbols[0]?.name).toBe('authenticate');
  });

  it('excludes method-kind symbols', () => {
    const result = readRepoOutlineResource(`purecontext://repos/${REPO_ID}/outline`, REPO_ID);
    const data = JSON.parse(result.contents[0]!.text as string) as { files: { symbols: { name: string }[] }[] };
    const allNames = data.files.flatMap((f) => f.symbols.map((s) => s.name));
    expect(allNames).not.toContain('render');
  });

  it('returns correct mimeType', () => {
    const result = readRepoOutlineResource(`purecontext://repos/${REPO_ID}/outline`, REPO_ID);
    expect(result.contents[0]!.mimeType).toBe('application/json');
  });

  it('closes the database', () => {
    readRepoOutlineResource(`purecontext://repos/${REPO_ID}/outline`, REPO_ID);
    expect(mockClose).toHaveBeenCalled();
  });
});

// ─── readFileOutlineResource ──────────────────────────────────────────────────

describe('readFileOutlineResource', () => {
  beforeEach(() => {
    vi.mocked(getSymbolsByFile).mockReturnValue([MOCK_SYMBOL]);
  });

  it('returns symbols for the given file', () => {
    const result = readFileOutlineResource(
      `purecontext://repos/${REPO_ID}/files/src%2Fauth.ts`,
      REPO_ID,
      'src/auth.ts',
    );
    const data = JSON.parse(result.contents[0]!.text as string) as {
      filePath: string;
      count: number;
      symbols: { name: string }[];
    };
    expect(data.filePath).toBe('src/auth.ts');
    expect(data.count).toBe(1);
    expect(data.symbols[0]!.name).toBe('authenticate');
  });

  it('returns an empty symbols array when no symbols found', () => {
    vi.mocked(getSymbolsByFile).mockReturnValue([]);
    const result = readFileOutlineResource(
      `purecontext://repos/${REPO_ID}/files/src%2Fempty.ts`,
      REPO_ID,
      'src/empty.ts',
    );
    const data = JSON.parse(result.contents[0]!.text as string) as { count: number };
    expect(data.count).toBe(0);
  });

  it('returns correct mimeType', () => {
    const result = readFileOutlineResource(
      `purecontext://repos/${REPO_ID}/files/src%2Fauth.ts`,
      REPO_ID,
      'src/auth.ts',
    );
    expect(result.contents[0]!.mimeType).toBe('application/json');
  });
});

// ─── readSymbolSourceResource ─────────────────────────────────────────────────

describe('readSymbolSourceResource', () => {
  const RAW_CONTENT = Buffer.from('x'.repeat(50) + 'function authenticate(token: string): boolean { return true; }' + 'y'.repeat(50));

  beforeEach(() => {
    vi.mocked(getSymbolById).mockReturnValue(MOCK_SYMBOL);
    // startByte=100, endByte=200 — slice those bytes from RAW_CONTENT
    vi.mocked(getFileContent).mockReturnValue(RAW_CONTENT);
  });

  it('returns the symbol source as plain text', () => {
    const result = readSymbolSourceResource(
      `purecontext://repos/${REPO_ID}/symbols/sym001`,
      REPO_ID,
      'sym001',
    );
    expect(result.contents[0]!.mimeType).toBe('text/plain');
    // Should contain the bytes [100, 200) of RAW_CONTENT
    const expected = RAW_CONTENT.slice(100, 200).toString('utf8');
    expect(result.contents[0]!.text).toBe(expected);
  });

  it('throws when symbol is not found', () => {
    vi.mocked(getSymbolById).mockReturnValue(null);
    expect(() =>
      readSymbolSourceResource(
        `purecontext://repos/${REPO_ID}/symbols/missing`,
        REPO_ID,
        'missing',
      ),
    ).toThrow('not found');
  });

  it('throws when file content is not cached', () => {
    vi.mocked(getFileContent).mockReturnValue(null);
    expect(() =>
      readSymbolSourceResource(
        `purecontext://repos/${REPO_ID}/symbols/sym001`,
        REPO_ID,
        'sym001',
      ),
    ).toThrow('not cached');
  });

  it('returns correct uri in contents', () => {
    const uri = `purecontext://repos/${REPO_ID}/symbols/sym001`;
    const result = readSymbolSourceResource(uri, REPO_ID, 'sym001');
    expect(result.contents[0]!.uri).toBe(uri);
  });
});

// ─── createResourceNotifier ───────────────────────────────────────────────────

describe('createResourceNotifier', () => {
  it('sends resource-updated notifications for outline, files, and repo list', async () => {
    const sendResourceUpdated = vi.fn().mockResolvedValue(undefined);
    const fakeServer = {
      server: { sendResourceUpdated },
    } as never;

    const notifier = createResourceNotifier(fakeServer);
    notifier('myrepo', ['src/auth.ts', 'src/models.ts'], ['src/old.ts']);

    // Allow microtasks to flush
    await new Promise((r) => setTimeout(r, 0));

    const calledUris = sendResourceUpdated.mock.calls.map((c: [{ uri: string }]) => c[0].uri);

    // Repo outline should be notified
    expect(calledUris).toContain('purecontext://repos/myrepo/outline');

    // Each changed/deleted file should be notified
    expect(calledUris).toContain(`purecontext://repos/myrepo/files/${encodeURIComponent('src/auth.ts')}`);
    expect(calledUris).toContain(`purecontext://repos/myrepo/files/${encodeURIComponent('src/models.ts')}`);
    expect(calledUris).toContain(`purecontext://repos/myrepo/files/${encodeURIComponent('src/old.ts')}`);

    // Repo list should be notified
    expect(calledUris).toContain('purecontext://repos');
  });

  it('handles empty change lists without error', async () => {
    const sendResourceUpdated = vi.fn().mockResolvedValue(undefined);
    const fakeServer = { server: { sendResourceUpdated } } as never;

    const notifier = createResourceNotifier(fakeServer);
    expect(() => notifier('myrepo', [], [])).not.toThrow();

    await new Promise((r) => setTimeout(r, 0));

    // Still notifies outline and repo list even with no file changes
    const calledUris = sendResourceUpdated.mock.calls.map((c: [{ uri: string }]) => c[0].uri);
    expect(calledUris).toContain('purecontext://repos/myrepo/outline');
    expect(calledUris).toContain('purecontext://repos');
  });
});
