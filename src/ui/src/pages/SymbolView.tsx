import { useEffect, useState } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client.js';
import type { SymbolSource } from '../api/types.js';
import { SymbolHeader } from '../components/SymbolHeader.js';
import { CodeViewer } from '../components/CodeViewer.js';
import { RelatedSymbols } from '../components/RelatedSymbols.js';

// ─── SymbolView ───────────────────────────────────────────────────────────────

export default function SymbolView() {
  const { symbolId } = useParams<{ symbolId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const repoId = searchParams.get('repoId') ?? '';

  const [symbol, setSymbol] = useState<SymbolSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbolId || !repoId) {
      setError('Missing symbol ID or repository ID.');
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    api.getSymbolSource(symbolId, repoId)
      .then((res) => { if (!cancelled) setSymbol(res.symbol); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [symbolId, repoId]);

  // ── Loading state ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        <div className="flex gap-2 items-center text-sm">
          <span className="block w-4 h-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
          Loading symbol…
        </div>
      </div>
    );
  }

  // ── Error / not-found state ────────────────────────────────────────────────

  if (error ?? !symbol) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <p className="text-gray-400 text-sm">{error ?? 'Symbol not found.'}</p>
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="text-xs text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M7 2L3 6L7 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Go back
        </button>
      </div>
    );
  }

  // ── Symbol view ────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex overflow-hidden">
      {/* ── Main content ── */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Back navigation + actions */}
        <div className="px-6 py-2 border-b border-gray-800/50 shrink-0 flex items-center justify-between">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="text-xs text-gray-600 hover:text-gray-400 transition-colors flex items-center gap-1"
            aria-label="Go back"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M7 2L3 6L7 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back
          </button>
          <Link
            to={`/blast-radius?repoId=${encodeURIComponent(repoId)}&symbolId=${encodeURIComponent(symbolId ?? '')}&symbolName=${encodeURIComponent(symbol.name)}`}
            className="text-xs text-orange-400 hover:text-orange-300 transition-colors flex items-center gap-1"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <circle cx="6" cy="6" r="2" fill="currentColor" />
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1" strokeDasharray="2.5 2.5" />
            </svg>
            Blast Radius
          </Link>
        </div>

        {/* Symbol metadata header */}
        <SymbolHeader symbol={symbol} repoId={repoId} />

        {/* Syntax-highlighted source code */}
        <div className="flex-1 overflow-auto scrollbar-thin">
          <CodeViewer
            code={symbol.source}
            language={symbol.language}
            filePath={symbol.filePath}
          />
        </div>
      </div>

      {/* ── Related symbols sidebar ── */}
      <aside
        className="w-56 shrink-0 border-l border-gray-800 overflow-y-auto scrollbar-thin"
        aria-label="Related symbols"
      >
        <div className="px-4 py-3 border-b border-gray-800 shrink-0">
          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
            Related
          </span>
        </div>
        <RelatedSymbols
          repoId={repoId}
          filePath={symbol.filePath}
          currentSymbolId={symbolId!}
        />
      </aside>
    </div>
  );
}
