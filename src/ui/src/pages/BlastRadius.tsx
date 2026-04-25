import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiClientError } from '../api/client.js';
import type { GetBlastRadiusResponse, RepoMeta, SearchResult } from '../api/types.js';
import { useRepoStore } from '../stores/repoStore.js';
import { useSearch } from '../hooks/useSearch.js';
import { ImpactStats } from '../components/ImpactStats.js';
import { BlastRadiusGraph } from '../components/BlastRadiusGraph.js';
import { BlastRadiusList } from '../components/BlastRadiusList.js';

// ─── Sub-components ───────────────────────────────────────────────────────────

function RepoSelector({
  repos,
  selectedId,
  onSelect,
}: {
  repos: RepoMeta[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <select
      value={selectedId ?? ''}
      onChange={(e) => onSelect(e.target.value)}
      className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100 focus:outline-none focus:border-blue-500"
      aria-label="Select repository"
    >
      {!selectedId && <option value="">Select repository…</option>}
      {repos.map((r) => (
        <option key={r.repoId} value={r.repoId}>
          {r.rootPath.split(/[/\\]/).pop() ?? r.repoId}
        </option>
      ))}
    </select>
  );
}

// ─── DepthSelector ────────────────────────────────────────────────────────────

function DepthSelector({
  value,
  onChange,
}: {
  value: number;
  onChange: (d: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500">Max depth</span>
      <input
        type="range"
        min={1}
        max={6}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-24 accent-blue-500"
        aria-label="Max depth"
      />
      <span className="text-xs font-mono text-gray-300 w-4">{value}</span>
    </div>
  );
}

// ─── SymbolPicker ─────────────────────────────────────────────────────────────

function SymbolPicker({
  repoId,
  selectedSymbol,
  onSelect,
}: {
  repoId: string | null;
  selectedSymbol: SearchResult | null;
  onSelect: (r: SearchResult) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const search = useSearch({ repoId, debounceMs: 300 });

  const handleInput = (q: string) => {
    search.setQuery(q);
  };

  const handleSelect = (r: SearchResult) => {
    onSelect(r);
    search.clearSearch();
  };

  const showResults = search.query.length > 0 && search.results.length > 0;

  return (
    <div className="relative">
      {selectedSymbol && (
        <div className="mb-2 flex items-center gap-2 px-3 py-2 bg-blue-600/10 border border-blue-600/30 rounded-lg">
          <span className="text-[10px] font-semibold uppercase tracking-wider bg-blue-600/30 text-blue-300 rounded px-1.5 py-0.5 shrink-0">
            {selectedSymbol.kind}
          </span>
          <span className="text-sm text-blue-300 font-mono font-medium flex-1 truncate">
            {selectedSymbol.name}
          </span>
          <button
            type="button"
            onClick={() => onSelect({ ...selectedSymbol, id: '' } as unknown as SearchResult)}
            className="text-gray-500 hover:text-gray-300 transition-colors text-xs"
            aria-label="Clear symbol selection"
          >
            ✕
          </button>
        </div>
      )}

      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <line x1="9.5" y1="9.5" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
        <input
          ref={inputRef}
          type="search"
          value={search.query}
          onChange={(e) => handleInput(e.target.value)}
          placeholder={repoId ? 'Search for a symbol…' : 'Select a repo first…'}
          disabled={!repoId}
          className="w-full pl-8 pr-4 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 disabled:opacity-40"
          aria-label="Search for a symbol to analyze"
        />
        {search.loading && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2">
            <span className="block w-3 h-3 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
          </span>
        )}
      </div>

      {/* Results dropdown */}
      {showResults && (
        <div className="absolute z-30 top-full left-0 right-0 mt-1 bg-gray-900 border border-gray-700 rounded-lg shadow-xl max-h-64 overflow-y-auto">
          {search.results.slice(0, 20).map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => handleSelect(r)}
              className="w-full text-left px-3 py-2.5 flex items-center gap-2 hover:bg-gray-800 transition-colors"
            >
              <span className="text-[9px] font-semibold uppercase tracking-wider bg-gray-700 text-gray-400 rounded px-1.5 py-0.5 shrink-0">
                {r.kind}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-mono text-gray-200 truncate">{r.name}</p>
                <p className="text-[10px] text-gray-500 truncate">{r.filePath}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── View toggle ──────────────────────────────────────────────────────────────

type ViewMode = 'graph' | 'list';

function ViewToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  return (
    <div className="flex rounded-lg border border-gray-700 overflow-hidden">
      {(['graph', 'list'] as ViewMode[]).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={`px-3 py-1.5 text-xs font-medium transition-colors capitalize ${
            mode === m
              ? 'bg-blue-600 text-white'
              : 'bg-gray-800 text-gray-400 hover:text-gray-200'
          }`}
          aria-pressed={mode === m}
        >
          {m === 'graph' ? (
            <span className="flex items-center gap-1">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <circle cx="6" cy="2" r="1.5" fill="currentColor" />
                <circle cx="2" cy="9" r="1.5" fill="currentColor" />
                <circle cx="10" cy="9" r="1.5" fill="currentColor" />
                <line x1="6" y1="3.5" x2="2.8" y2="7.7" stroke="currentColor" strokeWidth="1" />
                <line x1="6" y1="3.5" x2="9.2" y2="7.7" stroke="currentColor" strokeWidth="1" />
              </svg>
              Graph
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <rect x="1" y="2" width="10" height="1.5" rx="0.5" fill="currentColor" />
                <rect x="1" y="5.25" width="10" height="1.5" rx="0.5" fill="currentColor" />
                <rect x="1" y="8.5" width="7" height="1.5" rx="0.5" fill="currentColor" />
              </svg>
              List
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ─── EmptyState ───────────────────────────────────────────────────────────────

function EmptyState({ hasSymbol }: { hasSymbol: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center gap-4 py-16 px-8">
      <div className="w-16 h-16 rounded-full bg-gray-800 flex items-center justify-center mb-2">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
          <circle cx="14" cy="14" r="4" fill="#3b82f6" opacity="0.8" />
          <circle cx="14" cy="14" r="8" stroke="#ef4444" strokeWidth="1.5" strokeDasharray="3 3" opacity="0.5" />
          <circle cx="14" cy="14" r="12" stroke="#f97316" strokeWidth="1" strokeDasharray="3 3" opacity="0.3" />
        </svg>
      </div>
      <div>
        <h3 className="text-gray-300 font-medium mb-1">
          {hasSymbol ? 'Loading blast radius…' : 'Select a symbol to analyze'}
        </h3>
        <p className="text-sm text-gray-500 max-w-xs">
          {hasSymbol
            ? 'Traversing the dependency graph…'
            : 'Search for a function, class, or type to see which files would be affected if it changed.'}
        </p>
      </div>
    </div>
  );
}

// ─── BlastRadius page ─────────────────────────────────────────────────────────

export default function BlastRadius() {
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Repo state ─────────────────────────────────────────────────────────────
  const storedRepos   = useRepoStore((s) => s.repos);
  const reposLoaded   = useRepoStore((s) => s.reposLoaded);
  const setReposStore = useRepoStore((s) => s.setRepos);

  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(
    searchParams.get('repoId') ?? null,
  );

  useEffect(() => {
    if (reposLoaded) return;
    api.listRepos().then((res) => setReposStore(res.repos)).catch(() => {});
  }, [reposLoaded, setReposStore]);

  useEffect(() => {
    if (!selectedRepoId && storedRepos.length > 0) {
      setSelectedRepoId(storedRepos[0]!.repoId);
    }
  }, [storedRepos, selectedRepoId]);

  // ── Symbol selection ───────────────────────────────────────────────────────
  const [selectedSymbol, setSelectedSymbol] = useState<SearchResult | null>(null);

  // Pre-populate from URL params (e.g., linked from symbol view)
  const urlSymbolId = searchParams.get('symbolId');
  const urlSymbolName = searchParams.get('symbolName');

  // ── Depth ─────────────────────────────────────────────────────────────────
  const [depth, setDepth] = useState(3);

  // ── Blast radius data ──────────────────────────────────────────────────────
  const [data, setData] = useState<GetBlastRadiusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('graph');

  const analyzeSymbol = useCallback(
    async (repoId: string, symbolId: string, maxDepth: number) => {
      setLoading(true);
      setError(null);
      setData(null);
      try {
        const result = await api.getBlastRadius(repoId, symbolId, maxDepth);
        setData(result);
      } catch (err) {
        setError(err instanceof ApiClientError ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Auto-analyze when symbol + repo are set
  useEffect(() => {
    if (!selectedRepoId) return;
    const symId = selectedSymbol?.id || urlSymbolId;
    if (!symId) return;
    void analyzeSymbol(selectedRepoId, symId, depth);
  }, [selectedRepoId, selectedSymbol, urlSymbolId, depth, analyzeSymbol]);

  const handleSymbolSelect = useCallback(
    (r: SearchResult) => {
      if (!r.id) {
        // Clear selection (the ✕ button passes an empty id)
        setSelectedSymbol(null);
        setData(null);
        setError(null);
        setSearchParams((p) => {
          p.delete('symbolId');
          p.delete('symbolName');
          return p;
        });
        return;
      }
      setSelectedSymbol(r);
      setSearchParams((p) => {
        if (selectedRepoId) p.set('repoId', selectedRepoId);
        p.set('symbolId', r.id);
        p.set('symbolName', r.name);
        return p;
      });
    },
    [selectedRepoId, setSearchParams],
  );

  const handleRepoSelect = useCallback(
    (id: string) => {
      setSelectedRepoId(id);
      setSelectedSymbol(null);
      setData(null);
      setError(null);
    },
    [],
  );

  const hasTarget = Boolean(selectedSymbol?.id || urlSymbolId);

  return (
    <div className="h-full flex overflow-hidden">
      {/* ── Left panel: symbol selector ── */}
      <aside className="w-72 shrink-0 border-r border-gray-800 flex flex-col overflow-hidden bg-gray-950">
        <div className="px-4 py-3 border-b border-gray-800 shrink-0">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Blast Radius Analysis
          </h2>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* Repo selector */}
          <div className="space-y-1.5">
            <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
              Repository
            </label>
            <RepoSelector
              repos={storedRepos}
              selectedId={selectedRepoId}
              onSelect={handleRepoSelect}
            />
          </div>

          {/* Symbol search */}
          <div className="space-y-1.5">
            <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
              Symbol
            </label>
            <SymbolPicker
              repoId={selectedRepoId}
              selectedSymbol={selectedSymbol}
              onSelect={handleSymbolSelect}
            />
          </div>

          {/* Depth selector */}
          <div className="space-y-1.5">
            <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
              Analysis depth
            </label>
            <DepthSelector value={depth} onChange={setDepth} />
          </div>

          {/* Symbol info if pre-populated from URL */}
          {!selectedSymbol && urlSymbolId && urlSymbolName && (
            <div className="px-3 py-2 bg-blue-600/10 border border-blue-600/30 rounded-lg">
              <p className="text-[10px] text-gray-500 mb-0.5">Analyzing</p>
              <p className="text-xs font-mono text-blue-300 truncate">{urlSymbolName}</p>
            </div>
          )}

          {/* Stats */}
          {data && (
            <div className="space-y-1.5">
              <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                Summary
              </label>
              <ImpactStats data={data} />
            </div>
          )}
        </div>
      </aside>

      {/* ── Right panel: visualization ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-800 shrink-0 bg-gray-900">
          <span className="text-sm font-semibold text-gray-300">
            {data
              ? `${data.symbolName} — ${data.totalFiles - 1} file${data.totalFiles - 1 !== 1 ? 's' : ''} affected`
              : 'Blast Radius'}
          </span>

          <div className="ml-auto flex items-center gap-3">
            {data && (
              <ViewToggle mode={viewMode} onChange={setViewMode} />
            )}
            {data && (
              <button
                type="button"
                onClick={() => {
                  const symId = selectedSymbol?.id || urlSymbolId;
                  if (selectedRepoId && symId) void analyzeSymbol(selectedRepoId, symId, depth);
                }}
                className="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-300 transition-colors"
              >
                Refresh
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden relative">
          {loading && (
            <div className="flex items-center justify-center h-full gap-2 text-gray-500">
              <span className="block w-4 h-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
              <span className="text-sm">Analyzing blast radius…</span>
            </div>
          )}

          {!loading && error && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-sm">
                <div className="text-red-400 font-medium mb-1">Analysis failed</div>
                <div className="text-sm text-gray-500">{error}</div>
              </div>
            </div>
          )}

          {!loading && !error && !data && (
            <EmptyState hasSymbol={hasTarget} />
          )}

          {!loading && !error && data && data.totalFiles <= 1 && (
            <div className="flex flex-col items-center justify-center h-full text-center gap-3 text-gray-500">
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
                <circle cx="20" cy="20" r="8" fill="#3b82f6" fillOpacity="0.2" stroke="#3b82f6" strokeWidth="1.5" />
                <text x="20" y="24" textAnchor="middle" fill="#3b82f6" fontSize="10" fontWeight="bold">0</text>
              </svg>
              <div>
                <p className="text-gray-300 font-medium">No dependents found</p>
                <p className="text-sm mt-0.5">
                  Nothing imports <code className="text-blue-400 font-mono">{data.sourceFile}</code> within {depth} hop{depth !== 1 ? 's' : ''}.
                </p>
              </div>
            </div>
          )}

          {!loading && !error && data && data.totalFiles > 1 && viewMode === 'graph' && (
            <BlastRadiusGraph data={data} />
          )}

          {!loading && !error && data && data.totalFiles > 1 && viewMode === 'list' && (
            <div className="h-full overflow-y-auto p-4 scrollbar-thin">
              <BlastRadiusList data={data} repoId={selectedRepoId} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
