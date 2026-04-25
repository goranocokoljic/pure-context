import { create } from 'zustand';
import type { RepoMeta, GetFileTreeResponse, FileSummary } from '../api/types.js';

// ─── State ────────────────────────────────────────────────────────────────────

interface RepoState {
  /** All indexed repos (loaded once). */
  repos: RepoMeta[];
  reposLoaded: boolean;

  /** File trees keyed by repoId. */
  trees: Record<string, GetFileTreeResponse>;

  /** Repo outlines keyed by repoId. */
  outlines: Record<string, FileSummary[]>;

  /** Currently viewed repo. */
  selectedRepoId: string | null;

  /** Currently selected file path within the repo. */
  selectedFilePath: string | null;

  /** Expanded directory paths keyed by repoId. */
  expandedDirs: Record<string, Set<string>>;

  // ─── Actions ───────────────────────────────────────────────────────────────

  setRepos(repos: RepoMeta[]): void;
  setTree(repoId: string, tree: GetFileTreeResponse): void;
  setOutline(repoId: string, files: FileSummary[]): void;
  selectRepo(repoId: string): void;
  selectFile(filePath: string | null): void;
  toggleDir(repoId: string, path: string): void;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useRepoStore = create<RepoState>((set) => ({
  repos: [],
  reposLoaded: false,
  trees: {},
  outlines: {},
  selectedRepoId: null,
  selectedFilePath: null,
  expandedDirs: {},

  setRepos(repos) {
    set({ repos, reposLoaded: true });
  },

  setTree(repoId, tree) {
    set((s) => ({ trees: { ...s.trees, [repoId]: tree } }));
  },

  setOutline(repoId, files) {
    set((s) => ({ outlines: { ...s.outlines, [repoId]: files } }));
  },

  selectRepo(repoId) {
    set({ selectedRepoId: repoId, selectedFilePath: null });
  },

  selectFile(filePath) {
    set({ selectedFilePath: filePath });
  },

  toggleDir(repoId, path) {
    set((s) => {
      const prev = s.expandedDirs[repoId] ?? new Set<string>();
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return { expandedDirs: { ...s.expandedDirs, [repoId]: next } };
    });
  },
}));
