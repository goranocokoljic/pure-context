import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import type { SymbolSummary, ImporterFile } from '../api/types.js';

// ─── Kind badge ───────────────────────────────────────────────────────────────

const KIND_ABBR: Record<string, string> = {
  class: 'cls', interface: 'int', type: 'typ', enum: 'enm',
  component: 'cmp', composable: 'cps', hook: 'hk',
  function: 'fn', method: 'mth', const: 'cst',
  route: 'rte', middleware: 'mdw', decorator: 'dec',
};

const KIND_COLOR: Record<string, string> = {
  class:      'bg-blue-900/70 text-blue-300',
  interface:  'bg-indigo-900/70 text-indigo-300',
  type:       'bg-purple-900/70 text-purple-300',
  enum:       'bg-violet-900/70 text-violet-300',
  component:  'bg-emerald-900/70 text-emerald-300',
  composable: 'bg-teal-900/70 text-teal-300',
  hook:       'bg-cyan-900/70 text-cyan-300',
  function:   'bg-yellow-900/70 text-yellow-300',
  method:     'bg-orange-900/70 text-orange-300',
  const:      'bg-gray-800 text-gray-400',
  route:      'bg-rose-900/70 text-rose-300',
  middleware: 'bg-pink-900/70 text-pink-300',
  decorator:  'bg-amber-900/70 text-amber-300',
};

function KindBadge({ kind }: { kind: string }) {
  return (
    <span
      className={`shrink-0 text-[8px] font-bold font-mono px-1 py-px rounded ${KIND_COLOR[kind] ?? 'bg-gray-800 text-gray-400'}`}
      aria-hidden="true"
    >
      {KIND_ABBR[kind] ?? kind.slice(0, 3)}
    </span>
  );
}

// ─── Loading indicator ────────────────────────────────────────────────────────

function LoadingDots() {
  return (
    <div className="flex gap-1 py-1.5 pl-0.5">
      <span className="w-1.5 h-1.5 rounded-full bg-gray-700 animate-pulse" />
      <span className="w-1.5 h-1.5 rounded-full bg-gray-700 animate-pulse [animation-delay:150ms]" />
      <span className="w-1.5 h-1.5 rounded-full bg-gray-700 animate-pulse [animation-delay:300ms]" />
    </div>
  );
}

// ─── RelatedSymbols ───────────────────────────────────────────────────────────

export interface RelatedSymbolsProps {
  repoId: string;
  filePath: string;
  currentSymbolId: string;
}

export function RelatedSymbols({ repoId, filePath, currentSymbolId }: RelatedSymbolsProps) {
  const [sameFileSymbols, setSameFileSymbols] = useState<SymbolSummary[]>([]);
  const [importers, setImporters] = useState<ImporterFile[]>([]);
  const [loadingSameFile, setLoadingSameFile] = useState(true);
  const [loadingImporters, setLoadingImporters] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoadingSameFile(true);
    api.getFileOutline(repoId, filePath)
      .then((res) => {
        if (!cancelled) {
          setSameFileSymbols(res.symbols.filter((s) => s.id !== currentSymbolId));
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingSameFile(false); });
    return () => { cancelled = true; };
  }, [repoId, filePath, currentSymbolId]);

  useEffect(() => {
    let cancelled = false;
    setLoadingImporters(true);
    api.findImporters(repoId, filePath)
      .then((res) => {
        if (!cancelled) setImporters(res.importers);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingImporters(false); });
    return () => { cancelled = true; };
  }, [repoId, filePath]);

  function symbolLink(id: string) {
    return `/symbols/${encodeURIComponent(id)}?repoId=${encodeURIComponent(repoId)}`;
  }

  return (
    <div className="flex flex-col gap-5 p-4">
      {/* ── Same-file symbols ── */}
      <section>
        <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
          In this file
        </h3>
        {loadingSameFile ? (
          <LoadingDots />
        ) : sameFileSymbols.length === 0 ? (
          <p className="text-[11px] text-gray-600 italic">No other symbols</p>
        ) : (
          <ul className="space-y-0.5">
            {sameFileSymbols.map((sym) => (
              <li key={sym.id}>
                <Link
                  to={symbolLink(sym.id)}
                  className="flex items-center gap-1.5 text-[11px] text-gray-400 hover:text-blue-400 transition-colors py-0.5 group/sym"
                >
                  <KindBadge kind={sym.kind} />
                  <span className="font-mono truncate group-hover/sym:text-blue-400">
                    {sym.name}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Files that import this file ── */}
      <section>
        <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
          Imported by
        </h3>
        {loadingImporters ? (
          <LoadingDots />
        ) : importers.length === 0 ? (
          <p className="text-[11px] text-gray-600 italic">No importers found</p>
        ) : (
          <ul className="space-y-3">
            {importers.map((importer) => (
              <li key={importer.file}>
                <p
                  className="text-[10px] text-gray-600 font-mono truncate mb-1"
                  title={importer.file}
                >
                  {importer.file}
                </p>
                <ul className="space-y-0.5 pl-1">
                  {importer.symbols.slice(0, 5).map((sym) => (
                    <li key={sym.id}>
                      <Link
                        to={symbolLink(sym.id)}
                        className="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-blue-400 transition-colors py-0.5"
                      >
                        <KindBadge kind={sym.kind} />
                        <span className="font-mono truncate">{sym.name}</span>
                      </Link>
                    </li>
                  ))}
                  {importer.symbols.length > 5 && (
                    <li className="text-[10px] text-gray-700 pl-5 italic">
                      +{importer.symbols.length - 5} more
                    </li>
                  )}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
