/**
 * Phase 100 (Task 627) — npm/pnpm/yarn workspace package-name resolution.
 *
 * `@acme/lib` inside a workspace resolves to that package's SOURCE entry:
 * exports map (string / conditions / subpath patterns) → main/module/types
 * → src/index, source before built output; unknown names stay external; a
 * target that is not an indexed file is dropped; a linked root's packages
 * resolve across the seam.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

import {
  createWorkspacePackageResolver,
  discoverWorkspacePackages,
  exportsTargets,
  readWorkspaceGlobs,
  packageHead,
  workspacePackagesEnabled,
  _resetWorkspaceCaches,
} from '../../src/graph/workspace-packages.js';
import { buildGraph } from '../../src/graph/graph-builder.js';
import { createResolver } from '../../src/graph/path-resolver.js';
import { buildIndexedFileSet } from '../../src/graph/prefilled-targets.js';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { openDatabase } from '../../src/core/db/schema.js';
import type { ImportRecord } from '../../src/core/types.js';

let root: string;
const cleanup: string[] = [];

function write(base: string, relPath: string, content: string) {
  const abs = join(base, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function rec(sourceFile: string, specifier: string): ImportRecord {
  return { sourceFile, specifier, resolvedPath: null, importedNames: [], isTypeOnly: false };
}

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(javascriptHandler);
  await initParser();
  root = resolve(mkdtempSync(join(tmpdir(), 'pc-ws-')));
  write(root, 'package.json', JSON.stringify({ name: 'monorepo', private: true, workspaces: ['packages/*', 'apps/**', '!apps/skip/**'] }));
  // exports as a plain string
  write(root, 'packages/kit/package.json', JSON.stringify({ name: '@acme/kit', exports: './dist/index.mjs' }));
  write(root, 'packages/kit/src/index.ts', 'export const kit = 1;\n');
  // exports with conditions + subpath patterns; dist exists on disk too
  write(
    root,
    'packages/schema/package.json',
    JSON.stringify({
      name: '@acme/schema',
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.mjs', require: './dist/index.cjs' },
        './utils/*': { import: './dist/utils/*.mjs' },
        './package.json': './package.json',
      },
    }),
  );
  write(root, 'packages/schema/src/index.ts', 'export const schema = 1;\n');
  write(root, 'packages/schema/src/utils/merge.ts', 'export const merge = 1;\n');
  write(root, 'packages/schema/dist/index.mjs', 'export const schema = 1;\n');
  write(root, 'packages/schema/dist/utils/merge.mjs', 'export const merge = 1;\n');
  // main only, pointing at built output whose source mirror does NOT exist
  write(root, 'packages/legacy/package.json', JSON.stringify({ name: 'legacy-lib', main: 'lib/main.js' }));
  write(root, 'packages/legacy/lib/main.js', 'module.exports = 1;\n');
  // no entry fields at all → src/index probe
  write(root, 'packages/bare/package.json', JSON.stringify({ name: 'bare' }));
  write(root, 'packages/bare/src/index.ts', 'export const bare = 1;\n');
  // apps/** (recursive) + excluded branch
  write(root, 'apps/web/package.json', JSON.stringify({ name: '@acme/web', main: 'src/main.ts' }));
  write(root, 'apps/web/src/main.ts', "import { kit } from '@acme/kit';\nimport { merge } from '@acme/schema/utils/merge';\nimport x from 'legacy-lib';\nimport { bare } from 'bare';\nimport y from 'react';\nexport const main = [kit, merge, x, bare, y];\n");
  write(root, 'apps/skip/nested/package.json', JSON.stringify({ name: '@acme/skipped', main: 'index.ts' }));
  write(root, 'apps/skip/nested/index.ts', 'export const s = 1;\n');
  // a package dir without a name is ignored
  write(root, 'packages/noname/package.json', JSON.stringify({ private: true }));
});

afterAll(() => {
  for (const id of cleanup) {
    try {
      deleteIndex(id);
    } catch {
      /* ignore */
    }
  }
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  _resetWorkspaceCaches();
  delete process.env['PCTX_WORKSPACE_PACKAGES'];
});

describe('discovery', () => {
  it('reads package.json workspaces globs and expands them (negations honoured)', () => {
    expect(readWorkspaceGlobs(root)).toEqual(['packages/*', 'apps/**', '!apps/skip/**']);
    const names = discoverWorkspacePackages(root).map((p) => p.name).sort();
    expect(names).toEqual(['@acme/kit', '@acme/schema', '@acme/web', 'bare', 'legacy-lib']);
  });

  it('reads pnpm-workspace.yaml packages', () => {
    const r = resolve(mkdtempSync(join(tmpdir(), 'pc-ws-pnpm-')));
    write(r, 'package.json', JSON.stringify({ name: 'x', private: true }));
    write(r, 'pnpm-workspace.yaml', "packages:\n  - 'pkgs/*'\n  - '!pkgs/private'\n");
    write(r, 'pkgs/a/package.json', JSON.stringify({ name: '@p/a', main: 'index.ts' }));
    write(r, 'pkgs/a/index.ts', 'export const a = 1;\n');
    write(r, 'pkgs/private/package.json', JSON.stringify({ name: '@p/private', main: 'index.ts' }));
    expect(readWorkspaceGlobs(r)).toEqual(['pkgs/*', '!pkgs/private']);
    const res = createWorkspacePackageResolver(r)!;
    expect([...res.names()]).toEqual(['@p/a']);
    expect(res.resolve('@p/a')).toBe('pkgs/a/index.ts');
    rmSync(r, { recursive: true, force: true });
  });

  it('a root with no manifest yields no resolver; a named root is its own package', () => {
    const r = resolve(mkdtempSync(join(tmpdir(), 'pc-ws-none-')));
    expect(createWorkspacePackageResolver(r)).toBeNull();
    write(r, 'package.json', JSON.stringify({ name: 'plain', main: 'src/main.ts' }));
    write(r, 'src/main.ts', 'export const p = 1;\n');
    const res = createWorkspacePackageResolver(r)!;
    expect([...res.names()]).toEqual(['plain']);
    expect(res.resolve('plain')).toBe('src/main.ts');
    expect(res.resolve('other')).toBeNull();
    rmSync(r, { recursive: true, force: true });
  });

  it('a root INSIDE a workspace (split root) sees the ancestor globs, only packages under itself, and itself by name', () => {
    // <repo>/pnpm-workspace.yaml declares packages/**; the index is rooted at
    // <repo>/packages/kit (the Phase-99 split-root shape) and at <repo>/packages.
    const repo = resolve(mkdtempSync(join(tmpdir(), 'pc-ws-split-')));
    mkdirSync(join(repo, '.git'));
    write(repo, 'package.json', JSON.stringify({ name: 'framework', private: true }));
    write(repo, 'pnpm-workspace.yaml', "packages:\n  - 'packages/**'\n  - '!packages/skip'\n");
    write(repo, 'packages/kit/package.json', JSON.stringify({ name: '@n/kit', exports: './dist/index.mjs' }));
    write(repo, 'packages/kit/src/index.ts', 'export const kit = 1;\n');
    write(repo, 'packages/schema/package.json', JSON.stringify({ name: '@n/schema', main: 'src/index.ts' }));
    write(repo, 'packages/schema/src/index.ts', 'export const s = 1;\n');
    write(repo, 'packages/skip/package.json', JSON.stringify({ name: '@n/skip', main: 'index.ts' }));
    write(repo, 'packages/skip/index.ts', 'export const x = 1;\n');

    const kit = createWorkspacePackageResolver(join(repo, 'packages/kit'))!;
    expect([...kit.names()].sort()).toEqual(['@n/kit']); // schema lies outside this root
    expect(kit.resolve('@n/kit')).toBe('src/index.ts');
    expect(kit.resolve('@n/schema')).toBeNull();

    const pkgs = createWorkspacePackageResolver(join(repo, 'packages'))!;
    expect([...pkgs.names()].sort()).toEqual(['@n/kit', '@n/schema']);
    expect(pkgs.resolve('@n/kit')).toBe('kit/src/index.ts');
    expect(pkgs.resolve('@n/schema')).toBe('schema/src/index.ts');
    expect(pkgs.resolve('@n/skip')).toBeNull();

    // The ancestor walk stops at a repository boundary.
    const outside = resolve(mkdtempSync(join(tmpdir(), 'pc-ws-outside-')));
    write(outside, 'pnpm-workspace.yaml', "packages:\n  - '*/**'\n");
    const inner = join(outside, 'proj');
    mkdirSync(join(inner, '.git'), { recursive: true });
    write(inner, 'lib/package.json', JSON.stringify({ name: 'lib', main: 'index.ts' }));
    write(inner, 'lib/index.ts', 'export const l = 1;\n');
    expect(createWorkspacePackageResolver(inner)).toBeNull();
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('packageHead + config gate', () => {
    expect(packageHead('@acme/kit/dist/x')).toBe('@acme/kit');
    expect(packageHead('lodash/fp')).toBe('lodash');
    expect(workspacePackagesEnabled()).toBe(true);
    process.env['PCTX_WORKSPACE_PACKAGES'] = 'off';
    expect(workspacePackagesEnabled()).toBe(false);
  });
});

describe('exports shapes', () => {
  it('string, conditions, subpath patterns, unknown subpath', () => {
    expect(exportsTargets('./dist/index.mjs', '.')).toEqual(['./dist/index.mjs']);
    expect(exportsTargets('./dist/index.mjs', './x')).toEqual([]);
    expect(exportsTargets({ import: './a.mjs', require: './a.cjs' }, '.')).toEqual(['./a.mjs', './a.cjs']);
    const map = { '.': { types: './d.ts', import: './i.mjs' }, './utils/*': { import: './dist/utils/*.mjs' } };
    expect(exportsTargets(map, '.')).toEqual(['./i.mjs', './d.ts']);
    expect(exportsTargets(map, './utils/merge')).toEqual(['./dist/utils/merge.mjs']);
    expect(exportsTargets(map, './nope')).toEqual([]);
    expect(exportsTargets(null, '.')).toEqual([]);
  });
});

describe('resolution', () => {
  it('source before dist; main fallback; src/index probe; subpaths; unknown → null', () => {
    const res = createWorkspacePackageResolver(root)!;
    expect(res.resolve('@acme/kit')).toBe('packages/kit/src/index.ts'); // dist mirrored to src
    expect(res.resolve('@acme/schema')).toBe('packages/schema/src/index.ts'); // conditions, src first
    expect(res.resolve('@acme/schema/utils/merge')).toBe('packages/schema/src/utils/merge.ts'); // pattern + mirror
    expect(res.resolve('@acme/schema/package.json')).toBe('packages/schema/package.json');
    expect(res.resolve('legacy-lib')).toBe('packages/legacy/lib/main.js'); // no src mirror → built file
    expect(res.resolve('bare')).toBe('packages/bare/src/index.ts');
    expect(res.resolve('react')).toBeNull();
    expect(res.resolve('@acme/skipped')).toBeNull(); // negated glob
    expect(res.resolve('./local')).toBeNull();
    expect(res.resolve('@acme/kitten')).toBeNull(); // prefix is not a package boundary
  });

  it('with an indexed file set, a target that is not indexed is dropped', () => {
    const indexed = buildIndexedFileSet(['packages/kit/src/index.ts', 'apps/web/src/main.ts']);
    const res = createWorkspacePackageResolver(root, { indexedFiles: indexed })!;
    expect(res.resolve('@acme/kit')).toBe('packages/kit/src/index.ts');
    expect(res.resolve('bare')).toBeNull();
  });
});

describe('graph integration', () => {
  it('buildGraph resolves workspace names after aliases and before "external"', () => {
    const resolver = createResolver(root);
    const indexed = buildIndexedFileSet([
      'apps/web/src/main.ts',
      'packages/kit/src/index.ts',
      'packages/schema/src/utils/merge.ts',
      'packages/legacy/lib/main.js',
      'packages/bare/src/index.ts',
    ]);
    const imports = [
      rec('apps/web/src/main.ts', '@acme/kit'),
      rec('apps/web/src/main.ts', '@acme/schema/utils/merge'),
      rec('apps/web/src/main.ts', 'legacy-lib'),
      rec('apps/web/src/main.ts', 'bare'),
      rec('apps/web/src/main.ts', 'react'),
    ];
    const without = buildGraph(imports, resolver, 'r', undefined, { indexedFiles: indexed });
    expect(without).toEqual([]);
    const ws = createWorkspacePackageResolver(root, { indexedFiles: indexed });
    const edges = buildGraph(imports, resolver, 'r', undefined, { indexedFiles: indexed, workspacePackages: ws });
    expect(edges.map((e) => e.targetFile).sort()).toEqual([
      'packages/bare/src/index.ts',
      'packages/kit/src/index.ts',
      'packages/legacy/lib/main.js',
      'packages/schema/src/utils/merge.ts',
    ]);
    expect(edges.every((e) => !e.targetRepoId)).toBe(true);
  });

  it('a linked root answers `@scope/pkg` for a package it holds (cross edge)', () => {
    const app = resolve(mkdtempSync(join(tmpdir(), 'pc-ws-app-')));
    write(app, 'package.json', JSON.stringify({ name: 'app' }));
    write(app, 'src/main.ts', "import { kit } from '@acme/kit';\n");
    const resolver = createResolver(app);
    const libIndexed = buildIndexedFileSet(['packages/kit/src/index.ts']);
    const link = {
      repoId: 'lib',
      rootPath: root,
      indexedFiles: () => libIndexed,
      families: () => undefined,
      workspacePackages: () => createWorkspacePackageResolver(root, { indexedFiles: libIndexed }),
    };
    const edges = buildGraph([rec('src/main.ts', '@acme/kit'), rec('src/main.ts', 'react')], resolver, 'app', undefined, {
      indexedFiles: buildIndexedFileSet(['src/main.ts']),
      links: [link],
    });
    expect(edges).toEqual([
      expect.objectContaining({ sourceFile: 'src/main.ts', targetFile: 'packages/kit/src/index.ts', targetRepoId: 'lib' }),
    ]);
    rmSync(app, { recursive: true, force: true });
  });

  it('end to end: index_folder stores the workspace edges; graph.workspacePackages=off restores the old graph', async () => {
    const r1 = await indexFolder(root, { skipGit: true, crossIndex: 'off' });
    cleanup.push(r1.repoId);
    const db = openDatabase(r1.repoId);
    const targets = db
      .prepare<[string], { target_file: string }>(
        "SELECT target_file FROM dep_edges WHERE repo_id = ? AND source_file = 'apps/web/src/main.ts' ORDER BY target_file",
      )
      .all(r1.repoId)
      .map((r) => r.target_file);
    expect(targets).toEqual([
      'packages/bare/src/index.ts',
      'packages/kit/src/index.ts',
      'packages/legacy/lib/main.js',
      'packages/schema/src/utils/merge.ts',
    ]);
    db.close();

    process.env['PCTX_WORKSPACE_PACKAGES'] = 'off';
    // Force the graph to rebuild: touch the importer so it is reprocessed.
    write(root, 'apps/web/src/main.ts', "import { kit } from '@acme/kit';\nexport const main = [kit];\n");
    const r2 = await indexFolder(root, { skipGit: true, crossIndex: 'off' });
    expect(r2.repoId).toBe(r1.repoId);
    const db2 = openDatabase(r1.repoId);
    const after = db2
      .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM dep_edges WHERE repo_id = ? AND source_file = 'apps/web/src/main.ts'")
      .get(r1.repoId)!.c;
    expect(after).toBe(0);
    db2.close();
  });
});
