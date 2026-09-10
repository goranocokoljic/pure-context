/**
 * Phase 100 (Task 622) — index garbage collection.
 *
 * P4: dry-run first; a live index (root exists) or one with a job marker is
 * never a candidate; an orphan (.db without a repos row) and a dead root
 * (repos row whose root_path is gone) are; a blob survives while ANY
 * surviving index references its hash; young unreferenced blobs wait for
 * the grace window. The whole test runs in its own PCTX_DATA_DIR so the
 * sweep can never touch another suite's blobs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

import { indexFolder } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { computeRepoId, openDatabase, getIndexDir, getJobsDir, getRepo } from '../../src/core/db/schema.js';
import { openBlobStore, closeBlobStores, getBlobDbPath } from '../../src/core/db/blob-store.js';
import { getFileContent } from '../../src/core/db/file-store.js';
import { writeJobMarker, clearJobMarker } from '../../src/core/git-head.js';
import { planGc, applyGc, formatGcPlan } from '../../src/core/index-gc.js';
import { handler as listRepos } from '../../src/server/tools/list-repos.js';
import { handler as gcIndexes } from '../../src/server/tools/gc-indexes.js';
import { parseGcArgs } from '../../src/cli/gc.js';

let dataDir: string;
let prevDataDir: string | undefined;
let prevMode: string | undefined;
let liveRoot: string;
let deadRoot: string;
let liveId: string;
let deadId: string;
let orphanId: string;
let busyId: string;

function write(root: string, relPath: string, content: string) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function makeFixture(prefix: string, extra = ''): string {
  const root = resolve(mkdtempSync(join(tmpdir(), prefix)));
  write(root, 'src/shared.ts', 'export function shared(): number {\n  return 1;\n}\n');
  write(root, 'src/own.ts', `export function own(): string {\n  return ${JSON.stringify(prefix + extra)};\n}\n`);
  return root;
}

beforeAll(async () => {
  prevDataDir = process.env['PCTX_DATA_DIR'];
  prevMode = process.env['PCTX_CONTENT_STORE'];
  closeBlobStores();
  dataDir = resolve(mkdtempSync(join(tmpdir(), 'pc-gc-data-')));
  process.env['PCTX_DATA_DIR'] = dataDir;
  process.env['PCTX_CONTENT_STORE'] = 'blob';

  _resetForTesting();
  registerHandler(typescriptHandler);
  await initParser();

  liveRoot = makeFixture('pc-gc-live-');
  deadRoot = makeFixture('pc-gc-dead-');
  liveId = (await indexFolder(liveRoot, { skipGit: true, crossIndex: 'off' })).repoId;
  deadId = (await indexFolder(deadRoot, { skipGit: true, crossIndex: 'off' })).repoId;
  // Dead root: the checkout is gone, the index stays.
  rmSync(deadRoot, { recursive: true, force: true });
  // Orphan: a .db with no repos row (a crashed run).
  orphanId = 'gcorphan0000001';
  openDatabase(orphanId).close();
  // Busy: dead root but a job marker says a re-index is running.
  const busyRoot = makeFixture('pc-gc-busy-');
  busyId = (await indexFolder(busyRoot, { skipGit: true, crossIndex: 'off' })).repoId;
  rmSync(busyRoot, { recursive: true, force: true });
  writeJobMarker(getJobsDir(), { repoId: busyId, rootPath: busyRoot, mode: 'index-changed' });
});

afterAll(() => {
  closeBlobStores();
  try {
    clearJobMarker(getJobsDir(), busyId, true);
  } catch {
    /* ignore */
  }
  if (prevDataDir === undefined) delete process.env['PCTX_DATA_DIR'];
  else process.env['PCTX_DATA_DIR'] = prevDataDir;
  if (prevMode === undefined) delete process.env['PCTX_CONTENT_STORE'];
  else process.env['PCTX_CONTENT_STORE'] = prevMode;
  rmSync(liveRoot, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('planGc (dry run)', () => {
  it('classifies orphan, dead-root, busy and live indexes', () => {
    const plan = planGc({ blobs: true });
    const byId = new Map(plan.candidates.map((c) => [c.repoId, c]));
    expect(byId.get(orphanId)?.reason).toBe('no_repo_row');
    expect(byId.get(deadId)?.reason).toBe('root_missing');
    expect(byId.has(liveId)).toBe(false);
    expect(byId.has(busyId)).toBe(false);
    expect(plan.skipped.find((s) => s.repoId === busyId)?.reason).toBe('in_progress');
    expect(plan.skipped.find((s) => s.repoId === liveId)?.reason).toBe('live');
    expect(plan.liveIndexes).toBe(2); // live + busy survive
    expect(plan.reclaimableBytes).toBeGreaterThan(0);
    // Blob plan: shared.ts is referenced by the live index → never unreferenced.
    expect(plan.blobs).not.toBeNull();
    expect(plan.blobs!.referenced).toBeGreaterThanOrEqual(2);
    const text = formatGcPlan(plan, { blobsRequested: true }).join('\n');
    expect(text).toContain('no repo row');
    expect(text).toContain('root missing');
    expect(text).toContain('re-index in progress');
    // Dry run wrote nothing.
    expect(existsSync(join(getIndexDir(), `${orphanId}.db`))).toBe(true);
    expect(existsSync(join(getIndexDir(), `${deadId}.db`))).toBe(true);
  });

  it('scopeRoot restricts the plan to one index and never lists a live root', () => {
    const scoped = planGc({ scopeRoot: deadRoot });
    expect(scoped.candidates.map((c) => c.repoId)).toEqual([deadId]);
    const live = planGc({ scopeRoot: liveRoot });
    expect(live.candidates).toEqual([]);
    expect(live.skipped.find((s) => s.repoId === liveId)?.reason).toBe('live');
  });

  it('list_repos reports sizes, rootExists and the store summary', () => {
    const out = JSON.parse(listRepos().content[0]!.text as string) as {
      repos: Array<{ id: string; sizeBytes: number; rootExists: boolean }>;
      store: { indexesBytes: number; blobsBytes: number; orphanIndexes: number; orphanIndexBytes: number; deadRootIndexes: number; contentStore: string; nextAction?: string };
    };
    const live = out.repos.find((r) => r.id === liveId)!;
    expect(live.sizeBytes).toBeGreaterThan(0);
    expect(live.rootExists).toBe(true);
    expect(out.repos.find((r) => r.id === deadId)!.rootExists).toBe(false);
    expect(out.repos.some((r) => r.id === orphanId)).toBe(false);
    expect(out.store.orphanIndexes).toBe(1);
    expect(out.store.orphanIndexBytes).toBeGreaterThan(0);
    expect(out.store.deadRootIndexes).toBe(2);
    expect(out.store.blobsBytes).toBeGreaterThan(0);
    expect(out.store.contentStore).toBe('blob');
    expect(out.store.nextAction).toContain('gc_indexes');
  });

  it('gc_indexes tool is a dry run unless apply: true', () => {
    const out = JSON.parse(gcIndexes({ blobs: true }).content[0]!.text as string) as {
      dryRun: boolean;
      candidates: Array<{ repoId: string }>;
      nextAction: string;
    };
    expect(out.dryRun).toBe(true);
    expect(out.candidates.map((c) => c.repoId).sort()).toEqual([deadId, orphanId].sort());
    expect(out.nextAction).toContain('apply: true');
    expect(existsSync(join(getIndexDir(), `${orphanId}.db`))).toBe(true);
  });

  it('CLI flags parse', () => {
    expect(parseGcArgs(['--yes', '--blobs', '--repo', 'x'])).toEqual({ yes: true, blobs: true, json: false, scopeRoot: resolve('x') });
    expect(parseGcArgs([])).toEqual({ yes: false, blobs: false, json: false });
    expect(() => parseGcArgs(['--bogus'])).toThrow();
  });
});

describe('applyGc', () => {
  it('sweeps only unreferenced blobs older than the grace window', () => {
    const store = openBlobStore({ createIfMissing: true })!;
    const oldHash = 'gc-old-unreferenced';
    const youngHash = 'gc-young-unreferenced';
    store.db
      .prepare('INSERT OR IGNORE INTO blobs (hash, bytes, size, created_at) VALUES (?, ?, ?, ?)')
      .run(oldHash, Buffer.from('old'), 3, Date.now() - 60 * 60 * 1000);
    store.put(youngHash, Buffer.from('young'));

    const before = store.list().length;
    const plan = planGc({ blobs: true, graceMs: 15 * 60 * 1000 });
    expect(plan.blobs!.hashes).toContain(oldHash);
    expect(plan.blobs!.hashes).not.toContain(youngHash);
    expect(plan.blobs!.tooYoung).toBeGreaterThanOrEqual(1);

    // Apply with the grace window: only the OLD unreferenced blob goes; the
    // dead index's own.ts blob is unreferenced too but seconds old → kept.
    const first = applyGc({ blobs: true, graceMs: 15 * 60 * 1000 });
    expect(first.deletedIndexes.map((d) => d.repoId).sort()).toEqual([deadId, orphanId].sort());
    expect(first.failedIndexes).toEqual([]);
    expect(existsSync(join(getIndexDir(), `${orphanId}.db`))).toBe(false);
    expect(existsSync(join(getIndexDir(), `${deadId}.db`))).toBe(false);
    expect(existsSync(join(getIndexDir(), `${liveId}.db`))).toBe(true);
    expect(existsSync(join(getIndexDir(), `${busyId}.db`))).toBe(true);
    expect(first.blobsDeleted).toBe(1);
    expect(store.has(oldHash)).toBe(false);
    expect(store.has(youngHash)).toBe(true);
    // Without the grace window the dead index's own.ts blob and the young
    // blob are swept; shared.ts (also in the live index) survives.
    const result = applyGc({ blobs: true, graceMs: 0 });
    expect(result.deletedIndexes).toEqual([]);
    expect(result.blobsDeleted).toBe(2);
    expect(store.has(youngHash)).toBe(false);
    expect(store.list().length).toBe(before - 3);
    const db = openDatabase(liveId);
    expect(getRepo(db, liveId)).not.toBeNull();
    expect(getFileContent(db, liveId, 'src/shared.ts')!.toString()).toContain('shared');
    expect(getFileContent(db, liveId, 'src/own.ts')!.toString()).toContain('pc-gc-live-');
    db.close();
    expect(existsSync(getBlobDbPath())).toBe(true);
  });

  it('a second apply finds nothing', () => {
    const result = applyGc({ blobs: true });
    expect(result.deletedIndexes).toEqual([]);
    expect(result.blobsDeleted).toBe(0);
    // Busy index remains until its marker clears.
    clearJobMarker(getJobsDir(), busyId, true);
    const plan = planGc();
    expect(plan.candidates.map((c) => c.repoId)).toEqual([busyId]);
  });

  it('computeRepoId of the scope path finds the same index the hook would', () => {
    expect(computeRepoId(liveRoot)).toBe(liveId);
  });
});
