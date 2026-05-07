import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
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

// ─── Directory group node ─────────────────────────────────────────────────────

function DirGroupNode({ data }: { data: GraphNodeData }) {
  return (
    <div
      className="w-full h-full rounded border border-gray-700"
      style={{ background: 'rgba(31, 41, 55, 0.5)' }}
      data-testid="dir-group-node"
    >
      <div className="px-2 py-1 text-xs text-gray-500 font-mono truncate border-b border-gray-700/50">
        {data.label}
      </div>
    </div>
  );
}

// ─── Node types ───────────────────────────────────────────────────────────────

const nodeTypes = { file: GraphFileNode, dirGroup: DirGroupNode };

// ─── Pure algorithm functions (exported for tests) ────────────────────────────

/** Filter nodes whose file extension matches lang (empty string = all). */
export function filterNodesByLang(nodes: ApiNode[], lang: string): ApiNode[] {
  if (!lang) return nodes;
  return nodes.filter((n) => {
    const path = n.data.path as string;
    const ext = path.includes('.') ? path.split('.').pop() ?? '' : '';
    return ext === lang;
  });
}

/** BFS shortest path (undirected) between two node IDs. Returns null if unreachable. */
export function findShortestPath(
  from: string,
  to: string,
  edges: ApiEdge[],
): string[] | null {
  if (from === to) return [from];

  // Build undirected adjacency list
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source)!.push(e.target);
    adj.get(e.target)!.push(e.source);
  }

  const visited = new Set<string>([from]);
  const queue: string[][] = [[from]];

  while (queue.length > 0) {
    const path = queue.shift()!;
    const node = path[path.length - 1]!;
    for (const neighbor of adj.get(node) ?? []) {
      if (neighbor === to) return [...path, to];
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push([...path, neighbor]);
      }
    }
  }
  return null;
}

/** Map a node-ID path to the set of edge IDs that connect consecutive nodes. */
export function pathToEdgeIds(path: string[], edges: ApiEdge[]): Set<string> {
  if (path.length < 2) return new Set();
  const lookup = new Map<string, string>();
  for (const e of edges) {
    lookup.set(`${e.source}|${e.target}`, e.id);
    lookup.set(`${e.target}|${e.source}`, e.id);
  }
  const result = new Set<string>();
  for (let i = 0; i < path.length - 1; i++) {
    const id = lookup.get(`${path[i]}|${path[i + 1]}`);
    if (id) result.add(id);
  }
  return result;
}

/** Group nodes by their parent directory path. */
export function groupByDirectory(nodes: ApiNode[]): Map<string, ApiNode[]> {
  const groups = new Map<string, ApiNode[]>();
  for (const n of nodes) {
    const path = n.data.path as string;
    const lastSlash = path.lastIndexOf('/');
    const dir = lastSlash >= 0 ? path.slice(0, lastSlash) : '.';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(n);
  }
  return groups;
}

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
  const inDegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    adj.get(e.source)?.push(e.target);
  }

  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      level.set(id, 0);
      queue.push(id);
    }
  }
  if (queue.length === 0 && nodes.length > 0) {
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

// ─── Cluster layout builder ───────────────────────────────────────────────────

const CLUSTER_PADDING = 20;
const CLUSTER_NODE_W = 200;
const CLUSTER_NODE_H = 60;
const CLUSTER_HEADER_H = 24;
const CLUSTER_GAP = 10;
const CLUSTER_COLS = 2;

function buildClusterLayout(
  nodes: ApiNode[],
  basePositions: Map<string, { x: number; y: number }>,
): Node<GraphNodeData>[] {
  const dirMap = groupByDirectory(nodes);
  const allNodes: Node<GraphNodeData>[] = [];

  for (const [dir, dirNodes] of dirMap) {
    const rows = Math.ceil(dirNodes.length / CLUSTER_COLS);
    const groupW =
      CLUSTER_COLS * CLUSTER_NODE_W + (CLUSTER_COLS - 1) * CLUSTER_GAP + CLUSTER_PADDING * 2;
    const groupH =
      rows * CLUSTER_NODE_H + (rows - 1) * CLUSTER_GAP + CLUSTER_PADDING * 2 + CLUSTER_HEADER_H;

    // Group position: centroid of children's base positions
    let cx = 0;
    let cy = 0;
    for (const n of dirNodes) {
      const p = basePositions.get(n.id) ?? { x: 0, y: 0 };
      cx += p.x;
      cy += p.y;
    }
    cx /= dirNodes.length;
    cy /= dirNodes.length;

    const groupId = `__dir_${dir}`;
    allNodes.push({
      id: groupId,
      type: 'dirGroup',
      position: { x: cx - groupW / 2, y: cy - groupH / 2 },
      style: { width: groupW, height: groupH },
      data: { label: dir, path: '', symbolCount: 0, __isGroup: true } as unknown as GraphNodeData,
    });

    dirNodes.forEach((n, i) => {
      const col = i % CLUSTER_COLS;
      const row = Math.floor(i / CLUSTER_COLS);
      allNodes.push({
        id: n.id,
        type: 'file',
        parentId: groupId,
        extent: 'parent',
        position: {
          x: CLUSTER_PADDING + col * (CLUSTER_NODE_W + CLUSTER_GAP),
          y: CLUSTER_PADDING + CLUSTER_HEADER_H + row * (CLUSTER_NODE_H + CLUSTER_GAP),
        },
        data: n.data,
      });
    });
  }

  return allNodes;
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

  // ─── Filter / cluster state ─────────────────────────────────────────────────
  const [langFilter, setLangFilter] = useState('');
  const [clusterByDir, setClusterByDir] = useState(false);

  // ─── Path highlight state ────────────────────────────────────────────────────
  const [pathFrom, setPathFrom] = useState<string | null>(null);
  const [pathTo, setPathTo] = useState<string | null>(null);
  const [pathNodeIds, setPathNodeIds] = useState<Set<string>>(new Set());
  const [pathEdgeIds, setPathEdgeIds] = useState<Set<string>>(new Set());
  const [selectingPath, setSelectingPath] = useState<'from' | 'to' | null>(null);
  const [pathStatus, setPathStatus] = useState<'idle' | 'found' | 'not-found'>('idle');

  // ─── Derived data ────────────────────────────────────────────────────────────

  const availableLangs = useMemo(() => {
    const exts = new Set<string>();
    for (const n of apiNodes) {
      const path = n.data.path as string;
      const ext = path.includes('.') ? path.split('.').pop() : undefined;
      if (ext) exts.add(ext);
    }
    return [...exts].sort();
  }, [apiNodes]);

  const filteredNodes = useMemo(
    () => filterNodesByLang(apiNodes, langFilter),
    [apiNodes, langFilter],
  );

  const filteredEdges = useMemo(() => {
    if (!langFilter) return apiEdges;
    const nodeSet = new Set(filteredNodes.map((n) => n.id));
    return apiEdges.filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target));
  }, [apiEdges, filteredNodes, langFilter]);

  const stats = useMemo(
    () => ({ nodeCount: filteredNodes.length, edgeCount: filteredEdges.length }),
    [filteredNodes, filteredEdges],
  );

  // ─── Path operations ────────────────────────────────────────────────────────

  const handleFindPath = useCallback(() => {
    if (!pathFrom || !pathTo) return;
    const path = findShortestPath(pathFrom, pathTo, filteredEdges);
    if (path) {
      setPathNodeIds(new Set(path));
      setPathEdgeIds(pathToEdgeIds(path, filteredEdges));
      setPathStatus('found');
    } else {
      setPathNodeIds(new Set());
      setPathEdgeIds(new Set());
      setPathStatus('not-found');
    }
  }, [pathFrom, pathTo, filteredEdges]);

  const handleClearPath = useCallback(() => {
    setPathFrom(null);
    setPathTo(null);
    setPathNodeIds(new Set());
    setPathEdgeIds(new Set());
    setPathStatus('idle');
    setSelectingPath(null);
  }, []);

  const handleSelectPath = useCallback((which: 'from' | 'to') => {
    setSelectingPath((prev) => (prev === which ? null : which));
  }, []);

  // ─── Layout ─────────────────────────────────────────────────────────────────

  const runLayout = useCallback(() => {
    if (filteredNodes.length === 0) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const w = containerRef.current?.clientWidth ?? 800;
    const h = containerRef.current?.clientHeight ?? 600;

    let positions: Map<string, { x: number; y: number }>;
    if (layout === 'force') {
      positions = applyForceLayout(filteredNodes, filteredEdges, w, h);
    } else if (layout === 'hierarchical') {
      positions = applyHierarchicalLayout(filteredNodes, filteredEdges);
    } else {
      positions = applyRadialLayout(filteredNodes, filteredEdges);
    }

    if (clusterByDir) {
      setNodes(buildClusterLayout(filteredNodes, positions));
    } else {
      setNodes(toFlowNodes(filteredNodes, positions, focusFile));
    }
    setEdges(toFlowEdges(filteredEdges));
    layoutKey.current++;
    setTimeout(() => fitView({ duration: 300, padding: 0.1 }), 50);
  }, [filteredNodes, filteredEdges, focusFile, layout, clusterByDir, setNodes, setEdges, fitView]);

  useEffect(() => {
    runLayout();
  }, [runLayout]);

  // ─── Path highlighting effect ────────────────────────────────────────────────
  // Runs separately from runLayout so layout positions are not re-randomized.

  useEffect(() => {
    const hasPath = pathNodeIds.size > 0;
    setNodes((prev) =>
      prev.map((n) => {
        if ((n.data as GraphNodeData & { __isGroup?: boolean }).__isGroup) return n;
        return {
          ...n,
          style: {
            ...(n.style ?? {}),
            opacity: hasPath && !pathNodeIds.has(n.id) ? 0.2 : 1,
          },
        };
      }),
    );
    setEdges((prev) =>
      prev.map((e) => {
        const onPath = !hasPath || pathEdgeIds.has(e.id);
        return {
          ...e,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: hasPath && onPath ? '#3b82f6' : '#4b5563',
            width: 12,
            height: 12,
          },
          style: {
            stroke: hasPath && onPath ? '#3b82f6' : '#4b5563',
            strokeWidth: hasPath && onPath ? 2.5 : 1.5,
            opacity: onPath ? 1 : 0.2,
          },
        };
      }),
    );
  }, [pathNodeIds, pathEdgeIds, setNodes, setEdges]);

  // ─── Node click ──────────────────────────────────────────────────────────────

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const path = (node.data as { path?: string }).path;
      if (!path) return;

      if (selectingPath === 'from') {
        setPathFrom(path);
        setSelectingPath(null);
        return;
      }
      if (selectingPath === 'to') {
        setPathTo(path);
        setSelectingPath(null);
        return;
      }

      onNodeClick?.(path);
    },
    [onNodeClick, selectingPath],
  );

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full"
      data-testid="graph-viewer"
      style={{ cursor: selectingPath ? 'crosshair' : undefined }}
    >
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
        <MiniMap
          nodeColor={(n) =>
            (n.data as GraphNodeData & { __isGroup?: boolean }).__isGroup
              ? 'transparent'
              : '#374151'
          }
          maskColor="rgba(17, 24, 39, 0.7)"
          style={{ background: '#111827' }}
          data-testid="graph-minimap"
        />
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
          langFilter={langFilter}
          onLangFilterChange={setLangFilter}
          availableLangs={availableLangs}
          clusterByDir={clusterByDir}
          onClusterByDirChange={setClusterByDir}
          pathFrom={pathFrom}
          pathTo={pathTo}
          selectingPath={selectingPath}
          onSelectPath={handleSelectPath}
          onFindPath={handleFindPath}
          onClearPath={handleClearPath}
          pathStatus={pathStatus}
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
