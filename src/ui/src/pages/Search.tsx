import { useRef, useEffect, useCallback, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useSearch } from '../hooks/useSearch.js';
import { SearchFilters } from '../components/SearchFilters.js';
import { SearchResults } from '../components/SearchResults.js';
import { useRepoStore } from '../stores/repoStore.js';
import { api } from '../api/client.js';
import type { SearchResult, RepoMeta } from '../api/types.js';

// ─── Repo selector ────────────────────────────────────────────────────────────

function RepoSelector({
  repos,
  selectedId,
  onSelect,
}: {
  repos: RepoMeta[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (repos.length === 0) {
    return (
      <p className="text-xs text-gray-500 italic">No indexed repositories found.</p>
    );
  }

  return (
    <select
      value={selectedId ?? ''}
      onChange={(e) => onSelect(e.target.value)}
      className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100 focus:outline-none focus:border-blue-500"
      aria-label="Select repository"
    >
      {!selectedId && <option value="">Select a repository…</option>}
      {repos.map((r) => (
        <option key={r.repoId} value={r.repoId}>
          {r.rootPath.split(/[/\\]/).pop() ?? r.repoId}
        </option>
      ))}
    </select>
  );
}

// ─── Search page ──────────────────────────────────────────────────────────────

export default function Search() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);

  // ─── Repo state ───────────────────────────────────────────────────────────

  const storedRepos  = useRepoStore((s) => s.repos);
  const reposLoaded  = useRepoStore((s) => s.reposLoaded);
  const setReposStore = useRepoStore((s) => s.setRepos);

  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(
    searchParams.get('repoId') ?? null,
  );

  // Load repo list on first mount if not cached.
  useEffect(() => {
    if (reposLoaded) return;
    api.listRepos().then((res) => setReposStore(res.repos)).catch(() => {});
  }, [reposLoaded, setReposStore]);

  // Auto-select first repo once loaded.
  useEffect(() => {
    if (!selectedRepoId && storedRepos.length > 0) {
      setSelectedRepoId(storedRepos[0].repoId);
    }
  }, [storedRepos, selectedRepoId]);

  // ─── Search state ─────────────────────────────────────────────────────────

  const {
    query, setQuery,
    filters, setFilters,
    results, loading, error,
    clearSearch,
  } = useSearch({ repoId: selectedRepoId });

  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Reset focused index when results change.
  useEffect(() => {
    setFocusedIndex(-1);
  }, [results]);

  // Focus input on mount.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // ─── Keyboard navigation ──────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (results.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const idx = focusedIndex >= 0 ? focusedIndex : 0;
        const result = results[idx];
        if (result) handleSelect(result);
      } else if (e.key === 'Escape') {
        clearSearch();
        setFocusedIndex(-1);
      }
    },
    [results, focusedIndex, clearSearch], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handleSelect = useCallback(
    (result: SearchResult) => {
      navigate(
        `/symbols/${encodeURIComponent(result.id)}?repoId=${encodeURIComponent(result.repoId)}`,
      );
    },
    [navigate],
  );

  const activeFilterCount = filters.kinds.length + (filters.filePath ? 1 : 0);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex overflow-hidden">
      {/* ── Main search area ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Search header */}
        <div className="px-6 py-4 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-3 max-w-3xl">
            {/* Search input */}
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                  <line x1="9.5" y1="9.5" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </span>
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search symbols…"
                aria-label="Search symbols"
                aria-autocomplete="list"
                aria-controls="search-results"
                className="w-full pl-8 pr-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              {loading && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2">
                  <span className="block w-3 h-3 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                </span>
              )}
            </div>

            {/* Repo selector */}
            <RepoSelector
              repos={storedRepos}
              selectedId={selectedRepoId}
              onSelect={setSelectedRepoId}
            />

            {/* Filters toggle */}
            <button
              type="button"
              onClick={() => setFiltersOpen((o) => !o)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm transition-colors ${
                filtersOpen || activeFilterCount > 0
                  ? 'bg-blue-600/20 border-blue-600/50 text-blue-300'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'
              }`}
              aria-expanded={filtersOpen}
              aria-label="Toggle filters"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <line x1="1" y1="3" x2="13" y2="3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="3" y1="7" x2="11" y2="7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="5" y1="11" x2="9" y2="11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Filters
              {activeFilterCount > 0 && (
                <span className="ml-0.5 bg-blue-600 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                  {activeFilterCount}
                </span>
              )}
            </button>
          </div>

          {/* Result count */}
          {!loading && query && results.length > 0 && (
            <p className="text-xs text-gray-600 mt-2 max-w-3xl">
              {results.length} result{results.length !== 1 ? 's' : ''}
              {activeFilterCount > 0 && ' (filtered)'}
            </p>
          )}
        </div>

        {/* Results */}
        <div
          id="search-results"
          className="flex-1 overflow-y-auto scrollbar-thin"
          role="region"
          aria-label="Search results"
          aria-live="polite"
          aria-busy={loading}
        >
          <SearchResults
            results={results}
            query={query}
            loading={loading}
            error={error}
            focusedIndex={focusedIndex}
            onSelect={handleSelect}
          />
        </div>
      </div>

      {/* ── Filters sidebar ── */}
      {filtersOpen && (
        <aside className="w-64 shrink-0 border-l border-gray-800 flex flex-col overflow-y-auto">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between shrink-0">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
              Filters
            </span>
            <button
              type="button"
              onClick={() => setFiltersOpen(false)}
              className="text-gray-600 hover:text-gray-300 transition-colors"
              aria-label="Close filters"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <line x1="2" y1="2" x2="12" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="12" y1="2" x2="2" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="p-4">
            <SearchFilters filters={filters} onChange={setFilters} />
          </div>
        </aside>
      )}
    </div>
  );
}
