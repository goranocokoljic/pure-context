// ─── Graph controls panel ─────────────────────────────────────────────────────
// Zoom/fit, layout, depth, language filter, cluster toggle, path highlighter.

import { useReactFlow } from '@xyflow/react';

export type LayoutKind = 'force' | 'hierarchical' | 'radial';

export interface GraphControlsProps {
  // Existing controls
  layout: LayoutKind;
  onLayoutChange: (layout: LayoutKind) => void;
  depth: number;
  onDepthChange: (depth: number) => void;
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
  onRelayout: () => void;
  // Language filter
  langFilter: string;
  onLangFilterChange: (lang: string) => void;
  availableLangs: string[];
  // Cluster by directory
  clusterByDir: boolean;
  onClusterByDirChange: (v: boolean) => void;
  // Path highlighter
  pathFrom: string | null;
  pathTo: string | null;
  selectingPath: 'from' | 'to' | null;
  onSelectPath: (which: 'from' | 'to') => void;
  onFindPath: () => void;
  onClearPath: () => void;
  pathStatus: 'idle' | 'found' | 'not-found';
}

// ─── Tiny truncator for node path labels ─────────────────────────────────────

function shortPath(p: string | null): string {
  if (!p) return '—';
  const parts = p.split('/');
  return parts[parts.length - 1] ?? p;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function GraphControls({
  layout,
  onLayoutChange,
  depth,
  onDepthChange,
  nodeCount,
  edgeCount,
  truncated,
  onRelayout,
  langFilter,
  onLangFilterChange,
  availableLangs,
  clusterByDir,
  onClusterByDirChange,
  pathFrom,
  pathTo,
  selectingPath,
  onSelectPath,
  onFindPath,
  onClearPath,
  pathStatus,
}: GraphControlsProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <div
      data-testid="graph-controls"
      className="flex flex-col gap-3 p-3 bg-gray-900 border border-gray-700 rounded-lg shadow-lg"
      style={{ width: 230 }}
    >
      {/* ── Zoom ─────────────────────────────────────────────────────────────── */}
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

      {/* ── Layout ───────────────────────────────────────────────────────────── */}
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

      {/* ── Depth ────────────────────────────────────────────────────────────── */}
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

      {/* ── Language filter ───────────────────────────────────────────────────── */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Language</label>
        <select
          value={langFilter}
          onChange={(e) => onLangFilterChange(e.target.value)}
          className="w-full px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 focus:outline-none focus:border-blue-500"
          aria-label="Language filter"
          data-testid="lang-filter"
        >
          <option value="">All languages</option>
          {availableLangs.map((lang) => (
            <option key={lang} value={lang}>
              .{lang}
            </option>
          ))}
        </select>
      </div>

      {/* ── Cluster by directory ─────────────────────────────────────────────── */}
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={clusterByDir}
          onChange={(e) => onClusterByDirChange(e.target.checked)}
          className="accent-blue-500"
          aria-label="Cluster by directory"
          data-testid="cluster-toggle"
        />
        <span className="text-xs text-gray-400">Cluster by directory</span>
      </label>

      {/* ── Path highlighter ─────────────────────────────────────────────────── */}
      <div className="border-t border-gray-800 pt-2">
        <div className="text-xs text-gray-500 mb-1.5">Highlight Path</div>

        {/* From */}
        <div className="flex items-center gap-1.5 mb-1">
          <button
            type="button"
            onClick={() => onSelectPath('from')}
            className={`px-2 py-0.5 text-xs rounded border transition-colors ${
              selectingPath === 'from'
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-300'
            }`}
            aria-label="Select path start node"
            data-testid="path-from-btn"
          >
            From
          </button>
          <span
            className="text-xs font-mono text-gray-300 truncate flex-1"
            title={pathFrom ?? ''}
            data-testid="path-from-label"
          >
            {selectingPath === 'from' ? (
              <span className="text-blue-400 animate-pulse">click a node…</span>
            ) : (
              shortPath(pathFrom)
            )}
          </span>
        </div>

        {/* To */}
        <div className="flex items-center gap-1.5 mb-2">
          <button
            type="button"
            onClick={() => onSelectPath('to')}
            className={`px-2 py-0.5 text-xs rounded border transition-colors ${
              selectingPath === 'to'
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-300'
            }`}
            aria-label="Select path end node"
            data-testid="path-to-btn"
          >
            To
          </button>
          <span
            className="text-xs font-mono text-gray-300 truncate flex-1"
            title={pathTo ?? ''}
            data-testid="path-to-label"
          >
            {selectingPath === 'to' ? (
              <span className="text-blue-400 animate-pulse">click a node…</span>
            ) : (
              shortPath(pathTo)
            )}
          </span>
        </div>

        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={onFindPath}
            disabled={!pathFrom || !pathTo}
            className="flex-1 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-600 rounded text-white transition-colors"
            aria-label="Find path"
            data-testid="find-path-btn"
          >
            Find Path
          </button>
          <button
            type="button"
            onClick={onClearPath}
            disabled={!pathFrom && !pathTo && pathStatus === 'idle'}
            className="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 disabled:text-gray-700 border border-gray-700 rounded text-gray-400 transition-colors"
            aria-label="Clear path"
            data-testid="clear-path-btn"
          >
            Clear
          </button>
        </div>

        {/* Path status message */}
        {pathStatus === 'found' && (
          <div className="mt-1.5 text-xs text-green-400" data-testid="path-status-found">
            Path found — highlighted in blue
          </div>
        )}
        {pathStatus === 'not-found' && (
          <div className="mt-1.5 text-xs text-amber-400" data-testid="path-status-not-found">
            No path found between these nodes
          </div>
        )}
      </div>

      {/* ── Re-layout ────────────────────────────────────────────────────────── */}
      <button
        type="button"
        onClick={onRelayout}
        className="py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded text-white transition-colors"
        aria-label="Re-run layout"
      >
        Re-layout
      </button>

      {/* ── Stats ────────────────────────────────────────────────────────────── */}
      <div className="border-t border-gray-800 pt-2 text-gray-500" style={{ fontSize: '0.65rem' }}>
        <div>{nodeCount} nodes · {edgeCount} edges</div>
        {truncated && (
          <div className="text-amber-500 mt-0.5">Graph truncated (limit reached)</div>
        )}
      </div>
    </div>
  );
}
