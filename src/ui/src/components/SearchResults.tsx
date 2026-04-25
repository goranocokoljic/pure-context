import type { SearchResult } from '../api/types.js';
import { SymbolCard } from './SymbolCard.js';

// ─── Skeleton loader ──────────────────────────────────────────────────────────

function ResultSkeleton() {
  return (
    <div className="animate-pulse">
      {[85, 70, 90, 60, 75].map((w, i) => (
        <div key={i} className="px-4 py-3 border-b border-gray-800/60">
          <div className="flex items-center gap-2">
            <div className="h-4 w-8 bg-gray-800 rounded" />
            <div className="h-4 bg-gray-800 rounded" style={{ width: `${w}%` }} />
          </div>
          <div className="mt-1.5 h-3 bg-gray-800/70 rounded w-1/2 ml-10" />
        </div>
      ))}
    </div>
  );
}

// ─── Empty / error states ─────────────────────────────────────────────────────

function EmptyResults({ query }: { query: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-40 text-gray-500 gap-2">
      <span className="text-2xl opacity-30">&#128269;</span>
      <p className="text-sm">No results for &ldquo;{query}&rdquo;</p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="m-4 p-3 bg-red-950 border border-red-800 rounded text-red-300 text-sm">
      {message}
    </div>
  );
}

// ─── SearchResults ────────────────────────────────────────────────────────────

export interface SearchResultsProps {
  results: SearchResult[];
  query: string;
  loading: boolean;
  error: string | null;
  focusedIndex: number;
  onSelect: (result: SearchResult) => void;
}

export function SearchResults({
  results,
  query,
  loading,
  error,
  focusedIndex,
  onSelect,
}: SearchResultsProps) {
  if (loading) return <ResultSkeleton />;
  if (error) return <ErrorState message={error} />;
  if (query && results.length === 0) return <EmptyResults query={query} />;
  if (!query) {
    return (
      <div className="flex items-center justify-center h-40 text-gray-600 text-sm">
        Type to search symbols
      </div>
    );
  }

  return (
    <div role="listbox" aria-label="Search results">
      {results.map((result, idx) => (
        <SymbolCard
          key={result.id}
          result={result}
          query={query}
          focused={idx === focusedIndex}
          onClick={() => onSelect(result)}
        />
      ))}
    </div>
  );
}
