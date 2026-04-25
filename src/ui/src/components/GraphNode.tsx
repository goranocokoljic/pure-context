import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { GraphNodeData } from '../api/types.js';

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

  return (
    <div
      data-testid="graph-file-node"
      className={`
        rounded border px-2.5 py-1.5 text-xs font-mono select-none
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
