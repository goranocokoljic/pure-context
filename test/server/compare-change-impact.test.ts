/**
 * compare-change-impact.test.ts — Phase 79 Group C
 *
 * Architecture regression delta: snapshot a clean graph, introduce a cycle, then
 * confirm compare_change_impact reports it as a NEW cycle (not a pre-existing
 * flag). Also covers the no_baseline degrade path.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { join } from 'path';
import { mkdirSync } from 'fs';

const tmpHome = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  return path.join(os.tmpdir(), `purecontext-compare-impact-${Math.random().toString(36).slice(2)}`);
});

vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => tmpHome };
});

import { openDatabase, computeRepoId } from '../../src/core/db/schema.js';
import { handler as snapshotHandler } from '../../src/server/tools/get-architecture-snapshot.js';
import { handler } from '../../src/server/tools/compare-change-impact.js';

const REPO_ROOT = join(tmpHome, 'repo');
const REPO_ID = computeRepoId(REPO_ROOT);
const FRESH_ROOT = join(tmpHome, 'fresh');
const FRESH_ID = computeRepoId(FRESH_ROOT);

function parse(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0]!.text!);
}

function insertEdge(db: ReturnType<typeof openDatabase>, src: string, tgt: string) {
  db.prepare(
    `INSERT INTO dep_edges (repo_id, source_file, source_symbol_id, target_file, target_symbol_id, edge_type, specifier, tenant_id)
     VALUES (?, ?, NULL, ?, NULL, 'import', ?, 'local')`,
  ).run(REPO_ID, src, tgt, tgt);
}

beforeAll(() => {
  mkdirSync(join(tmpHome, 'indexes'), { recursive: true });
  const db = openDatabase(REPO_ID);
  db.prepare(`INSERT OR IGNORE INTO repos (id, root_path, indexed_at, schema_version) VALUES (?, ?, ?, 8)`)
    .run(REPO_ID, REPO_ROOT, Date.now());
  // Clean acyclic edge at baseline time: a → b only.
  insertEdge(db, 'src/a.ts', 'src/b.ts');
  db.close();

  const freshDb = openDatabase(FRESH_ID);
  freshDb.prepare(`INSERT OR IGNORE INTO repos (id, root_path, indexed_at, schema_version) VALUES (?, ?, ?, 8)`)
    .run(FRESH_ID, FRESH_ROOT, Date.now());
  freshDb.close();
});

describe('compare_change_impact', () => {
  it('returns no_baseline when no snapshot exists', () => {
    const out = parse(handler({ repoId: FRESH_ID }));
    expect(out.verdict).toBe('no_baseline');
  });

  it('detects a newly introduced import cycle against a baseline snapshot', async () => {
    // 1. Snapshot the clean (acyclic) graph.
    const snap = parse(await snapshotHandler({ repoId: REPO_ID, action: 'create', label: 'before' }));
    expect(snap.snapshot.cycleCount).toBe(0);

    // 2. Introduce a cycle: b → a (now a ⇄ b).
    const db = openDatabase(REPO_ID);
    insertEdge(db, 'src/b.ts', 'src/a.ts');
    db.close();

    // 3. Compare current live graph against the baseline.
    const out = parse(handler({ repoId: REPO_ID, baselineSnapshotId: snap.snapshot.snapshotId }));
    expect(out.verdict).toBe('regressed');
    expect(out.newCycles.length).toBeGreaterThan(0);
    expect(out.newCycles.flat()).toContain('src/a.ts');
    expect(out.reasons.join(' ')).toMatch(/cycle/i);
  });

  it('reports unchanged when the graph matches the baseline', async () => {
    const snap = parse(await snapshotHandler({ repoId: REPO_ID, action: 'create', label: 'after' }));
    const out = parse(handler({ repoId: REPO_ID, baselineSnapshotId: snap.snapshot.snapshotId }));
    expect(out.verdict).toBe('unchanged');
    expect(out.newCycles).toHaveLength(0);
  });
});
