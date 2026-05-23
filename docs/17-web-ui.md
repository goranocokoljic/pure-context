# Web UI — Reference

This is the reference page: build commands, configuration flags, keyboard shortcuts, heatmap metrics, and graph-viewer controls.

For the **user-friendly tour** — when to use the UI vs the chat, what each view is good for, workflow examples — see [`WEB-UI.md`](../WEB-UI.md) at the project root.

---

## Activating the UI

The UI is served by the same process as the MCP server, but only when HTTP transport is active:

```bash
purecontext-mcp --transport http --port 3000
# Web UI: http://localhost:3000
# MCP endpoint: http://localhost:3000/mcp/sse
```

The UI is pre-built into the npm package. For source builds:

```bash
npm run build:ui   # build only the UI
npm run build      # build everything
npm run dev        # watch mode: TypeScript + Vite dev server with HMR
```

---

## Configuration

| Field | Default | Description |
|-------|--------:|-------------|
| `webUI.enabled` | `true` | Set `false` to disable UI even in HTTP mode (API-only) |
| `webUI.theme` | `"system"` | `"light"` / `"dark"` / `"system"` default; users can override |
| `webUI.basePath` | `"/"` | Mount the UI under a subpath (e.g., `/purecontext`) |
| `webUI.maxGraphNodes` | `500` | Hard cap on graph viewer node count for performance |

When deployed behind a reverse proxy at a subpath, set `webUI.basePath` to match the proxy path.

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
| `T` | Toggle light/dark theme |

---

## Graph viewer

### Controls

| Action | Control |
|--------|---------|
| Pan | Click and drag background |
| Zoom | Scroll wheel |
| Fit to view | Double-click background |
| Select node | Click |
| Expand node | Click `+` |
| Forward walk | Enable "Dependencies" mode |
| Reverse walk | Enable "Importers" mode |

### Layouts

| Layout | Behavior |
|--------|----------|
| Force-directed (default) | Physics simulation; nodes cluster by connectivity |
| Hierarchical | Root at top, dependencies flow downward |
| Radial | Selected node at center; connected nodes radiate outward |

### Filters and overlays

| Feature | Description |
|---------|-------------|
| Depth slider | Traversal depth 1–5 hops |
| Language filter | Show only nodes of a specific language |
| Kind filter | Show only files/symbols of a specific kind |
| Cycle detection | Highlight circular dependency cycles in red |
| Blast-radius mode | Color gradient: red (direct impact) → yellow (indirect) |
| Export | Save graph as SVG or PNG |
| Minimap | Overview panel for large graphs |

---

## Architecture heatmap

Color-codes files by a chosen metric.

| Metric | Color scale | Source |
|--------|-------------|--------|
| Churn | blue (stable) → red (high churn) | git log history |
| Complexity | green → orange → red | per-file cyclomatic complexity |
| Quality score | green (high) → red (low) | aggregated metrics |
| Test coverage | green (covered) → red (uncovered) | uploaded lcov file |

---

## Test coverage upload

The coverage overlay needs an lcov-format report:

1. Run your test suite with coverage output (`vitest --coverage`, `pytest --cov`, `jest --coverage`, etc.)
2. Export as lcov: typical output paths are `coverage/lcov.info` or `coverage.info`
3. In the UI: Settings → Coverage → Upload lcov file

Coverage data is stored per workspace and persists across UI sessions.

---

## URL conventions

| Pattern | Purpose |
|---------|---------|
| `/r/:repoId` | Repository home |
| `/r/:repoId/f/:filePath` | File outline |
| `/r/:repoId/s/:symbolId` | Symbol viewer |
| `/r/:repoId/s/:symbolId#L42` | Symbol viewer with line anchor |
| `/r/:repoId/graph?root=:symbolId&depth=3` | Graph viewer with preset |
| `/r/:repoId/heatmap?metric=churn` | Heatmap with preset metric |

URLs are stable — link them in PR descriptions or share with teammates.

---

## Related reference

- [Transport Modes](14-transport-modes.md) — required HTTP setup for UI to activate
- [Git & History Integration](18-git-history.md) — powers the symbol timeline and churn heatmap
- [Configuration](04-configuration.md) — full `webUI.*` schema
