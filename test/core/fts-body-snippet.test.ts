import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openInMemoryDatabase } from '../../src/core/db/schema.js';
import { insertSymbols, bulkUpsertFtsSymbols, ftsSearchSymbols } from '../../src/core/db/symbol-store.js';
import type { SymbolRecord } from '../../src/core/types.js';

const REPO_ID = 'test-body-snippet-repo';

function makeSymbol(overrides: Partial<SymbolRecord> & { id: string; name: string }): SymbolRecord {
  return {
    kind: 'function',
    filePath: 'src/model.php',
    startByte: 0,
    endByte: 100,
    signature: overrides.name,
    summary: overrides.name,
    ...overrides,
  };
}

describe('FTS body snippet enrichment', () => {
  let db: ReturnType<typeof openInMemoryDatabase>;

  beforeEach(() => {
    db = openInMemoryDatabase();
    // Register the repo so the FK constraint is satisfied (if any)
    db.prepare(
      "INSERT OR IGNORE INTO repos (id, root_path, file_count, indexed_at, schema_version) VALUES (?, ?, 0, 0, 1)",
    ).run(REPO_ID, '/tmp/test');
  });

  afterEach(() => {
    db.close();
  });

  it('body snippet words are searchable via FTS', () => {
    const sym = makeSymbol({
      id: 'aabbccdd00112233',
      name: 'get_row',
      bodySnippet: 'db->query prepared statement result row',
    });

    insertSymbols(db, REPO_ID, [sym]);

    const results = ftsSearchSymbols(db, REPO_ID, 'prepared statement');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('get_row');
  });

  it('multiple body words match independently', () => {
    const sym = makeSymbol({
      id: 'aabbccdd00112233',
      name: 'get_row',
      bodySnippet: 'db->query prepared statement result row',
    });

    insertSymbols(db, REPO_ID, [sym]);

    const results = ftsSearchSymbols(db, REPO_ID, 'exec query');
    // FTS5 with AND semantics — neither "exec" nor "query" alone should match unless both present
    // "query" is present in bodySnippet; "exec" is not — should return empty
    expect(results).toHaveLength(0);
  });

  it('body-only query returns the symbol when body contains the words', () => {
    const sym = makeSymbol({
      id: 'aabbccdd00112233',
      name: 'get_row',
      bodySnippet: 'db query exec prepared statement',
    });

    insertSymbols(db, REPO_ID, [sym]);

    const results = ftsSearchSymbols(db, REPO_ID, 'exec query');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('get_row');
  });

  it('existing name/signature search is unaffected', () => {
    const sym = makeSymbol({
      id: 'aabbccdd00112233',
      name: 'CIR_Model',
      signature: 'class CIR_Model extends CI_Model',
      summary: 'Database model class',
      bodySnippet: 'db query exec prepared statement',
    });

    insertSymbols(db, REPO_ID, [sym]);

    const byName = ftsSearchSymbols(db, REPO_ID, 'CIR_Model');
    expect(byName).toHaveLength(1);
    expect(byName[0].name).toBe('CIR_Model');

    const bySummary = ftsSearchSymbols(db, REPO_ID, 'Database model');
    expect(bySummary).toHaveLength(1);
  });

  it('symbol without bodySnippet still indexes normally', () => {
    const sym = makeSymbol({
      id: 'ff00112233445566',
      name: 'save_user',
      signature: 'function save_user($data)',
      summary: 'Persists user record',
    });
    // No bodySnippet field

    insertSymbols(db, REPO_ID, [sym]);

    const results = ftsSearchSymbols(db, REPO_ID, 'save_user');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('save_user');
  });

  it('bodySnippet from one symbol does not pollute another symbol', () => {
    const sym1 = makeSymbol({
      id: 'aaaa000011112222',
      name: 'get_row',
      bodySnippet: 'unique_word_alpha prepared query',
    });
    const sym2 = makeSymbol({
      id: 'bbbb000011112222',
      name: 'save_record',
      signature: 'function save_record()',
      summary: 'Saves a record',
    });

    insertSymbols(db, REPO_ID, [sym1, sym2]);

    const results = ftsSearchSymbols(db, REPO_ID, 'unique_word_alpha');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('get_row');
  });
});
