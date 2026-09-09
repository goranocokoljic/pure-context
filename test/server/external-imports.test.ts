/**
 * Phase 97, Task 604 — boundary honesty: `externalImports`.
 *
 * Two-module fixture with ONE module unindexed: the indexed module's imports
 * that point at the other resolve to nothing yet look internal → the seam
 * signal appears on get_blast_radius / find_importers / get_context_bundle
 * and names the sibling index. On a fully-resolved repo nothing is attached.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { computeExternalImports, findSiblingIndexes, looksInternal } from '../../src/server/tools/external-imports.js';
import { handler as blastRadius } from '../../src/server/tools/get-blast-radius.js';
import { handler as findImporters } from '../../src/server/tools/find-importers.js';
import { handler as contextBundle } from '../../src/server/tools/get-context-bundle.js';
import { registerHandler } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

registerHandler(typescriptHandler);

let base: string;
let appRepoId: string;
let libRepoId: string;
let wholeRepoId: string;

function symbolId(repoId: string, name: string): string {
  const db = openDatabase(repoId);
  const row = db.prepare('SELECT id FROM symbols WHERE repo_id = ? AND name = ?').get(repoId, name) as { id: string };
  db.close();
  return row.id;
}

function parse(res: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0].text ?? '{}') as Record<string, unknown>;
}

beforeAll(async () => {
  await initParser();
  base = mkdtempSync(join(tmpdir(), 'pc-extimp-'));
  // tree/app imports tree/lib (a sibling module) via a relative path and an alias.
  mkdirSync(join(base, 'tree', 'app', 'src'), { recursive: true });
  mkdirSync(join(base, 'tree', 'lib', 'src'), { recursive: true });
  writeFileSync(join(base, 'tree', 'lib', 'src', 'util.ts'), 'export function util(): number { return 1; }\n');
  writeFileSync(
    join(base, 'tree', 'app', 'src', 'main.ts'),
    "import { util } from '../../lib/src/util';\nimport { x } from '@/missing';\nimport { z } from 'zod';\nexport function main(): number { return util(); }\n",
  );
  writeFileSync(join(base, 'tree', 'app', 'src', 'other.ts'), "import { main } from './main';\nexport const o = main();\n");

  // Split indexes: app and lib separately (the reporter's shape).
  appRepoId = (await indexFolder(join(base, 'tree', 'app'), { concurrency: 1, cloneFromWorktree: false })).repoId;
  libRepoId = (await indexFolder(join(base, 'tree', 'lib'), { concurrency: 1, cloneFromWorktree: false })).repoId;
}, 60_000);

afterAll(() => {
  for (const id of [appRepoId, libRepoId, wholeRepoId]) {
    try { if (id) deleteIndex(id); } catch { /* ignore */ }
  }
  rmSync(base, { recursive: true, force: true });
});

describe('looksInternal', () => {
  const ctx = { rootPath: '', topDirs: new Set(['src', 'app']), topPyModules: new Set(['conf']), goModule: 'github.com/acme/svc', reservedNamespaces: ['android', 'java'] };
  it('TS: relative + aliases + top-level dirs are internal; npm packages are not', () => {
    expect(looksInternal('./a', 'x.ts', null, ctx)).toBe(true);
    expect(looksInternal('@/a', 'x.ts', null, ctx)).toBe(true);
    expect(looksInternal('~/a', 'x.ts', null, ctx)).toBe(true);
    expect(looksInternal('src/a', 'x.ts', null, ctx)).toBe(true);
    expect(looksInternal('zod', 'x.ts', null, ctx)).toBe(false);
    expect(looksInternal('@scope/pkg', 'x.ts', null, ctx)).toBe(false);
  });
  it('JVM: shared declared-package prefix, never reserved namespaces', () => {
    expect(looksInternal('com.acme.nav.Foo', 'A.kt', 'com.acme.app', ctx)).toBe(true);
    expect(looksInternal('com.other.Foo', 'A.kt', 'com.acme.app', ctx)).toBe(false);
    expect(looksInternal('android.util.Log', 'A.kt', 'android.app', ctx)).toBe(false);
    expect(looksInternal('com.acme.x', 'A.kt', null, ctx)).toBe(false);
  });
  it('Python / Go / Rust / C#', () => {
    expect(looksInternal('.sibling', 'a/b.py', null, ctx)).toBe(true);
    expect(looksInternal('app.models', 'a/b.py', null, ctx)).toBe(true);
    expect(looksInternal('conf', 'a/b.py', null, ctx)).toBe(true);
    expect(looksInternal('numpy', 'a/b.py', null, ctx)).toBe(false);
    expect(looksInternal('github.com/acme/svc/pkg', 'a.go', null, ctx)).toBe(true);
    expect(looksInternal('github.com/other/lib', 'a.go', null, ctx)).toBe(false);
    expect(looksInternal('crate::x', 'a.rs', null, ctx)).toBe(true);
    expect(looksInternal('serde', 'a.rs', null, ctx)).toBe(false);
    expect(looksInternal('Acme.Data', 'A.cs', 'Acme.Web', ctx)).toBe(true);
    expect(looksInternal('System.IO', 'A.cs', 'Acme.Web', ctx)).toBe(false);
  });
});

describe('split index (one module unindexed)', () => {
  it('computeExternalImports flags the cross-module imports and names the sibling index', () => {
    const db = openDatabase(appRepoId);
    const ext = computeExternalImports(db, appRepoId, ['src/main.ts']);
    db.close();
    expect(ext).not.toBeNull();
    expect(ext!.count).toBe(2); // ../../lib/src/util + @/missing; zod is external
    expect(ext!.sample.map((s) => s.specifier).sort()).toEqual(['../../lib/src/util', '@/missing']);
    expect(ext!.siblingIndexes.map((s) => s.relation)).toEqual(['sibling']);
    expect(ext!.siblingIndexes[0].repoId).toBe(libRepoId);
    expect(ext!.nextAction).toContain('find_cross_repo_usages');
  });

  it('get_blast_radius / find_importers / get_context_bundle attach externalImports', () => {
    const br = parse(blastRadius({ repoId: appRepoId, symbolId: symbolId(appRepoId, 'main') }));
    expect((br.externalImports as { count: number }).count).toBe(2);
    const fi = parse(findImporters({ repoId: appRepoId, filePath: 'src/main.ts' }));
    expect((fi.externalImports as { count: number }).count).toBe(2);
    // The bundle from other.ts walks INTO main.ts — the seam is on a bundled file.
    const cb = parse(contextBundle({ repoId: appRepoId, symbolId: symbolId(appRepoId, 'o') }));
    expect((cb.externalImports as { count: number }).count).toBe(2);
  });

  it('a file with only resolved / third-party imports gets nothing', () => {
    const fi = parse(findImporters({ repoId: appRepoId, filePath: 'src/other.ts' }));
    expect(fi.externalImports).toBeUndefined();
  });
});

describe('whole tree as one index', () => {
  it('the relative import resolves → only the alias remains; nested indexes are reported as such', async () => {
    wholeRepoId = (await indexFolder(join(base, 'tree'), { concurrency: 1, cloneFromWorktree: false })).repoId;
    const db = openDatabase(wholeRepoId);
    const ext = computeExternalImports(db, wholeRepoId, ['app/src/main.ts']);
    db.close();
    expect(ext!.count).toBe(1);
    expect(ext!.sample[0].specifier).toBe('@/missing');
    const rel = findSiblingIndexes(wholeRepoId, join(base, 'tree')).map((s) => s.relation).sort();
    expect(rel).toEqual(['nested', 'nested']);
    // Lib's own file: fully resolved, nothing attached.
    const fi = parse(findImporters({ repoId: wholeRepoId, filePath: 'lib/src/util.ts' }));
    expect(fi.externalImports).toBeUndefined();
  }, 60_000);
});
