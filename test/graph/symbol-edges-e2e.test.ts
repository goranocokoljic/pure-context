/**
 * Phase 101 (Tasks 630–633): symbol-level `ref` edges, end to end through the
 * index manager and the reader tools.
 *
 * One root, three languages. Pins:
 *   - a whole-tree run builds refs (TS named / namespace / barrel re-export
 *     chain, shadowed local, Python bare + dotted qualifier, Kotlin explicit +
 *     wildcard);
 *   - `get_blast_radius` / `get_context_bundle` answer at symbol granularity on
 *     request, keep the file answer as the upper bound, and the symbol radius
 *     is a SUBSET of the file radius (P4);
 *   - `get_call_hierarchy`, `get_symbol_risk`, `prepare_change` consume refs;
 *   - a targeted re-index drops refs whose target id vanished and rebuilds the
 *     importers (design note §2.5);
 *   - `skipSymbolEdges` yields no rows and the tools fall back with a note.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { indexFolder, reindexFiles, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { kotlinHandler } from '../../src/handlers/kotlin.js';
import { pythonHandler } from '../../src/handlers/python.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { countSymbolRefs, getRefsBySourceFile } from '../../src/core/db/symbol-ref-store.js';
import { getBlastRadius } from '../../src/graph/graph-traversal.js';
import { getSymbolBlastRadius } from '../../src/graph/symbol-traversal.js';
import { handler as blastRadiusTool } from '../../src/server/tools/get-blast-radius.js';
import { handler as contextBundleTool } from '../../src/server/tools/get-context-bundle.js';
import { handler as callHierarchyTool } from '../../src/server/tools/get-call-hierarchy.js';
import { handler as symbolRiskTool } from '../../src/server/tools/get-symbol-risk.js';
import { handler as prepareChangeTool } from '../../src/server/tools/prepare-change.js';
import { handler as listReposTool } from '../../src/server/tools/list-repos.js';

const norm = (p: string) => p.replace(/\\/g, '/');

function write(base: string, relPath: string, content: string) {
  const abs = join(base, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function parse(res: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text ?? '{}') as Record<string, unknown>;
}

function symbolId(repoId: string, name: string, kind?: string): string {
  const db = openDatabase(repoId);
  const row = (
    kind
      ? db.prepare('SELECT id FROM symbols WHERE repo_id = ? AND name = ? AND kind = ?').get(repoId, name, kind)
      : db.prepare('SELECT id FROM symbols WHERE repo_id = ? AND name = ?').get(repoId, name)
  ) as { id: string } | undefined;
  db.close();
  if (!row) throw new Error(`symbol ${name} not found in ${repoId}`);
  return row.id;
}

/** `sourceName -> targetName` pairs of every stored ref, resolved through the symbols table. */
function refPairs(repoId: string): string[] {
  const db = openDatabase(repoId);
  const rows = db
    .prepare(
      `SELECT s.name AS src, t.name AS dst, r.name AS via, r.ref_count AS n
       FROM symbol_refs r
       JOIN symbols s ON s.repo_id = r.repo_id AND s.id = r.source_symbol_id
       JOIN symbols t ON t.repo_id = r.repo_id AND t.id = r.target_symbol_id
       WHERE r.repo_id = ? ORDER BY s.name, t.name`,
    )
    .all(repoId) as Array<{ src: string; dst: string; via: string; n: number }>;
  db.close();
  return rows.map((r) => `${r.src} -> ${r.dst}`);
}

const FILES: Record<string, string> = {
  // ── TypeScript ────────────────────────────────────────────────────────────
  'src/lib.ts': [
    'export function helper(): number { return 1; }',
    'export const CONST = 2;',
    'export class Widget { size = 3; }',
    'export function unused(): void {}',
    '',
  ].join('\n'),
  // barrel: named re-export + star re-export (Phase 101 §2.3 import records)
  'src/index.ts': "export { helper } from './lib';\nexport * from './lib';\n",
  'src/app.ts': [
    "import { helper, Widget } from './index';",
    "import * as lib from './lib';",
    '',
    'export function useHelper(): number { return helper() + helper(); }',
    'export class Svc {',
    '  run(): number { const w = new Widget(); return w.size + lib.CONST; }',
    '  other(): number { return 0; }',
    '}',
    '',
  ].join('\n'),
  // shadowed local: the import is never matched (P3)
  'src/shadow.ts': [
    "import { helper } from './lib';",
    'function helper(): number { return 9; }',
    'export function run(): number { return helper(); }',
    '',
  ].join('\n'),
  // ── Python (src/ layout → the Phase-98 root allowlist) ────────────────────
  'src/pkg/__init__.py': '',
  'src/pkg/engine.py': 'class Engine:\n    """The engine."""\n    def run(self):\n        return 1\n',
  'src/pkg/util.py': 'def compute():\n    return 2\n\n\ndef spare():\n    return 3\n',
  'src/main.py': [
    'from pkg.engine import Engine',
    'import pkg.util',
    '',
    'def main():',
    '    return Engine().run()',
    '',
    'def other():',
    '    return pkg.util.compute()',
    '',
  ].join('\n'),
  // ── Kotlin ────────────────────────────────────────────────────────────────
  'build.gradle.kts': '// module marker\n',
  'src/main/kotlin/com/acme/libs/Foo.kt': 'package com.acme.libs\n\nclass Foo {\n  fun run(): Int = 1\n}\n\nclass Spare\n',
  'src/main/kotlin/com/acme/app/Bar.kt': 'package com.acme.app\n\nimport com.acme.libs.Foo\n\nclass Bar {\n  val foo = Foo()\n}\n',
  'src/main/kotlin/com/acme/app/Wild.kt': 'package com.acme.app\n\nimport com.acme.libs.*\n\nclass Wild {\n  val f = Foo()\n}\n',
};

let base = '';
let root = '';
let repoId = '';
const cleanup: string[] = [];
const OPTS = { fileLimit: 100, concurrency: 1, cloneFromWorktree: false, skipGit: true } as const;

beforeAll(async () => {
  _resetForTesting();
  registerHandler(kotlinHandler);
  registerHandler(pythonHandler);
  registerHandler(typescriptHandler);
  await initParser();
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'pc-symref-')));
  root = join(base, 'proj');
  for (const [p, c] of Object.entries(FILES)) write(root, p, c);
  const res = await indexFolder(root, OPTS);
  repoId = res.repoId;
  cleanup.push(repoId);
  expect(res.symbolRefsBuilt).toBeGreaterThan(0);
}, 120_000);

afterAll(() => {
  for (const id of cleanup) {
    try { deleteIndex(id); } catch { /* ignore */ }
  }
  rmSync(base, { recursive: true, force: true });
});

describe('Task 630 — the builder through the index manager', () => {
  it('stores the expected refs per language rule', () => {
    const pairs = refPairs(repoId);
    // TS: named import through the barrel chain, namespace form, class member attribution.
    expect(pairs).toContain('useHelper -> helper');
    expect(pairs).toContain('Svc.run -> Widget');
    expect(pairs).toContain('Svc.run -> CONST');
    expect(pairs).not.toContain('Svc -> Widget'); // innermost attribution: the method, not the class
    expect(pairs).not.toContain('Svc.other -> Widget');
    expect(pairs.some((p) => p.endsWith('-> unused'))).toBe(false);
    // Shadow rule: shadow.ts declares its own helper.
    expect(pairs).not.toContain('run -> helper');
    // Python: bare from-import and dotted plain import.
    expect(pairs).toContain('main -> Engine');
    expect(pairs).toContain('other -> compute');
    expect(pairs.some((p) => p.endsWith('-> spare'))).toBe(false);
    // Kotlin: explicit import and wildcard import.
    expect(pairs).toContain('Bar -> Foo');
    expect(pairs).toContain('Wild -> Foo');
    expect(pairs).not.toContain('Wild -> Spare');
  });

  it('every ref is lexical and counts occurrences', () => {
    const db = openDatabase(repoId);
    const rows = getRefsBySourceFile(db, repoId, 'src/app.ts');
    db.close();
    expect(rows.every((r) => r.confidence === 'lexical')).toBe(true);
    const helperRef = rows.find((r) => r.name === 'helper');
    expect(helperRef?.refCount).toBe(2);
    expect(norm(helperRef!.targetFile)).toBe('src/lib.ts'); // the chain landed on lib.ts, not the barrel
  });

  it('list_repos reports the ref count', async () => {
    const out = parse(await listReposTool({}));
    const me = (out['repos'] as Array<Record<string, unknown>>).find((r) => r['id'] === repoId);
    expect(me?.['symbolRefs']).toBeGreaterThan(0);
  });
});

describe('Task 631 — readers', () => {
  it('get_blast_radius granularity=symbol: only referencing symbols, file answer kept as the upper bound', () => {
    const helper = symbolId(repoId, 'helper', 'function');
    const out = parse(blastRadiusTool({ repoId, symbolId: helper, granularity: 'symbol' }));
    expect(out['granularity']).toBe('symbol');
    expect(out['confidence']).toBe('lexical');
    const symbols = out['symbols'] as Array<{ name: string; depth: number; via?: string }>;
    expect(symbols.map((s) => s.name).sort()).toEqual(['helper', 'useHelper']);
    expect(symbols.find((s) => s.name === 'useHelper')?.depth).toBe(1);
    expect(symbols.find((s) => s.name === 'useHelper')?.via).toBe('helper');
    const fileRadius = out['fileRadius'] as { affectedFiles: number; files: string[] };
    // File level: lib.ts ← index.ts ← app.ts, lib.ts ← app.ts, lib.ts ← shadow.ts (superset).
    expect(fileRadius.affectedFiles).toBeGreaterThan((out['files'] as string[]).length);
    for (const f of out['files'] as string[]) expect(fileRadius.files).toContain(f);
  });

  it('default granularity is unchanged (file), with no note', () => {
    const helper = symbolId(repoId, 'helper', 'function');
    const out = parse(blastRadiusTool({ repoId, symbolId: helper }));
    expect(out['granularity']).toBe('file');
    expect(out).not.toHaveProperty('note');
    expect(out).not.toHaveProperty('fileRadius');
  });

  it('P4: for every symbol, files(symbolRadius) ⊆ files(fileRadius) at depth 3', () => {
    const db = openDatabase(repoId);
    const ids = (db.prepare('SELECT id FROM symbols WHERE repo_id = ?').all(repoId) as Array<{ id: string }>).map((r) => r.id);
    let checked = 0;
    for (const id of ids) {
      const fileR = new Set(getBlastRadius(id, repoId, db, 3).files.map(norm));
      const symR = getSymbolBlastRadius(id, repoId, db, 3);
      for (const f of symR?.files ?? []) expect(fileR.has(norm(f))).toBe(true);
      checked++;
    }
    db.close();
    expect(checked).toBeGreaterThan(10);
  });

  it('get_context_bundle granularity=symbol: what the symbol mentions, forward', () => {
    const run = symbolId(repoId, 'Svc.run');
    const out = parse(contextBundleTool({ repoId, symbolId: run, granularity: 'symbol' }));
    expect(out['granularity']).toBe('symbol');
    const names = (out['symbols'] as Array<{ name: string }>).map((s) => s.name).sort();
    expect(names).toEqual(['CONST', 'Svc.run', 'Widget']);
    const fb = out['fileBundle'] as { symbolCount: number };
    expect(fb.symbolCount).toBeGreaterThan(names.length);
  });

  it('get_call_hierarchy uses refs for cross-file callers (edgeSource: ref)', async () => {
    const helper = symbolId(repoId, 'helper', 'function');
    const out = parse(await callHierarchyTool({ repoId, symbolId: helper, direction: 'callers' }));
    const root = out['root'] as { children: Array<{ name: string; callCount: number }> };
    expect(root.children.map((c) => c.name)).toEqual(['useHelper']);
    expect(root.children[0]!.callCount).toBe(2);
    // shadow.ts's run() calls ITS OWN helper — not a caller of lib's.
    expect(root.children.map((c) => c.name)).not.toContain('run');
  });

  it('get_symbol_risk reports symbol-level centrality', async () => {
    const helper = symbolId(repoId, 'helper', 'function');
    const out = parse(await symbolRiskTool({ repoId, symbolId: helper }));
    const centrality = (out['factors'] as { centrality: { raw: number; symbolRefs?: number } }).centrality;
    expect(centrality.symbolRefs).toBe(1);
    expect(centrality.raw).toBeGreaterThanOrEqual(1);
    expect((out['reasons'] as string[]).some((r) => r.includes('1 symbol(s) reference helper'))).toBe(true);
  });

  it('prepare_change lists the direct referencing symbols', async () => {
    const helper = symbolId(repoId, 'helper', 'function');
    const out = parse(await prepareChangeTool({ repoId, intent: 'modify', targetSymbolId: helper }));
    const direct = out['directReferences'] as { count: number; symbols: Array<{ name: string }>; files: string[] };
    expect(direct.count).toBe(1);
    expect(direct.symbols[0]!.name).toBe('useHelper');
    expect(direct.files.map(norm)).toEqual(['src/app.ts']);
  });
});

describe('Task 630 — incremental re-index (design note §2.5)', () => {
  it('a renamed target drops the stale ref; the importer is rebuilt when the name returns', async () => {
    // Rename Widget → WidgetX in lib.ts: app.ts still says `Widget` (through the barrel), so
    // its ref must vanish (dangling target id), while its CONST ref stays.
    write(root, 'src/lib.ts', FILES['src/lib.ts']!.replace('class Widget', 'class WidgetX'));
    await reindexFiles(repoId, ['src/lib.ts']);
    let pairs = refPairs(repoId);
    expect(pairs).not.toContain('Svc.run -> Widget');
    expect(pairs).not.toContain('Svc.run -> WidgetX');
    expect(pairs).toContain('Svc.run -> CONST');
    expect(pairs).toContain('useHelper -> helper');

    // Revert: the importers of lib.ts are rebuilt by lib.ts's own re-index.
    write(root, 'src/lib.ts', FILES['src/lib.ts']!);
    await reindexFiles(repoId, ['src/lib.ts']);
    pairs = refPairs(repoId);
    expect(pairs).toContain('Svc.run -> Widget');
  }, 60_000);

  it('deleting a source file removes its refs', async () => {
    rmSync(join(root, 'src/shadow.ts'));
    write(root, 'src/extra.ts', "import { unused } from './lib';\nexport function callsUnused(): void { unused(); }\n");
    await reindexFiles(repoId, ['src/extra.ts'], ['src/shadow.ts']);
    const pairs = refPairs(repoId);
    expect(pairs).toContain('callsUnused -> unused');
    const db = openDatabase(repoId);
    expect(getRefsBySourceFile(db, repoId, 'src/shadow.ts')).toEqual([]);
    db.close();
  }, 60_000);
});

describe('Task 630 — the off switch', () => {
  it('skipSymbolEdges builds no rows and the tools fall back to the file answer with a note', async () => {
    const root2 = join(base, 'proj2');
    for (const [p, c] of Object.entries(FILES)) write(root2, p, c);
    const res = await indexFolder(root2, { ...OPTS, skipSymbolEdges: true });
    cleanup.push(res.repoId);
    expect(res.symbolRefsBuilt).toBeUndefined();
    const db = openDatabase(res.repoId);
    expect(countSymbolRefs(db, res.repoId)).toBe(0);
    db.close();
    const helper = symbolId(res.repoId, 'helper', 'function');
    const out = parse(blastRadiusTool({ repoId: res.repoId, symbolId: helper, granularity: 'symbol' }));
    expect(out['granularity']).toBe('file');
    expect(String(out['note'])).toContain('no symbol-level edges');
  }, 120_000);
});
