import type { SymbolKind } from '../api/types.js';
import type { SearchFilters } from '../hooks/useSearch.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_KINDS: SymbolKind[] = [
  'function', 'class', 'method', 'const', 'type',
  'interface', 'enum', 'component', 'composable',
  'hook', 'route', 'decorator', 'middleware',
];

// ─── KindToggle ───────────────────────────────────────────────────────────────

function KindToggle({
  kind,
  active,
  onToggle,
}: {
  kind: SymbolKind;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors border ${
        active
          ? 'bg-blue-600 border-blue-500 text-white'
          : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
      }`}
    >
      {kind}
    </button>
  );
}

// ─── SearchFilters component ──────────────────────────────────────────────────

export interface SearchFiltersProps {
  filters: SearchFilters;
  onChange: (f: SearchFilters) => void;
}

export function SearchFilters({ filters, onChange }: SearchFiltersProps) {
  const hasFilters = filters.kinds.length > 0 || filters.filePath !== '';

  function toggleKind(kind: SymbolKind) {
    const next = filters.kinds.includes(kind)
      ? filters.kinds.filter((k) => k !== kind)
      : [...filters.kinds, kind];
    onChange({ ...filters, kinds: next });
  }

  function clearAll() {
    onChange({ kinds: [], filePath: '' });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Kind filter */}
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Kind</p>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by kind">
          {ALL_KINDS.map((k) => (
            <KindToggle
              key={k}
              kind={k}
              active={filters.kinds.includes(k)}
              onToggle={() => toggleKind(k)}
            />
          ))}
        </div>
      </div>

      {/* File pattern filter */}
      <div>
        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-2">
          File pattern
        </label>
        <input
          type="text"
          value={filters.filePath}
          onChange={(e) => onChange({ ...filters, filePath: e.target.value })}
          placeholder="e.g. src/**/*.ts"
          className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500"
        />
      </div>

      {/* Clear all */}
      {hasFilters && (
        <div>
          <button
            type="button"
            onClick={clearAll}
            className="text-xs text-red-400 hover:text-red-300 transition-colors"
          >
            Clear all filters
          </button>
        </div>
      )}
    </div>
  );
}
