/**
 * Phase 100 (Task 621) — shared content-addressed blob store.
 *
 * P1: every reader goes through file-store, so an index whose rows hold
 *     NULL `raw_content` (bytes in blobs.db) must answer every tool
 *     byte-identically to an index that holds the bytes inline.
 * P2: dedup by hash — two indexes of the same bytes store one blob.
 * P3: inline rows keep reading inline; a pre-v13 index migrates on its next
 *     whole-tree run without a re-parse.
 * R1: a failed blob write leaves the bytes inline, never lost.
 * R5: export always carries bytes; import stores by the importing mode.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

import { indexFolder, reindexFiles, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { computeRepoId, openDatabase, getRepo, getDataDir, getIndexDir, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { getSqliteFactory } from '../../src/core/db/sqlite-loader.js';
import {
  openBlobStore,
  closeBlobStores,
  getBlobDbPath,
  contentStoreMode,
} from '../../src/core/db/blob-store.js';
import {
  getFileContent,
  getAllFilesWithContent,
  getFileSizeBytes,
  getFileSizesBatch,
  getTenantStorageBytes,
  inlineContentBytes,
  moveInlineContentToBlobs,
  persistContent,
  upsertFile,
} from '../../src/core/db/file-store.js';
import { getSymbolLineRange } from '../../src/server/tools/symbol-lines.js';
import { handler as searchAst } from '../../src/server/tools/search-ast.js';
import { handler as searchByDecorator } from '../../src/server/tools/search-by-decorator.js';
import { handler as findUntested } from '../../src/server/tools/find-untested-symbols.js';
import { handler as getPublicApi } from '../../src/server/tools/get-public-api.js';
import { handler as getFileContentTool } from '../../src/server/tools/get-file-content.js';
import { handler as getEntryPoints } from '../../src/server/tools/get-entry-points.js';
import { handler as exportIndex } from '../../src/server/tools/export-index.js';
import { handler as importIndex } from '../../src/server/tools/import-index.js';
import { cloneIndex, findCloneSource } from '../../src/core/worktree-clone.js';
import { gitHeadSha } from '../../src/core/git-head.js';

const cleanup: string[] = [];
let fixtureA: string;
let fixtureB: string;

function write(root: string, relPath: string, content: string) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function makeFixture(prefix: string): string {
  const root = resolve(mkdtempSync(join(tmpdir(), prefix)));
  write(root, 'src/util.ts', 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  write(
    root,
    'src/service.ts',
    "import { add } from './util.js';\n\n/** Sums. */\nexport class Calc {\n  @log()\n  run(x: number): number {\n    return add(x, 1);\n  }\n}\nfunction log() { return (_t: unknown, _k: string) => {}; }\nexport const NAME = 'calc — ünïcödé';\n",
  );
  write(root, 'src/main.ts', "import { Calc } from './service.js';\nexport function main(): void {\n  new Calc().run(2);\n}\n");
  write(root, 'test/util.test.ts', "import { add } from '../src/util.js';\ndescribe('add', () => { it('works', () => { expect(add(1, 2)).toBe(3); }); });\n");
  return root;
}

function stripMeta(res: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = res.content[0]?.text ?? '';
  const obj = JSON.parse(text) as Record<string, unknown>;
  delete obj['_meta'];
  return obj;
}

/** Index `root` under the given content mode; returns the repoId. */
async function indexIn(mode: 'blob' | 'inline', root: string, git = false): Promise<string> {
  const prev = process.env['PCTX_CONTENT_STORE'];
  process.env['PCTX_CONTENT_STORE'] = mode;
  try {
    const r = await indexFolder(root, { skipGit: !git, crossIndex: 'off' });
    cleanup.push(r.repoId);
    return r.repoId;
  } finally {
    if (prev === undefined) delete process.env['PCTX_CONTENT_STORE'];
    else process.env['PCTX_CONTENT_STORE'] = prev;
  }
}

function rowsNullCount(repoId: string): { total: number; nulls: number } {
  const db = openDatabase(repoId);
  const row = db
    .prepare<[string], { total: number; nulls: number }>(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN raw_content IS NULL THEN 1 ELSE 0 END) AS nulls FROM files WHERE repo_id = ?',
    )
    .get(repoId)!;
  db.close();
  return { total: row.total, nulls: row.nulls ?? 0 };
}

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  await initParser();
  fixtureA = makeFixture('pc-blob-a-');
  fixtureB = makeFixture('pc-blob-b-');
});

afterAll(() => {
  for (const id of cleanup) {
    try {
      deleteIndex(id);
    } catch {
      /* ignore */
    }
  }
  rmSync(fixtureA, { recursive: true, force: true });
  rmSync(fixtureB, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env['PCTX_CONTENT_STORE'];
});

describe('blob store primitives', () => {
  it('lives under PCTX_DATA_DIR and round-trips bytes by hash', () => {
    expect(getBlobDbPath().startsWith(getDataDir())).toBe(true);
    expect(getBlobDbPath().startsWith(process.env['PCTX_DATA_DIR']!)).toBe(true);
    const store = openBlobStore({ createIfMissing: true })!;
    const bytes = Buffer.from('hello — ünï ' + Math.random());
    const hash = 'h' + Math.random().toString(16).slice(2);
    expect(store.has(hash)).toBe(false);
    expect(store.put(hash, bytes)).toBe(true);
    expect(store.put(hash, Buffer.from('different'))).toBe(true); // INSERT OR IGNORE keeps the first
    expect(store.get(hash)!.equals(bytes)).toBe(true);
    expect(store.sizeOf(hash)).toBe(bytes.length);
    const many = store.getMany([hash, 'nope']);
    expect(many.size).toBe(1);
    expect(store.deleteMany([hash])).toBe(1);
    expect(store.get(hash)).toBeNull();
  });

  it('putMany dedups within a batch and across connections', () => {
    const store = openBlobStore({ createIfMissing: true })!;
    const hash = 'dup' + Math.random().toString(16).slice(2);
    const present = store.putMany([
      { hash, bytes: Buffer.from('one') },
      { hash, bytes: Buffer.from('one') },
    ]);
    expect(present.has(hash)).toBe(true);
    // A second, independent connection (another process in real life) racing
    // on the same hash: INSERT OR IGNORE — exactly one row survives.
    const other = getSqliteFactory().open(store.path);
    other
      .prepare('INSERT OR IGNORE INTO blobs (hash, bytes, size, created_at) VALUES (?, ?, ?, ?)')
      .run(hash, Buffer.from('two'), 3, Date.now());
    other.close();
    const n = store.db.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM blobs WHERE hash = ?').get(hash)!.c;
    expect(n).toBe(1);
    expect(store.get(hash)!.toString()).toBe('one');
    store.deleteMany([hash]);
  });

  it('contentStoreMode honours PCTX_CONTENT_STORE', () => {
    process.env['PCTX_CONTENT_STORE'] = 'inline';
    expect(contentStoreMode()).toBe('inline');
    process.env['PCTX_CONTENT_STORE'] = 'blob';
    expect(contentStoreMode()).toBe('blob');
  });
});

describe('inline vs blob parity (P1)', () => {
  let inlineId: string;
  let blobId: string;

  beforeAll(async () => {
    inlineId = await indexIn('inline', fixtureA);
    // Same bytes, second root: the blob-mode index shares every blob with
    // any other blob-mode index of the same content (P2).
    blobId = await indexIn('blob', fixtureB);
  });

  it('stores NULL rows in blob mode and inline bytes in inline mode', () => {
    const a = rowsNullCount(inlineId);
    expect(a.total).toBe(4);
    expect(a.nulls).toBe(0);
    const b = rowsNullCount(blobId);
    expect(b.total).toBe(4);
    expect(b.nulls).toBe(4);
    expect(existsSync(getBlobDbPath())).toBe(true);
    const dbB = openDatabase(blobId);
    expect(inlineContentBytes(dbB, blobId)).toBe(0);
    dbB.close();
    const dbA = openDatabase(inlineId);
    expect(inlineContentBytes(dbA, inlineId)).toBeGreaterThan(0);
    dbA.close();
  });

  it('file-store accessors answer identically', () => {
    const dbA = openDatabase(inlineId);
    const dbB = openDatabase(blobId);
    const filesA = getAllFilesWithContent(dbA, inlineId);
    const filesB = getAllFilesWithContent(dbB, blobId);
    expect(filesA.map((f) => f.path)).toEqual(filesB.map((f) => f.path));
    for (let i = 0; i < filesA.length; i++) {
      expect(filesB[i]!.rawContent!.equals(filesA[i]!.rawContent!)).toBe(true);
      expect(getFileContent(dbB, blobId, filesA[i]!.path)!.equals(filesA[i]!.rawContent!)).toBe(true);
      expect(getFileSizeBytes(dbB, blobId, filesA[i]!.path)).toBe(getFileSizeBytes(dbA, inlineId, filesA[i]!.path));
    }
    const paths = filesA.map((f) => f.path);
    expect([...getFileSizesBatch(dbB, blobId, paths).entries()]).toEqual([...getFileSizesBatch(dbA, inlineId, paths).entries()]);
    expect(getAllFilesWithContent(dbB, blobId, { pathPrefix: 'src/s' }).map((f) => f.path)).toEqual(['src/service.ts']);
    expect(getFileContent(dbB, blobId, 'src/service.ts', 'local')!.toString()).toContain('ünïcödé');
    expect(getFileContent(dbB, blobId, 'missing.ts')).toBeNull();
    // Tenant storage bytes: the blob index counts its blob sizes.
    expect(getTenantStorageBytes(dbB, 'local')).toBeGreaterThan(0);
    dbA.close();
    dbB.close();
  });

  it('symbol line ranges resolve through the blob store', () => {
    const dbA = openDatabase(inlineId);
    const dbB = openDatabase(blobId);
    const ids = dbA
      .prepare<[string], { id: string }>('SELECT id FROM symbols WHERE repo_id = ? ORDER BY id')
      .all(inlineId)
      .map((r) => r.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(getSymbolLineRange(dbB, blobId, id)).toEqual(getSymbolLineRange(dbA, inlineId, id));
    }
    dbA.close();
    dbB.close();
  });

  it('every content-reading tool returns the same payload', async () => {
    const pairs: Array<[string, (repoId: string) => Promise<unknown> | unknown]> = [
      ['get_file_content', (id) => getFileContentTool({ repoId: id, filePath: 'src/service.ts' })],
      ['search_ast', (id) => searchAst({ repoId: id, nodeType: 'class_declaration' })],
      ['search_by_decorator', (id) => searchByDecorator({ repoId: id, decoratorName: 'log' })],
      ['find_untested_symbols', (id) => findUntested({ repoId: id })],
      ['get_public_api', (id) => getPublicApi({ repoId: id })],
      ['get_entry_points', (id) => getEntryPoints({ repoId: id })],
    ];
    for (const [name, call] of pairs) {
      const a = stripMeta((await call(inlineId)) as never);
      const b = stripMeta((await call(blobId)) as never);
      const norm = (o: unknown) => JSON.parse(JSON.stringify(o).replaceAll(inlineId, 'ID').replaceAll(blobId, 'ID'));
      expect(norm(b), name).toEqual(norm(a));
    }
  });

  it('export carries bytes inline; import stores by the importing mode (R5)', async () => {
    const out = join(tmpdir(), `pc-blob-export-${Date.now()}.pcx`);
    const res = await exportIndex({ repoId: blobId, outputPath: out, compress: false, includeVectors: false });
    expect(res.isError).toBeFalsy();
    const bundle = JSON.parse(readFileSync(out, 'utf8')) as {
      files: Array<{ path: string; rawContent: string | null }>;
    };
    expect(bundle.files.every((f) => typeof f.rawContent === 'string' && f.rawContent.length > 0)).toBe(true);

    // Import re-creates the SAME repo id (the bundle's); drop the index first
    // so the import is a from-scratch write in blob mode.
    deleteIndex(blobId);
    expect(existsSync(join(getIndexDir(), `${blobId}.db`))).toBe(false);
    process.env['PCTX_CONTENT_STORE'] = 'blob';
    const imp = await importIndex({ bundlePath: out });
    expect(imp.isError).toBeFalsy();
    const c = rowsNullCount(blobId);
    expect(c.total).toBe(4);
    expect(c.nulls).toBe(4);
    const db = openDatabase(blobId);
    expect(getFileContent(db, blobId, 'src/service.ts')!.toString()).toContain('ünïcödé');
    expect(getAllFilesWithContent(db, blobId).every((f) => f.rawContent !== null)).toBe(true);
    db.close();
    unlinkSync(out);
  });
});

describe('migration and fallbacks (P3, R1)', () => {
  it('a pre-v13 index moves inline content to blobs on its next whole-tree run, no re-parse', async () => {
    const root = makeFixture('pc-blob-mig-');
    const id = await indexIn('inline', root);
    let db = openDatabase(id);
    db.prepare('UPDATE repos SET schema_version = 12 WHERE id = ?').run(id);
    const symbolsBefore = db.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM symbols WHERE repo_id = ?').get(id)!.c;
    db.close();

    process.env['PCTX_CONTENT_STORE'] = 'blob';
    const r = await indexFolder(root, { skipGit: true, crossIndex: 'off' });
    expect(r.filesIndexed).toBe(0); // hash cache: nothing re-parsed
    expect(r.contentMigrated).toEqual({ files: 4, bytes: expect.any(Number) });
    expect(r.contentMigrated!.bytes).toBeGreaterThan(0);
    const c = rowsNullCount(id);
    expect(c.nulls).toBe(4);
    db = openDatabase(id);
    expect(getRepo(db, id)!.schemaVersion).toBe(SCHEMA_VERSION);
    expect(db.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM symbols WHERE repo_id = ?').get(id)!.c).toBe(symbolsBefore);
    expect(getFileContent(db, id, 'src/util.ts')!.toString()).toContain('export function add');
    db.close();

    // A second run has nothing left to move.
    const r2 = await indexFolder(root, { skipGit: true, crossIndex: 'off' });
    expect(r2.contentMigrated).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it('targeted re-index writes the edited file to the blob store', async () => {
    const root = makeFixture('pc-blob-reidx-');
    const id = await indexIn('blob', root);
    write(root, 'src/util.ts', 'export function add(a: number, b: number): number {\n  return a + b + 0;\n}\nexport const NEW = 1;\n');
    process.env['PCTX_CONTENT_STORE'] = 'blob';
    await reindexFiles(id, ['src/util.ts'], [], { crossIndex: 'off' });
    const c = rowsNullCount(id);
    expect(c.nulls).toBe(4);
    const db = openDatabase(id);
    expect(getFileContent(db, id, 'src/util.ts')!.toString()).toContain('NEW = 1');
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('a hash-only row (no bytes anywhere) reads as null, not as an error', () => {
    const id = 'blobtest-hashonly';
    const db = openDatabase(id);
    db.prepare('INSERT OR REPLACE INTO repos (id, root_path, indexed_at, schema_version) VALUES (?, ?, ?, ?)').run(id, '/tmp/blobtest', Date.now(), SCHEMA_VERSION);
    upsertFile(db, id, 'x.ts', 'deadbeef-no-such-blob');
    expect(getFileContent(db, id, 'x.ts')).toBeNull();
    expect(getFileSizeBytes(db, id, 'x.ts')).toBe(0);
    expect(getAllFilesWithContent(db, id, { onlyWithContent: true })).toEqual([]);
    db.close();
    cleanup.push(id);
  });

  it('inline mode stores bytes inline; blob mode returns null for the row', () => {
    process.env['PCTX_CONTENT_STORE'] = 'inline';
    const bytes = Buffer.from('abc');
    expect(persistContent('h-inline-' + Math.random(), bytes)).toBe(bytes);
    process.env['PCTX_CONTENT_STORE'] = 'blob';
    const h = 'h-blob-' + Math.random();
    expect(persistContent(h, bytes)).toBeNull();
    expect(openBlobStore()!.get(h)!.equals(bytes)).toBe(true);
  });

  it('moveInlineContentToBlobs is a no-op in inline mode and idempotent in blob mode', () => {
    const id = 'blobtest-move';
    const db = openDatabase(id);
    db.prepare('INSERT OR REPLACE INTO repos (id, root_path, indexed_at, schema_version) VALUES (?, ?, ?, ?)').run(id, '/tmp/blobtest-move', Date.now(), SCHEMA_VERSION);
    for (let i = 0; i < 5; i++) upsertFile(db, id, `f${i}.ts`, `hash-move-${i}-${Math.random()}`, Buffer.from(`content ${i}`));
    process.env['PCTX_CONTENT_STORE'] = 'inline';
    expect(moveInlineContentToBlobs(db, id)).toEqual({ files: 0, bytes: 0 });
    process.env['PCTX_CONTENT_STORE'] = 'blob';
    const moved = moveInlineContentToBlobs(db, id, { chunk: 2 });
    expect(moved.files).toBe(5);
    expect(inlineContentBytes(db, id)).toBe(0);
    expect(moveInlineContentToBlobs(db, id)).toEqual({ files: 0, bytes: 0 });
    expect(getFileContent(db, id, 'f3.ts')!.toString()).toBe('content 3');
    db.close();
    cleanup.push(id);
  });
});

// ─── Task 623: content-free worktree clones ───────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', ['-c', 'user.name=pc', '-c', 'user.email=pc@example.com', ...args], { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

describe('worktree clone carries no inline content (Task 623)', () => {
  it('clone of a pre-v13-style (inline) sibling ends up blob-backed and smaller', async () => {
    const gitAvailable = spawnSync('git', ['--version']).status === 0;
    if (!gitAvailable) return;
    // realpath: git reports long paths; mkdtemp may hand back an 8.3 short one.
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'pc-blob-wt-')));
    const main = join(base, 'main');
    mkdirSync(main);
    git(main, 'init', '-q');
    git(main, 'config', 'core.autocrlf', 'false');
    for (let i = 0; i < 30; i++) {
      write(main, `src/m${i}.ts`, `export function f${i}(): string {\n  return ${JSON.stringify('x'.repeat(2000) + i)};\n}\n`);
    }
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'init');
    // Sibling indexed INLINE (the pre-1.33 shape).
    const mainId = await indexIn('inline', main, true);
    expect(gitHeadSha(main)).toBeTruthy();

    const wt = join(base, 'wt');
    git(main, 'worktree', 'add', '-q', wt, '-b', 'feature');
    const wtId = computeRepoId(realpathSync.native(wt));
    cleanup.push(wtId);
    const source = findCloneSource(realpathSync.native(wt));
    expect(source).not.toBeNull();

    process.env['PCTX_CONTENT_STORE'] = 'blob';
    const result = cloneIndex(source!, wtId, realpathSync.native(wt));
    expect(result.contentMoved).toBe(30);
    expect(result.bytes).toBeLessThan(result.bytesCopied);
    const c = rowsNullCount(wtId);
    expect(c.total).toBe(30);
    expect(c.nulls).toBe(30);
    // Parity with the source's content through the accessor.
    const dbM = openDatabase(mainId);
    const dbW = openDatabase(wtId);
    const a = getAllFilesWithContent(dbM, mainId);
    const b = getAllFilesWithContent(dbW, wtId);
    expect(b.map((f) => f.path)).toEqual(a.map((f) => f.path));
    for (let i = 0; i < a.length; i++) expect(b[i]!.rawContent!.equals(a[i]!.rawContent!)).toBe(true);
    dbM.close();
    dbW.close();
    git(main, 'worktree', 'remove', '--force', wt);
    rmSync(base, { recursive: true, force: true });
  });
});

afterAll(() => {
  closeBlobStores();
});
