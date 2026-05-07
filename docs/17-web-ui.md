# Web UI


The Web UI provides a visual interface for exploring indexed codebases. It is served by the same process as the MCP server when HTTP transport is active.

---

## Accessing the Web UI

The Web UI is available at `http://localhost:3000` (or your server URL) when running in HTTP mode:

```bash
purecontext-mcp --transport http --port 3000
```

Then open `http://localhost:3000` in a browser.

### Building the UI

The UI is pre-built in the npm package. For development or rebuilding from source:

```bash
npm run build:ui   # build only the UI
npm run build      # build everything
npm run dev        # watch mode: TypeScript + Vite dev server with hot reload
```

---

## Repository browser

- List all indexed repositories with symbol counts, file counts, and language breakdown
- Collapsible file tree with file type icons
- Click any file to open its symbol outline

---

## Symbol search

- Real-time search with 300ms debounce — results appear as you type
- Filter by: symbol kind, language, file path pattern
- Keyboard navigation: arrow keys to move through results, Enter to open
- Query term highlighting in results
- Switches between keyword and semantic mode (if semantic search is enabled)

---

## Symbol viewer

- Syntax-highlighted source code (powered by Shiki — VS Code-quality highlighting)
- Line numbers with anchors (shareable URLs)
- Light/dark theme toggle (preference persisted in localStorage)
- **Related symbols panel**: importers, dependencies, same-file symbols

---

## Dependency graph viewer

An interactive force-directed graph of file and symbol dependencies.

### Controls

| Action | Control |
|--------|---------|
| Pan | Click and drag |
| Zoom | Scroll wheel |
| Fit to view | Double-click background |
| Select node | Click |
| Expand node | Click `+` |
| Forward walk | Enable "Dependencies" mode |
| Reverse walk | Enable "Importers" mode |

### Layout options

- **Force-directed** (default) — physics simulation, nodes cluster by connectivity
- **Hierarchical** — root at top, dependencies flow downward
- **Radial** — selected node at center, connected nodes radiate outward

### Depth slider

Adjust traversal depth (1–5 hops). Higher depth reveals transitive dependencies but may produce large graphs.

### Blast radius view

Switch to "Blast radius" mode to see everything that depends on the selected node — color gradient from red (direct impact) to yellow (indirect).

---

## Architecture heatmap

An overlay on the file tree that color-codes files by a selected metric:

| Metric | Color scale | Use case |
|--------|-------------|----------|
| Churn | blue (stable) → red (high churn) | Identify high-risk files before a refactor |
| Complexity | green → orange → red | Find over-complex files that need attention |
| Quality score | green (high) → red (low) | Prioritize technical debt |
| Test coverage | green (covered) → red (uncovered) | Requires external coverage report |

Click any cell in the heatmap to open the file's symbol outline.

---

## Symbol timeline

Per-symbol git history visualized as a timeline. Shows:
- When the symbol was created (first commit where it appears)
- Each commit that modified the symbol (with author, date, message)
- When the symbol was deleted (if applicable)

Requires git history integration enabled (see [Git & History Integration](18-git-history.md)).

---

## Test coverage overlay

Overlays test coverage data on the file tree. Requires an lcov-format coverage report:

1. Run your test suite with coverage output (`npx vitest --coverage`, `pytest --cov`, etc.)
2. Export as lcov: `coverage.info` / `lcov.info`
3. In PureContext Web UI: Settings → Coverage → Upload lcov file

Files are color-coded by coverage percentage. Click a file to see line-level coverage in the source viewer.

---

## Multi-repo workspace

When multiple repos are indexed, the sidebar shows a repo switcher. Cross-repo search results appear in a unified list with the source repo identified for each result.

---

## Advanced graph controls

Additional controls available in the graph viewer:

| Feature | Description |
|---------|-------------|
| Language filter | Show only nodes of a specific language |
| Kind filter | Show only files/symbols of a specific kind |
| Cycle detection | Highlight circular dependency cycles in red |
| Export | Save graph as SVG or PNG |
| Minimap | Overview panel for large graphs |

---

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `/` | Focus search bar |
| `↑` / `↓` | Navigate search results |
| `Enter` | Open selected symbol |
| `Esc` | Close panels / clear search |
| `G` | Open graph view for current symbol |
| `B` | Show blast radius for current symbol |
| `H` | Toggle heatmap overlay |
