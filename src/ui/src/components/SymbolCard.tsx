import type { SearchResult, SymbolKind } from '../api/types.js';

// ─── Kind badge ───────────────────────────────────────────────────────────────

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

// ─── Highlight helper ─────────────────────────────────────────────────────────

/**
 * Split `text` into alternating plain/highlighted segments based on `query`.
 * Returns an array of { text, highlight } objects.
 */
function highlightSegments(
  text: string,
  query: string,
): Array<{ text: string; highlight: boolean }> {
  if (!query.trim()) return [{ text, highlight: false }];

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);
  return parts.map((part) => ({
    text: part,
    highlight: regex.test(part),
  }));
}

// ─── SymbolCard ───────────────────────────────────────────────────────────────

export interface SymbolCardProps {
  result: SearchResult;
  query: string;
  focused: boolean;
  onClick: () => void;
}

export function SymbolCard({ result, query, focused, onClick }: SymbolCardProps) {
  const nameSegments = highlightSegments(result.name, query);
  const sigSegments  = result.signature ? highlightSegments(result.signature, query) : [];

  return (
    <button
      type="button"
      onClick={onClick}
      data-focused={focused}
      className={`w-full text-left px-4 py-3 border-b border-gray-800/60 hover:bg-gray-800/50 transition-colors group ${
        focused ? 'bg-gray-800/70 ring-1 ring-inset ring-blue-700/50' : ''
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        {/* Kind badge */}
        <span
          className={`shrink-0 text-[9px] font-bold font-mono px-1.5 py-0.5 rounded ${KIND_COLOR[result.kind] ?? 'bg-gray-800 text-gray-400'}`}
          aria-label={result.kind}
        >
          {KIND_ABBR[result.kind] ?? result.kind.slice(0, 3)}
        </span>

        {/* Name with highlight */}
        <span className="text-sm font-semibold text-gray-100 truncate group-hover:text-blue-300 transition-colors">
          {nameSegments.map((seg, i) =>
            seg.highlight ? (
              <mark key={i} className="bg-yellow-500/30 text-yellow-200 rounded-sm">
                {seg.text}
              </mark>
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )}
        </span>
      </div>

      {/* Signature */}
      {result.signature && (
        <p className="text-[11px] text-gray-500 mt-0.5 truncate font-mono pl-8">
          {sigSegments.map((seg, i) =>
            seg.highlight ? (
              <mark key={i} className="bg-yellow-500/20 text-yellow-300/80 rounded-sm">
                {seg.text}
              </mark>
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )}
        </p>
      )}

      {/* File path */}
      <p className="text-[11px] text-gray-600 mt-0.5 truncate pl-8 font-mono">
        {result.filePath}
      </p>
    </button>
  );
}
