import type { FileTreeNode } from '../api/types.js';
import { useRepoStore } from '../stores/repoStore.js';

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
}

function TreeNode({ name, node, path, repoId, depth, onFileClick }: TreeNodeProps) {
  // Avoid returning `new Set()` from a selector — it creates a new reference
  // each render and causes infinite re-renders via Zustand's shallow comparison.
  const expandedDirs = useRepoStore((s) => s.expandedDirs[repoId]);
  const toggleDir = useRepoStore((s) => s.toggleDir);
  const selectedFilePath = useRepoStore((s) => s.selectedFilePath);

  const indent = 8 + depth * 14;
  const isExpanded = node.type === 'dir' && (expandedDirs?.has(path) ?? false);
  const isSelected = node.type === 'file' && selectedFilePath === path;

  if (node.type === 'dir') {
    return (
      <div>
        <button
          onClick={() => toggleDir(repoId, path)}
          style={{ paddingLeft: `${indent}px` }}
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
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // ─── File leaf ───────────────────────────────────────────────────────────

  return (
    <button
      onClick={() => onFileClick(path)}
      style={{ paddingLeft: `${indent}px` }}
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
    </button>
  );
}

// ─── FileTree ─────────────────────────────────────────────────────────────────

export interface FileTreeProps {
  tree: Record<string, FileTreeNode>;
  repoId: string;
  onFileClick: (path: string) => void;
}

export function FileTree({ tree, repoId, onFileClick }: FileTreeProps) {
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
        />
      ))}
    </div>
  );
}
