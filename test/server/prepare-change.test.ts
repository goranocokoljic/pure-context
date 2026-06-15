/**
 * prepare-change.test.ts — Phase 79 Group A
 *
 * Integration tests for the pre-edit orchestrator. Uses a real temp SQLite DB
 * for synthesis (co-change, coverage), and mocks search_symbols / find_references
 * so target resolution (ready / ambiguous_target / no_target) is deterministic.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { mkdirSync } from 'fs';

const tmpHome = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  return path.join(os.tmpdir(), `purecontext-prepare-change-${Math.random().toString(36).slice(2)}`);
});

vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => tmpHome };
});

// Deterministic target resolution. Mock fns created via vi.hoisted so they are
// initialized before the (hoisted) vi.mock factories reference them.
const { searchMock, findRefsMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
  findRefsMock: vi.fn(() => ({ content: [{ type: 'text', text: JSON.stringify({ references: [] }) }] })),
}));
vi.mock('../../src/server/tools/search-symbols.js', () => ({ handler: searchMock }));
vi.mock('../../src/server/tools/find-references.js', () => ({ handler: findRefsMock }));

import { openDatabase, computeRepoId } from '../../src/core/db/schema.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import { upsertFile } from '../../src/core/db/file-store.js';
import { insertCommitFiles } from '../../src/core/db/co-change-store.js';
import { handler } from '../../src/server/tools/prepare-change.js';
import type { RepoCommit } from '../../src/core/git-log-reader.js';

const REPO_ROOT = join(tmpHome, 'repo');
const REPO_ID = computeRepoId(REPO_ROOT);
const NOW = Math.floor(Date.now() / 1000);

function searchResult(symbols: Array<{ id: string; name: string; kind: string; filePath: string; score: number }>) {
  return { content: [{ type: 'text', text: JSON.stringify({ count: symbols.length, symbols }) }] };
}

function parse(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0]!.text!);
}

beforeAll(() => {
  mkdirSync(join(tmpHome, 'indexes'), { recursive: true });
  const db = openDatabase(REPO_ID);
  db.prepare(`INSERT OR IGNORE INTO repos (id, root_path, indexed_at, schema_version) VALUES (?, ?, ?, 8)`)
    .run(REPO_ID, REPO_ROOT, Date.now());

  upsertFile(db, REPO_ID, 'src/a.ts', 'h', Buffer.from('export function alpha() { return 1; }'));
  upsertFile(db, REPO_ID, 'src/shared.ts', 'h', Buffer.from('export function shared() { return 3; }'));
  insertSymbols(db, REPO_ID, [
    { id: 'sym-alpha', name: 'alpha', kind: 'function', filePath: 'src/a.ts', startByte: 0, endByte: 36, signature: 'function alpha()', summary: '' },
  ]);
  // alpha untested → coverage gap.
  db.prepare(
    `INSERT OR REPLACE INTO provider_metadata (repo_id, provider_name, entity_key, metadata, updated_at)
     VALUES (?, 'test-mapper', ?, ?, ?)`,
  ).run(REPO_ID, 'sym-alpha', JSON.stringify({ testFiles: [], testSymbolIds: [], coverageStatus: 'untested' }), NOW);

  // Rich co-change: src/a.ts moves with the untouched src/shared.ts 6× + padding.
  const commits: RepoCommit[] = [];
  for (let i = 0; i < 6; i++) commits.push({ sha: `pair${i}`, date: 1000 + i, files: ['src/a.ts', 'src/shared.ts'] });
  for (let i = 0; i < 22; i++) commits.push({ sha: `pad${i}`, date: 5000 + i, files: [`pad${i}.ts`] });
  insertCommitFiles(db, REPO_ID, commits);
  db.close();
});

afterAll(() => { /* temp dir left for OS cleanup */ });

describe('prepare_change target resolution', () => {
  it('resolves a symbolId to a ready pre-flight with reasons + predictionId', async () => {
    const out = parse(await handler({ repoId: REPO_ID, intent: 'modify', targetSymbolId: 'sym-alpha' }));
    expect(out.verdict).toBe('ready');
    expect(out.target.name).toBe('alpha');
    expect(out.predictedChange.changedFilePaths).toContain('src/a.ts');
    expect(out.predictionId).toBeTruthy();
    expect(out.reasons.length).toBeGreaterThan(0);
  });

  it('surfaces the historically co-changing untouched file as missingCoChange', async () => {
    const out = parse(await handler({ repoId: REPO_ID, intent: 'modify', targetSymbolId: 'sym-alpha' }));
    expect(out.missingCoChange.map((m: { filePath: string }) => m.filePath)).toContain('src/shared.ts');
    expect(out.coverageGaps.map((g: { symbolId: string }) => g.symbolId)).toContain('sym-alpha');
  });

  it('returns no_target for an unknown symbolId', async () => {
    const out = parse(await handler({ repoId: REPO_ID, intent: 'modify', targetSymbolId: 'does-not-exist' }));
    expect(out.verdict).toBe('no_target');
  });

  it('returns ambiguous_target when a query has no clear winner', async () => {
    searchMock.mockReturnValueOnce(
      searchResult([
        { id: 's1', name: 'handle', kind: 'function', filePath: 'src/x.ts', score: 100 },
        { id: 's2', name: 'handle', kind: 'function', filePath: 'src/y.ts', score: 100 },
      ]),
    );
    const out = parse(await handler({ repoId: REPO_ID, intent: 'rename', query: 'handle' }));
    expect(out.verdict).toBe('ambiguous_target');
    expect(out.candidates).toHaveLength(2);
  });

  it('resolves a query with a clear winner to ready', async () => {
    searchMock.mockReturnValueOnce(
      searchResult([
        { id: 'sym-alpha', name: 'alpha', kind: 'function', filePath: 'src/a.ts', score: 200 },
        { id: 's2', name: 'alphabet', kind: 'function', filePath: 'src/y.ts', score: 50 },
      ]),
    );
    const out = parse(await handler({ repoId: REPO_ID, intent: 'modify', query: 'alpha' }));
    expect(out.verdict).toBe('ready');
    expect(out.target.symbolId).toBe('sym-alpha');
  });

  it('returns no_target when the query matches nothing', async () => {
    searchMock.mockReturnValueOnce(searchResult([]));
    const out = parse(await handler({ repoId: REPO_ID, intent: 'modify', query: 'nonexistent' }));
    expect(out.verdict).toBe('no_target');
  });

  it('errors when neither targetSymbolId nor query is given', async () => {
    const res = await handler({ repoId: REPO_ID, intent: 'modify' });
    expect(res.isError).toBe(true);
  });
});
