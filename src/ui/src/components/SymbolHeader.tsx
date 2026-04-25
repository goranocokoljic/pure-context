import { Link } from 'react-router-dom';
import type { SymbolSource, SymbolKind } from '../api/types.js';

// ─── Kind mappings ────────────────────────────────────────────────────────────

const KIND_ABBR: Record<SymbolKind, string> = {
  class: 'cls', interface: 'int', type: 'typ', enum: 'enm',
  component: 'cmp', composable: 'cps', hook: 'hk',
  function: 'fn', method: 'mth', const: 'cst',
  route: 'rte', middleware: 'mdw', decorator: 'dec',
};

const KIND_COLOR: Record<SymbolKind, string> = {
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

// ─── SymbolHeader ─────────────────────────────────────────────────────────────

export interface SymbolHeaderProps {
  symbol: SymbolSource;
  repoId: string;
}

export function SymbolHeader({ symbol, repoId }: SymbolHeaderProps) {
  return (
    <div className="px-6 py-4 border-b border-gray-800 shrink-0">
      {/* Name + kind badge */}
      <div className="flex items-center gap-3 mb-2">
        <span
          className={`shrink-0 text-[10px] font-bold font-mono px-2 py-0.5 rounded ${KIND_COLOR[symbol.kind] ?? 'bg-gray-800 text-gray-400'}`}
          aria-label={symbol.kind}
        >
          {KIND_ABBR[symbol.kind] ?? symbol.kind.slice(0, 3)}
        </span>
        <h1 className="text-lg font-semibold text-gray-100 font-mono">{symbol.name}</h1>
      </div>

      {/* Full signature */}
      {symbol.signature && (
        <p className="text-sm font-mono text-gray-400 mb-2 leading-relaxed">
          {symbol.signature}
        </p>
      )}

      {/* Docstring / summary */}
      {symbol.summary && (
        <p className="text-sm text-gray-500 mb-3">{symbol.summary}</p>
      )}

      {/* File path link → repo detail */}
      <Link
        to={`/repos/${encodeURIComponent(repoId)}`}
        className="text-xs text-gray-600 hover:text-blue-400 font-mono transition-colors"
        title="View repository"
      >
        {symbol.filePath}
      </Link>
    </div>
  );
}
