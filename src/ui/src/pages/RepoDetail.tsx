import { useEffect, useState, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api, ApiClientError } from '../api/client.js';
import { useRepoStore } from '../stores/repoStore.js';
import { FileTree } from '../components/FileTree.js';
import { FileOutline } from '../components/FileOutline.js';
import type { RepoMeta, FileSummary } from '../api/types.js';

// ─── Breadcrumb ───────────────────────────────────────────────────────────────

function Breadcrumb({ repo, selectedFile }: { repo: RepoMeta; selectedFile: string | null }) {
  const name = repo.rootPath.split(/[/\\]/).pop() ?? repo.repoId;
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-gray-500 min-w-0">
      <Link to="/" className="hover:text-gray-300 transition-colors shrink-0">
        Repos
      </Link>
      <span aria-hidden="true" className="text-gray-700">/</span>
      <span className={`truncate ${selectedFile ? 'hover:text-gray-300 cursor-pointer' : 'text-gray-300'}`}>
        {name}
      </span>
      {selectedFile && (
        <>
          <span aria-hidden="true" className="text-gray-700 shrink-0">/</span>
          <span className="text-gray-300 truncate text-xs font-mono">{selectedFile}</span>
        </>
      )}
    </nav>
  );
}

// ─── Stat chip ────────────────────────────────────────────────────────────────

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center px-4 py-2 bg-gray-800/50 rounded-lg border border-gray-700/50">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="text-lg font-bold text-gray-100 mt-0.5">{value}</span>
    </div>
  );
}

// ─── Stats bar ────────────────────────────────────────────────────────────────

function RepoStats({ repo }: { repo: RepoMeta }) {
  const lastIndexed = new Date(repo.lastIndexed).toLocaleString();
  return (
    <div className="flex flex-wrap items-center gap-3 px-6 py-3 border-b border-gray-800 bg-gray-900/50">
      <StatChip label="Symbols" value={repo.symbolCount.toLocaleString()} />
      <StatChip label="Files" value={repo.fileCount.toLocaleString()} />
      <Link
        to={`/repos/${encodeURIComponent(repo.repoId)}/graph`}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-300 transition-colors"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <circle cx="2" cy="6" r="1.5" fill="currentColor" />
          <circle cx="10" cy="2" r="1.5" fill="currentColor" />
          <circle cx="10" cy="10" r="1.5" fill="currentColor" />
          <line x1="3.5" y1="5.2" x2="8.5" y2="2.8" stroke="currentColor" strokeWidth="1" />
          <line x1="3.5" y1="6.8" x2="8.5" y2="9.2" stroke="currentColor" strokeWidth="1" />
        </svg>
        Dep Graph
      </Link>
      <div className="ml-auto text-xs text-gray-600 hidden sm:block">
        Last indexed: <span className="text-gray-500">{lastIndexed}</span>
      </div>
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function TreeSkeleton() {
  return (
    <div className="p-3 space-y-1.5 animate-pulse">
      {[80, 65, 90, 55, 70, 45, 75].map((w, i) => (
        <div key={i} className="h-5 bg-gray-800 rounded" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

// ─── Error banner ─────────────────────────────────────────────────────────────

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="m-3 p-3 bg-red-950 border border-red-800 rounded text-red-300 text-sm">
      {message}
    </div>
  );
}

// ─── RepoDetail ───────────────────────────────────────────────────────────────

export default function RepoDetail() {
  const { id: repoId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // ─── Store ─────────────────────────────────────────────────────────────────

  const repos = useRepoStore((s) => s.repos);
  const reposLoaded = useRepoStore((s) => s.reposLoaded);
  const trees = useRepoStore((s) => s.trees);
  const outlines = useRepoStore((s) => s.outlines);
  const selectedFilePath = useRepoStore((s) => s.selectedFilePath);
  const setRepos = useRepoStore((s) => s.setRepos);
  const setTree = useRepoStore((s) => s.setTree);
  const setOutline = useRepoStore((s) => s.setOutline);
  const selectRepo = useRepoStore((s) => s.selectRepo);
  const selectFile = useRepoStore((s) => s.selectFile);

  // ─── Local state ───────────────────────────────────────────────────────────

  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineError, setOutlineError] = useState<string | null>(null);

  const repo = repos.find((r) => r.repoId === repoId);
  const tree = repoId ? trees[repoId] : undefined;
  const outline = repoId ? outlines[repoId] : undefined;

  // ─── Load repos list if not yet cached ─────────────────────────────────────

  useEffect(() => {
    if (reposLoaded || !repoId) return;
    api.listRepos().then((res) => setRepos(res.repos)).catch(() => {
      // Non-fatal: repo card will show generic info
    });
  }, [reposLoaded, repoId, setRepos]);

  // ─── Select repo in store ──────────────────────────────────────────────────

  useEffect(() => {
    if (repoId) selectRepo(repoId);
  }, [repoId, selectRepo]);

  // ─── Load file tree ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!repoId || tree) return;
    let cancelled = false;
    setTreeLoading(true);
    setTreeError(null);
    api.getFileTree(repoId)
      .then((res) => {
        if (!cancelled) {
          setTree(repoId, res);
          setTreeLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setTreeError(err instanceof ApiClientError ? err.message : String(err));
          setTreeLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [repoId, tree, setTree]);

  // ─── Load repo outline ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!repoId || outline) return;
    let cancelled = false;
    setOutlineLoading(true);
    setOutlineError(null);
    api.getRepoOutline(repoId)
      .then((res) => {
        if (!cancelled) {
          setOutline(repoId, res.files);
          setOutlineLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setOutlineError(err instanceof ApiClientError ? err.message : String(err));
          setOutlineLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [repoId, outline, setOutline]);

  // ─── File selection ────────────────────────────────────────────────────────

  const handleFileClick = useCallback((path: string) => {
    selectFile(path);
  }, [selectFile]);

  const handleSymbolClick = useCallback((symbolId: string) => {
    if (repoId) {
      navigate(`/symbols/${encodeURIComponent(symbolId)}?repoId=${encodeURIComponent(repoId)}`);
    }
  }, [repoId, navigate]);

  // ─── Derived: selected file summary ────────────────────────────────────────

  const selectedFileSummary: FileSummary | null = (() => {
    if (!selectedFilePath || !outline) return null;
    return outline.find((f) => f.filePath === selectedFilePath) ?? {
      filePath: selectedFilePath,
      symbols: [],
    };
  })();

  // ─── Guard: invalid repo id ────────────────────────────────────────────────

  if (!repoId) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        Invalid repository ID.
      </div>
    );
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="px-6 py-3 border-b border-gray-800 shrink-0 min-w-0">
        <Breadcrumb repo={repo ?? { repoId, rootPath: repoId, symbolCount: 0, fileCount: 0, lastIndexed: '' }} selectedFile={selectedFilePath} />
      </div>

      {/* Stats */}
      {repo && <RepoStats repo={repo} />}

      {/* Body: file tree + outline */}
      <div className="flex-1 flex overflow-hidden">
        {/* ── Left panel: file tree ── */}
        <div className="w-64 shrink-0 border-r border-gray-800 flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-800 shrink-0">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Files</span>
          </div>
          <div className="flex-1 overflow-hidden">
            {treeLoading && <TreeSkeleton />}
            {treeError && <ErrorBanner message={treeError} />}
            {!treeLoading && !treeError && tree && (
              <FileTree
                tree={tree.tree}
                repoId={repoId}
                onFileClick={handleFileClick}
              />
            )}
          </div>
        </div>

        {/* ── Right panel: symbol outline ── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-800 shrink-0">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Symbols</span>
            {outlineLoading && (
              <span className="ml-2 text-[10px] text-gray-600 animate-pulse">loading…</span>
            )}
          </div>
          <div className="flex-1 overflow-hidden">
            {outlineError && <ErrorBanner message={outlineError} />}
            {!outlineError && (
              <FileOutline
                fileSummary={selectedFileSummary}
                onSymbolClick={handleSymbolClick}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
