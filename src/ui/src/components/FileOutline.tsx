import type { FileSummary, SymbolSummary, SymbolKind } from '../api/types.js';

// ─── Kind metadata ────────────────────────────────────────────────────────────

const KIND_ORDER: SymbolKind[] = [
  'class', 'interface', 'type', 'enum',
  'component', 'composable', 'hook',
  'function', 'method', 'const',
  'route', 'middleware', 'decorator',
];

const KIND_LABELS: Record<SymbolKind, string> = {
  class: 'Classes',
  interface: 'Interfaces',
  type: 'Types',
  enum: 'Enums',
  component: 'Components',
  composable: 'Composables',
  hook: 'Hooks',
  function: 'Functions',
  method: 'Methods',
  const: 'Constants',
  route: 'Routes',
  middleware: 'Middleware',
  decorator: 'Decorators',
};

/** Short abbreviated label for the kind badge (max 3 chars). */
const KIND_ABBR: Record<SymbolKind, string> = {
  class: 'cls',
  interface: 'int',
  type: 'typ',
  enum: 'enm',
  component: 'cmp',
  composable: 'cps',
  hook: 'hk',
  function: 'fn',
  method: 'mth',
  const: 'cst',
  route: 'rte',
  middleware: 'mdw',
  decorator: 'dec',
};

function kindBadgeClass(kind: SymbolKind): string {
  switch (kind) {
    case 'class':      return 'bg-blue-900/70 text-blue-300';
    case 'interface':  return 'bg-indigo-900/70 text-indigo-300';
    case 'type':       return 'bg-purple-900/70 text-purple-300';
    case 'enum':       return 'bg-violet-900/70 text-violet-300';
    case 'component':  return 'bg-emerald-900/70 text-emerald-300';
    case 'composable': return 'bg-teal-900/70 text-teal-300';
    case 'hook':       return 'bg-cyan-900/70 text-cyan-300';
    case 'function':   return 'bg-yellow-900/70 text-yellow-300';
    case 'method':     return 'bg-orange-900/70 text-orange-300';
    case 'const':      return 'bg-gray-800 text-gray-400';
    case 'route':      return 'bg-rose-900/70 text-rose-300';
    case 'middleware':  return 'bg-pink-900/70 text-pink-300';
    case 'decorator':  return 'bg-amber-900/70 text-amber-300';
    default:           return 'bg-gray-800 text-gray-400';
  }
}

// ─── Symbol row ───────────────────────────────────────────────────────────────

interface SymbolRowProps {
  symbol: SymbolSummary;
  onSymbolClick?: (id: string) => void;
}

function SymbolRow({ symbol, onSymbolClick }: SymbolRowProps) {
  return (
    <button
      onClick={() => onSymbolClick?.(symbol.id)}
      className="w-full text-left px-3 py-1.5 hover:bg-gray-800/60 rounded transition-colors group"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`shrink-0 text-[9px] font-bold font-mono px-1 py-0.5 rounded ${kindBadgeClass(symbol.kind)}`}
          aria-label={symbol.kind}
        >
          {KIND_ABBR[symbol.kind] ?? symbol.kind.slice(0, 3)}
        </span>
        <span className="text-sm text-gray-200 font-medium truncate group-hover:text-blue-300 transition-colors">
          {symbol.name}
        </span>
      </div>
      {symbol.signature && (
        <p className="text-[11px] text-gray-500 mt-0.5 truncate font-mono pl-8">
          {symbol.signature}
        </p>
      )}
      {symbol.summary && (
        <p className="text-[11px] text-gray-600 mt-0.5 truncate pl-8">
          {symbol.summary}
        </p>
      )}
    </button>
  );
}

// ─── Kind group ───────────────────────────────────────────────────────────────

interface KindGroupProps {
  kind: SymbolKind;
  symbols: SymbolSummary[];
  onSymbolClick?: (id: string) => void;
}

function KindGroup({ kind, symbols, onSymbolClick }: KindGroupProps) {
  return (
    <section aria-label={KIND_LABELS[kind] ?? kind} className="mb-3">
      <div className="flex items-center gap-2 px-3 py-1">
        <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
          {KIND_LABELS[kind] ?? kind}
        </span>
        <span className="text-[10px] text-gray-600">({symbols.length})</span>
      </div>
      <div>
        {symbols.map((sym) => (
          <SymbolRow key={sym.id} symbol={sym} onSymbolClick={onSymbolClick} />
        ))}
      </div>
    </section>
  );
}

// ─── Grouping logic ───────────────────────────────────────────────────────────

function groupByKind(symbols: SymbolSummary[]): [SymbolKind, SymbolSummary[]][] {
  const map = new Map<SymbolKind, SymbolSummary[]>();
  for (const sym of symbols) {
    const arr = map.get(sym.kind) ?? [];
    arr.push(sym);
    map.set(sym.kind, arr);
  }
  // Render in KIND_ORDER, then any remaining kinds alphabetically
  const ordered: SymbolKind[] = [
    ...KIND_ORDER.filter((k) => map.has(k)),
    ...Array.from(map.keys()).filter((k) => !KIND_ORDER.includes(k)).sort(),
  ];
  return ordered.map((k) => [k, map.get(k)!]);
}

// ─── FileOutline ──────────────────────────────────────────────────────────────

export interface FileOutlineProps {
  fileSummary: FileSummary | null;
  onSymbolClick?: (symbolId: string) => void;
}

export function FileOutline({ fileSummary, onSymbolClick }: FileOutlineProps) {
  if (!fileSummary) {
    return (
      <div className="flex items-center justify-center h-full text-gray-600 text-sm">
        Select a file to view its symbols
      </div>
    );
  }

  if (fileSummary.symbols.length === 0) {
    return (
      <div className="h-full overflow-y-auto scrollbar-thin">
        <div className="px-3 py-2 border-b border-gray-800">
          <p className="text-xs text-gray-500 truncate">{fileSummary.filePath}</p>
        </div>
        <div className="flex items-center justify-center h-32 text-gray-600 text-sm">
          No symbols in this file
        </div>
      </div>
    );
  }

  const groups = groupByKind(fileSummary.symbols);

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="px-3 py-2 border-b border-gray-800 shrink-0">
        <p className="text-xs text-gray-400 truncate font-mono">{fileSummary.filePath}</p>
        <p className="text-[11px] text-gray-600 mt-0.5">
          {fileSummary.symbols.length} symbol{fileSummary.symbols.length !== 1 ? 's' : ''}
        </p>
      </div>
      <div className="py-2">
        {groups.map(([kind, symbols]) => (
          <KindGroup key={kind} kind={kind} symbols={symbols} onSymbolClick={onSymbolClick} />
        ))}
      </div>
    </div>
  );
}
