import { describe, it, expect } from 'vitest';
import { buildGraph } from '../../src/graph/graph-builder.js';
import { createResolver } from '../../src/graph/path-resolver.js';
import type { ImportRecord } from '../../src/core/types.js';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function makeTempProject(files: Record<string, string>): string {
  const root = join(tmpdir(), `purecontext-gb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(join(root, path.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function makeImport(overrides: Partial<ImportRecord>): ImportRecord {
  return {
    sourceFile: 'src/a.ts',
    specifier: './b',
    resolvedPath: null,
    importedNames: [],
    isTypeOnly: false,
    ...overrides,
  };
}

describe('buildGraph', () => {
  it('creates an edge from source to resolved target', () => {
    const root = makeTempProject({ 'src/a.ts': '', 'src/b.ts': '' });
    const resolver = createResolver(root);
    const imports = [makeImport({ sourceFile: 'src/a.ts', specifier: './b' })];
    const edges = buildGraph(imports, resolver, 'repo1');
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceFile).toBe('src/a.ts');
    expect(edges[0].targetFile).toBe('src/b.ts');
    expect(edges[0].repoId).toBe('repo1');
    rmSync(root, { recursive: true });
  });

  it('uses pre-resolved resolvedPath when available', () => {
    const root = makeTempProject({});
    const resolver = createResolver(root);
    const imports = [
      makeImport({
        sourceFile: 'src/a.ts',
        specifier: './b',
        resolvedPath: 'src/b.ts',
      }),
    ];
    const edges = buildGraph(imports, resolver, 'repo1');
    expect(edges).toHaveLength(1);
    expect(edges[0].targetFile).toBe('src/b.ts');
    rmSync(root, { recursive: true });
  });

  it('drops imports that resolve to null (external packages)', () => {
    const root = makeTempProject({});
    const resolver = createResolver(root);
    const imports = [
      makeImport({ sourceFile: 'src/a.ts', specifier: 'express' }),
    ];
    const edges = buildGraph(imports, resolver, 'repo1');
    expect(edges).toHaveLength(0);
    rmSync(root, { recursive: true });
  });

  it('deduplicates edges with the same (sourceFile, targetFile)', () => {
    const root = makeTempProject({ 'src/a.ts': '', 'src/b.ts': '' });
    const resolver = createResolver(root);
    // Two imports from the same target (e.g. named + default)
    const imports = [
      makeImport({ sourceFile: 'src/a.ts', specifier: './b', importedNames: ['foo'] }),
      makeImport({ sourceFile: 'src/a.ts', specifier: './b', importedNames: ['bar'] }),
    ];
    const edges = buildGraph(imports, resolver, 'repo1');
    expect(edges).toHaveLength(1);
    rmSync(root, { recursive: true });
  });

  it('keeps edges from different sources to the same target', () => {
    const root = makeTempProject({ 'src/a.ts': '', 'src/b.ts': '', 'src/c.ts': '' });
    const resolver = createResolver(root);
    const imports = [
      makeImport({ sourceFile: 'src/a.ts', specifier: './c' }),
      makeImport({ sourceFile: 'src/b.ts', specifier: './c' }),
    ];
    const edges = buildGraph(imports, resolver, 'repo1');
    expect(edges).toHaveLength(2);
    rmSync(root, { recursive: true });
  });

  it('keeps edges from the same source to different targets', () => {
    const root = makeTempProject({ 'src/a.ts': '', 'src/b.ts': '', 'src/c.ts': '' });
    const resolver = createResolver(root);
    const imports = [
      makeImport({ sourceFile: 'src/a.ts', specifier: './b' }),
      makeImport({ sourceFile: 'src/a.ts', specifier: './c' }),
    ];
    const edges = buildGraph(imports, resolver, 'repo1');
    expect(edges).toHaveLength(2);
    rmSync(root, { recursive: true });
  });

  it('sets sourceSymbolId and targetSymbolId to null (Phase 1)', () => {
    const root = makeTempProject({ 'src/a.ts': '', 'src/b.ts': '' });
    const resolver = createResolver(root);
    const edges = buildGraph(
      [makeImport({ sourceFile: 'src/a.ts', specifier: './b' })],
      resolver,
      'repo1',
    );
    expect(edges[0].sourceSymbolId).toBeNull();
    expect(edges[0].targetSymbolId).toBeNull();
    rmSync(root, { recursive: true });
  });

  it('sets edgeType to "import"', () => {
    const root = makeTempProject({ 'src/a.ts': '', 'src/b.ts': '' });
    const resolver = createResolver(root);
    const edges = buildGraph(
      [makeImport({ sourceFile: 'src/a.ts', specifier: './b' })],
      resolver,
      'repo1',
    );
    expect(edges[0].edgeType).toBe('import');
    rmSync(root, { recursive: true });
  });

  it('skips records with empty sourceFile', () => {
    const root = makeTempProject({ 'src/b.ts': '' });
    const resolver = createResolver(root);
    const imports = [makeImport({ sourceFile: '', specifier: './b' })];
    const edges = buildGraph(imports, resolver, 'repo1');
    expect(edges).toHaveLength(0);
    rmSync(root, { recursive: true });
  });

  it('handles an empty import list', () => {
    const root = makeTempProject({});
    const resolver = createResolver(root);
    expect(buildGraph([], resolver, 'repo1')).toEqual([]);
    rmSync(root, { recursive: true });
  });
});
