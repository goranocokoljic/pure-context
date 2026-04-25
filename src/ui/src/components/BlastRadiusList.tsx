import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { GetBlastRadiusResponse, BlastRadiusEntry } from '../api/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function depthColor(depth: number): string {
  if (depth === 0) return 'text-blue-400';
  if (depth === 1) return 'text-red-400';
  if (depth === 2) return 'text-orange-400';
  return 'text-yellow-400';
}

function depthBadge(depth: number): string {
  if (depth === 0) return 'bg-blue-500/20 text-blue-300 border-blue-500/30';
  if (depth === 1) return 'bg-red-500/20 text-red-300 border-red-500/30';
  if (depth === 2) return 'bg-orange-500/20 text-orange-300 border-orange-500/30';
  return 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30';
}

function depthHeading(depth: number): string {
  if (depth === 0) return 'Source file';
  if (depth === 1) return 'Direct dependents (1 hop)';
  if (depth === 2) return '2-hop dependents';
  return `${depth}-hop dependents`;
}

// ─── FileRow ──────────────────────────────────────────────────────────────────

function FileRow({
  entry,
  repoId,
}: {
  entry: BlastRadiusEntry;
  repoId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasSymbols = entry.symbols.length > 0;

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-3 py-2.5 bg-gray-800/50 hover:bg-gray-800 transition-colors text-left"
        aria-expanded={expanded}
      >
        {/* Expand chevron */}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
          className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        >
          <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>

        {/* File path */}
        <code className="flex-1 text-xs font-mono text-gray-200 truncate">
          {entry.filePath}
        </code>

        {/* Symbol count */}
        <span className="text-[10px] text-gray-500 shrink-0">
          {entry.symbolCount} symbol{entry.symbolCount !== 1 ? 's' : ''}
        </span>
      </button>

      {expanded && hasSymbols && (
        <div className="divide-y divide-gray-800">
          {entry.symbols.map((sym) => (
            <div key={sym.id} className="px-3 py-2 flex items-start gap-2 hover:bg-gray-800/30 transition-colors">
              {/* Kind badge */}
              <span className="text-[9px] font-semibold uppercase tracking-wider bg-gray-700 text-gray-400 rounded px-1.5 py-0.5 shrink-0 mt-px">
                {sym.kind}
              </span>

              {/* Symbol name + signature */}
              <div className="flex-1 min-w-0">
                {repoId ? (
                  <Link
                    to={`/symbols/${encodeURIComponent(sym.id)}?repoId=${encodeURIComponent(repoId)}`}
                    className="text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors font-mono"
                  >
                    {sym.name}
                  </Link>
                ) : (
                  <span className="text-xs font-medium text-gray-300 font-mono">{sym.name}</span>
                )}
                {sym.signature && sym.signature !== sym.name && (
                  <p className="text-[10px] text-gray-500 font-mono truncate mt-0.5">{sym.signature}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {expanded && !hasSymbols && (
        <p className="px-4 py-2 text-xs text-gray-600 italic">No symbols indexed in this file.</p>
      )}
    </div>
  );
}

// ─── DepthSection ─────────────────────────────────────────────────────────────

function DepthSection({
  depth,
  entries,
  repoId,
}: {
  depth: number;
  entries: BlastRadiusEntry[];
  repoId: string | null;
}) {
  const [open, setOpen] = useState(depth <= 2);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full py-2 text-left group"
        aria-expanded={open}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
          className={`shrink-0 transition-transform text-gray-500 ${open ? 'rotate-90' : ''}`}
        >
          <path d="M4 2L8 6L4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className={`text-xs font-semibold ${depthColor(depth)}`}>
          {depthHeading(depth)}
        </span>
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${depthBadge(depth)}`}>
          {entries.length}
        </span>
      </button>

      {open && (
        <div className="pl-4 mt-1 space-y-1.5">
          {entries.map((entry) => (
            <FileRow key={entry.filePath} entry={entry} repoId={repoId} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── BlastRadiusList ──────────────────────────────────────────────────────────

interface Props {
  data: GetBlastRadiusResponse;
  repoId: string | null;
}

export function BlastRadiusList({ data, repoId }: Props) {
  const byDepth = new Map<number, BlastRadiusEntry[]>();
  for (const entry of data.entries) {
    const arr = byDepth.get(entry.depth) ?? [];
    arr.push(entry);
    byDepth.set(entry.depth, arr);
  }

  const sortedDepths = Array.from(byDepth.keys()).sort((a, b) => a - b);

  if (data.entries.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
        No dependent files found.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {sortedDepths.map((depth) => (
        <DepthSection
          key={depth}
          depth={depth}
          entries={byDepth.get(depth)!}
          repoId={repoId}
        />
      ))}
    </div>
  );
}
