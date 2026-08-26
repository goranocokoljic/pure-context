/**
 * Task 502 (Phase 82): empty-graph honesty signal.
 */
import { describe, it, expect } from 'vitest';
import { graphCoverageWarning } from '../../src/server/tools/graph-coverage.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { upsertFile } from '../../src/core/db/file-store.js';

const REPO = 'covtest';

function seedDb(fileCount: number, edgeCount: number) {
  const db = openInMemoryDatabase();
  upsertRepo(db, {
    id: REPO,
    rootPath: '/tmp/covtest',
    symbolCount: 0,
    fileCount,
    languages: [],
    indexedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
    clonePath: null,
    tenantId: 'local',
  });
  for (let i = 0; i < fileCount; i++) {
    upsertFile(db, REPO, `src/File${i}.kt`, `hash${i}`);
  }
  const insertEdge = db.prepare(`
    INSERT INTO dep_edges (repo_id, source_file, target_file, edge_type, specifier)
    VALUES (?, ?, ?, 'import', 'x')
  `);
  for (let i = 0; i < edgeCount; i++) {
    insertEdge.run(REPO, `src/File${i}.kt`, `src/File${i + 1}.kt`);
  }
  return db;
}

describe('graphCoverageWarning (Task 502)', () => {
  it('warns when a non-trivial repo has zero edges', () => {
    const db = seedDb(30, 0);
    const warning = graphCoverageWarning(db, REPO);
    expect(warning).not.toBeNull();
    expect(warning!.graphCoverage).toBe('empty');
    expect(warning!.graphCoverageNote).toContain('find_references');
    db.close();
  });

  it('stays silent when edges exist', () => {
    const db = seedDb(30, 5);
    expect(graphCoverageWarning(db, REPO)).toBeNull();
    db.close();
  });

  it('stays silent on tiny repos (an empty graph is unremarkable there)', () => {
    const db = seedDb(5, 0);
    expect(graphCoverageWarning(db, REPO)).toBeNull();
    db.close();
  });
});
