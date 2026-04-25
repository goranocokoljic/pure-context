// ─── Graph controls panel ─────────────────────────────────────────────────────
// Zoom in/out, fit-to-view, layout selector, depth slider.

import { useReactFlow } from '@xyflow/react';

export type LayoutKind = 'force' | 'hierarchical' | 'radial';

interface GraphControlsProps {
  layout: LayoutKind;
  onLayoutChange: (layout: LayoutKind) => void;
  depth: number;
  onDepthChange: (depth: number) => void;
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
  onRelayout: () => void;
}

export function GraphControls({
  layout,
  onLayoutChange,
  depth,
  onDepthChange,
  nodeCount,
  edgeCount,
  truncated,
  onRelayout,
}: GraphControlsProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <div
      data-testid="graph-controls"
      className="flex flex-col gap-3 p-3 bg-gray-900 border border-gray-700 rounded-lg shadow-lg"
      style={{ width: 220 }}
    >
      {/* Zoom controls */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => zoomIn({ duration: 200 })}
          className="flex-1 py-1 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-300 transition-colors"
          aria-label="Zoom in"
        >
          + Zoom In
        </button>
        <button
          type="button"
          onClick={() => zoomOut({ duration: 200 })}
          className="flex-1 py-1 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-300 transition-colors"
          aria-label="Zoom out"
        >
          − Zoom Out
        </button>
      </div>

      <button
        type="button"
        onClick={() => fitView({ duration: 300, padding: 0.1 })}
        className="py-1 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-300 transition-colors"
        aria-label="Fit to view"
      >
        Fit to View
      </button>

      {/* Layout selector */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Layout</label>
        <select
          value={layout}
          onChange={(e) => onLayoutChange(e.target.value as LayoutKind)}
          className="w-full px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 focus:outline-none focus:border-blue-500"
          aria-label="Layout algorithm"
        >
          <option value="force">Force-directed</option>
          <option value="hierarchical">Hierarchical</option>
          <option value="radial">Radial</option>
        </select>
      </div>

      {/* Depth slider */}
      <div>
        <label className="flex items-center justify-between text-xs text-gray-500 mb-1">
          <span>Depth</span>
          <span className="text-gray-300">{depth}</span>
        </label>
        <input
          type="range"
          min={1}
          max={10}
          value={depth}
          onChange={(e) => onDepthChange(Number(e.target.value))}
          className="w-full accent-blue-500"
          aria-label="Traversal depth"
          data-testid="depth-slider"
        />
        <div className="flex justify-between text-gray-600 mt-0.5" style={{ fontSize: '0.6rem' }}>
          <span>1</span>
          <span>10</span>
        </div>
      </div>

      {/* Re-layout button */}
      <button
        type="button"
        onClick={onRelayout}
        className="py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded text-white transition-colors"
        aria-label="Re-run layout"
      >
        Re-layout
      </button>

      {/* Stats */}
      <div className="border-t border-gray-800 pt-2 text-gray-500" style={{ fontSize: '0.65rem' }}>
        <div>{nodeCount} nodes · {edgeCount} edges</div>
        {truncated && (
          <div className="text-amber-500 mt-0.5">Graph truncated (limit reached)</div>
        )}
      </div>
    </div>
  );
}
