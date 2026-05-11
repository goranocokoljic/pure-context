import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client.js';
import type { GetGraphResponse } from '../api/types.js';
import { GraphViewer, type LayoutKind } from '../components/GraphViewer.js';

// ─── Loading / error states ───────────────────────────────────────────────────

function Loading() {
  return (
    <div className="flex items-center justify-center h-full text-gray-500 gap-2">
      <div className="w-4 h-4 rounded-full bg-blue-500 animate-pulse" />
      <span className="text-sm">Loading graph…</span>
    </div>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center max-w-sm">
        <div className="text-red-400 font-medium mb-1">Failed to load graph</div>
        <div className="text-sm text-gray-500">{message}</div>
      </div>
    </div>
  );
}

function EmptyPanel() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center text-gray-500">
        <div className="text-lg mb-1">No dependency data</div>
        <div className="text-sm">Index this repository first to see dependency edges.</div>
      </div>
    </div>
  );
}

function NoRepoPanel() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center text-gray-500">
        <div className="text-lg mb-1">No repository selected</div>
        <div className="text-sm mb-3">Open a repository first, then navigate to its graph.</div>
        <Link
          to="/"
          className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
        >
          ← Go to repositories
        </Link>
      </div>
    </div>
  );
}

// ─── DependencyGraph page ─────────────────────────────────────────────────────

export default function DependencyGraph() {
  const { id: repoId } = useParams<{ id: string }>();
  const [graphData, setGraphData] = useState<GetGraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [focusFile, setFocusFile] = useState<string | undefined>(undefined);
  const [depth, setDepth] = useState(3);
  const [layout, setLayout] = useState<LayoutKind>('force');

  const loadGraph = useCallback(async () => {
    if (!repoId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api.getGraph(repoId, {
        filePath: focusFile,
        depth,
        limit: 200,
      });
      setGraphData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [repoId, focusFile, depth]);

  // Load on mount and when focusFile changes
  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  const handleNodeClick = useCallback((filePath: string) => {
    setFocusFile((prev) => (prev === filePath ? undefined : filePath));
  }, []);

  const handleDepthChange = useCallback(
    (newDepth: number) => {
      setDepth(newDepth);
    },
    [],
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-gray-800 shrink-0 bg-gray-900">
        {repoId && (
          <Link
            to={`/repos/${encodeURIComponent(repoId)}`}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            ← Back to repo
          </Link>
        )}

        <h1 className="text-sm font-semibold text-gray-200">Dependency Graph</h1>

        {focusFile && (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs text-gray-500">Focus:</span>
            <code className="text-xs text-blue-400 font-mono truncate max-w-xs">{focusFile}</code>
            <button
              type="button"
              onClick={() => setFocusFile(undefined)}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
              aria-label="Clear focus"
            >
              ✕
            </button>
          </div>
        )}

        {!focusFile && (
          <span className="text-xs text-gray-600 ml-auto">
            Click a node to focus on its neighborhood
          </span>
        )}

        <button
          type="button"
          onClick={() => void loadGraph()}
          className="ml-2 px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-300 transition-colors"
          aria-label="Refresh graph"
        >
          Refresh
        </button>
      </div>

      {/* Graph area */}
      <div className="flex-1 overflow-hidden relative">
        {!repoId && <NoRepoPanel />}
        {repoId && loading && <Loading />}
        {repoId && !loading && error && <ErrorPanel message={error} />}
        {repoId && !loading && !error && graphData && graphData.nodes.length === 0 && <EmptyPanel />}
        {repoId && !loading && !error && graphData && graphData.nodes.length > 0 && (
          <GraphViewer
            apiNodes={graphData.nodes}
            apiEdges={graphData.edges}
            focusFile={focusFile}
            layout={layout}
            depth={depth}
            onDepthChange={handleDepthChange}
            onLayoutChange={setLayout}
            truncated={graphData.truncated}
            onNodeClick={handleNodeClick}
          />
        )}
      </div>
    </div>
  );
}
