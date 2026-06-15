/**
 * verify-change.test.ts — Phase 79 Group B
 *
 * Plan-vs-actual reconciliation. Uses a real temp SQLite DB; verify_change calls
 * analyze_diff internally (no mocks) so the actual-side synthesis is real.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { join } from 'path';
import { mkdirSync } from 'fs';

const tmpHome = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  return path.join(os.tmpdir(), `purecontext-verify-change-${Math.random().toString(36).slice(2)}`);
});

vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => tmpHome };
});

import { openDatabase, computeRepoId } from '../../src/core/db/schema.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import { upsertFile } from '../../src/core/db/file-store.js';
import { insertCommitFiles } from '../../src/core/db/co-change-store.js';
import { handler } from '../../src/server/tools/verify-change.js';
import type { RepoCommit } from '../../src/core/git-log-reader.js';

const REPO_ROOT = join(tmpHome, 'repo');
const REPO_ID = computeRepoId(REPO_ROOT);
const NOW = Math.floor(Date.now() / 1000);

const A_MOD = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 export function alpha() {
-  return 1;
+  return 2;
 }
`;

const A_AND_SHARED = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 export function alpha() {
-  return 1;
+  return 2;
 }
--- a/src/shared.ts
+++ b/src/shared.ts
@@ -1,3 +1,3 @@
 export function shared() {
-  return 3;
+  return 4;
 }
`;

const A_AND_EXTRA = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 export function alpha() {
-  return 1;
+  return 2;
 }
--- a/src/extra.ts
+++ b/src/extra.ts
@@ -1 +1 @@
-const X = 1;
+const X = 2;
`;

function parse(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0]!.text!);
}

beforeAll(() => {
  mkdirSync(join(tmpHome, 'indexes'), { recursive: true });
  const db = openDatabase(REPO_ID);
  db.prepare(`INSERT OR IGNORE INTO repos (id, root_path, indexed_at, schema_version) VALUES (?, ?, ?, 8)`)
    .run(REPO_ID, REPO_ROOT, Date.now());

  upsertFile(db, REPO_ID, 'src/a.ts', 'h', Buffer.from('export function alpha() {\n  return 1;\n}\n'));
  upsertFile(db, REPO_ID, 'src/shared.ts', 'h', Buffer.from('export function shared() {\n  return 3;\n}\n'));
  insertSymbols(db, REPO_ID, [
    { id: 'sym-alpha', name: 'alpha', kind: 'function', filePath: 'src/a.ts', startByte: 0, endByte: 39, signature: 'function alpha()', summary: '' },
  ]);
  // alpha is TESTED → isolates the co-change signal from coverage gaps.
  db.prepare(
    `INSERT OR REPLACE INTO provider_metadata (repo_id, provider_name, entity_key, metadata, updated_at)
     VALUES (?, 'test-mapper', ?, ?, ?)`,
  ).run(REPO_ID, 'sym-alpha', JSON.stringify({ testFiles: ['test/a.test.ts'], testSymbolIds: [], coverageStatus: 'tested' }), NOW);

  const commits: RepoCommit[] = [];
  for (let i = 0; i < 6; i++) commits.push({ sha: `pair${i}`, date: 1000 + i, files: ['src/a.ts', 'src/shared.ts'] });
  for (let i = 0; i < 22; i++) commits.push({ sha: `pad${i}`, date: 5000 + i, files: [`pad${i}.ts`] });
  insertCommitFiles(db, REPO_ID, commits);
  db.close();
});

describe('verify_change reconciliation', () => {
  it('flags a planned-but-untouched co-change partner as incomplete', async () => {
    const out = parse(await handler({
      repoId: REPO_ID,
      diff: A_MOD,
      predictedFilePaths: ['src/a.ts', 'src/shared.ts'],
      predictedCoChange: ['src/shared.ts'],
    }));
    expect(out.verdict).toBe('incomplete');
    expect(out.unaddressedCoChange).toContain('src/shared.ts');
    expect(out.reasons.length).toBeGreaterThan(0);
  });

  it('marks the change complete when the predicted partner was touched', async () => {
    const out = parse(await handler({
      repoId: REPO_ID,
      diff: A_AND_SHARED,
      predictedFilePaths: ['src/a.ts', 'src/shared.ts'],
      predictedCoChange: ['src/shared.ts'],
    }));
    expect(out.addressedCoChange).toContain('src/shared.ts');
    expect(out.unaddressedCoChange).toHaveLength(0);
    expect(out.verdict).toBe('complete');
  });

  it('reports unplanned changes as scope_expanded', async () => {
    const out = parse(await handler({
      repoId: REPO_ID,
      diff: A_AND_EXTRA,
      predictedFilePaths: ['src/a.ts'],
      predictedCoChange: [],
    }));
    expect(out.verdict).toBe('scope_expanded');
    expect(out.unplannedChanges).toContain('src/extra.ts');
  });

  it('echoes predictionId when provided', async () => {
    const out = parse(await handler({
      repoId: REPO_ID,
      diff: A_MOD,
      predictedFilePaths: ['src/a.ts'],
      predictedCoChange: [],
      predictionId: 'abc123',
    }));
    expect(out.predictionId).toBe('abc123');
  });
});
