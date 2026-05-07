import type { FileTreeNode, CoverageStatus, HeatmapMode, FileHeatScore } from '../api/types.js';
import { useRepoStore } from '../stores/repoStore.js';
import { heatColor, modeScore } from '../stores/heatmapStore.js';

// ─── File icon ────────────────────────────────────────────────────────────────

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const icons: Record<string, string> = {
    ts: 'TS', tsx: 'TX', js: 'JS', jsx: 'JX',
    vue: 'VU', svelte: 'SV', astro: 'AS',
    py: 'PY', go: 'GO', rs: 'RS', rb: 'RB',
    java: 'JV', kt: 'KT', cs: 'C#', cpp: 'C+',
    c: 'C ', h: 'H ', php: 'PHP', lua: 'LU',
    r: 'R ', dart: 'DA', swift: 'SW', ex: 'EX',
    hs: 'HS', scala: 'SC', elixir: 'EX',
    json: 'JSON', yaml: 'YAML', yml: 'YML',
    toml: 'TOML', md: 'MD', txt: 'TXT',
    css: 'CSS', scss: 'SCSS', html: 'HTM', svg: 'SVG',
    sh: 'SH', bash: 'SH', zsh: 'SH',
    sql: 'SQL', graphql: 'GQL',
  };
  return icons[ext] ?? '  ';
}

function FileIcon({ name }: { name: string }) {
  const label = fileIcon(name);
  return (
    <span
      className="shrink-0 text-[9px] font-bold w-6 h-4 flex items-center justify-center rounded bg-gray-800 text-gray-500 font-mono leading-none"
      aria-hidden="true"
    >
      {label}
    </span>
  );
}

// ─── Coverage dot ─────────────────────────────────────────────────────────────

function CoverageDot({ status, title }: { status: CoverageStatus; title: string }) {
  const color =
    status === 'tested'   ? 'bg-green-500' :
    status === 'untested' ? 'bg-red-500'   :
                            'bg-gray-500';
  return (
    <span
      className={`shrink-0 w-1.5 h-1.5 rounded-full ${color}`}
      title={title}
      aria-label={`Coverage: ${status}`}
    />
  );
}

// ─── Heat tooltip text ────────────────────────────────────────────────────────

function heatTooltip(score: FileHeatScore): string {
  const parts: string[] = [];
  if (score.avgComplexity > 0) {
    parts.push(`Avg complexity: ${score.avgComplexity}`);
  }
  if (score.commitCount > 0) {
    parts.push(`Churn: ${score.commitCount} commits/90d`);
  }
  if (score.criticalSymbols > 0) {
    parts.push(`${score.criticalSymbols} critical symbol${score.criticalSymbols !== 1 ? 's' : ''}`);
  }
  return parts.length > 0 ? parts.join(' | ') : 'No metrics available';
}

// ─── Max heat score across a subtree ─────────────────────────────────────────

function maxScoreInSubtree(
  tree: Record<string, FileTreeNode>,
  basePath: string,
  heatScores: ReadonlyMap<string, FileHeatScore>,
  mode: HeatmapMode,
): number | null {
  let max: number | null = null;
  for (const [name, node] of Object.entries(tree)) {
    const childPath = `${basePath}/${name}`;
    if (node.type === 'file') {
      const entry = heatScores.get(childPath);
      if (entry !== undefined) {
        const s = modeScore(entry, mode);
        max = max === null ? s : Math.max(max, s);
      }
    } else {
      const childMax = maxScoreInSubtree(node.children, childPath, heatScores, mode);
      if (childMax !== null) {
        max = max === null ? childMax : Math.max(max, childMax);
      }
    }
  }
  return max;
}

// ─── Sort: dirs before files, then alphabetical ───────────────────────────────

function sortedEntries(tree: Record<string, FileTreeNode>): [string, FileTreeNode][] {
  return Object.entries(tree).sort(([aName, aNode], [bName, bNode]) => {
    if (aNode.type !== bNode.type) return aNode.type === 'dir' ? -1 : 1;
    return aName.localeCompare(bName);
  });
}

// ─── Individual tree node ─────────────────────────────────────────────────────

interface TreeNodeProps {
  name: string;
  node: FileTreeNode;
  /** Full path relative to repo root, e.g. "src/core/types.ts" */
  path: string;
  repoId: string;
  depth: number;
  onFileClick: (path: string) => void;
  /** Optional map from filePath → aggregate coverage status for that file. */
  coverageMap?: ReadonlyMap<string, CoverageStatus>;
  /** Optional map from filePath → heatmap score entry. */
  heatScores?: ReadonlyMap<string, FileHeatScore>;
  /** Active heatmap mode (required when heatScores is provided). */
  heatMode?: HeatmapMode;
}

function TreeNode({
  name,
  node,
  path,
  repoId,
  depth,
  onFileClick,
  coverageMap,
  heatScores,
  heatMode,
}: TreeNodeProps) {
  // Avoid returning `new Set()` from a selector — it creates a new reference
  // each render and causes infinite re-renders via Zustand's shallow comparison.
  const expandedDirs = useRepoStore((s) => s.expandedDirs[repoId]);
  const toggleDir = useRepoStore((s) => s.toggleDir);
  const selectedFilePath = useRepoStore((s) => s.selectedFilePath);

  const indent = 8 + depth * 14;
  const isExpanded = node.type === 'dir' && (expandedDirs?.has(path) ?? false);
  const isSelected = node.type === 'file' && selectedFilePath === path;

  if (node.type === 'dir') {
    // Compute max heat score across all files in this directory subtree
    const dirMaxScore =
      heatScores && heatMode
        ? maxScoreInSubtree(node.children, path, heatScores, heatMode)
        : null;

    const heatBorderStyle =
      dirMaxScore !== null
        ? { borderLeftColor: heatColor(dirMaxScore), borderLeftWidth: '2px', borderLeftStyle: 'solid' as const }
        : undefined;

    return (
      <div>
        <button
          onClick={() => toggleDir(repoId, path)}
          style={{ paddingLeft: `${indent}px`, ...heatBorderStyle }}
          title={dirMaxScore !== null ? `Max risk score: ${Math.round(dirMaxScore)}` : undefined}
          className="flex items-center gap-1.5 w-full text-left py-[3px] pr-2 text-sm text-gray-400 hover:text-gray-100 hover:bg-gray-800/60 rounded transition-colors"
          aria-expanded={isExpanded}
        >
          {/* chevron */}
          <svg
            className={`shrink-0 w-3 h-3 text-gray-600 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            viewBox="0 0 6 10"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M1 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {/* folder icon */}
          <svg className="shrink-0 w-4 h-4 text-blue-400/70" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            {isExpanded
              ? <path d="M1.5 3A1.5 1.5 0 0 0 0 4.5v8A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V6.5A1.5 1.5 0 0 0 14.5 5H8.414l-1.5-1.5H1.5z" />
              : <path d="M.54 3.87.5 3a2 2 0 0 1 2-2h3.672a2 2 0 0 1 1.414.586l.828.828A2 2 0 0 0 9.828 3h3.982a2 2 0 0 1 1.992 2.181l-.637 7A2 2 0 0 1 13.174 14H2.826a2 2 0 0 1-1.991-1.819l-.637-7a2 2 0 0 1 .342-1.31zM8 1H2.5a1 1 0 0 0-1 1l.006.017A4.97 4.97 0 0 1 3.982 2h5.845A2 2 0 0 0 8 1z" />
            }
          </svg>
          <span className="truncate text-xs font-medium">{name}</span>
          <span className="ml-auto shrink-0 text-[10px] text-gray-600">{node.fileCount}</span>
        </button>

        {isExpanded && (
          <div role="group" aria-label={name}>
            {sortedEntries(node.children).map(([childName, childNode]) => (
              <TreeNode
                key={childName}
                name={childName}
                node={childNode}
                path={`${path}/${childName}`}
                repoId={repoId}
                depth={depth + 1}
                onFileClick={onFileClick}
                coverageMap={coverageMap}
                heatScores={heatScores}
                heatMode={heatMode}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // ─── File leaf ───────────────────────────────────────────────────────────

  const coverageStatus = coverageMap?.get(path);
  const heatEntry = heatScores?.get(path);
  const fileScore = heatEntry && heatMode ? modeScore(heatEntry, heatMode) : null;

  const heatBorderStyle =
    fileScore !== null
      ? { borderLeftColor: heatColor(fileScore), borderLeftWidth: '2px', borderLeftStyle: 'solid' as const }
      : undefined;

  return (
    <button
      onClick={() => onFileClick(path)}
      style={{ paddingLeft: `${indent}px`, ...heatBorderStyle }}
      title={heatEntry ? heatTooltip(heatEntry) : undefined}
      className={`flex items-center gap-1.5 w-full text-left py-[3px] pr-2 text-sm rounded transition-colors ${
        isSelected
          ? 'bg-blue-900/50 text-blue-200'
          : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800/60'
      }`}
      aria-current={isSelected ? 'true' : undefined}
    >
      {/* spacer for chevron alignment */}
      <span className="w-3 shrink-0" aria-hidden="true" />
      <FileIcon name={name} />
      <span className="truncate text-xs">{name}</span>
      {coverageStatus && (
        <CoverageDot
          status={coverageStatus}
          title={`Coverage: ${coverageStatus}`}
        />
      )}
    </button>
  );
}

// ─── FileTree ─────────────────────────────────────────────────────────────────

export interface FileTreeProps {
  tree: Record<string, FileTreeNode>;
  repoId: string;
  onFileClick: (path: string) => void;
  /** Optional per-file coverage status, keyed by repo-relative file path. */
  coverageMap?: ReadonlyMap<string, CoverageStatus>;
  /** Optional heatmap scores, keyed by repo-relative file path. */
  heatScores?: ReadonlyMap<string, FileHeatScore>;
  /** Active heatmap mode (required when heatScores is provided). */
  heatMode?: HeatmapMode;
}

export function FileTree({
  tree,
  repoId,
  onFileClick,
  coverageMap,
  heatScores,
  heatMode,
}: FileTreeProps) {
  if (Object.keys(tree).length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-gray-600 text-sm">
        No files found
      </div>
    );
  }

  return (
    <div className="overflow-y-auto h-full scrollbar-thin py-1" role="tree" aria-label="File tree">
      {sortedEntries(tree).map(([name, node]) => (
        <TreeNode
          key={name}
          name={name}
          node={node}
          path={name}
          repoId={repoId}
          depth={0}
          onFileClick={onFileClick}
          coverageMap={coverageMap}
          heatScores={heatScores}
          heatMode={heatMode}
        />
      ))}
    </div>
  );
}
