import { useState, useEffect, useRef, useCallback } from 'react';
import { api, ApiClientError } from '../api/client.js';
import type { SearchResult, SymbolKind } from '../api/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SearchFilters {
  kinds: SymbolKind[];
  filePath: string;
}

export interface UseSearchOptions {
  repoId: string | null;
  debounceMs?: number;
  cacheSize?: number;
}

export interface UseSearchReturn {
  query: string;
  setQuery: (q: string) => void;
  filters: SearchFilters;
  setFilters: (f: SearchFilters) => void;
  results: SearchResult[];
  loading: boolean;
  error: string | null;
  clearSearch: () => void;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

function makeCacheKey(repoId: string, query: string, filters: SearchFilters): string {
  return JSON.stringify({ repoId, query, kinds: [...filters.kinds].sort(), filePath: filters.filePath });
}

class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private readonly maxSize: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      // Delete oldest entry
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

// Module-level cache shared across hook instances.
const resultCache = new LruCache<SearchResult[]>(50);

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSearch({
  repoId,
  debounceMs = 300,
  cacheSize: _cacheSize = 50,
}: UseSearchOptions): UseSearchReturn {
  const [query, setQueryRaw] = useState('');
  const [filters, setFilters] = useState<SearchFilters>({ kinds: [], filePath: '' });
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tracks whether the current in-flight request is still valid.
  const cancelRef = useRef<(() => void) | null>(null);
  // Tracks the debounce timer.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const executeSearch = useCallback(
    (q: string, f: SearchFilters) => {
      if (!repoId || q.trim().length === 0) {
        setResults([]);
        setLoading(false);
        setError(null);
        return;
      }

      const cacheKey = makeCacheKey(repoId, q, f);
      const cached = resultCache.get(cacheKey);
      if (cached) {
        setResults(cached);
        setLoading(false);
        setError(null);
        return;
      }

      // Cancel any prior in-flight fetch.
      cancelRef.current?.();
      let cancelled = false;
      cancelRef.current = () => { cancelled = true; };

      setLoading(true);
      setError(null);

      const params = {
        query: q,
        ...(f.kinds.length === 1 ? { kind: f.kinds[0] } : {}),
        ...(f.filePath ? { filePath: f.filePath } : {}),
        limit: 50,
      };

      api
        .searchSymbols(repoId, params)
        .then((res) => {
          if (cancelled) return;
          resultCache.set(cacheKey, res.results);
          setResults(res.results);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof ApiClientError ? err.message : String(err));
          setLoading(false);
        });
    },
    [repoId],
  );

  // Debounce: whenever query or filters change, schedule a search.
  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      executeSearch(query, filters);
    }, debounceMs);
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [query, filters, debounceMs, executeSearch]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      cancelRef.current?.();
    };
  }, []);

  const setQuery = useCallback((q: string) => {
    setQueryRaw(q);
  }, []);

  const clearSearch = useCallback(() => {
    setQueryRaw('');
    setFilters({ kinds: [], filePath: '' });
    setResults([]);
    setError(null);
    cancelRef.current?.();
  }, []);

  return { query, setQuery, filters, setFilters, results, loading, error, clearSearch };
}
