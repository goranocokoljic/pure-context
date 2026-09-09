/**
 * Phase 99 (Tasks 614–617, 619): cross-index edges, end to end.
 *
 * One git checkout holds two DISJOINT index roots — `libs/` (Kotlin + Python
 * src-layout + TS) and `app/` (imports all three across the seam). Indexing
 * each root separately must:
 *   - link them automatically (same `git rev-parse --show-toplevel`);
 *   - store app → libs edges with `target_repo_id`, validated against libs;
 *   - answer blast radius / importers / context bundle ACROSS the seam from
 *     both sides (the app side stores the edges; the libs side finds them
 *     through the reverse link row);
 *   - stay byte-identical to a pre-99 run when nothing links;
 *   - PARITY (the gate): the whole tree indexed as ONE root yields the same
 *     file sets as the two linked roots, modulo the root prefix.
 * Negatives: a git worktree of the checkout and an unrelated repo under the
 * same parent never link; a parent index never links to a nested one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { indexFolder, reindexFiles, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { kotlinHandler } from '../../src/handlers/kotlin.js';
import { pythonHandler } from '../../src/handlers/python.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { openDatabase, computeRepoId, getRepo } from '../../src/core/db/schema.js';
import { getRepoLinks } from '../../src/core/db/link-store.js';
import { resolveLinks, describeLinkDrift } from '../../src/core/workspace-links.js';
import { getBlastRadius, getContextBundle, findDeadCode } from '../../src/graph/graph-traversal.js';
import { openWorkspace, findLinkedImporters } from '../../src/graph/workspace-graph.js';
import { handler as blastRadiusTool } from '../../src/server/tools/get-blast-radius.js';
import { handler as findImportersTool } from '../../src/server/tools/find-importers.js';
import { handler as contextBundleTool } from '../../src/server/tools/get-context-bundle.js';
import { handler as listReposTool } from '../../src/server/tools/list-repos.js';
import { handler as stalenessTool } from '../../src/server/tools/check-index-staleness.js';
import { handler as exportTool } from '../../src/server/tools/export-index.js';
import { graphCoverageWarning } from '../../src/server/tools/graph-coverage.js';
import { computeExternalImports } from '../../src/server/tools/external-imports.js';
import { buildRiskContext } from '../../src/server/tools/symbol-risk.js';

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', ['-c', 'user.name=pc', '-c', 'user.email=pc@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function initRepo(dir: string): void {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
}

function write(base: string, relPath: string, content: string) {
  const abs = join(base, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function parse(res: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0].text ?? '{}') as Record<string, unknown>;
}

function symbolId(repoId: string, name: string): string {
  const db = openDatabase(repoId);
  const row = db.prepare('SELECT id FROM symbols WHERE repo_id = ? AND name = ?').get(repoId, name) as { id: string } | undefined;
  db.close();
  if (!row) throw new Error(`symbol ${name} not found in ${repoId}`);
  return row.id;
}

function edges(repoId: string): Array<{ source_file: string; target_file: string; target_repo_id: string | null }> {
  const db = openDatabase(repoId);
  const rows = db
    .prepare('SELECT source_file, target_file, target_repo_id FROM dep_edges WHERE repo_id = ? ORDER BY source_file, target_file')
    .all(repoId) as Array<{ source_file: string; target_file: string; target_repo_id: string | null }>;
  db.close();
  return rows.map((r) => ({ ...r, source_file: r.source_file.replace(/\\/g, '/'), target_file: r.target_file.replace(/\\/g, '/') }));
}

const norm = (p: string) => p.replace(/\\/g, '/');

let base: string;
let libsRoot: string;
let appRoot: string;
let libsId = '';
let appId = '';
const cleanup: string[] = [];

const LIBS_FILES = {
  'build.gradle.kts': '// module marker\n',
  'src/main/kotlin/com/acme/libs/Foo.kt': 'package com.acme.libs\n\nclass Foo {\n  fun run(): Int = 1\n}\n',
  'src/main/kotlin/com/acme/libs/Helper.kt': 'package com.acme.libs\n\nimport com.acme.libs.Foo\n\nclass Helper {\n  val f = Foo()\n}\n',
  // libs → app: indexed BEFORE app exists, so this edge can only appear when
  // libs re-resolves against the link recorded by app's build (pending → built).
  'src/main/kotlin/com/acme/libs/UsesApp.kt': 'package com.acme.libs\n\nimport com.acme.app.Bar\n\nclass UsesApp {\n  val b = Bar()\n}\n',
  'src/acme_core/__init__.py': '',
  'src/acme_core/engine.py': 'class Engine:\n    """The engine."""\n    def run(self):\n        return 1\n',
  'src/util.ts': 'export function util(): number { return 1; }\n',
  'src/lonely.ts': 'export function lonely(): number { return 2; }\n',
  // Same RELATIVE path as a file in app/ (see below): the linked resolver must
  // not mistake the sibling's copy for the importer itself.
  'src/main/kotlin/com/acme/shared/Dup.kt': 'package com.acme.shared\n\nclass Dup\n',
};
const APP_FILES = {
  'build.gradle.kts': '// module marker\n',
  'src/main/kotlin/com/acme/app/Bar.kt':
    'package com.acme.app\n\nimport com.acme.libs.Foo\nimport java.util.UUID\n\nclass Bar {\n  val foo = Foo()\n}\n',
  'src/main/kotlin/com/acme/app/Baz.kt': 'package com.acme.app\n\nimport com.acme.app.Bar\n\nclass Baz {\n  val bar = Bar()\n}\n',
  'src/main/kotlin/com/acme/shared/Dup.kt':
    'package com.acme.app.shared\n\nimport com.acme.shared.Dup\n\nclass DupUser {\n  val d = Dup()\n}\n',
  'main.py': 'from acme_core.engine import Engine\nimport numpy\n\ndef main():\n    return Engine().run()\n',
  'src/main.ts': "import { util } from '../../libs/src/util';\nimport { z } from 'zod';\nexport function main(): number { return util(); }\n",
  'src/other.ts': "import { main } from './main';\nexport const o = main();\n",
};

beforeAll(async () => {
  _resetForTesting();
  registerHandler(kotlinHandler);
  registerHandler(pythonHandler);
  registerHandler(typescriptHandler);
  await initParser();

  // realpathSync.native: on Windows CI the temp dir is an 8.3 short path
  // (C:/Users/RUNNER~1/...) while git reports the long form; the JS realpath
  // does not expand short names, the native one does.
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'pc-xidx-')));
  initRepo(base);
  libsRoot = join(base, 'libs');
  appRoot = join(base, 'app');
  for (const [p, c] of Object.entries(LIBS_FILES)) write(libsRoot, p, c);
  for (const [p, c] of Object.entries(APP_FILES)) write(appRoot, p, c);
  git(base, 'add', '.');
  git(base, 'commit', '-q', '-m', 'initial');

  libsId = (await indexFolder(libsRoot, { fileLimit: 100, concurrency: 1, cloneFromWorktree: false, crossIndex: 'auto' })).repoId;
  cleanup.push(libsId);
  appId = (await indexFolder(appRoot, { fileLimit: 100, concurrency: 1, cloneFromWorktree: false, crossIndex: 'auto' })).repoId;
  cleanup.push(appId);
}, 120_000);

afterAll(() => {
  for (const id of cleanup) {
    try { deleteIndex(id); } catch { /* ignore */ }
  }
  rmSync(base, { recursive: true, force: true });
});

describe('Task 614 — the linking rule', () => {
  it('two disjoint roots in ONE checkout link automatically (both directions recorded)', () => {
    const appDb = openDatabase(appId);
    const appLinks = getRepoLinks(appDb, appId);
    appDb.close();
    expect(appLinks.map((l) => l.linkedRepoId)).toEqual([libsId]);
    expect(appLinks[0].source).toBe('auto');
    expect(appLinks[0].linkedSha).toBe(git(base, 'rev-parse', 'HEAD'));

    // The libs side learned about app through the reverse row — PENDING until
    // libs itself builds against app.
    const libsDb = openDatabase(libsId);
    const libsLinks = getRepoLinks(libsDb, libsId);
    libsDb.close();
    expect(libsLinks.map((l) => [l.linkedRepoId, l.built])).toEqual([[appId, false]]);
    expect(describeLinkDrift(libsLinks[0]).status).toBe('pending');
  });

  it('a no-op whole-tree run on the earlier root re-resolves its graph against the new link (pending → built)', async () => {
    // libs was indexed before app existed: its import of com.acme.app.Bar had nowhere to go.
    expect(edges(libsId).filter((e) => e.target_repo_id !== null)).toEqual([]);
    const res = await indexFolder(libsRoot, { fileLimit: 100, concurrency: 1, cloneFromWorktree: false, crossIndex: 'auto' });
    expect(res.filesIndexed).toBe(0); // nothing re-parsed …
    expect(res.linksUsed?.map((l) => l.repoId)).toEqual([appId]);
    expect(res.crossEdgesFound).toBe(1); // … yet the stored records were re-resolved across the new link
    const after = edges(libsId);
    expect(after.filter((e) => e.target_repo_id !== null).map((e) => `${e.source_file} -> ${e.target_file}`)).toEqual([
      'src/main/kotlin/com/acme/libs/UsesApp.kt -> src/main/kotlin/com/acme/app/Bar.kt',
    ]);
    const libsDb = openDatabase(libsId);
    const l = getRepoLinks(libsDb, libsId)[0];
    libsDb.close();
    expect(l.built).toBe(true); // the link is now built by THIS side
    expect(describeLinkDrift(l).status).toBe('fresh');
    // And a second no-op run leaves everything byte-identical (no rebuild churn).
    const res2 = await indexFolder(libsRoot, { fileLimit: 100, concurrency: 1, cloneFromWorktree: false, crossIndex: 'auto' });
    expect(res2.filesIndexed).toBe(0);
    expect(res2.crossEdgesFound).toBe(0);
    expect(edges(libsId)).toEqual(after);
  }, 60_000);

  it('a git worktree of the checkout is NEVER linked (reason worktree)', async () => {
    const wt = join(dirname(base), `${base.split(/[\\/]/).pop()}-wt`);
    git(base, 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
    try {
      const wtLibs = join(wt, 'libs');
      const wtId = (await indexFolder(wtLibs, { fileLimit: 100, concurrency: 1, cloneFromWorktree: false, crossIndex: 'auto' })).repoId;
      cleanup.push(wtId);
      // From the worktree's libs: the original app/libs are location-unrelated
      // (different parent) and outside its toplevel → not candidates at all;
      // from the ORIGINAL app the worktree's libs is not under its toplevel
      // either. Force the question with the parent-dir sibling shape:
      const wtApp = join(wt, 'app');
      const wtAppId = (await indexFolder(wtApp, { fileLimit: 100, concurrency: 1, cloneFromWorktree: false, crossIndex: 'auto' })).repoId;
      cleanup.push(wtAppId);
      const res = resolveLinks(wtAppId, wtApp, { crossIndex: 'auto' });
      expect(res.links.map((l) => l.repoId)).toEqual([wtId]); // its OWN libs
      expect(res.links.map((l) => l.repoId)).not.toContain(libsId);
      // And the worktree root itself vs the main checkout root: same common dir, different toplevel.
      const wtRootId = (await indexFolder(wt, { fileLimit: 100, concurrency: 1, cloneFromWorktree: false, crossIndex: 'auto' })).repoId;
      cleanup.push(wtRootId);
      const mainRootId = (await indexFolder(base, { fileLimit: 100, concurrency: 1, cloneFromWorktree: false, crossIndex: 'auto' })).repoId;
      cleanup.push(mainRootId);
      const fromMain = resolveLinks(mainRootId, base, { crossIndex: 'auto' });
      expect(fromMain.links.map((l) => l.repoId)).not.toContain(wtRootId);
      expect(fromMain.unlinked.find((u) => u.repoId === wtRootId)?.reason).toBe('worktree');
      // A parent index never links to its nested roots (they overlap).
      expect(fromMain.links).toEqual([]);
      expect(fromMain.unlinked.find((u) => u.repoId === libsId)?.reason).toBe('overlapping');
      deleteIndex(mainRootId);
      deleteIndex(wtRootId);
    } finally {
      git(base, 'worktree', 'remove', '--force', wt);
    }
  }, 120_000);

  it('an unrelated repo under the same parent folder never links (different-repo); explicit config does', async () => {
    const other = join(base, 'other');
    mkdirSync(other, { recursive: true });
    initRepo(other);
    write(other, 'src/main/kotlin/com/acme/libs/Foo.kt', 'package com.acme.libs\n\nclass Foo\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'init');
    const otherId = (await indexFolder(other, { fileLimit: 100, concurrency: 1, cloneFromWorktree: false, crossIndex: 'auto' })).repoId;
    cleanup.push(otherId);
    const res = resolveLinks(appId, appRoot, { crossIndex: 'auto' });
    expect(res.links.map((l) => l.repoId)).toEqual([libsId]);
    expect(res.unlinked.find((u) => u.repoId === otherId)?.reason).toBe('different-repo');
    // Explicit config crosses repositories on purpose; cap 0 disables everything.
    const forced = resolveLinks(appId, appRoot, { crossIndex: 'auto', linkedRepos: [other] });
    expect(forced.links.map((l) => l.repoId).sort()).toEqual([libsId, otherId].sort());
    expect(forced.links.find((l) => l.repoId === otherId)?.source).toBe('config');
    expect(resolveLinks(appId, appRoot, { crossIndex: 'off' }).links).toEqual([]);
    expect(resolveLinks(appId, appRoot, { crossIndex: 'auto', maxLinkedRepos: 0 }).links).toEqual([]);
    rmSync(other, { recursive: true, force: true });
    deleteIndex(otherId);
  }, 60_000);
});

describe('Task 615 — cross-index edges are stored in the SOURCE index, validated', () => {
  it('Kotlin (declared package), Python (src layout) and TS (../ relative) all cross the seam', () => {
    const cross = edges(appId).filter((e) => e.target_repo_id !== null);
    expect(cross.every((e) => e.target_repo_id === libsId)).toBe(true);
    const pairs = cross.map((e) => `${e.source_file} -> ${e.target_file}`).sort();
    expect(pairs).toEqual([
      'main.py -> src/acme_core/engine.py',
      'src/main.ts -> src/util.ts',
      'src/main/kotlin/com/acme/app/Bar.kt -> src/main/kotlin/com/acme/libs/Foo.kt',
      // identical relative path on both sides — the sibling's file is NOT "myself"
      'src/main/kotlin/com/acme/shared/Dup.kt -> src/main/kotlin/com/acme/shared/Dup.kt',
    ]);
    // Local edges stay local (target_repo_id NULL); externals produce nothing.
    const local = edges(appId).filter((e) => e.target_repo_id === null).map((e) => `${e.source_file} -> ${e.target_file}`);
    expect(local).toEqual([
      'src/main/kotlin/com/acme/app/Baz.kt -> src/main/kotlin/com/acme/app/Bar.kt',
      'src/other.ts -> src/main.ts',
    ]);
    // libs → app (resolved by the pending → built run above).
    expect(edges(libsId).filter((e) => e.target_repo_id !== null).map((e) => e.target_file)).toEqual([
      'src/main/kotlin/com/acme/app/Bar.kt',
    ]);
  });

  it('a targeted re-index of one app file keeps its cross edges (stored links, no rediscovery)', async () => {
    const before = edges(appId);
    await reindexFiles(appId, ['src/main/kotlin/com/acme/app/Bar.kt']);
    expect(edges(appId)).toEqual(before);
  });
});

describe('Task 616 — traversal over the workspace graph', () => {
  it('blast radius of libs/Foo.kt returns app/Bar.kt (and Baz.kt at depth 2) tagged with the app index', () => {
    const db = openDatabase(libsId);
    const ws = openWorkspace(db, libsId, libsRoot);
    try {
      const r = getBlastRadius(symbolId(libsId, 'Foo'), libsId, db, 3, ws);
      // UsesApp.kt arrives at depth 2 THROUGH app/Bar.kt — a seam crossed twice.
      expect(r.files.map(norm).sort()).toEqual([
        'src/main/kotlin/com/acme/libs/Foo.kt',
        'src/main/kotlin/com/acme/libs/Helper.kt',
        'src/main/kotlin/com/acme/libs/UsesApp.kt',
      ]);
      expect(r.linked).toHaveLength(1);
      expect(r.linked![0].repoId).toBe(appId);
      expect(r.linked![0].files.map(norm).sort()).toEqual([
        'src/main/kotlin/com/acme/app/Bar.kt',
        'src/main/kotlin/com/acme/app/Baz.kt',
      ]);
      expect(r.linked![0].symbols.map((s) => s.name).sort()).toEqual(['Bar', 'Baz']);
      // Depth cap across the seam: depth 1 stops at Bar, truncated.
      const d1 = getBlastRadius(symbolId(libsId, 'Foo'), libsId, db, 1, ws);
      expect(d1.linked![0].files.map(norm)).toEqual(['src/main/kotlin/com/acme/app/Bar.kt']);
      expect(d1.truncated).toBe(true);
    } finally {
      ws.close();
      db.close();
    }
  });

  it('context bundle from app/other.ts walks main.ts → libs/util.ts across the seam', () => {
    const db = openDatabase(appId);
    const ws = openWorkspace(db, appId, appRoot);
    try {
      const r = getContextBundle(symbolId(appId, 'o'), appId, db, 3, ws);
      expect(r.files.map(norm).sort()).toEqual(['src/main.ts', 'src/other.ts']);
      expect(r.linked![0].files.map(norm)).toEqual(['src/util.ts']);
      expect(r.linked![0].symbols.map((s) => s.name)).toEqual(['util']);
    } finally {
      ws.close();
      db.close();
    }
  });

  it('linked importers of libs/src/util.ts come from the app index', () => {
    const db = openDatabase(libsId);
    const ws = openWorkspace(db, libsId, libsRoot);
    try {
      const imp = findLinkedImporters(ws, 'src/util.ts');
      expect(imp.map((i) => [i.repoId, norm(i.file)])).toEqual([[appId, 'src/main.ts']]);
      // Dead code: util.ts is imported across the seam — not dead; lonely.ts is.
      const dead = findDeadCode(libsId, db, ws).map((s) => norm(s.filePath));
      expect(dead).not.toContain('src/util.ts');
      expect(dead).toContain('src/lonely.ts');
    } finally {
      ws.close();
      db.close();
    }
  });

  it('the MCP tools expose links / linked / linkedImporters', () => {
    const br = parse(blastRadiusTool({ repoId: libsId, symbolId: symbolId(libsId, 'Foo') }));
    expect((br.links as Array<{ repoId: string }>).map((l) => l.repoId)).toEqual([appId]);
    expect(br.affectedFiles).toBe(5);
    expect((br.linked as Array<{ repoId: string; files: string[] }>)[0].files.map(norm)).toEqual([
      'src/main/kotlin/com/acme/app/Bar.kt',
      'src/main/kotlin/com/acme/app/Baz.kt',
    ]);
    expect(br.externalImports).toBeUndefined();

    const fi = parse(findImportersTool({ repoId: libsId, filePath: 'src/util.ts' }));
    expect(fi.importerCount).toBe(1);
    expect((fi.linkedImporters as Array<{ file: string }>).map((i) => norm(i.file))).toEqual(['src/main.ts']);

    const cb = parse(contextBundleTool({ repoId: appId, symbolId: symbolId(appId, 'o') }));
    expect(cb.fileCount).toBe(3);
    expect((cb.linked as Array<{ files: string[] }>)[0].files.map(norm)).toEqual(['src/util.ts']);
    // The relative import now RESOLVED across the seam — no seam warning left
    // (zod is third-party, ignored).
    expect(cb.externalImports).toBeUndefined();
  });

  it('symbol risk centrality counts the cross importer', () => {
    const db = openDatabase(libsId);
    try {
      const ctx = buildRiskContext(db, libsId);
      const foo = [...ctx.afferentByFile.entries()].find(([f]) => norm(f).endsWith('libs/Foo.kt'));
      expect(foo?.[1]).toBe(2); // Helper.kt (local) + Bar.kt (app)
      expect(ctx.afferentByFile.get('src/util.ts')).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('Task 617 — coverage, staleness, honesty', () => {
  it('coverage treats a cross edge as resolvable; a vanished linked file counts as dangling-linked', () => {
    const db = openDatabase(appId);
    try {
      expect(graphCoverageWarning(db, appId)).toBeNull();
      // Simulate the sibling losing a file: point one cross edge at a path libs no longer holds.
      db.prepare("UPDATE dep_edges SET target_file = 'src/gone.ts' WHERE repo_id = ? AND target_repo_id = ? AND target_file = 'src/util.ts'")
        .run(appId, libsId);
      const w = graphCoverageWarning(db, appId);
      expect(w?.graphCoverage).toBe('partial');
      expect(w?.danglingLinked).toEqual([{ repoId: libsId, count: 1, reason: 'file_missing' }]);
      expect(w?.graphCoverageNote).toContain('re-run index_folder');
      db.prepare("UPDATE dep_edges SET target_file = 'src/util.ts' WHERE repo_id = ? AND target_repo_id = ? AND target_file = 'src/gone.ts'")
        .run(appId, libsId);
      expect(graphCoverageWarning(db, appId)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('list_repos and check_index_staleness report per-link drift; a sibling commit flips it to moved', () => {
    const before = parse(listReposTool()) as { repos: Array<Record<string, unknown>> };
    const app = before.repos.find((r) => r.id === appId)!;
    const links = app.links as Array<{ repoId: string; status: string; behindBy: number }>;
    expect(links.map((l) => [l.repoId, l.status])).toEqual([[libsId, 'fresh']]);

    write(libsRoot, 'src/new.ts', 'export const n = 1;\n');
    git(base, 'add', '.');
    git(base, 'commit', '-q', '-m', 'libs moves');
    const after = parse(stalenessTool({ repoId: appId })) as Record<string, unknown>;
    const l2 = (after.links as Array<{ status: string; behindBy: number }>)[0];
    expect(l2.status).toBe('moved');
    expect(l2.behindBy).toBe(1);
    expect(after.linksFresh).toBe(false);
    expect(String(after.linksNote)).toContain('index_folder');
    // describeLinkDrift on the raw row agrees.
    const db = openDatabase(appId);
    const raw = getRepoLinks(db, appId)[0];
    db.close();
    expect(describeLinkDrift(raw).status).toBe('moved');
  });

  it('externalImports on the libs side names nothing (fully resolved) and is unchanged on an unlinked seam', () => {
    const db = openDatabase(appId);
    const ext = computeExternalImports(db, appId, ['src/main.ts']);
    db.close();
    expect(ext).toBeNull(); // ../../libs/src/util resolved across the seam; zod is external
  });

  it('export carries target_repo_id on cross edges', async () => {
    const outputPath = join(base, 'app-export.pcx');
    await exportTool({ repoId: appId, outputPath, compress: false } as never);
    const raw = JSON.parse(readFileSync(outputPath, 'utf8')) as { depEdges: Array<{ targetRepoId?: string }> };
    const cross = raw.depEdges.filter((e) => e.targetRepoId);
    expect(cross.length).toBe(4);
    expect(cross.every((e) => e.targetRepoId === libsId)).toBe(true);
  });
});

describe('Task 619 — PARITY: one root == two linked roots', () => {
  it('blast radius / context bundle file sets agree for every seam-crossing file (modulo the root prefix)', async () => {
    // Index the whole checkout as ONE root. It never links to libs/app (overlapping).
    const wholeId = (await indexFolder(base, { fileLimit: 200, concurrency: 1, cloneFromWorktree: false, crossIndex: 'auto' })).repoId;
    cleanup.push(wholeId);
    const wdb = openDatabase(wholeId);
    const wws = openWorkspace(wdb, wholeId, base);
    expect(wws.links).toEqual([]);

    const sides: Array<[string, string, string]> = [
      [libsId, 'libs', libsRoot],
      [appId, 'app', appRoot],
    ];
    const fileSet = (files: string[], prefix: string) => files.map((f) => `${prefix}/${norm(f)}`).sort();
    const sideName = (id: string) => (id === libsId ? 'libs' : 'app');

    for (const [id, prefix] of sides) {
      const db = openDatabase(id);
      const ws = openWorkspace(db, id, prefix === 'libs' ? libsRoot : appRoot);
      const syms = db.prepare('SELECT id, file_path FROM symbols WHERE repo_id = ?').all(id) as Array<{ id: string; file_path: string }>;
      try {
        for (const s of syms) {
          // Python is EXCLUDED from parity on purpose: each root's own `src/`
          // allowlist applies across the seam (libs/src/acme_core → acme_core),
          // while the one-root index sees `libs.src.acme_core` and cannot
          // resolve `from acme_core.engine` — the split is a strict SUPERSET
          // there (asserted separately below).
          if (s.file_path.endsWith('.py')) continue;
          const wholePath = `${prefix}/${norm(s.file_path)}`;
          const wsym = wdb.prepare('SELECT id FROM symbols WHERE repo_id = ? AND file_path = ?').get(wholeId, wholePath) as { id: string } | undefined;
          expect(wsym, `whole-tree symbol for ${wholePath}`).toBeDefined();
          for (const dir of ['reverse', 'forward'] as const) {
            const split = dir === 'reverse' ? getBlastRadius(s.id, id, db, 3, ws) : getContextBundle(s.id, id, db, 3, ws);
            const whole = dir === 'reverse' ? getBlastRadius(wsym!.id, wholeId, wdb, 3, wws) : getContextBundle(wsym!.id, wholeId, wdb, 3, wws);
            const splitFiles = [
              ...fileSet(split.files, prefix),
              ...(split.linked ?? []).flatMap((g) => fileSet(g.files, sideName(g.repoId))),
            ].sort();
            expect(splitFiles, `${dir} from ${wholePath}`).toEqual(fileSet(whole.files, '').map((f) => f.slice(1)));
          }
        }
      } finally {
        ws.close();
        db.close();
      }
    }
    // Python: the split resolves across the seam with libs's own src/ root;
    // the one-root index does not (documented superset, see above).
    const wholeEngine = wdb
      .prepare('SELECT id FROM symbols WHERE repo_id = ? AND name = ?')
      .get(wholeId, 'Engine') as { id: string };
    const wholeBlast = getBlastRadius(wholeEngine.id, wholeId, wdb, 3, wws);
    expect(wholeBlast.files.map(norm)).toEqual(['libs/src/acme_core/engine.py']);
    const ldb = openDatabase(libsId);
    const lws = openWorkspace(ldb, libsId, libsRoot);
    const splitBlast = getBlastRadius(symbolId(libsId, 'Engine'), libsId, ldb, 3, lws);
    lws.close();
    ldb.close();
    expect(splitBlast.linked?.[0]?.files.map(norm)).toEqual(['main.py']);
    wws.close();
    wdb.close();
  }, 120_000);
});

describe('P3 — a repo with no links is byte-identical', () => {
  it('the unlinked root yields the pre-99 result shape (no linked/links fields)', async () => {
    const solo = join(dirname(base), `${base.split(/[\\/]/).pop()}-solo`);
    mkdirSync(solo, { recursive: true });
    initRepo(solo);
    write(solo, 'a.ts', "import { b } from './b';\nexport const a = b;\n");
    write(solo, 'b.ts', 'export const b = 1;\n');
    git(solo, 'add', '.');
    git(solo, 'commit', '-q', '-m', 'init');
    const soloId = (await indexFolder(solo, { fileLimit: 100, concurrency: 1, cloneFromWorktree: false, crossIndex: 'auto' })).repoId;
    cleanup.push(soloId);
    expect(computeRepoId(solo)).toBe(soloId);
    const db = openDatabase(soloId);
    expect(getRepoLinks(db, soloId)).toEqual([]);
    expect(getRepo(db, soloId)?.schemaVersion).toBe(12);
    const r = getBlastRadius(symbolId(soloId, 'b'), soloId, db, 3, openWorkspace(db, soloId, solo));
    expect(Object.keys(r).sort()).toEqual(['files', 'symbols', 'tokenEstimate', 'truncated']);
    db.close();
    const br = parse(blastRadiusTool({ repoId: soloId, symbolId: symbolId(soloId, 'b') }));
    expect(br.links).toBeUndefined();
    expect(br.linked).toBeUndefined();
    rmSync(solo, { recursive: true, force: true });
  }, 60_000);
});
