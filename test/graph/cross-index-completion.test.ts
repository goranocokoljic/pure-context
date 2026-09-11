/**
 * Phase 102 (Tasks 635–640): cross-index COMPLETION — the readers Phase 99
 * left per index now cross a link when asked (`crossIndex: true`):
 *
 *   - find_cycles: a cycle that passes through two roots (ui → lib → ui);
 *   - find_dead_code: `keptAliveByLinks` names the symbols a linked root
 *     imports (symbol-level evidence from the linked import names);
 *   - get_layer_violations / snapshots / compare_change_impact: this root's
 *     rules applied to its edges INTO a linked root (`<rootName>:<path>`);
 *   - get_coupling_map / render_import_graph / render_dep_matrix: cross rows
 *     counted and drawn as `<repoId>:<path>` / `<rootName>:<file>`;
 *   - DI edges (android): a consumer in app/ wired to a provider in core/;
 *   - get_task_context carries the honesty riders;
 *   - P1: without `crossIndex` every tool answers exactly as before;
 *   - P5 PARITY: the whole tree indexed as ONE root agrees with the linked
 *     roots on cycles, layer violations and dead symbols.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { kotlinHandler } from '../../src/handlers/kotlin.js';
import { androidAdapter } from '../../src/adapters/android.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { openWorkspace, workspaceAdjacency, crossReferencedLocalFiles } from '../../src/graph/workspace-graph.js';
import { findImportCycles, findWorkspaceCycles, findDeadCode, getBlastRadius } from '../../src/graph/graph-traversal.js';
import { handler as findCyclesTool } from '../../src/server/tools/find-cycles.js';
import { handler as findDeadCodeTool } from '../../src/server/tools/find-dead-code.js';
import { handler as layerViolationsTool } from '../../src/server/tools/get-layer-violations.js';
import { handler as snapshotTool } from '../../src/server/tools/get-architecture-snapshot.js';
import { handler as compareTool } from '../../src/server/tools/compare-change-impact.js';
import { handler as couplingTool } from '../../src/server/tools/get-coupling-map.js';
import { handler as importGraphTool } from '../../src/server/tools/render-import-graph.js';
import { handler as depMatrixTool } from '../../src/server/tools/render-dep-matrix.js';
import { handler as taskContextTool } from '../../src/server/tools/get-task-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ANDROID_FIXTURE = resolve(__dirname, '../fixtures/android-project');

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', ['-c', 'user.name=pc', '-c', 'user.email=pc@example.com', ...args], { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function write(base: string, relPath: string, content: string) {
  const abs = join(base, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function parse(res: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0].text ?? '{}') as Record<string, unknown>;
}

const norm = (p: string) => p.replace(/\\/g, '/');
const IDX = { fileLimit: 100, concurrency: 1, cloneFromWorktree: false, crossIndex: 'auto' as const };

let base: string;
let uiRoot: string;
let libRoot: string;
let uiId = '';
let libId = '';
const cleanup: string[] = [];

// ui ↔ lib: ping.ts ↔ util.ts is a cycle through BOTH roots; view.ts → db.ts
// is the layer violation (ui may not import lib's db); db.ts has no local
// importer (dead in lib alone — kept alive by ui); lonely.ts is dead.
const UI_FILES = {
  'src/ping.ts': "import { util } from '../../lib/src/util';\nexport function ping(): number { return util(); }\n",
  'src/view.ts': "import { query } from '../../lib/src/db';\nexport function view(): number { return query(); }\n",
  'src/local.ts': "import { view } from './view';\nexport const local = view();\n",
};
const LIB_FILES = {
  'src/util.ts': "import { ping } from '../../ui/src/ping';\nexport function util(): number { return ping(); }\n",
  'src/db.ts': 'export function query(): number { return 1; }\nexport function unusedHelper(): number { return 2; }\n',
  'src/lonely.ts': 'export function lonely(): number { return 3; }\n',
};

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(kotlinHandler);
  await initParser();

  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'pc-x102-')));
  git(base, 'init', '-q', '-b', 'main');
  git(base, 'config', 'core.autocrlf', 'false');
  uiRoot = join(base, 'ui');
  libRoot = join(base, 'lib');
  for (const [p, c] of Object.entries(UI_FILES)) write(uiRoot, p, c);
  for (const [p, c] of Object.entries(LIB_FILES)) write(libRoot, p, c);
  git(base, 'add', '.');
  git(base, 'commit', '-q', '-m', 'initial');

  uiId = (await indexFolder(uiRoot, IDX)).repoId;
  cleanup.push(uiId);
  libId = (await indexFolder(libRoot, IDX)).repoId;
  cleanup.push(libId);
  // ui was indexed before lib existed: rebuild so its imports cross too.
  await indexFolder(uiRoot, IDX);
}, 120_000);

afterAll(() => {
  for (const id of cleanup) {
    try { deleteIndex(id); } catch { /* ignore */ }
  }
  rmSync(base, { recursive: true, force: true });
});

// ─── Task 635 — adjacency + cycles ───────────────────────────────────────────

describe('Task 635 — workspace adjacency and find_cycles across links', () => {
  it('the union adjacency has (repoId, path) nodes and follows cross rows both ways', () => {
    const db = openDatabase(uiId);
    const ws = openWorkspace(db, uiId, uiRoot);
    try {
      const { edges, adj } = workspaceAdjacency(ws);
      const pairs = edges.map((e) => `${e.source.repoId === uiId ? 'ui' : 'lib'}/${norm(e.source.path)} -> ${e.target.repoId === uiId ? 'ui' : 'lib'}/${norm(e.target.path)}`).sort();
      expect(pairs).toEqual([
        'lib/src/util.ts -> ui/src/ping.ts',
        'ui/src/local.ts -> ui/src/view.ts',
        'ui/src/ping.ts -> lib/src/util.ts',
        'ui/src/view.ts -> lib/src/db.ts',
      ]);
      // Every target has an adjacency entry (a leaf is still a node).
      expect(adj.size).toBe(5);
    } finally {
      ws.close();
      db.close();
    }
  });

  it('the local reader sees NO cycle; the workspace reader finds ui/ping ↔ lib/util', () => {
    const db = openDatabase(uiId);
    const ws = openWorkspace(db, uiId, uiRoot);
    try {
      expect(findImportCycles(uiId, db).cycles).toEqual([]);
      const r = findWorkspaceCycles(ws);
      expect(r.totalFound).toBe(1);
      const c = r.cycles[0]!;
      expect(c.crossIndex).toBe(true);
      expect(c.length).toBe(2);
      expect(c.severity).toBe('error');
      expect(c.members.map((m) => [m.repoId === uiId ? 'ui' : 'lib', norm(m.path)]).sort()).toEqual([
        ['lib', 'src/util.ts'],
        ['ui', 'src/ping.ts'],
      ]);
      // Display names: local bare, linked `<repoId>:<path>`.
      expect(c.files.map(norm).sort()).toEqual([`${libId}:src/util.ts`, 'src/ping.ts'].sort());
      // filePath scoping uses the LOCAL path.
      expect(findWorkspaceCycles(ws, 'src/ping.ts').totalFound).toBe(1);
      expect(findWorkspaceCycles(ws, 'src/view.ts').totalFound).toBe(0);
    } finally {
      ws.close();
      db.close();
    }
  });

  it('the tool: crossIndex:true adds links + members; default stays per index (P1)', async () => {
    const local = parse(await findCyclesTool({ repoId: uiId }));
    expect(local.cycles).toEqual([]);
    expect(local.links).toBeUndefined();
    expect(local.crossIndex).toBeUndefined();

    const cross = parse(await findCyclesTool({ repoId: uiId, crossIndex: true }));
    expect(cross.crossIndex).toBe(true);
    expect((cross.links as Array<{ repoId: string }>).map((l) => l.repoId)).toEqual([libId]);
    expect(cross.totalFound).toBe(1);
    const cyc = (cross.cycles as Array<{ files: string[]; crossIndex: boolean; members: unknown[] }>)[0]!;
    expect(cyc.crossIndex).toBe(true);
    expect(cyc.members).toHaveLength(2);
    // DI rows never enter cycle detection (excluded by the adjacency default).
    expect(cyc.files.every((f) => !f.startsWith('di:'))).toBe(true);
  });
});

// ─── Task 636 — dead code ────────────────────────────────────────────────────

describe('Task 636 — dead code kept alive by a link, with symbol evidence', () => {
  it('db.ts is not dead (imported only by ui); lonely.ts is; keptAliveByLinks names who uses what', () => {
    const db = openDatabase(libId);
    const ws = openWorkspace(db, libId, libRoot);
    try {
      const dead = findDeadCode(libId, db, ws).map((s) => norm(s.filePath));
      expect(dead).toContain('src/lonely.ts');
      expect(dead).not.toContain('src/db.ts');
      expect(dead).not.toContain('src/util.ts');
      const cross = crossReferencedLocalFiles(ws);
      expect([...cross.keys()].map(norm).sort()).toEqual(['src/db.ts', 'src/util.ts']);
      const dbInfo = [...cross.values()].find((f) => norm(f.filePath) === 'src/db.ts')!;
      expect(dbInfo.referencedBy.map((r) => [r.repoId, norm(r.file)])).toEqual([[uiId, 'src/view.ts']]);
    } finally {
      ws.close();
      db.close();
    }
    const out = parse(findDeadCodeTool({ repoId: libId }));
    expect((out.links as Array<{ repoId: string }>).map((l) => l.repoId)).toEqual([uiId]);
    const kept = out.keptAliveByLinks as Array<{ filePath: string; referencedBy: unknown[]; symbols: Array<{ name: string; referencedBy: Array<{ repoId: string; file: string }> }> }>;
    // util.ts has a local importer? No — ping.ts is in ui. Both lib files are kept alive by ui only.
    expect(kept.map((k) => norm(k.filePath))).toEqual(['src/db.ts', 'src/util.ts']);
    const dbKept = kept[0]!;
    const query = dbKept.symbols.find((s) => s.name === 'query')!;
    const unused = dbKept.symbols.find((s) => s.name === 'unusedHelper')!;
    // `query` is named by ui's import; `unusedHelper` is kept alive by the file import only.
    expect(query.referencedBy.map((r) => [r.repoId, norm(r.file)])).toEqual([[uiId, 'src/view.ts']]);
    expect(unused.referencedBy).toEqual([]);
    expect((out.files as Array<{ filePath: string }>).map((f) => norm(f.filePath))).toEqual(['src/lonely.ts']);
  });

  it('P1: a repo with no links keeps the pre-102 shape', async () => {
    const solo = join(dirname(base), `${base.split(/[\\/]/).pop()}-solo`);
    mkdirSync(solo, { recursive: true });
    git(solo, 'init', '-q', '-b', 'main');
    write(solo, 'a.ts', "import { b } from './b';\nexport const a = b;\n");
    write(solo, 'b.ts', 'export const b = 1;\n');
    git(solo, 'add', '.');
    git(solo, 'commit', '-q', '-m', 'init');
    const soloId = (await indexFolder(solo, IDX)).repoId;
    cleanup.push(soloId);
    expect(Object.keys(parse(findDeadCodeTool({ repoId: soloId }))).sort()).toEqual(['files', 'totalDeadSymbols']);
    const cyc = parse(await findCyclesTool({ repoId: soloId }));
    expect(Object.keys(cyc).sort()).toEqual(['_meta', '_tokenEstimate', 'cycles', 'totalFound', 'truncated']);
    // Opted in with nothing to link: still the local answer, links: [].
    const cyc2 = parse(await findCyclesTool({ repoId: soloId, crossIndex: true }));
    expect(cyc2.links).toEqual([]);
    expect(cyc2.cycles).toEqual([]);
    const lv = parse(layerViolationsTool({ repoId: soloId, layers: { definitions: [{ name: 'x', paths: ['*.ts'] }], rules: [] } }));
    expect(lv.crossIndex).toBeUndefined();
    rmSync(solo, { recursive: true, force: true });
  }, 60_000);
});

// ─── Task 637 — layers, snapshot, regression delta ───────────────────────────

const UI_LAYERS = {
  definitions: [
    { name: 'ui', paths: ['src/**'] },
    { name: 'db', paths: ['lib:src/db*'] }, // the linked root by its name
    { name: 'libcore', paths: ['lib:src/util*'] },
  ],
  rules: [
    { from: 'ui', to: 'db', allowed: false },
    { from: 'ui', to: 'libcore', allowed: true },
  ],
};

describe('Task 637 — layer rules applied across the seam (`<rootName>:<path>`)', () => {
  it('get_layer_violations: local-only sees nothing; crossIndex catches ui → lib:db', () => {
    const local = parse(layerViolationsTool({ repoId: uiId, layers: UI_LAYERS }));
    expect(local.violations).toEqual([]);
    expect(local.crossIndex).toBeUndefined();

    const cross = parse(layerViolationsTool({ repoId: uiId, layers: UI_LAYERS, crossIndex: true }));
    expect(cross.crossIndex).toBe(true);
    expect((cross.links as Array<{ repoId: string; rootName: string }>).map((l) => [l.repoId, l.rootName])).toEqual([[libId, 'lib']]);
    const v = cross.violations as Array<Record<string, unknown>>;
    expect(v).toHaveLength(1);
    expect(v[0]!.from_layer).toBe('ui');
    expect(v[0]!.to_layer).toBe('db');
    expect(norm(v[0]!.from_file as string)).toBe('src/view.ts');
    expect(norm(v[0]!.to_file as string)).toBe('lib:src/db.ts');
    expect(v[0]!.to_repo_id).toBe(libId);
    expect(norm(v[0]!.to_root as string)).toBe(norm(libRoot));
    expect((cross.summary as { total_violations: number }).total_violations).toBe(1);
  });

  it('snapshot(crossIndex) stores the link set + cross cycles; compare(crossIndex) diffs them; a local-only baseline → no_baseline for the cross part', async () => {
    const snapLocal = parse(await snapshotTool({ repoId: uiId, action: 'create', label: 'local' }));
    expect(snapLocal.crossIndex).toBeUndefined();
    const localId = (snapLocal.snapshot as { snapshotId: string }).snapshotId;

    const cmpNoBase = parse(compareTool({ repoId: uiId, baselineSnapshotId: localId, crossIndex: true }));
    expect(cmpNoBase.crossIndex).toBe(true);
    expect(cmpNoBase.crossBaseline).toBe('no_baseline');
    expect(cmpNoBase.currentCrossCycleCount).toBe(1);
    expect(cmpNoBase.verdict).toBe('unchanged'); // the cross flag is NOT a regression
    expect((cmpNoBase.reasons as string[]).some((r) => r.includes('Cross-index part not compared'))).toBe(true);

    const snapCross = parse(await snapshotTool({ repoId: uiId, action: 'create', label: 'cross', crossIndex: true }));
    expect(snapCross.crossIndex).toBe(true);
    expect(snapCross.crossCycleCount).toBe(1);
    expect((snapCross.links as Array<{ repoId: string }>).map((l) => l.repoId)).toEqual([libId]);
    const crossId = (snapCross.snapshot as { snapshotId: string }).snapshotId;

    const cmp = parse(compareTool({ repoId: uiId, baselineSnapshotId: crossId, crossIndex: true }));
    expect(cmp.crossBaseline).toBe('compared');
    expect(cmp.verdict).toBe('unchanged');
    expect(cmp.newCrossCycles).toEqual([]);
    expect(cmp.resolvedCrossCycles).toEqual([]);
    // Local-only compare against the same snapshot: pre-102 shape (no cross keys).
    const cmpLocal = parse(compareTool({ repoId: uiId, baselineSnapshotId: crossId }));
    expect(cmpLocal.crossIndex).toBeUndefined();
    expect(cmpLocal.crossBaseline).toBeUndefined();

    // diff: same link set → crossCycleCountDelta; local vs cross → no_baseline.
    const diff = parse(await snapshotTool({ repoId: uiId, action: 'diff', snapshotId: crossId, compareId: crossId }));
    expect((diff.diff as { crossCycleCountDelta: number; crossBaseline: string }).crossCycleCountDelta).toBe(0);
    expect((diff.diff as { crossBaseline: string }).crossBaseline).toBe('compared');
    const diff2 = parse(await snapshotTool({ repoId: uiId, action: 'diff', snapshotId: localId, compareId: crossId }));
    expect((diff2.diff as { crossBaseline: string }).crossBaseline).toBe('no_baseline');
    expect((diff2.diff as { crossCycleCountDelta?: number }).crossCycleCountDelta).toBeUndefined();
  });
});

// ─── Task 638 — coupling + renders ───────────────────────────────────────────

describe('Task 638 — coupling map and renders across links', () => {
  it('get_coupling_map(crossIndex) counts ping.ts ↔ lib/util.ts both ways, tagged', async () => {
    const local = parse(await couplingTool({ repoId: uiId, filePath: 'src/ping.ts' }));
    expect(local.files).toEqual([]); // ping.ts has no LOCAL edge at all
    const cross = parse(await couplingTool({ repoId: uiId, filePath: 'src/ping.ts', crossIndex: true }));
    const row = (cross.files as Array<Record<string, unknown>>)[0]!;
    expect(row.efferentCoupling).toBe(1);
    expect(row.afferentCoupling).toBe(1);
    expect(row.crossEfferent).toBe(1);
    expect(row.crossAfferent).toBe(1);
    expect((row.efferentDeps as string[]).map(norm)).toEqual([`${libId}:src/util.ts`]);
    expect((row.afferentDeps as string[]).map(norm)).toEqual([`${libId}:src/util.ts`]);
    expect((cross.links as Array<{ repoId: string }>)[0]!.repoId).toBe(libId);
  });

  it('render_import_graph(crossIndex) draws lib files as `<root>:<file>` boundary nodes', async () => {
    const local = parse(await importGraphTool({ repoId: uiId, filePath: 'src/' }));
    expect(local.crossIndex).toBeUndefined();
    expect(local.diagram as string).not.toContain('lib:');
    const cross = parse(await importGraphTool({ repoId: uiId, filePath: 'src/', crossIndex: true }));
    expect(cross.crossIndex).toBe(true);
    expect(cross.crossEdgeCount).toBe(2);
    const diagram = cross.diagram as string;
    expect(diagram).toContain('lib:util.ts');
    expect(diagram).toContain('lib:db.ts');
    expect((cross.links as Array<{ rootName: string }>)[0]!.rootName).toBe('lib');
  });

  it('render_dep_matrix(crossIndex) adds the imported lib files as `<root>:<path>` columns', async () => {
    const local = parse(await depMatrixTool({ repoId: uiId }));
    expect((local.files as string[]).map(norm)).toEqual(['src/local.ts', 'src/view.ts']);
    const cross = parse(await depMatrixTool({ repoId: uiId, crossIndex: true, topN: 10 }));
    const files = (cross.files as string[]).map(norm);
    expect(files).toContain('src/ping.ts');
    expect(files).toContain('lib:src/util.ts');
    expect(files).toContain('lib:src/db.ts');
    expect(cross.matrix as string).toContain('lib:src/util.ts');
  });
});

// ─── Task 640 — riders on get_task_context ───────────────────────────────────

describe('Task 640 — get_task_context honesty riders', () => {
  it('attaches externalImports when a queried file has an internal-looking import the index cannot resolve', async () => {
    // A third root, NOT linked (different git repo), importing lib by relative path.
    const other = join(dirname(base), `${base.split(/[\\/]/).pop()}-other`);
    mkdirSync(other, { recursive: true });
    git(other, 'init', '-q', '-b', 'main');
    // Relative path into the OTHER checkout: resolvable on disk, outside this index, never linked.
    write(other, 'src/use.ts', `import { util } from '../../${base.split(/[\\/]/).pop()}/lib/src/util';\nexport function useUtil(): number { return util(); }\n`);
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'init');
    const otherId = (await indexFolder(other, IDX)).repoId;
    cleanup.push(otherId);
    const out = parse(await taskContextTool({ repoId: otherId, task: 'useUtil util', mode: 'flat' }));
    expect((out.contextItems as unknown[]).length).toBeGreaterThan(0);
    const ext = out.externalImports as { count: number; sample: Array<{ specifier: string }> } | undefined;
    expect(ext).toBeDefined();
    expect(ext!.count).toBeGreaterThan(0);
    // The empty branch also carries the riders (no graphCoverage on a tiny repo → no key, no throw).
    const empty = parse(await taskContextTool({ repoId: otherId, task: 'zzqx nothingmatchesthis', mode: 'flat' }));
    expect(empty.contextItems).toEqual([]);
    rmSync(other, { recursive: true, force: true });
  }, 60_000);
});

// ─── P5 — parity: one root == linked roots ───────────────────────────────────

describe('P5 — parity: the whole tree as ONE root agrees with the linked roots', () => {
  it('cycles, layer violations and dead symbols match (modulo the root prefix)', async () => {
    const wholeId = (await indexFolder(base, { ...IDX, fileLimit: 200 })).repoId;
    cleanup.push(wholeId);
    const wdb = openDatabase(wholeId);
    const wws = openWorkspace(wdb, wholeId, base);
    expect(wws.links).toEqual([]);
    try {
      // Cycles: whole (local reader) vs split (workspace reader from ui).
      const wholeCycles = findImportCycles(wholeId, wdb).cycles.map((c) => c.files.map(norm).sort());
      const udb = openDatabase(uiId);
      const uws = openWorkspace(udb, uiId, uiRoot);
      const splitCycles = findWorkspaceCycles(uws).cycles.map((c) =>
        c.members.map((m) => `${m.repoId === uiId ? 'ui' : 'lib'}/${norm(m.path)}`).sort(),
      );
      uws.close();
      udb.close();
      expect(splitCycles).toEqual(wholeCycles);
      expect(wholeCycles).toEqual([['lib/src/util.ts', 'ui/src/ping.ts']]);

      // Layer violations: the whole-root rule set names lib/src/db; the split
      // rule set names it as lib:src/db — same one violation.
      const wholeV = parse(layerViolationsTool({
        repoId: wholeId,
        layers: {
          definitions: [
            { name: 'ui', paths: ['ui/src/**'] },
            { name: 'db', paths: ['lib/src/db*'] },
            { name: 'libcore', paths: ['lib/src/util*'] },
          ],
          rules: UI_LAYERS.rules,
        },
      })).violations as Array<{ from_file: string; to_file: string }>;
      const splitV = parse(layerViolationsTool({ repoId: uiId, layers: UI_LAYERS, crossIndex: true })).violations as Array<{ from_file: string; to_file: string }>;
      expect(wholeV.map((v) => `${norm(v.from_file)} -> ${norm(v.to_file)}`)).toEqual(['ui/src/view.ts -> lib/src/db.ts']);
      expect(splitV.map((v) => `ui/${norm(v.from_file)} -> ${norm(v.to_file).replace('lib:', 'lib/')}`)).toEqual(['ui/src/view.ts -> lib/src/db.ts']);

      // Dead symbols under lib/: whole vs the linked lib root.
      const wholeDead = findDeadCode(wholeId, wdb, wws)
        .filter((s) => norm(s.filePath).startsWith('lib/'))
        .map((s) => `${norm(s.filePath)}:${s.name}`)
        .sort();
      const ldb = openDatabase(libId);
      const lws = openWorkspace(ldb, libId, libRoot);
      const splitDead = findDeadCode(libId, ldb, lws).map((s) => `lib/${norm(s.filePath)}:${s.name}`).sort();
      lws.close();
      ldb.close();
      expect(splitDead).toEqual(wholeDead);
      expect(wholeDead).toEqual(['lib/src/lonely.ts:lonely']);
    } finally {
      wws.close();
      wdb.close();
    }
  }, 120_000);
});

// ─── Task 639 — DI edges across links (android) ──────────────────────────────

describe('Task 639 — Hilt DI edges cross the seam (core/ provides, app/ consumes)', () => {
  let abase: string;
  let coreId = '';
  let appId = '';

  beforeAll(async () => {
    abase = realpathSync.native(mkdtempSync(join(tmpdir(), 'pc-x102-di-')));
    cpSync(ANDROID_FIXTURE, abase, { recursive: true });
    git(abase, 'init', '-q', '-b', 'main');
    git(abase, 'config', 'core.autocrlf', 'false');
    git(abase, 'add', '.');
    git(abase, 'commit', '-q', '-m', 'android');
    const opts = { ...IDX, adapters: [androidAdapter] };
    coreId = (await indexFolder(join(abase, 'core'), opts)).repoId;
    cleanup.push(coreId);
    appId = (await indexFolder(join(abase, 'app'), opts)).repoId;
    cleanup.push(appId);
  }, 120_000);

  afterAll(() => {
    rmSync(abase, { recursive: true, force: true });
  });

  it('app/HomeViewModel (@Inject UserRepository) → core/DataModule (@Binds UserRepository) with target_repo_id', () => {
    const db = openDatabase(appId);
    const rows = db
      .prepare('SELECT source_file, target_file, target_repo_id, specifier FROM dep_edges WHERE repo_id = ? AND edge_type = ? ORDER BY source_file, target_file')
      .all(appId, 'di') as Array<{ source_file: string; target_file: string; target_repo_id: string | null; specifier: string }>;
    db.close();
    const cross = rows.filter((r) => r.target_repo_id !== null);
    expect(cross.map((r) => `${norm(r.source_file)} -> ${norm(r.target_file)} (${r.specifier})`)).toContain(
      'src/main/java/com/example/app/HomeViewModel.kt -> src/main/java/com/example/core/DataModule.kt (di:UserRepository)',
    );
    expect(cross.every((r) => r.target_repo_id === coreId)).toBe(true);
    // The provider side stores NO reverse DI row (importing side only, P4).
    const cdb = openDatabase(coreId);
    const coreCross = cdb
      .prepare('SELECT COUNT(*) AS n FROM dep_edges WHERE repo_id = ? AND edge_type = ? AND target_repo_id IS NOT NULL')
      .get(coreId, 'di') as { n: number };
    cdb.close();
    expect(coreCross.n).toBe(0);
  });

  it('the DI wiring reaches blast radius across the seam and is still excluded from cycles', async () => {
    const cdb = openDatabase(coreId);
    const cws = openWorkspace(cdb, coreId, join(abase, 'core'));
    try {
      const mod = cdb.prepare('SELECT id FROM symbols WHERE repo_id = ? AND name = ? LIMIT 1').get(coreId, 'DataModule') as { id: string };
      const br = getBlastRadius(mod.id, coreId, cdb, 2, cws);
      const linkedFiles = (br.linked ?? []).flatMap((g) => g.files.map(norm));
      expect(linkedFiles).toContain('src/main/java/com/example/app/HomeViewModel.kt');
    } finally {
      cws.close();
      cdb.close();
    }
    const cyc = parse(await findCyclesTool({ repoId: appId, crossIndex: true }));
    // @Binds module ↔ impl pairs would be false 2-cycles; the adjacency drops 'di'.
    expect((cyc.cycles as Array<{ files: string[] }>).every((c) => c.files.every((f) => !f.includes('DataModule')))).toBe(true);
  });
});
