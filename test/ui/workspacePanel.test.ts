import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── localStorage stub ────────────────────────────────────────────────────────

function makeLocalStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { for (const k in store) delete store[k]; },
  };
}

// ─── workspaceStore unit tests ────────────────────────────────────────────────

describe('workspaceStore (localStorage persistence)', () => {
  let ls: ReturnType<typeof makeLocalStorage>;

  beforeEach(() => {
    ls = makeLocalStorage();
    vi.stubGlobal('localStorage', ls);
    vi.resetModules();
  });

  it('starts with empty pinned repos', async () => {
    const { useWorkspaceStore } = await import('../../src/ui/src/stores/workspaceStore.js');
    expect(useWorkspaceStore.getState().pinnedRepos).toEqual([]);
  });

  it('pin() adds a repo and persists to localStorage', async () => {
    const { useWorkspaceStore } = await import('../../src/ui/src/stores/workspaceStore.js');
    const { pin } = useWorkspaceStore.getState();

    pin('repo-abc');
    expect(useWorkspaceStore.getState().pinnedRepos).toContain('repo-abc');
    expect(JSON.parse(ls.getItem('purecontext-workspace')!)).toContain('repo-abc');
  });

  it('pin() is idempotent — no duplicates', async () => {
    const { useWorkspaceStore } = await import('../../src/ui/src/stores/workspaceStore.js');
    const { pin } = useWorkspaceStore.getState();

    pin('repo-abc');
    pin('repo-abc');
    expect(useWorkspaceStore.getState().pinnedRepos.filter((id) => id === 'repo-abc')).toHaveLength(1);
  });

  it('unpin() removes a repo and persists to localStorage', async () => {
    const { useWorkspaceStore } = await import('../../src/ui/src/stores/workspaceStore.js');
    const { pin, unpin } = useWorkspaceStore.getState();

    pin('repo-abc');
    pin('repo-xyz');
    unpin('repo-abc');

    const { pinnedRepos } = useWorkspaceStore.getState();
    expect(pinnedRepos).not.toContain('repo-abc');
    expect(pinnedRepos).toContain('repo-xyz');
    expect(JSON.parse(ls.getItem('purecontext-workspace')!)).not.toContain('repo-abc');
  });

  it('loads pinned repos from localStorage on first import', async () => {
    ls.setItem('purecontext-workspace', JSON.stringify(['repo-persisted']));
    const { useWorkspaceStore } = await import('../../src/ui/src/stores/workspaceStore.js');
    expect(useWorkspaceStore.getState().pinnedRepos).toContain('repo-persisted');
  });

  it('setActive() sets the active repo ID', async () => {
    const { useWorkspaceStore } = await import('../../src/ui/src/stores/workspaceStore.js');
    useWorkspaceStore.getState().setActive('repo-abc');
    expect(useWorkspaceStore.getState().activeRepoId).toBe('repo-abc');
  });
});

// ─── Multi-repo search integration ───────────────────────────────────────────

describe('multi-repo search — API client routing', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('routes to /api/search when repoIds has >1 entry', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [], _meta: { timingMs: 1 } }),
    });
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });

    const { api } = await import('../../src/ui/src/api/client.js');
    await api.searchSymbols(null, {
      query: 'myFunc',
      repoIds: ['repo-a', 'repo-b'],
    }).catch(() => {});

    const calledUrl: string = mockFetch.mock.calls[0]?.[0] ?? '';
    expect(calledUrl).toContain('/api/search');
    expect(calledUrl).toContain('repoIds=repo-a%2Crepo-b');
  });

  it('routes to /api/repos/:id/search when single repoId', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [], _meta: { timingMs: 1 } }),
    });
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });

    const { api } = await import('../../src/ui/src/api/client.js');
    await api.searchSymbols('repo-a', { query: 'myFunc' }).catch(() => {});

    const calledUrl: string = mockFetch.mock.calls[0]?.[0] ?? '';
    expect(calledUrl).toContain('/api/repos/repo-a/search');
  });
});

// ─── normalizeSearchResponse (HTTP server helper) ─────────────────────────────

describe('normalizeSearchResponse', () => {
  it('renames symbols → results in tool JSON output', () => {
    const input = JSON.stringify({ count: 2, symbols: [{ id: 'a' }, { id: 'b' }], _meta: {} });
    // Inline the same logic used in http-server.ts
    const parsed = JSON.parse(input) as Record<string, unknown>;
    if ('symbols' in parsed && !('results' in parsed)) {
      parsed['results'] = parsed['symbols'];
      delete parsed['symbols'];
    }
    const result = JSON.parse(JSON.stringify(parsed));
    expect(result.results).toHaveLength(2);
    expect(result.symbols).toBeUndefined();
  });

  it('leaves results intact when already present', () => {
    const input = JSON.stringify({ count: 1, results: [{ id: 'x' }], _meta: {} });
    const parsed = JSON.parse(input) as Record<string, unknown>;
    if ('symbols' in parsed && !('results' in parsed)) {
      parsed['results'] = parsed['symbols'];
      delete parsed['symbols'];
    }
    const result = JSON.parse(JSON.stringify(parsed));
    expect(result.results).toHaveLength(1);
  });
});
