/**
 * Task 219 — FTS split-name indexing.
 *
 * Verifies that camelCase/PascalCase symbol names are split into component
 * tokens at index time so that partial-word FTS5 queries match.
 *
 * Root cause: FTS5's unicode61 tokenizer treats "FrontController" as a
 * single token. Searching for "controller" would never match it unless we
 * explicitly index the split form "front controller" alongside the original.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openInMemoryDatabase } from '../../src/core/db/schema.js';
import { insertSymbols, bulkUpsertFtsSymbols, ftsSearchSymbols } from '../../src/core/db/symbol-store.js';
import type { SymbolRecord } from '../../src/core/types.js';

const REPO_ID = 'fts-split-name-test-repo';

function makeSymbol(overrides: Partial<SymbolRecord> & { id: string; name: string }): SymbolRecord {
  return {
    kind: 'function',
    filePath: 'src/Controller.php',
    startByte: 0,
    endByte: 100,
    signature: overrides.name,
    summary: overrides.summary ?? overrides.name,
    ...overrides,
  };
}

describe('FTS split-name indexing', () => {
  let db: ReturnType<typeof openInMemoryDatabase>;

  beforeEach(() => {
    db = openInMemoryDatabase();
    db.prepare(
      "INSERT OR IGNORE INTO repos (id, root_path, file_count, indexed_at, schema_version) VALUES (?, ?, 0, 0, 1)",
    ).run(REPO_ID, '/tmp/test');
  });

  afterEach(() => {
    db.close();
  });

  // ── camelCase / PascalCase splitting ────────────────────────────────────────

  it('searching "controller" finds PascalCase "FrontController"', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'aaaa000000000001', name: 'FrontController' }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'controller');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('FrontController');
  });

  it('searching "front" finds PascalCase "FrontController"', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'aaaa000000000002', name: 'FrontController' }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'front');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('FrontController');
  });

  it('searching "searcher" finds PascalCase "HybridSearcher"', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'aaaa000000000003', name: 'HybridSearcher' }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'searcher');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('HybridSearcher');
  });

  it('searching "user" finds lowerCamelCase "getUserById"', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'aaaa000000000004', name: 'getUserById' }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'user');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('getUserById');
  });

  it('searching "parse" finds lowerCamelCase "parseFile"', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'aaaa000000000005', name: 'parseFile' }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'parse');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('parseFile');
  });

  it('multi-word AND query "front controller" finds "FrontController"', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'aaaa000000000006', name: 'FrontController' }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'front controller');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('FrontController');
  });

  it('multi-word AND query "get user by" finds "getUserById"', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'aaaa000000000007', name: 'getUserById' }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'get user by');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('getUserById');
  });

  // ── Acronym handling ────────────────────────────────────────────────────────

  it('acronym run in name: "http" finds "getHTTPStatus"', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'aaaa000000000008', name: 'getHTTPStatus' }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'http');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('getHTTPStatus');
  });

  it('acronym run in name: "status" finds "getHTTPStatus"', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'aaaa000000000009', name: 'getHTTPStatus' }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'status');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('getHTTPStatus');
  });

  it('all-caps name "MCP" still matches on full name', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'aaaa00000000000a', name: 'MCP' }),
    ]);
    // FTS5 lowercases tokens — searching "mcp" should match all-caps "MCP"
    const results = ftsSearchSymbols(db, REPO_ID, 'mcp');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('MCP');
  });

  // ── Hybrid snake_case + camelCase segments ──────────────────────────────────

  it('searching "front" finds hybrid "CIR_FrontController"', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'aaaa00000000000b', name: 'CIR_FrontController' }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'front');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('CIR_FrontController');
  });

  it('searching "controller" finds hybrid "CIR_FrontController"', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'aaaa00000000000c', name: 'CIR_FrontController' }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'controller');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('CIR_FrontController');
  });

  it('multi-part hybrid: "admin" and "controller" both find "CIR_AllAdminController"', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'aaaa00000000000d', name: 'CIR_AllAdminController' }),
    ]);
    const adminResults = ftsSearchSymbols(db, REPO_ID, 'admin');
    expect(adminResults).toHaveLength(1);

    const ctrlResults = ftsSearchSymbols(db, REPO_ID, 'controller');
    expect(ctrlResults).toHaveLength(1);
  });

  // ── snake_case (unchanged — FTS5 already splits on underscores) ─────────────

  it('snake_case "get_user_by_id": "user" still finds it (FTS5 splits on _)', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'aaaa00000000000b', name: 'get_user_by_id' }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'user');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('get_user_by_id');
  });

  it('snake_case "save_record": full name still matches', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'aaaa00000000000c', name: 'save_record' }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'save_record');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('save_record');
  });

  // ── Original full name still matches ────────────────────────────────────────

  it('original full name "FrontController" still matches after split indexing', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'aaaa00000000000d', name: 'FrontController' }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'FrontController');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('FrontController');
  });

  // ── No cross-symbol pollution ────────────────────────────────────────────────

  it('split tokens from one symbol do not pollute another symbol', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'aaaa00000000000e', name: 'FrontController' }),
      makeSymbol({
        id: 'aaaa00000000000f',
        name: 'saveRecord',
        filePath: 'src/record-store.ts',
        summary: 'Persists a record to the database',
      }),
    ]);

    const results = ftsSearchSymbols(db, REPO_ID, 'controller');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('FrontController');
  });

  // ── bulkUpsertFtsSymbols also applies the split ──────────────────────────────

  it('bulkUpsertFtsSymbols: split tokens are indexed', () => {
    // Insert the symbol row first (bulkUpsertFtsSymbols updates FTS only)
    db.prepare(`
      INSERT OR REPLACE INTO symbols
        (id, repo_id, name, kind, file_path, start_byte, end_byte, signature, summary, indexed_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, 0, 100, ?, ?, 0, 'local')
    `).run('aaaa000000000010', REPO_ID, 'IndexManager', 'class', 'src/index-manager.ts', 'IndexManager', 'Manages indexing');

    const sym = makeSymbol({
      id: 'aaaa000000000010',
      name: 'IndexManager',
      filePath: 'src/index-manager.ts',
      summary: 'Manages indexing',
    });

    bulkUpsertFtsSymbols(db, REPO_ID, [sym]);

    const results = ftsSearchSymbols(db, REPO_ID, 'manager');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('IndexManager');
  });

  it('bulkUpsertFtsSymbols: "index" also finds "IndexManager"', () => {
    db.prepare(`
      INSERT OR REPLACE INTO symbols
        (id, repo_id, name, kind, file_path, start_byte, end_byte, signature, summary, indexed_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, 0, 100, ?, ?, 0, 'local')
    `).run('aaaa000000000011', REPO_ID, 'IndexManager', 'class', 'src/index-manager.ts', 'IndexManager', 'Manages indexing');

    const sym = makeSymbol({
      id: 'aaaa000000000011',
      name: 'IndexManager',
      filePath: 'src/index-manager.ts',
      summary: 'Manages indexing',
    });

    bulkUpsertFtsSymbols(db, REPO_ID, [sym]);

    const results = ftsSearchSymbols(db, REPO_ID, 'index');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('IndexManager');
  });
});
