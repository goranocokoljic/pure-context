import { useEffect, useState } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client.js';
import type { SymbolSource, TestMapping, SymbolHistoryResponse } from '../api/types.js';
import { SymbolHeader } from '../components/SymbolHeader.js';
import { CodeViewer } from '../components/CodeViewer.js';
import { RelatedSymbols } from '../components/RelatedSymbols.js';
import { SymbolTimeline } from '../components/SymbolTimeline.js';

// ─── Tab type ──────────────────────────────────────────────────────────────────

type Tab = 'source' | 'history';

// ─── SymbolView ───────────────────────────────────────────────────────────────

export default function SymbolView() {
  const { symbolId } = useParams<{ symbolId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const repoId = searchParams.get('repoId') ?? '';

  const [symbol, setSymbol] = useState<SymbolSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<TestMapping | null>(null);

  // History tab state
  const [activeTab, setActiveTab] = useState<Tab>('source');
  const [history, setHistory] = useState<SymbolHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFetched, setHistoryFetched] = useState(false);

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

    // Load coverage separately — non-blocking, failure is silent.
    api.getSymbolCoverage(repoId, symbolId)
      .then((res) => { if (!cancelled) setCoverage(res.mapping); })
      .catch(() => { /* coverage not available — no-op */ });

    return () => { cancelled = true; };
  }, [symbolId, repoId]);

  // Lazy-load history only when the History tab is first activated.
  useEffect(() => {
    if (activeTab !== 'history' || historyFetched || !symbolId || !repoId) return;
    let cancelled = false;
    setHistoryLoading(true);
    api.getSymbolHistory(repoId, symbolId)
      .then((res) => { if (!cancelled) setHistory(res); })
      .catch(() => { if (!cancelled) setHistory(null); })
      .finally(() => {
        if (!cancelled) {
          setHistoryLoading(false);
          setHistoryFetched(true);
        }
      });
    return () => { cancelled = true; };
  }, [activeTab, historyFetched, symbolId, repoId]);

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

  // Whether to show the History tab (only when history has been fetched and has data,
  // OR before fetching — show speculatively and hide if empty after fetch).
  const hasHistory = history !== null && history.history.length > 0;
  const showHistoryTab = !historyFetched || hasHistory;

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

        {/* Tab bar — Source | History */}
        <div className="flex border-b border-gray-800 shrink-0 px-6">
          <button
            type="button"
            onClick={() => setActiveTab('source')}
            className={`text-xs py-2 mr-4 border-b-2 transition-colors ${
              activeTab === 'source'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-400'
            }`}
          >
            Source
          </button>
          {showHistoryTab && (
            <button
              type="button"
              onClick={() => setActiveTab('history')}
              className={`text-xs py-2 border-b-2 transition-colors ${
                activeTab === 'history'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-400'
              }`}
              data-testid="history-tab"
            >
              History
            </button>
          )}
        </div>

        {/* Tab panel */}
        <div className="flex-1 overflow-auto scrollbar-thin">
          {activeTab === 'source' ? (
            <CodeViewer
              code={symbol.source}
              language={symbol.language}
              filePath={symbol.filePath}
            />
          ) : (
            <>
              {historyLoading && (
                <div className="flex items-center justify-center h-32 text-gray-500">
                  <div className="flex gap-2 items-center text-sm">
                    <span className="block w-4 h-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                    Loading history…
                  </div>
                </div>
              )}
              {!historyLoading && history && hasHistory && (
                <SymbolTimeline
                  history={history.history}
                  totalCommits={history.totalCommits}
                  churnScore={history.churnScore}
                  note={history.note}
                />
              )}
              {!historyLoading && historyFetched && !hasHistory && (
                <div className="px-6 py-8 text-center text-gray-500 text-sm">
                  No git history found for this symbol.
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Related symbols + Tests sidebar ── */}
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

        {/* Tests section — only shown when coverage data is available */}
        {coverage && (
          <div className="border-t border-gray-800">
            <div className="px-4 py-3 border-b border-gray-800">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                  Tests
                </span>
                <span
                  className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                    coverage.coverageStatus === 'tested'
                      ? 'bg-green-900/60 text-green-400'
                      : coverage.coverageStatus === 'untested'
                      ? 'bg-red-900/60 text-red-400'
                      : 'bg-gray-800 text-gray-500'
                  }`}
                >
                  {coverage.coverageStatus}
                </span>
              </div>
              <p className="text-[9px] text-gray-600 mt-1 leading-tight">
                Based on symbol references — not instrumented coverage
              </p>
            </div>
            {coverage.testFilePaths.length > 0 ? (
              <ul className="divide-y divide-gray-800/50">
                {coverage.testFilePaths.map((fp) => (
                  <li key={fp} className="px-4 py-2">
                    <span
                      className="text-[10px] text-blue-400 font-mono break-all leading-snug"
                      title={fp}
                    >
                      {fp.split('/').pop() ?? fp}
                    </span>
                    <p className="text-[9px] text-gray-600 mt-0.5 break-all">{fp}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-3 text-[10px] text-gray-600 italic">
                {coverage.coverageStatus === 'unknown'
                  ? 'Structural type — not directly testable.'
                  : 'No test references found.'}
              </p>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
