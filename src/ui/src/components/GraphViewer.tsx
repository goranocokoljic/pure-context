import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  MarkerType,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';

import { GraphControls, type LayoutKind } from './GraphControls.js';
import { GraphFileNode } from './GraphNode.js';
import type { GraphNode as ApiNode, GraphEdge as ApiEdge, GraphNodeData, GraphEdgeData } from '../api/types.js';

// ─── Node types ───────────────────────────────────────────────────────────────

const nodeTypes = { file: GraphFileNode };

// ─── Layout algorithms ────────────────────────────────────────────────────────

interface SimNode extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
}

function applyForceLayout(
  nodes: ApiNode[],
  edges: ApiEdge[],
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  const simNodes: SimNode[] = nodes.map((n, i) => ({
    id: n.id,
    x: (Math.random() - 0.5) * width,
    y: (Math.random() - 0.5) * height,
    index: i,
  }));

  const nodeIndex = new Map(simNodes.map((n) => [n.id, n]));

  const simLinks: SimulationLinkDatum<SimNode>[] = edges
    .map((e) => ({ source: nodeIndex.get(e.source), target: nodeIndex.get(e.target) }))
    .filter((l): l is { source: SimNode; target: SimNode } => !!l.source && !!l.target);

  forceSimulation<SimNode>(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks)
        .id((d) => d.id)
        .distance(120)
        .strength(0.8),
    )
    .force('charge', forceManyBody<SimNode>().strength(-400))
    .force('center', forceCenter(0, 0))
    .force('collide', forceCollide<SimNode>(70))
    .stop()
    .tick(200);

  return new Map(simNodes.map((n) => [n.id, { x: n.x!, y: n.y! }]));
}

function applyHierarchicalLayout(
  nodes: ApiNode[],
  edges: ApiEdge[],
): Map<string, { x: number; y: number }> {
  // Build in-degree map to find roots
  const inDegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    adj.get(e.source)?.push(e.target);
  }

  // BFS to assign levels
  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      level.set(id, 0);
      queue.push(id);
    }
  }
  if (queue.length === 0 && nodes.length > 0) {
    // Cyclic — just put first node as root
    level.set(nodes[0]!.id, 0);
    queue.push(nodes[0]!.id);
  }

  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!;
    const l = level.get(node) ?? 0;
    for (const child of adj.get(node) ?? []) {
      if (!level.has(child)) {
        level.set(child, l + 1);
        queue.push(child);
      }
    }
  }

  // Assign x positions within each level
  const levelNodes = new Map<number, string[]>();
  for (const [id, l] of level) {
    if (!levelNodes.has(l)) levelNodes.set(l, []);
    levelNodes.get(l)!.push(id);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [l, ids] of levelNodes) {
    const totalWidth = ids.length * 180;
    ids.forEach((id, i) => {
      positions.set(id, {
        x: i * 180 - totalWidth / 2,
        y: l * 140,
      });
    });
  }

  // Any unplaced nodes
  let fallbackX = 0;
  for (const n of nodes) {
    if (!positions.has(n.id)) {
      positions.set(n.id, { x: fallbackX, y: 0 });
      fallbackX += 180;
    }
  }

  return positions;
}

function applyRadialLayout(
  nodes: ApiNode[],
  edges: ApiEdge[],
): Map<string, { x: number; y: number }> {
  if (nodes.length === 0) return new Map();

  // Degree centrality — most-connected node goes to center
  const degree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const sorted = [...nodes].sort(
    (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0),
  );

  const positions = new Map<string, { x: number; y: number }>();
  const center = sorted[0]!;
  positions.set(center.id, { x: 0, y: 0 });

  const rest = sorted.slice(1);
  const rings = [rest.slice(0, 8), rest.slice(8, 24), rest.slice(24)];
  const radii = [200, 380, 560];

  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]!;
    if (ring.length === 0) continue;
    const radius = radii[r]!;
    ring.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / ring.length;
      positions.set(node.id, {
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle),
      });
    });
  }

  return positions;
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

function toFlowNodes(
  apiNodes: ApiNode[],
  positions: Map<string, { x: number; y: number }>,
  focusFile?: string,
): Node<GraphNodeData>[] {
  return apiNodes.map((n) => {
    const pos = positions.get(n.id) ?? { x: 0, y: 0 };
    return {
      id: n.id,
      type: 'file',
      position: pos,
      data: n.data,
      style:
        focusFile && n.id === focusFile
          ? { filter: 'drop-shadow(0 0 8px rgba(59,130,246,0.8))' }
          : undefined,
    };
  });
}

function toFlowEdges(apiEdges: ApiEdge[]): Edge<GraphEdgeData>[] {
  return apiEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    markerEnd: { type: MarkerType.ArrowClosed, color: '#4b5563', width: 12, height: 12 },
    style: { stroke: '#4b5563', strokeWidth: 1.5 },
    data: e.data,
    type: 'smoothstep',
  }));
}

// ─── Inner graph (needs ReactFlowProvider context) ────────────────────────────

interface InnerGraphViewerProps {
  apiNodes: ApiNode[];
  apiEdges: ApiEdge[];
  focusFile?: string;
  layout: LayoutKind;
  depth: number;
  onDepthChange: (d: number) => void;
  onLayoutChange: (l: LayoutKind) => void;
  truncated: boolean;
  onNodeClick?: (filePath: string) => void;
}

function InnerGraphViewer({
  apiNodes,
  apiEdges,
  focusFile,
  layout,
  depth,
  onDepthChange,
  onLayoutChange,
  truncated,
  onNodeClick,
}: InnerGraphViewerProps) {
  const { fitView } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<GraphNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<GraphEdgeData>>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const layoutKey = useRef(0);

  const runLayout = useCallback(() => {
    if (apiNodes.length === 0) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const w = containerRef.current?.clientWidth ?? 800;
    const h = containerRef.current?.clientHeight ?? 600;

    let positions: Map<string, { x: number; y: number }>;
    if (layout === 'force') {
      positions = applyForceLayout(apiNodes, apiEdges, w, h);
    } else if (layout === 'hierarchical') {
      positions = applyHierarchicalLayout(apiNodes, apiEdges);
    } else {
      positions = applyRadialLayout(apiNodes, apiEdges);
    }

    setNodes(toFlowNodes(apiNodes, positions, focusFile));
    setEdges(toFlowEdges(apiEdges));
    layoutKey.current++;

    // Fit after a tick so React Flow has measured nodes
    setTimeout(() => fitView({ duration: 300, padding: 0.1 }), 50);
  }, [apiNodes, apiEdges, focusFile, layout, setNodes, setEdges, fitView]);

  // Re-layout whenever data or layout changes
  useEffect(() => {
    runLayout();
  }, [runLayout]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const path = (node.data as { path?: string }).path;
      if (path) onNodeClick?.(path);
    },
    [onNodeClick],
  );

  const stats = useMemo(
    () => ({ nodeCount: apiNodes.length, edgeCount: apiEdges.length }),
    [apiNodes, apiEdges],
  );

  return (
    <div ref={containerRef} className="relative w-full h-full" data-testid="graph-viewer">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        nodeTypes={nodeTypes}
        minZoom={0.05}
        maxZoom={3}
        fitView
        attributionPosition="bottom-right"
        className="bg-gray-950"
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#1f2937" />
      </ReactFlow>

      {/* Controls overlay */}
      <div className="absolute top-3 right-3 z-10">
        <GraphControls
          layout={layout}
          onLayoutChange={onLayoutChange}
          depth={depth}
          onDepthChange={onDepthChange}
          nodeCount={stats.nodeCount}
          edgeCount={stats.edgeCount}
          truncated={truncated}
          onRelayout={runLayout}
        />
      </div>
    </div>
  );
}

// ─── Public component (wraps with ReactFlowProvider) ─────────────────────────

interface GraphViewerProps {
  apiNodes: ApiNode[];
  apiEdges: ApiEdge[];
  focusFile?: string;
  layout: LayoutKind;
  depth: number;
  onDepthChange: (d: number) => void;
  onLayoutChange: (l: LayoutKind) => void;
  truncated: boolean;
  onNodeClick?: (filePath: string) => void;
}

export function GraphViewer(props: GraphViewerProps) {
  return (
    <ReactFlowProvider>
      <InnerGraphViewer {...props} />
    </ReactFlowProvider>
  );
}

// ─── Isolated layout utilities (exported for tests) ───────────────────────────

export { applyForceLayout, applyHierarchicalLayout, applyRadialLayout };
export type { LayoutKind };
