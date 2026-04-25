import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, reindexFiles, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase, computeRepoId } from '../../src/core/db/schema.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();
});

// ─── Full index FTS population ────────────────────────────────────────────────

describe('FTS population — full index', () => {
  const repoId = computeRepoId(FIXTURE);

  afterEach(() => {
    deleteIndex(repoId);
  });

  it('fts_symbols count equals symbols count after full index', async () => {
    await indexFolder(FIXTURE, { fileLimit: 50 });

    const db = openDatabase(repoId);
    const ftsCount = (
      db.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM fts_symbols WHERE repo_id = ?').get(repoId)?.c ?? 0
    );
    const symCount = (
      db.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM symbols WHERE repo_id = ?').get(repoId)?.c ?? 0
    );
    db.close();

    expect(symCount).toBeGreaterThan(0);
    expect(ftsCount).toBe(symCount);
  });

  it('fts_symbols content includes file stem for token lookups', async () => {
    await indexFolder(FIXTURE, { fileLimit: 50 });

    const db = openDatabase(repoId);
    // 'utils' is the stem of src/utils.ts — searching FTS should return its symbols
    const rows = db
      .prepare<[string], { symbol_id: string }>(
        "SELECT symbol_id FROM fts_symbols WHERE fts_symbols MATCH 'utils' AND repo_id = ?",
      )
      .all(repoId);
    db.close();

    expect(rows.length).toBeGreaterThan(0);
  });
});

// ─── Incremental reindex FTS update ──────────────────────────────────────────

describe('FTS population — incremental reindex', () => {
  let tmpRoot: string;
  let repoId: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `purecontext-fts-reindex-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    writeFileSync(join(tmpRoot, 'widget.ts'), 'export function buildWidget(): string { return "old"; }');
    repoId = computeRepoId(resolve(tmpRoot));
  });

  afterEach(() => {
    deleteIndex(repoId);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reindex replaces old FTS entries with new ones', async () => {
    await indexFolder(tmpRoot, { fileLimit: 10 });

    // Overwrite file with a renamed symbol
    writeFileSync(join(tmpRoot, 'widget.ts'), 'export function buildWidgetV2(): string { return "new"; }');
    await reindexFiles(repoId, ['widget.ts']);

    const db = openDatabase(repoId);
    const oldRows = db
      .prepare<[string], { symbol_id: string }>(
        "SELECT symbol_id FROM fts_symbols WHERE fts_symbols MATCH 'buildWidget' AND repo_id = ?",
      )
      .all(repoId);
    const newRows = db
      .prepare<[string], { symbol_id: string }>(
        "SELECT symbol_id FROM fts_symbols WHERE fts_symbols MATCH 'buildWidgetV2' AND repo_id = ?",
      )
      .all(repoId);
    db.close();

    // Old symbol should be gone; new symbol should be present
    expect(oldRows.length).toBe(0);
    expect(newRows.length).toBeGreaterThan(0);
  });
});

// ─── File deletion removes FTS entries ───────────────────────────────────────

describe('FTS population — file deletion', () => {
  let tmpRoot: string;
  let repoId: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `purecontext-fts-delete-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    writeFileSync(join(tmpRoot, 'widget.ts'), 'export function buildWidget(): string { return "old"; }');
    repoId = computeRepoId(resolve(tmpRoot));
  });

  afterEach(() => {
    deleteIndex(repoId);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('deleting a file removes its FTS entries', async () => {
    await indexFolder(tmpRoot, { fileLimit: 10 });

    const db1 = openDatabase(repoId);
    const beforeCount = (
      db1.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM fts_symbols WHERE repo_id = ?').get(repoId)?.c ?? 0
    );
    db1.close();
    expect(beforeCount).toBeGreaterThan(0);

    // Pass widget.ts as deleted
    await reindexFiles(repoId, [], ['widget.ts']);

    const db2 = openDatabase(repoId);
    const afterCount = (
      db2.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM fts_symbols WHERE repo_id = ?').get(repoId)?.c ?? 0
    );
    db2.close();

    expect(afterCount).toBe(0);
  });
});
