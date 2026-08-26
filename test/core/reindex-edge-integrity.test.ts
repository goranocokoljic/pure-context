/**
 * Task 561 — incremental re-index must not delete incoming edges.
 *
 * The 1.18.0 verification report's critical repro: three files where B and C
 * import A. Editing ONLY A and re-indexing used to delete BOTH incoming edges
 * (deleteEdgesByFile cleared source AND target rows, but only the reprocessed
 * file's outgoing edges were re-inserted). The prescribed index_file-after-
 * every-write loop therefore rotted the graph monotonically.
 *
 * Fixed by deleteEdgesBySource on the reprocess paths; the both-directions
 * delete now runs only for files actually removed from disk.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { indexFolder, reindexFiles } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { getAllDepEdges } from '../../src/core/db/dep-store.js';
import { registerHandler } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';

registerHandler(typescriptHandler);

let dir: string;
let repoId: string;

function edgePairs(): Array<[string, string]> {
  const db = openDatabase(repoId);
  const edges = getAllDepEdges(db, repoId);
  db.close();
  return edges
    .map((e) => [e.sourceFile, e.targetFile] as [string, string])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

describe('reindex edge integrity (report critical 1)', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pctx-edge-int-'));
    writeFileSync(join(dir, 'a.ts'), 'export const A = 1;\n');
    writeFileSync(join(dir, 'b.ts'), "import { A } from './a';\nexport const B = A + 1;\n");
    writeFileSync(join(dir, 'c.ts'), "import { A } from './a';\nexport const C = A + 2;\n");
    const result = await indexFolder(dir);
    repoId = result.repoId;
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fresh index has both incoming edges on a.ts', () => {
    expect(edgePairs()).toEqual([
      ['b.ts', 'a.ts'],
      ['c.ts', 'a.ts'],
    ]);
  });

  it('re-indexing ONLY the imported file keeps both incoming edges', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export const A = 42;\n');
    await reindexFiles(repoId, ['a.ts']);
    expect(edgePairs()).toEqual([
      ['b.ts', 'a.ts'],
      ['c.ts', 'a.ts'],
    ]);
  });

  it('a session of repeated targeted re-indexes leaves the edge set stable', async () => {
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(dir, 'a.ts'), `export const A = ${i};\n`);
      await reindexFiles(repoId, ['a.ts']);
    }
    expect(edgePairs()).toEqual([
      ['b.ts', 'a.ts'],
      ['c.ts', 'a.ts'],
    ]);
  });

  it('removing an import from an importer drops exactly that edge', async () => {
    writeFileSync(join(dir, 'b.ts'), 'export const B = 2;\n');
    await reindexFiles(repoId, ['b.ts']);
    expect(edgePairs()).toEqual([['c.ts', 'a.ts']]);
  });

  it('a file deleted from disk clears edges in BOTH directions', async () => {
    unlinkSync(join(dir, 'a.ts'));
    await reindexFiles(repoId, [], ['a.ts']);
    expect(edgePairs()).toEqual([]);
  });

  it('targeted re-index converges to the same edges as a fresh full index', async () => {
    // Rebuild the original three-file state on disk, re-add via targeted path.
    writeFileSync(join(dir, 'a.ts'), 'export const A = 1;\n');
    writeFileSync(join(dir, 'b.ts'), "import { A } from './a';\nexport const B = A + 1;\n");
    await reindexFiles(repoId, ['a.ts', 'b.ts']);
    const targeted = edgePairs();

    // Fresh full index over the identical tree (separate temp copy → own repoId).
    const freshDir = mkdtempSync(join(tmpdir(), 'pctx-edge-fresh-'));
    try {
      writeFileSync(join(freshDir, 'a.ts'), 'export const A = 1;\n');
      writeFileSync(
        join(freshDir, 'b.ts'),
        "import { A } from './a';\nexport const B = A + 1;\n",
      );
      writeFileSync(
        join(freshDir, 'c.ts'),
        "import { A } from './a';\nexport const C = A + 2;\n",
      );
      const fresh = await indexFolder(freshDir);
      const db = openDatabase(fresh.repoId);
      const freshPairs = getAllDepEdges(db, fresh.repoId)
        .map((e) => [e.sourceFile, e.targetFile] as [string, string])
        .sort((a, b) => a[0].localeCompare(b[0]));
      db.close();
      expect(targeted).toEqual(freshPairs);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});
