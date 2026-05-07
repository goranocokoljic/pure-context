/**
 * SymbolTimeline.tsx
 *
 * Renders the git history of a single symbol as an interactive SVG timeline.
 *
 * - Horizontal axis spans the last 12 months (or all-time via toggle).
 * - Each commit is a dot coloured by author (deterministic HSL from name hash).
 * - Hover shows a tooltip with author initials, date, and commit message.
 * - Click expands the commit to show the full SHA and message.
 * - Churn score badge appears above the timeline.
 */

import { useState, useMemo } from 'react';
import type { SymbolCommit } from '../api/types.js';

// ─── Pure helpers (exported for tests) ────────────────────────────────────────

/**
 * Deterministic author colour: hsl(hash(authorEmail) % 360, 70%, 50%).
 * Falls back to author name when email is empty.
 */
export function authorColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360}, 70%, 50%)`;
}

/** Extract up-to-two uppercase initials from a display name. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** Truncate a commit message to `max` chars with an ellipsis. */
export function truncateMessage(msg: string, max = 60): string {
  return msg.length > max ? `${msg.slice(0, max)}…` : msg;
}

/** Human-readable churn label for a given score (commits/90d). */
export function churnLabel(score: number): string {
  if (score >= 10) return 'Hotspot';
  if (score >= 5) return 'Volatile';
  if (score >= 2) return 'Active';
  return 'Stable';
}

/** Tailwind classes for the churn badge background/text. */
export function churnBadgeClasses(score: number): string {
  if (score >= 10) return 'text-red-400 bg-red-900/40';
  if (score >= 5) return 'text-orange-400 bg-orange-900/40';
  if (score >= 2) return 'text-yellow-400 bg-yellow-900/40';
  return 'text-green-400 bg-green-900/40';
}

/**
 * Map a UTC date string to an x-coordinate within a [xMin, xMax] time window.
 * Returns a value in [0, 1]; clamp before use.
 */
export function dateRatio(isoDate: string, xMinMs: number, xMaxMs: number): number {
  const t = new Date(isoDate).getTime();
  if (xMaxMs <= xMinMs) return 0;
  return (t - xMinMs) / (xMaxMs - xMinMs);
}

/** Format a Date as "Jan '24" for axis tick labels. */
export function formatMonthLabel(d: Date): string {
  const month = d.toLocaleString('en', { month: 'short' });
  const year = String(d.getFullYear()).slice(-2);
  return `${month} '${year}`;
}

// ─── SVG constants ─────────────────────────────────────────────────────────────

const SVG_W = 620;
const SVG_H = 90;
const DOT_R = 6;
const ML = 16;   // margin left
const MR = 16;   // margin right
const MT = 28;   // margin top (dot centre y)
const MB = 22;   // margin bottom (room for tick labels)
const PLOT_W = SVG_W - ML - MR;
const DOT_Y = MT + (SVG_H - MT - MB) / 2;

// ─── Component ─────────────────────────────────────────────────────────────────

export interface SymbolTimelineProps {
  history: SymbolCommit[];
  totalCommits: number;
  churnScore: number;
  note?: string;
}

export function SymbolTimeline({
  history,
  totalCommits,
  churnScore,
  note,
}: SymbolTimelineProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [allTime, setAllTime] = useState(false);

  // ── Time window ─────────────────────────────────────────────────────────────

  const nowMs = useMemo(() => Date.now(), []);
  const twelveMonthsMs = 365 * 24 * 60 * 60 * 1000;

  const xMaxMs = nowMs;
  const xMinMs = useMemo(() => {
    if (!allTime || history.length === 0) return nowMs - twelveMonthsMs;
    const earliest = Math.min(...history.map((c) => new Date(c.date).getTime()));
    // add 2% padding on the left
    return earliest - (nowMs - earliest) * 0.02;
  }, [allTime, history, nowMs, twelveMonthsMs]);

  // ── Axis ticks ───────────────────────────────────────────────────────────────

  const ticks = useMemo(() => {
    const result: { x: number; label: string }[] = [];
    const d = new Date(xMinMs);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    const monthStep = allTime && nowMs - xMinMs > 2 * twelveMonthsMs ? 3 : 1;
    while (d.getTime() <= xMaxMs) {
      const ratio = Math.max(0, Math.min(1, (d.getTime() - xMinMs) / (xMaxMs - xMinMs)));
      result.push({ x: ML + ratio * PLOT_W, label: formatMonthLabel(d) });
      d.setMonth(d.getMonth() + monthStep);
    }
    return result;
  }, [xMinMs, xMaxMs, allTime, nowMs, twelveMonthsMs]);

  // ── Dot positions ────────────────────────────────────────────────────────────

  const dots = useMemo(
    () =>
      history.map((commit, idx) => {
        const ratio = Math.max(0, Math.min(1, dateRatio(commit.date, xMinMs, xMaxMs)));
        return { commit, idx, cx: ML + ratio * PLOT_W };
      }),
    [history, xMinMs, xMaxMs],
  );

  // ── Render ───────────────────────────────────────────────────────────────────

  const hovered = hoveredIdx !== null ? history[hoveredIdx] ?? null : null;
  const expanded = expandedIdx !== null ? history[expandedIdx] ?? null : null;

  return (
    <div className="px-6 py-4 flex flex-col gap-3">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${churnBadgeClasses(churnScore)}`}
            data-testid="churn-badge"
          >
            {churnScore.toFixed(1)} commits/90d — {churnLabel(churnScore)}
          </span>
          <span className="text-[10px] text-gray-500">
            {totalCommits} total commit{totalCommits !== 1 ? 's' : ''}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setAllTime((v) => !v)}
          className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors shrink-0"
        >
          {allTime ? 'Last 12 months' : 'All time'}
        </button>
      </div>

      {/* ── SVG timeline ── */}
      <div
        className="rounded border border-gray-800 bg-gray-950 overflow-hidden"
        role="region"
        aria-label="Commit timeline"
      >
        <svg
          width="100%"
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          className="block"
          aria-hidden="false"
        >
          {/* Axis baseline */}
          <line
            x1={ML}
            y1={DOT_Y}
            x2={SVG_W - MR}
            y2={DOT_Y}
            stroke="#374151"
            strokeWidth={1}
          />

          {/* Month tick marks + labels */}
          {ticks.map((tick) => (
            <g key={`tick-${tick.label}-${tick.x}`}>
              <line
                x1={tick.x}
                y1={DOT_Y - 4}
                x2={tick.x}
                y2={DOT_Y + 4}
                stroke="#374151"
                strokeWidth={1}
              />
              <text
                x={tick.x}
                y={SVG_H - 5}
                textAnchor="middle"
                fontSize={8}
                fill="#6b7280"
              >
                {tick.label}
              </text>
            </g>
          ))}

          {/* Commit dots */}
          {dots.map(({ commit, idx, cx }) => {
            const color = authorColor(commit.authorEmail || commit.author);
            const isHovered = hoveredIdx === idx;
            const isExpanded = expandedIdx === idx;
            return (
              <circle
                key={commit.sha}
                cx={cx}
                cy={DOT_Y}
                r={isHovered || isExpanded ? DOT_R + 2 : DOT_R}
                fill={color}
                stroke={isExpanded ? '#e5e7eb' : isHovered ? '#9ca3af' : 'transparent'}
                strokeWidth={1.5}
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHoveredIdx(idx)}
                onMouseLeave={() => setHoveredIdx(null)}
                onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
                role="button"
                aria-label={`${commit.author}: ${truncateMessage(commit.message)}`}
                data-testid={`commit-dot-${idx}`}
              />
            );
          })}
        </svg>
      </div>

      {/* ── Tooltip (hovered) ── */}
      {hovered && (
        <div
          className="rounded border border-gray-700 bg-gray-900 px-3 py-2 flex items-start gap-2 text-[11px]"
          data-testid="commit-tooltip"
        >
          <span
            className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 mt-0.5"
            style={{ background: authorColor(hovered.authorEmail || hovered.author), color: '#fff' }}
            aria-hidden="true"
          >
            {initials(hovered.author)}
          </span>
          <div className="min-w-0">
            <p className="text-gray-300 font-medium">{hovered.author}</p>
            <p className="text-gray-500 text-[10px]">
              {new Date(hovered.date).toLocaleDateString()} · {hovered.daysAgo}d ago · {hovered.shortSha}
            </p>
            <p className="text-gray-400 mt-0.5 break-all">{truncateMessage(hovered.message)}</p>
          </div>
        </div>
      )}

      {/* ── Expanded commit detail (clicked) ── */}
      {expanded && !hovered && (
        <div
          className="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-[11px]"
          data-testid="commit-expanded"
        >
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-gray-400 font-mono text-[10px]">{expanded.sha}</span>
            <button
              type="button"
              onClick={() => setExpandedIdx(null)}
              className="text-gray-600 hover:text-gray-400 text-xs leading-none"
              aria-label="Close commit detail"
            >
              ✕
            </button>
          </div>
          <p className="text-gray-300">{expanded.message}</p>
          <p className="text-gray-500 text-[10px] mt-1">
            {expanded.author}
            {expanded.authorEmail ? ` <${expanded.authorEmail}>` : ''}
            {' · '}
            {new Date(expanded.date).toLocaleString()}
          </p>
        </div>
      )}

      {/* ── Fallback note ── */}
      {note && (
        <p className="text-[10px] text-gray-600 italic">{note}</p>
      )}
    </div>
  );
}
