import type { HeatmapMode } from '../api/types.js';
import { heatColor } from '../stores/heatmapStore.js';

// ─── Props ────────────────────────────────────────────────────────────────────

interface HeatmapLegendProps {
  mode: HeatmapMode;
  onModeChange: (mode: HeatmapMode) => void;
}

// ─── Mode buttons config ──────────────────────────────────────────────────────

const MODES: { value: HeatmapMode; label: string; title: string }[] = [
  {
    value: 'complexity',
    label: 'Complexity',
    title: 'Colour by cyclomatic complexity (worst symbol per file)',
  },
  {
    value: 'churn',
    label: 'Churn',
    title: 'Colour by commit frequency (commits per 90 days)',
  },
  {
    value: 'combined',
    label: 'Combined',
    title: 'Weighted composite: 60 % complexity + 40 % churn',
  },
];

// ─── Gradient stops ───────────────────────────────────────────────────────────

const GRADIENT_STOPS = Array.from({ length: 11 }, (_, i) => heatColor(i * 10));
const GRADIENT = `linear-gradient(to right, ${GRADIENT_STOPS.join(', ')})`;

// ─── Component ────────────────────────────────────────────────────────────────

export function HeatmapLegend({ mode, onModeChange }: HeatmapLegendProps) {
  return (
    <div className="px-3 py-2 border-b border-gray-800 bg-gray-900/80">
      {/* Mode toggle */}
      <div className="flex gap-1 mb-2" role="group" aria-label="Heatmap mode">
        {MODES.map(({ value, label, title }) => (
          <button
            key={value}
            onClick={() => onModeChange(value)}
            title={title}
            aria-pressed={mode === value}
            className={`flex-1 text-[10px] py-0.5 rounded transition-colors ${
              mode === value
                ? 'bg-blue-600 text-white font-semibold'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Colour scale bar */}
      <div>
        <div
          className="h-2 w-full rounded-sm"
          style={{ background: GRADIENT }}
          aria-hidden="true"
        />
        <div className="flex justify-between text-[9px] text-gray-500 mt-0.5">
          <span>Low risk</span>
          <span>High risk</span>
        </div>
      </div>
    </div>
  );
}
