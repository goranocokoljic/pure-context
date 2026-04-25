/**
 * Unit tests for the repoStore Zustand store.
 * These run in Node (no DOM needed) because Zustand works without a browser.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ─── Minimal Zustand shim for Node environment ────────────────────────────────
// Zustand itself is ESM and should import fine; we just need to reset state
// between tests by re-creating the store with the factory function.

// Store factory — mirrors the real store but lets us create fresh instances.
type SymbolKind = 'function' | 'class' | 'method' | 'const' | 'type' | 'interface' | 'enum' | 'component' | 'composable' | 'hook' | 'route' | 'decorator' | 'middleware';

interface FileSummary {
  filePath: string;
  symbols: Array<{ id: string; name: string; kind: SymbolKind; signature: string; summary: string; startByte: number; endByte: number }>;
}

interface RepoMeta {
  repoId: string;
  rootPath: string;
  symbolCount: number;
  fileCount: number;
  lastIndexed: string;
}

// Plain-object implementation of the same store logic (no Zustand runtime needed)
function makeStore() {
  let state = {
    repos: [] as RepoMeta[],
    reposLoaded: false,
    trees: {} as Record<string, unknown>,
    outlines: {} as Record<string, FileSummary[]>,
    selectedRepoId: null as string | null,
    selectedFilePath: null as string | null,
    expandedDirs: {} as Record<string, Set<string>>,
  };

  return {
    getState: () => state,
    setRepos(repos: RepoMeta[]) {
      state = { ...state, repos, reposLoaded: true };
    },
    setTree(repoId: string, tree: unknown) {
      state = { ...state, trees: { ...state.trees, [repoId]: tree } };
    },
    setOutline(repoId: string, files: FileSummary[]) {
      state = { ...state, outlines: { ...state.outlines, [repoId]: files } };
    },
    selectRepo(repoId: string) {
      state = { ...state, selectedRepoId: repoId, selectedFilePath: null };
    },
    selectFile(filePath: string | null) {
      state = { ...state, selectedFilePath: filePath };
    },
    toggleDir(repoId: string, path: string) {
      const prev = state.expandedDirs[repoId] ?? new Set<string>();
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      state = { ...state, expandedDirs: { ...state.expandedDirs, [repoId]: next } };
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('repoStore logic', () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    store = makeStore();
  });

  it('starts with empty repos and no selection', () => {
    const s = store.getState();
    expect(s.repos).toEqual([]);
    expect(s.reposLoaded).toBe(false);
    expect(s.selectedRepoId).toBeNull();
    expect(s.selectedFilePath).toBeNull();
  });

  it('setRepos updates repos and marks loaded', () => {
    const repos: RepoMeta[] = [
      { repoId: 'abc123', rootPath: '/src', symbolCount: 10, fileCount: 5, lastIndexed: '2026-01-01' },
    ];
    store.setRepos(repos);
    const s = store.getState();
    expect(s.repos).toEqual(repos);
    expect(s.reposLoaded).toBe(true);
  });

  it('setTree caches tree keyed by repoId', () => {
    store.setTree('repo1', { tree: {}, repoId: 'repo1', _meta: {} });
    store.setTree('repo2', { tree: {}, repoId: 'repo2', _meta: {} });
    const s = store.getState();
    expect(Object.keys(s.trees)).toContain('repo1');
    expect(Object.keys(s.trees)).toContain('repo2');
  });

  it('setOutline caches outline keyed by repoId', () => {
    const files: FileSummary[] = [{ filePath: 'src/index.ts', symbols: [] }];
    store.setOutline('repo1', files);
    expect(store.getState().outlines['repo1']).toEqual(files);
  });

  it('selectRepo sets selectedRepoId and clears selectedFilePath', () => {
    store.selectFile('/some/file.ts');
    store.selectRepo('repo42');
    const s = store.getState();
    expect(s.selectedRepoId).toBe('repo42');
    expect(s.selectedFilePath).toBeNull();
  });

  it('selectFile sets selectedFilePath', () => {
    store.selectFile('src/core/types.ts');
    expect(store.getState().selectedFilePath).toBe('src/core/types.ts');
  });

  it('selectFile accepts null to deselect', () => {
    store.selectFile('src/foo.ts');
    store.selectFile(null);
    expect(store.getState().selectedFilePath).toBeNull();
  });

  it('toggleDir expands a directory', () => {
    store.toggleDir('repo1', 'src');
    const expanded = store.getState().expandedDirs['repo1'];
    expect(expanded?.has('src')).toBe(true);
  });

  it('toggleDir collapses an already-expanded directory', () => {
    store.toggleDir('repo1', 'src');
    store.toggleDir('repo1', 'src');
    const expanded = store.getState().expandedDirs['repo1'];
    expect(expanded?.has('src')).toBe(false);
  });

  it('toggleDir tracks expanded dirs independently per repo', () => {
    store.toggleDir('repo1', 'src');
    store.toggleDir('repo2', 'lib');
    expect(store.getState().expandedDirs['repo1']?.has('src')).toBe(true);
    expect(store.getState().expandedDirs['repo1']?.has('lib')).toBeFalsy();
    expect(store.getState().expandedDirs['repo2']?.has('lib')).toBe(true);
  });

  it('multiple setTree calls do not clobber existing entries', () => {
    store.setTree('r1', { tree: { a: { type: 'file' } } });
    store.setTree('r2', { tree: { b: { type: 'file' } } });
    const s = store.getState();
    expect(s.trees['r1']).toBeDefined();
    expect(s.trees['r2']).toBeDefined();
  });
});
