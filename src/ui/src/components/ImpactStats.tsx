import type { GetBlastRadiusResponse } from '../api/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function filesByDepth(data: GetBlastRadiusResponse): Map<number, number> {
  const map = new Map<number, number>();
  for (const entry of data.entries) {
    map.set(entry.depth, (map.get(entry.depth) ?? 0) + 1);
  }
  return map;
}

function reviewEstimate(fileCount: number): string {
  if (fileCount === 0) return '—';
  if (fileCount <= 3) return 'Low (~30 min)';
  if (fileCount <= 10) return 'Medium (~2 hrs)';
  if (fileCount <= 30) return 'High (~1 day)';
  return 'Very high (>1 day)';
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  color = 'text-gray-100',
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-gray-800 rounded-lg px-4 py-3 flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
        {label}
      </span>
      <span className={`text-xl font-bold tabular-nums ${color}`}>{value}</span>
      {sub && <span className="text-xs text-gray-500">{sub}</span>}
    </div>
  );
}

// ─── Depth bar ────────────────────────────────────────────────────────────────

const DEPTH_COLORS: Record<number, string> = {
  0: 'bg-blue-500',
  1: 'bg-red-500',
  2: 'bg-orange-500',
};

function depthBarColor(depth: number): string {
  return DEPTH_COLORS[depth] ?? 'bg-yellow-500';
}

function depthLabel(depth: number): string {
  if (depth === 0) return 'Source';
  if (depth === 1) return 'Direct';
  if (depth === 2) return '2-hop';
  return `${depth}-hop`;
}

// ─── ImpactStats ─────────────────────────────────────────────────────────────

export function ImpactStats({ data }: { data: GetBlastRadiusResponse }) {
  const depthCounts = filesByDepth(data);
  const directFiles = depthCounts.get(1) ?? 0;
  const indirectFiles = data.totalFiles - 1 - directFiles; // exclude depth 0 (source)
  const maxDepthFound = Math.max(...data.entries.map((e) => e.depth));

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard
          label="Files affected"
          value={data.totalFiles - 1}
          sub="excluding source"
          color="text-red-400"
        />
        <StatCard
          label="Symbols affected"
          value={data.totalSymbols}
          color="text-orange-400"
        />
        <StatCard
          label="Direct impact"
          value={directFiles}
          sub="1-hop files"
          color="text-red-300"
        />
        <StatCard
          label="Indirect impact"
          value={indirectFiles}
          sub="2+ hop files"
          color="text-yellow-300"
        />
      </div>

      {/* Review effort */}
      <div className="bg-gray-800 rounded-lg px-4 py-3 flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          Estimated review effort
        </span>
        <span className="text-sm font-medium text-gray-200">
          {reviewEstimate(data.totalFiles - 1)}
        </span>
      </div>

      {/* Depth distribution */}
      {maxDepthFound > 0 && (
        <div className="bg-gray-800 rounded-lg px-4 py-3 space-y-2">
          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider block">
            Impact by depth
          </span>
          {Array.from({ length: maxDepthFound + 1 }, (_, d) => d).filter((d) => d > 0).map((d) => {
            const count = depthCounts.get(d) ?? 0;
            const maxCount = Math.max(...Array.from(depthCounts.values()));
            const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
            return (
              <div key={d} className="flex items-center gap-3">
                <span className="text-xs text-gray-500 w-12 shrink-0">{depthLabel(d)}</span>
                <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${depthBarColor(d)}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-xs text-gray-400 tabular-nums w-8 text-right">{count}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
