import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiClientError } from '../api/client.js';
import type { RepoMeta } from '../api/types.js';

// ─── Repo card ────────────────────────────────────────────────────────────────

function RepoCard({ repo }: { repo: RepoMeta }) {
  const navigate = useNavigate();
  const lastIndexed = new Date(repo.lastIndexed).toLocaleString();
  const shortPath =
    repo.rootPath.length > 60 ? '…' + repo.rootPath.slice(-57) : repo.rootPath;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/repos/${encodeURIComponent(repo.repoId)}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') navigate(`/repos/${encodeURIComponent(repo.repoId)}`);
      }}
      className="border border-gray-800 rounded-lg p-5 bg-gray-900 hover:border-blue-600 transition-colors cursor-pointer group"
      aria-label={`Open ${repo.rootPath.split('/').pop() ?? repo.repoId}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-semibold text-gray-100 truncate group-hover:text-blue-400 transition-colors">
            {repo.rootPath.split(/[/\\]/).pop() ?? repo.repoId}
          </h3>
          <p className="text-xs text-gray-500 mt-1 truncate" title={repo.rootPath}>
            {shortPath}
          </p>
        </div>
        <span className="text-xs font-mono text-gray-600 shrink-0 mt-0.5">{repo.repoId}</span>
      </div>

      <div className="flex items-center gap-6 mt-4 text-sm text-gray-400">
        <Stat label="Symbols" value={repo.symbolCount.toLocaleString()} />
        <Stat label="Files" value={repo.fileCount.toLocaleString()} />
        <Stat label="Indexed" value={lastIndexed} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-gray-600 text-xs">{label} </span>
      <span className="font-medium text-gray-300">{value}</span>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-64 text-center text-gray-500 gap-3">
      <div className="text-5xl opacity-30">&#128269;</div>
      <p className="text-lg font-medium text-gray-400">No repositories indexed</p>
      <p className="text-sm max-w-xs">
        Use <code className="bg-gray-800 px-1 rounded text-gray-300">npx purecontext-mcp index-folder</code> to
        index a project.
      </p>
    </div>
  );
}

// ─── RepoList page ────────────────────────────────────────────────────────────

export default function RepoList() {
  const [repos, setRepos] = useState<RepoMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .listRepos()
      .then((res) => {
        if (!cancelled) setRepos(res.repos);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiClientError ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = repos.filter((r) => {
    const q = filter.toLowerCase();
    return (
      r.rootPath.toLowerCase().includes(q) ||
      r.repoId.toLowerCase().includes(q)
    );
  });

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-xl font-bold text-gray-100">Repositories</h1>
          <input
            type="search"
            placeholder="Filter repositories…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-64 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
        </div>

        {loading && (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-28 bg-gray-900 border border-gray-800 rounded-lg animate-pulse" />
            ))}
          </div>
        )}

        {error && (
          <div className="p-4 bg-red-950 border border-red-800 rounded-lg text-red-300 text-sm">
            {error}
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          repos.length === 0 ? <EmptyState /> : (
            <p className="text-gray-500 text-sm">No repositories match &ldquo;{filter}&rdquo;.</p>
          )
        )}

        {!loading && !error && filtered.length > 0 && (
          <div className="space-y-3">
            {filtered.map((repo) => (
              <RepoCard key={repo.repoId} repo={repo} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
