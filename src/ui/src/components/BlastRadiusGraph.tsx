import { useState, useRef, useCallback, useEffect } from 'react';
import type { GetBlastRadiusResponse, BlastRadiusEntry } from '../api/types.js';

// ─── Layout constants ─────────────────────────────────────────────────────────

const SVG_SIZE = 680;
const CX = SVG_SIZE / 2;
const CY = SVG_SIZE / 2;
const NODE_R = 18;
const SOURCE_R = 24;

// Ring radii per depth (depth 0 = center, depth 1 = first ring, etc.)
const RING_RADII = [0, 130, 220, 295];
function ringRadius(depth: number): number {
  return RING_RADII[depth] ?? 295 + (depth - 3) * 60;
}

// ─── Colour helpers ───────────────────────────────────────────────────────────

function depthFill(depth: number): string {
  if (depth === 0) return '#3b82f6'; // blue — source
  if (depth === 1) return '#ef4444'; // red — direct
  if (depth === 2) return '#f97316'; // orange — 2-hop
  return '#eab308';                  // yellow — indirect
}

function depthRingStroke(depth: number): string {
  if (depth === 1) return 'rgba(239,68,68,0.18)';
  if (depth === 2) return 'rgba(249,115,22,0.18)';
  return 'rgba(234,179,8,0.18)';
}

function depthLabel(depth: number): string {
  if (depth === 1) return 'Direct dependents';
  if (depth === 2) return '2-hop';
  return `${depth}-hop`;
}

// ─── Node layout ──────────────────────────────────────────────────────────────

interface LayoutNode {
  entry: BlastRadiusEntry;
  x: number;
  y: number;
}

const MAX_NODES_PER_RING = 28;

function buildLayout(data: GetBlastRadiusResponse): LayoutNode[] {
  const byDepth = new Map<number, BlastRadiusEntry[]>();
  for (const entry of data.entries) {
    const arr = byDepth.get(entry.depth) ?? [];
    arr.push(entry);
    byDepth.set(entry.depth, arr);
  }

  const nodes: LayoutNode[] = [];
  for (const [depth, entries] of byDepth) {
    if (depth === 0) {
      // Source node at center
      nodes.push({ entry: entries[0]!, x: CX, y: CY });
      continue;
    }
    const r = ringRadius(depth);
    // Cap visible nodes per ring
    const visible = entries.slice(0, MAX_NODES_PER_RING);
    for (let i = 0; i < visible.length; i++) {
      // Start from top (-PI/2) so first node is at 12 o'clock
      const angle = (2 * Math.PI / visible.length) * i - Math.PI / 2;
      nodes.push({
        entry: visible[i]!,
        x: CX + r * Math.cos(angle),
        y: CY + r * Math.sin(angle),
      });
    }
  }
  return nodes;
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

function Tooltip({ node }: { node: LayoutNode }) {
  const entry = node.entry;
  const fill = depthFill(entry.depth);
  const label = entry.depth === 0 ? 'Source' : depthLabel(entry.depth);

  return (
    <div
      className="absolute z-20 pointer-events-none"
      style={{
        left: node.x / SVG_SIZE * 100 + '%',
        top: node.y / SVG_SIZE * 100 + '%',
        transform: 'translate(-50%, -120%)',
      }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 shadow-lg min-w-[160px] max-w-[260px]">
        <div className="flex items-center gap-2 mb-1">
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ background: fill }}
          />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
            {label}
          </span>
        </div>
        <p className="text-xs font-mono text-gray-200 break-all leading-relaxed">{entry.filePath}</p>
        <p className="text-[10px] text-gray-500 mt-1">
          {entry.symbolCount} symbol{entry.symbolCount !== 1 ? 's' : ''}
        </p>
      </div>
    </div>
  );
}

// ─── BlastRadiusGraph ─────────────────────────────────────────────────────────

interface Props {
  data: GetBlastRadiusResponse;
  onNodeClick?: (filePath: string) => void;
}

export function BlastRadiusGraph({ data, onNodeClick }: Props) {
  const nodes = buildLayout(data);
  const [hovered, setHovered] = useState<LayoutNode | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Close tooltip on outside click
  useEffect(() => {
    const handler = () => setHovered(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, []);

  const handleNodeClick = useCallback(
    (e: React.MouseEvent, node: LayoutNode) => {
      e.stopPropagation();
      onNodeClick?.(node.entry.filePath);
    },
    [onNodeClick],
  );

  const maxDepth = Math.max(...data.entries.map((e) => e.depth));

  // Count truncated nodes per ring
  const byDepth = new Map<number, number>();
  for (const entry of data.entries) {
    byDepth.set(entry.depth, (byDepth.get(entry.depth) ?? 0) + 1);
  }

  return (
    <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
      {/* Legend */}
      <div className="absolute top-3 left-3 z-10 flex flex-col gap-1">
        {[
          { depth: 0, label: 'Source' },
          { depth: 1, label: 'Direct (1-hop)' },
          { depth: 2, label: '2-hop' },
          { depth: 3, label: '3+ hop' },
        ]
          .filter(({ depth }) => depth === 0 || (byDepth.get(depth) ?? 0) > 0)
          .map(({ depth, label }) => (
            <div key={depth} className="flex items-center gap-2">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ background: depthFill(depth) }}
              />
              <span className="text-[10px] text-gray-400">{label}</span>
            </div>
          ))}
      </div>

      {/* SVG */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
        className="w-full h-full max-w-[680px] max-h-[680px]"
        aria-label="Blast radius radial graph"
      >
        {/* Ring guides */}
        {Array.from({ length: maxDepth }, (_, i) => i + 1).map((d) => (
          <circle
            key={d}
            cx={CX}
            cy={CY}
            r={ringRadius(d)}
            fill={depthRingStroke(d)}
            stroke={depthFill(d)}
            strokeWidth={1}
            strokeDasharray="4 4"
            opacity={0.5}
          />
        ))}

        {/* Ring depth labels */}
        {Array.from({ length: maxDepth }, (_, i) => i + 1).map((d) => {
          const count = byDepth.get(d) ?? 0;
          if (count === 0) return null;
          const truncated = count > MAX_NODES_PER_RING ? count - MAX_NODES_PER_RING : 0;
          const r = ringRadius(d);
          return (
            <g key={d}>
              <text
                x={CX}
                y={CY - r + 14}
                textAnchor="middle"
                fill={depthFill(d)}
                fontSize={10}
                opacity={0.7}
              >
                {depthLabel(d)} ({count}{truncated > 0 ? `, +${truncated} more` : ''})
              </text>
            </g>
          );
        })}

        {/* Edges from source to direct, direct to 2-hop, etc. */}
        {nodes
          .filter((n) => n.entry.depth > 0)
          .map((n) => {
            // Draw edge from the ring one level inward (approximate by going toward center)
            const parentDepth = n.entry.depth - 1;
            const parentR = ringRadius(parentDepth);
            // Find closest node in parent ring or just draw from center area
            const dx = n.x - CX;
            const dy = n.y - CY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const startX = dist === 0 ? CX : CX + (dx / dist) * parentR;
            const startY = dist === 0 ? CY : CY + (dy / dist) * parentR;
            return (
              <line
                key={n.entry.filePath}
                x1={startX}
                y1={startY}
                x2={n.x}
                y2={n.y}
                stroke={depthFill(n.entry.depth)}
                strokeWidth={1}
                strokeOpacity={0.35}
              />
            );
          })}

        {/* Nodes */}
        {nodes.map((n) => {
          const r = n.entry.depth === 0 ? SOURCE_R : NODE_R;
          const fill = depthFill(n.entry.depth);
          const name = n.entry.filePath.split('/').pop() ?? n.entry.filePath;
          const truncatedName = name.length > 14 ? name.slice(0, 12) + '…' : name;
          const isHovered = hovered?.entry.filePath === n.entry.filePath;

          return (
            <g
              key={n.entry.filePath}
              role="button"
              tabIndex={0}
              aria-label={`${n.entry.filePath} — ${n.entry.symbolCount} symbols`}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHovered(n)}
              onMouseLeave={() => setHovered(null)}
              onClick={(e) => handleNodeClick(e, n)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onNodeClick?.(n.entry.filePath);
                }
              }}
            >
              <circle
                cx={n.x}
                cy={n.y}
                r={r + (isHovered ? 3 : 0)}
                fill={fill}
                fillOpacity={isHovered ? 0.9 : 0.75}
                stroke={fill}
                strokeWidth={isHovered ? 2.5 : 1.5}
                style={{ transition: 'r 0.12s, fill-opacity 0.12s' }}
              />
              {/* Symbol count badge for source node */}
              {n.entry.depth === 0 && (
                <text
                  x={n.x}
                  y={n.y + 4}
                  textAnchor="middle"
                  fill="white"
                  fontSize={10}
                  fontWeight="bold"
                  pointerEvents="none"
                >
                  {n.entry.symbolCount}
                </text>
              )}
              {/* Label below node */}
              <text
                x={n.x}
                y={n.y + r + 14}
                textAnchor="middle"
                fill={isHovered ? 'white' : '#9ca3af'}
                fontSize={9}
                pointerEvents="none"
              >
                {truncatedName}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Hover tooltip */}
      {hovered && (
        <Tooltip node={hovered} />
      )}
    </div>
  );
}
