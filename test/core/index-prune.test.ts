/**
 * Task 562 — index_folder prunes files that vanished from disk.
 *
 * Report critical 2: no prune + path-keyed repoId meant an in-place branch
 * switch produced a HYBRID index (union of both branches); a file deleted on
 * the feature branch kept all its symbols, and only deleting the database
 * recovered.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { indexFolder } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { getAllDepEdges } from '../../src/core/db/dep-store.js';
import { registerHandler } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';

registerHandler(typescriptHandler);

let dir: string;
let repoId: string;

function dbState(): { files: string[]; symbols: string[]; edges: number } {
  const db = openDatabase(repoId);
  const files = (
    db.prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ?').all(repoId)
  )
    .map((r) => r.path)
    .sort();
  const symbols = (
    db.prepare<[string], { name: string }>('SELECT name FROM symbols WHERE repo_id = ?').all(repoId)
  )
    .map((r) => r.name)
    .sort();
  const edges = getAllDepEdges(db, repoId).length;
  db.close();
  return { files, symbols, edges };
}

describe('index_folder prune (report critical 2)', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pctx-prune-'));
    // "main branch" state: two files, one imports the other.
    writeFileSync(join(dir, 'keep.ts'), 'export const KEEP = 1;\n');
    writeFileSync(
      join(dir, 'feature.ts'),
      "import { KEEP } from './keep';\nexport const FEATURE_ONLY = KEEP;\n",
    );
    const result = await indexFolder(dir);
    repoId = result.repoId;
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('indexes the initial state fully', () => {
    const s = dbState();
    expect(s.files).toEqual(['feature.ts', 'keep.ts']);
    expect(s.symbols).toContain('FEATURE_ONLY');
    expect(s.edges).toBe(1);
  });

  it('a deleted file is pruned on re-index — no hybrid index', async () => {
    // Simulate switching to a branch where feature.ts does not exist.
    unlinkSync(join(dir, 'feature.ts'));
    const result = await indexFolder(dir);
    expect(result.filesPruned).toBe(1);

    const s = dbState();
    expect(s.files).toEqual(['keep.ts']);
    expect(s.symbols).not.toContain('FEATURE_ONLY');
    // Its outgoing edge is gone too, in both directions.
    expect(s.edges).toBe(0);
  });

  it('re-indexing again is a stable no-op (nothing left to prune)', async () => {
    const result = await indexFolder(dir);
    expect(result.filesPruned).toBe(0);
    expect(result.filesIndexed).toBe(0);
    expect(dbState().files).toEqual(['keep.ts']);
  });

  it('switching "back" restores the file cleanly', async () => {
    writeFileSync(
      join(dir, 'feature.ts'),
      "import { KEEP } from './keep';\nexport const FEATURE_ONLY = KEEP;\n",
    );
    const result = await indexFolder(dir);
    expect(result.filesPruned).toBe(0);

    const s = dbState();
    expect(s.files).toEqual(['feature.ts', 'keep.ts']);
    expect(s.symbols).toContain('FEATURE_ONLY');
    expect(s.edges).toBe(1);
  });
});
