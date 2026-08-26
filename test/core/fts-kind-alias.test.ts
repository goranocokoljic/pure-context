/**
 * Phase 88 (Task 543) — UI-framework kind alias tokens in FTS content.
 *
 * Hook/component symbol names never contain the words "hook"/"component",
 * so vocabulary queries ("hook to create a workflow") could not retrieve
 * them into the FTS candidate pool at all on large mixed monorepos (novu).
 * buildFtsContent now indexes the kind as a token; hook ↔ composable are
 * cross-framework synonyms and both kinds carry both tokens.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openInMemoryDatabase } from '../../src/core/db/schema.js';
import { insertSymbols, ftsSearchSymbols } from '../../src/core/db/symbol-store.js';
import type { SymbolRecord } from '../../src/core/types.js';

const REPO_ID = 'fts-kind-alias-test-repo';

function makeSymbol(overrides: Partial<SymbolRecord> & { id: string; name: string }): SymbolRecord {
  return {
    kind: 'function',
    filePath: 'src/hooks/use-create-workflow.ts',
    startByte: 0,
    endByte: 100,
    signature: overrides.name,
    summary: overrides.summary ?? overrides.name,
    ...overrides,
  };
}

describe('FTS kind alias tokens (hook/composable/component)', () => {
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

  it('searching "hook" finds a kind:hook symbol whose name lacks the word', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'bbbb000000000001', name: 'useCreateWorkflow', kind: 'hook' }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'hook');
    expect(results.map((r) => r.name)).toContain('useCreateWorkflow');
  });

  it('searching "hook" also finds a kind:composable symbol (cross-framework alias)', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'bbbb000000000002', name: 'usePatchWorkflow', kind: 'composable' }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'hook');
    expect(results.map((r) => r.name)).toContain('usePatchWorkflow');
  });

  it('searching "composable" finds a kind:hook symbol (reverse alias)', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'bbbb000000000003', name: 'useDeleteWorkflow', kind: 'hook' }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'composable');
    expect(results.map((r) => r.name)).toContain('useDeleteWorkflow');
  });

  it('searching "component" finds a kind:component symbol', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({
        id: 'bbbb000000000004',
        name: 'WorkflowCard',
        kind: 'component',
        filePath: 'src/components/workflow-card.tsx',
      }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'component');
    expect(results.map((r) => r.name)).toContain('WorkflowCard');
  });

  it('plain function symbols do NOT match "hook"', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({ id: 'bbbb000000000005', name: 'createWorkflow', kind: 'function', filePath: 'src/api/workflows.ts' }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'hook');
    expect(results.map((r) => r.name)).not.toContain('createWorkflow');
  });
});
