/**
 * merge-readiness.test.ts — Phase 80, Task 487
 *
 * Composite pre-merge gate. Uses a real temp SQLite DB; merge_readiness calls
 * verify_change + compare_change_impact internally (no mocks).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { join } from 'path';
import { mkdirSync } from 'fs';

const tmpHome = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  return path.join(os.tmpdir(), `purecontext-merge-readiness-${Math.random().toString(36).slice(2)}`);
});

vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => tmpHome };
});

import { openDatabase, computeRepoId } from '../../src/core/db/schema.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import { upsertFile } from '../../src/core/db/file-store.js';
import { insertCommitFiles } from '../../src/core/db/co-change-store.js';
import { handler } from '../../src/server/tools/merge-readiness.js';
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
  // alpha is TESTED so coverage doesn't independently force incomplete.
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

describe('merge_readiness composite gate', () => {
  it('blocks when a planned co-change partner is still untouched (verify incomplete)', async () => {
    const out = parse(await handler({
      repoId: REPO_ID,
      diff: A_MOD,
      predictedFilePaths: ['src/a.ts', 'src/shared.ts'],
      predictedCoChange: ['src/shared.ts'],
    }));
    expect(out.gate).toBe('block');
    expect(out.verify.verdict).toBe('incomplete');
    expect(out.unresolved.some((u: string) => u.includes('src/shared.ts'))).toBe(true);
    expect(out.reasons.length).toBeGreaterThan(0);
    expect(out.nextAction).toBe('resolve_unresolved_then_remerge');
  });

  it('warns (not blocks) when complete but no architecture baseline exists', async () => {
    const out = parse(await handler({
      repoId: REPO_ID,
      diff: A_AND_SHARED,
      predictedFilePaths: ['src/a.ts', 'src/shared.ts'],
      predictedCoChange: ['src/shared.ts'],
    }));
    expect(out.verify.verdict).toBe('complete');
    expect(out.architecture.verdict).toBe('no_baseline');
    // verify pass + architecture warn (no baseline) → overall warn.
    expect(out.gate).toBe('warn');
    expect(out.nextAction).toBe('review_then_merge');
  });

  it('always returns the composite envelope shape', async () => {
    const out = parse(await handler({
      repoId: REPO_ID,
      diff: A_MOD,
      predictedFilePaths: ['src/a.ts'],
    }));
    expect(out).toHaveProperty('gate');
    expect(Array.isArray(out.reasons)).toBe(true);
    expect(Array.isArray(out.unresolved)).toBe(true);
    expect(out).toHaveProperty('verify');
    expect(out).toHaveProperty('architecture');
  });
});
