import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRepoStore } from '../stores/repoStore.js';
import { useWorkspaceStore } from '../stores/workspaceStore.js';
import { api } from '../api/client.js';
import type { RepoMeta } from '../api/types.js';

// ─── Icons ────────────────────────────────────────────────────────────────────

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      {filled ? (
        <path d="M6.5 1L8 5H12L8.5 7.5L9.5 12L6.5 9.5L3.5 12L4.5 7.5L1 5H5L6.5 1Z" fill="currentColor" />
      ) : (
        <path d="M6.5 1L8 5H12L8.5 7.5L9.5 12L6.5 9.5L3.5 12L4.5 7.5L1 5H5L6.5 1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <line x1="2" y1="2" x2="12" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="12" y1="2" x2="2" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SearchAllIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.4" />
      <line x1="8.5" y1="8.5" x2="11.5" y2="11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// ─── Repo row ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffMins = Math.floor(diffMs / 60_000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function RepoRow({ repo, pinned, onPin, onUnpin }: {
  repo: RepoMeta;
  pinned: boolean;
  onPin: () => void;
  onUnpin: () => void;
}) {
  const repoName = repo.rootPath.split(/[/\\]/).pop() ?? repo.repoId;
  const hasSymbols = repo.symbolCount > 0;

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 border-b border-gray-800/60 ${
        !hasSymbols ? 'opacity-50' : ''
      }`}
      data-testid="repo-row"
    >
      {/* Status dot */}
      <span
        className={`shrink-0 w-2 h-2 rounded-full ${hasSymbols ? 'bg-green-500' : 'bg-gray-600'}`}
        title={hasSymbols ? `${repo.symbolCount} symbols` : 'Not indexed'}
      />

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-gray-200 truncate" title={repo.rootPath}>
          {repoName}
        </p>
        <p className="text-[10px] text-gray-500">
          {repo.symbolCount.toLocaleString()} symbols &middot; {formatDate(repo.lastIndexed)}
        </p>
      </div>

      {/* Pin toggle */}
      <button
        type="button"
        onClick={pinned ? onUnpin : onPin}
        aria-label={pinned ? `Unpin ${repoName}` : `Pin ${repoName}`}
        aria-pressed={pinned}
        className={`shrink-0 p-1 rounded transition-colors ${
          pinned
            ? 'text-yellow-400 hover:text-yellow-300'
            : 'text-gray-600 hover:text-gray-300'
        }`}
        data-testid={pinned ? 'unpin-btn' : 'pin-btn'}
      >
        <PinIcon filled={pinned} />
      </button>
    </div>
  );
}

// ─── WorkspacePanel ───────────────────────────────────────────────────────────

export interface WorkspacePanelProps {
  onClose: () => void;
}

export function WorkspacePanel({ onClose }: WorkspacePanelProps) {
  const navigate = useNavigate();

  const storedRepos  = useRepoStore((s) => s.repos);
  const reposLoaded  = useRepoStore((s) => s.reposLoaded);
  const setReposStore = useRepoStore((s) => s.setRepos);

  const pinnedRepos = useWorkspaceStore((s) => s.pinnedRepos);
  const pin         = useWorkspaceStore((s) => s.pin);
  const unpin       = useWorkspaceStore((s) => s.unpin);

  // Load repos if not already loaded.
  useEffect(() => {
    if (reposLoaded) return;
    api.listRepos().then((res) => setReposStore(res.repos)).catch(() => {});
  }, [reposLoaded, setReposStore]);

  function handleSearchAll() {
    if (pinnedRepos.length === 0) return;
    const params = new URLSearchParams();
    for (const id of pinnedRepos) params.append('repoIds', id);
    navigate(`/search?${params.toString()}`);
    onClose();
  }

  function handleSearchRepo(repoId: string) {
    navigate(`/search?repoId=${encodeURIComponent(repoId)}`);
    onClose();
  }

  const pinnedList = storedRepos.filter((r) => pinnedRepos.includes(r.repoId));
  const unpinnedList = storedRepos.filter((r) => !pinnedRepos.includes(r.repoId));

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        aria-hidden="true"
        data-testid="workspace-backdrop"
      />

      {/* Panel */}
      <aside
        className="fixed top-14 right-0 bottom-0 z-50 w-72 bg-gray-900 border-l border-gray-800 flex flex-col shadow-xl"
        role="dialog"
        aria-label="Workspace panel"
        data-testid="workspace-panel"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 shrink-0">
          <div>
            <span className="text-sm font-semibold text-gray-100">Workspace</span>
            {pinnedRepos.length > 0 && (
              <span className="ml-2 text-[10px] bg-blue-600 text-white rounded-full px-1.5 py-0.5 font-bold">
                {pinnedRepos.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {pinnedRepos.length > 0 && (
              <button
                type="button"
                onClick={handleSearchAll}
                className="flex items-center gap-1.5 px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded transition-colors"
                title="Search across all pinned repos"
                data-testid="search-all-btn"
              >
                <SearchAllIcon />
                Search all
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-gray-500 hover:text-gray-200 transition-colors rounded"
              aria-label="Close workspace panel"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {/* Pinned section */}
          {pinnedList.length > 0 && (
            <div>
              <p className="px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                Pinned
              </p>
              {pinnedList.map((repo) => (
                <div key={repo.repoId} onClick={() => handleSearchRepo(repo.repoId)} className="cursor-pointer hover:bg-gray-800/30 transition-colors">
                  <RepoRow
                    repo={repo}
                    pinned
                    onPin={() => pin(repo.repoId)}
                    onUnpin={() => unpin(repo.repoId)}
                  />
                </div>
              ))}
            </div>
          )}

          {/* All repos section */}
          {unpinnedList.length > 0 && (
            <div>
              <p className="px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                {pinnedList.length > 0 ? 'All repositories' : 'Repositories'}
              </p>
              {unpinnedList.map((repo) => (
                <div key={repo.repoId} onClick={() => handleSearchRepo(repo.repoId)} className="cursor-pointer hover:bg-gray-800/30 transition-colors">
                  <RepoRow
                    repo={repo}
                    pinned={false}
                    onPin={() => pin(repo.repoId)}
                    onUnpin={() => unpin(repo.repoId)}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Empty state */}
          {storedRepos.length === 0 && reposLoaded && (
            <div className="flex flex-col items-center justify-center h-40 text-gray-600 text-sm gap-2">
              <p>No indexed repositories.</p>
              <p className="text-xs text-center px-4">
                Run <code className="font-mono bg-gray-800 px-1 rounded">index-folder</code> to get started.
              </p>
            </div>
          )}

          {storedRepos.length === 0 && !reposLoaded && (
            <div className="flex items-center justify-center h-24">
              <span className="block w-4 h-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
            </div>
          )}
        </div>

        {/* Footer hint */}
        {pinnedRepos.length === 0 && storedRepos.length > 0 && (
          <div className="px-4 py-3 border-t border-gray-800 shrink-0">
            <p className="text-[10px] text-gray-600 text-center">
              Pin repos to enable multi-repo search
            </p>
          </div>
        )}
      </aside>
    </>
  );
}
