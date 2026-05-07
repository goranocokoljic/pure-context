import { Routes, Route, NavLink, useNavigate } from 'react-router-dom';
import { Suspense, lazy, useState } from 'react';
import { useThemeStore } from './stores/themeStore.js';
import { WorkspacePanel } from './components/WorkspacePanel.js';
import { useWorkspaceStore } from './stores/workspaceStore.js';

// ─── Lazy pages ───────────────────────────────────────────────────────────────

const RepoList = lazy(() => import('./pages/RepoList.js'));
const RepoDetail = lazy(() => import('./pages/RepoDetail.js'));
const Search = lazy(() => import('./pages/Search.js'));
const SymbolView = lazy(() => import('./pages/SymbolView.js'));
const DependencyGraph = lazy(() => import('./pages/DependencyGraph.js'));
const BlastRadius = lazy(() => import('./pages/BlastRadius.js'));
const NotFound = lazy(() => import('./pages/NotFound.js'));

// ─── Loading fallback ─────────────────────────────────────────────────────────

function PageSpinner() {
  return (
    <div className="flex items-center justify-center h-64 text-gray-500">
      <div className="flex gap-2 items-center">
        <div className="w-4 h-4 rounded-full bg-blue-500 animate-pulse" />
        <span className="text-sm">Loading…</span>
      </div>
    </div>
  );
}

// ─── Nav link styles ──────────────────────────────────────────────────────────

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded text-sm font-medium transition-colors ${
    isActive
      ? 'bg-blue-600 text-white'
      : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800'
  }`;

// ─── Grid (workspace) icon ────────────────────────────────────────────────────

function GridIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="1" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────

function Header({ onWorkspaceToggle }: { onWorkspaceToggle: () => void }) {
  const navigate = useNavigate();
  const pinnedCount = useWorkspaceStore((s) => s.pinnedRepos.length);

  return (
    <header className="h-14 border-b border-gray-800 flex items-center px-6 gap-6 shrink-0 bg-gray-900">
      <button
        onClick={() => navigate('/')}
        className="flex items-center gap-2 text-blue-400 font-bold text-lg hover:text-blue-300 transition-colors"
      >
        <PureContextLogo />
        PureContext
      </button>

      <nav className="flex items-center gap-1 ml-4">
        <NavLink to="/" end className={navLinkClass}>
          Repositories
        </NavLink>
        <NavLink to="/search" className={navLinkClass}>
          Search
        </NavLink>
        <NavLink to="/graph" className={navLinkClass}>
          Graph
        </NavLink>
        <NavLink to="/blast-radius" className={navLinkClass}>
          Blast Radius
        </NavLink>
      </nav>

      <div className="ml-auto flex items-center gap-2">
        {/* Workspace panel toggle */}
        <button
          type="button"
          onClick={onWorkspaceToggle}
          aria-label="Toggle workspace panel"
          title="Workspace"
          data-testid="workspace-toggle"
          className="relative p-1.5 rounded text-gray-400 hover:text-gray-100 hover:bg-gray-800 transition-colors"
        >
          <GridIcon />
          {pinnedCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-blue-600 text-white text-[8px] font-bold rounded-full flex items-center justify-center">
              {pinnedCount}
            </span>
          )}
        </button>
        <ThemeToggle />
      </div>
    </header>
  );
}

// ─── Theme toggle ─────────────────────────────────────────────────────────────

function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const toggle = useThemeStore((s) => s.toggle);

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      className="p-1.5 rounded text-gray-400 hover:text-gray-100 hover:bg-gray-800 transition-colors"
      data-testid="theme-toggle"
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <circle cx="7.5" cy="7.5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
      <line x1="7.5" y1="1"   x2="7.5" y2="3"   stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="7.5" y1="12"  x2="7.5" y2="14"  stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="1"   y1="7.5" x2="3"   y2="7.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="12"  y1="7.5" x2="14"  y2="7.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="3.05" y1="3.05" x2="4.46" y2="4.46" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="10.54" y1="10.54" x2="11.95" y2="11.95" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="11.95" y1="3.05" x2="10.54" y2="4.46" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="4.46"  y1="10.54" x2="3.05" y2="11.95" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path
        d="M12.5 8A5 5 0 0 1 7 2.5a5 5 0 0 0 0 10A5 5 0 0 0 12.5 8z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PureContextLogo() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="10" r="3" fill="currentColor" />
      <line x1="10" y1="2" x2="10" y2="5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="10" y1="15" x2="10" y2="18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="2" y1="10" x2="5" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="15" y1="10" x2="18" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Header onWorkspaceToggle={() => setWorkspaceOpen((o) => !o)} />
      <main className="flex-1 overflow-hidden">
        <Suspense fallback={<PageSpinner />}>
          <Routes>
            <Route path="/" element={<RepoList />} />
            <Route path="/repos/:id" element={<RepoDetail />} />
            <Route path="/search" element={<Search />} />
            <Route path="/symbols/:symbolId" element={<SymbolView />} />
            <Route path="/graph" element={<DependencyGraph />} />
            <Route path="/repos/:id/graph" element={<DependencyGraph />} />
            <Route path="/blast-radius" element={<BlastRadius />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </main>
      {workspaceOpen && (
        <WorkspacePanel onClose={() => setWorkspaceOpen(false)} />
      )}
    </div>
  );
}
