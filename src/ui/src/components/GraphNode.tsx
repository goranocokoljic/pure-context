import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { GraphNodeData } from '../api/types.js';

// ─── Heatmap color scale ──────────────────────────────────────────────────────
// score: 0 = best (green), 1 = worst (red), via yellow midpoint

function heatScoreColor(score: number): string {
  if (score < 0.5) {
    const t = score * 2;
    // green (#22c55e) → yellow (#eab308)
    const r = Math.round(34 + t * (234 - 34));
    const g = Math.round(197 + t * (179 - 197));
    const b = Math.round(94 + t * (8 - 94));
    return `rgb(${r},${g},${b})`;
  } else {
    const t = (score - 0.5) * 2;
    // yellow (#eab308) → red (#ef4444)
    const r = Math.round(234 + t * (239 - 234));
    const g = Math.round(179 + t * (68 - 179));
    const b = Math.round(8 + t * (68 - 8));
    return `rgb(${r},${g},${b})`;
  }
}

// ─── File icon ────────────────────────────────────────────────────────────────

function FileIcon({ ext }: { ext: string }) {
  const color =
    ext === 'ts' || ext === 'tsx'
      ? '#3b82f6'
      : ext === 'js' || ext === 'jsx'
        ? '#eab308'
        : ext === 'vue'
          ? '#22c55e'
          : ext === 'py'
            ? '#a78bfa'
            : '#9ca3af';

  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect x="1" y="1" width="8" height="10" rx="1" stroke={color} strokeWidth="1.2" />
      <path d="M7 1v3h3" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
      <line x1="3" y1="6" x2="9" y2="6" stroke={color} strokeWidth="1" strokeLinecap="round" />
      <line x1="3" y1="8" x2="7" y2="8" stroke={color} strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

// ─── Graph node ───────────────────────────────────────────────────────────────

export const GraphFileNode = memo(function GraphFileNode({
  data,
  selected,
}: NodeProps & { data: GraphNodeData }) {
  const label = data.label ?? '';
  const ext = label.includes('.') ? label.split('.').pop() ?? '' : '';

  // Optional quality/churn indicators — only shown when heatmap data is loaded
  const heatmapScore =
    typeof data.heatmapScore === 'number' ? (data.heatmapScore as number) : undefined;
  const isChurnHotspot = Boolean(data.isChurnHotspot);

  return (
    <div
      data-testid="graph-file-node"
      className={`
        relative rounded border px-2.5 py-1.5 text-xs font-mono select-none
        bg-gray-900 text-gray-200 transition-colors
        ${selected ? 'border-blue-500 shadow-lg shadow-blue-500/20' : 'border-gray-700 hover:border-gray-500'}
      `}
      style={{ minWidth: 120, maxWidth: 200 }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: '#4b5563', width: 6, height: 6 }}
      />

      {/* Quality indicator dot — colored ring based on heatmap score */}
      {heatmapScore !== undefined && (
        <div
          className="absolute -top-1.5 -right-1.5 w-3 h-3 rounded-full border-2 border-gray-950"
          style={{ background: heatScoreColor(heatmapScore) }}
          title={`Quality score: ${Math.round((1 - heatmapScore) * 100)}%`}
          aria-label="quality-indicator"
        />
      )}

      {/* Churn indicator — pulsing dot for hotspot files */}
      {isChurnHotspot && (
        <div
          className="absolute -top-1.5 -left-1.5 w-3 h-3 rounded-full bg-orange-500 animate-ping opacity-75"
          aria-label="churn-indicator"
        />
      )}

      <div className="flex items-center gap-1.5 truncate">
        <FileIcon ext={ext} />
        <span className="truncate" title={data.path}>
          {label}
        </span>
      </div>

      {data.symbolCount > 0 && (
        <div className="mt-0.5 text-gray-500" style={{ fontSize: '0.65rem' }}>
          {data.symbolCount} symbol{data.symbolCount !== 1 ? 's' : ''}
        </div>
      )}

      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: '#4b5563', width: 6, height: 6 }}
      />
    </div>
  );
});
