/**
 * Phase 98, Task 608 — validated fast path for handler-prefilled import
 * targets. Before this, `buildGraph` inserted a prefilled `resolvedPath`
 * verbatim, producing dangling edges (gap-analysis-v2 H1).
 */
import { describe, it, expect } from 'vitest';
import {
  buildIndexedFileSet,
  resolvePrefilledTarget,
} from '../../src/graph/prefilled-targets.js';
import { buildGraph } from '../../src/graph/graph-builder.js';
import type { PathResolver } from '../../src/graph/path-resolver.js';
import type { ImportRecord } from '../../src/core/types.js';

const nullResolver: PathResolver = { projectRoot: '/repo', resolve: () => null };

function rec(sourceFile: string, resolvedPath: string, specifier = resolvedPath): ImportRecord {
  return { sourceFile, specifier, resolvedPath, importedNames: [], isTypeOnly: false };
}

describe('resolvePrefilledTarget', () => {
  it('exact repo-relative and ./-prefixed values', () => {
    const idx = buildIndexedFileSet(['src/a.sh', 'src/lib/b.sh']);
    expect(resolvePrefilledTarget(rec('src/a.sh', 'src/lib/b.sh'), idx, nullResolver)).toEqual(['src/lib/b.sh']);
    expect(resolvePrefilledTarget(rec('src/a.sh', './lib/b.sh'), idx, nullResolver)).toEqual(['src/lib/b.sh']);
  });

  it('C sibling include: "auth.h" resolves next to the importer', () => {
    const idx = buildIndexedFileSet(['src/net/auth.h', 'src/net/server.c']);
    expect(resolvePrefilledTarget(rec('src/net/server.c', 'auth.h'), idx, nullResolver)).toEqual(['src/net/auth.h']);
  });

  it('C include root: "net/auth.h" found by unique suffix', () => {
    const idx = buildIndexedFileSet(['include/net/auth.h', 'src/main.c']);
    expect(resolvePrefilledTarget(rec('src/main.c', 'net/auth.h'), idx, nullResolver)).toEqual(['include/net/auth.h']);
  });

  it('suffix tie prefers the candidate sharing the importer directory; a rootless tie is dropped', () => {
    const idx = buildIndexedFileSet(['a/util.h', 'b/util.h', 'a/x.c', 'c/y.c']);
    expect(resolvePrefilledTarget(rec('a/x.c', 'util.h'), idx, nullResolver)).toEqual(['a/util.h']);
    // c/y.c shares no directory with either util.h → ambiguous → no edge
    expect(resolvePrefilledTarget(rec('c/y.c', 'util.h'), idx, nullResolver)).toEqual([]);
  });

  it('stylesheet partials: @use "variables" → _variables.scss, dir index', () => {
    const idx = buildIndexedFileSet(['styles/_variables.scss', 'styles/main.scss', 'styles/mixins/_index.scss']);
    expect(resolvePrefilledTarget(rec('styles/main.scss', 'variables'), idx, nullResolver)).toEqual(['styles/_variables.scss']);
    expect(resolvePrefilledTarget(rec('styles/main.scss', 'mixins'), idx, nullResolver)).toEqual(['styles/mixins/_index.scss']);
  });

  it('Lua: a/b.lua, a/b/init.lua, and the Neovim lua/ runtime root', () => {
    const idx = buildIndexedFileSet(['lua/plugins/init.lua', 'lua/util/str.lua', 'init.lua']);
    expect(resolvePrefilledTarget(rec('init.lua', 'util/str.lua'), idx, nullResolver)).toEqual(['lua/util/str.lua']);
    expect(resolvePrefilledTarget(rec('init.lua', 'plugins.lua'), idx, nullResolver)).toEqual(['lua/plugins/init.lua']);
  });

  it('Terraform: a ./modules/x directory fans out to its .tf files only', () => {
    const idx = buildIndexedFileSet(['main.tf', 'modules/vpc/main.tf', 'modules/vpc/vars.tf', 'modules/vpc/sub/deep.tf', 'modules/vpc/README.md']);
    expect(resolvePrefilledTarget(rec('main.tf', './modules/vpc'), idx, nullResolver)).toEqual(['modules/vpc/main.tf', 'modules/vpc/vars.tf']);
  });

  it('falls back to the disk resolver but only accepts an indexed hit', () => {
    const idx = buildIndexedFileSet(['src/a.ts', 'src/b.ts']);
    const resolver: PathResolver = { projectRoot: '/repo', resolve: (s) => (s === './b' ? 'src/b.ts' : s === './zz' ? 'src/zz.ts' : null) };
    expect(resolvePrefilledTarget(rec('src/a.ts', 'b', './b'), idx, resolver)).toEqual(['src/b.ts']);
    expect(resolvePrefilledTarget(rec('src/a.ts', 'zz', './zz'), idx, resolver)).toEqual([]);
  });

  it('a value that matches nothing yields no target (never a dangling edge)', () => {
    const idx = buildIndexedFileSet(['src/a.c']);
    expect(resolvePrefilledTarget(rec('src/a.c', 'missing.h'), idx, nullResolver)).toEqual([]);
  });

  it('returns the STORED path form (backslash paths on Windows-indexed repos)', () => {
    const idx = buildIndexedFileSet(['src\\net\\auth.h', 'src\\net\\server.c']);
    expect(resolvePrefilledTarget(rec('src/net/server.c', 'auth.h'), idx, nullResolver)).toEqual(['src\\net\\auth.h']);
  });
});

describe('buildGraph with indexedFiles', () => {
  it('drops a phantom prefilled target and keeps a real one', () => {
    const idx = buildIndexedFileSet(['src/a.c', 'src/b.h']);
    const edges = buildGraph(
      [rec('src/a.c', 'b.h'), rec('src/a.c', 'ghost.h')],
      nullResolver,
      'r1',
      undefined,
      { indexedFiles: idx },
    );
    expect(edges.map((e) => e.targetFile)).toEqual(['src/b.h']);
  });

  it('back-compat: without indexedFiles the prefilled value is used verbatim', () => {
    const edges = buildGraph([rec('src/a.c', 'ghost.h')], nullResolver, 'r1');
    expect(edges.map((e) => e.targetFile)).toEqual(['ghost.h']);
  });
});
