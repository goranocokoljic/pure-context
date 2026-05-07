import { create } from 'zustand';

// ─── Persistence ──────────────────────────────────────────────────────────────

const STORAGE_KEY = 'purecontext-workspace';

function loadFromStorage(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as string[];
    return [];
  } catch {
    return [];
  }
}

function saveToStorage(pinnedRepos: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pinnedRepos));
  } catch {
    // ignore write errors (e.g. private browsing mode)
  }
}

// ─── Store ────────────────────────────────────────────────────────────────────

export interface WorkspaceStore {
  pinnedRepos: string[];
  activeRepoId: string | null;
  pin(repoId: string): void;
  unpin(repoId: string): void;
  setActive(repoId: string): void;
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  pinnedRepos: loadFromStorage(),
  activeRepoId: null,

  pin(repoId) {
    set((s) => {
      if (s.pinnedRepos.includes(repoId)) return {};
      const next = [...s.pinnedRepos, repoId];
      saveToStorage(next);
      return { pinnedRepos: next };
    });
  },

  unpin(repoId) {
    set((s) => {
      const next = s.pinnedRepos.filter((id) => id !== repoId);
      saveToStorage(next);
      return { pinnedRepos: next };
    });
  },

  setActive(repoId) {
    set({ activeRepoId: repoId });
  },
}));
