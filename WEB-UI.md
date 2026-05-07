# The Web UI

PureContext's primary interface is the AI agent — you talk to Claude and it calls the tools. But some questions are easier to answer visually than through conversation. The Web UI exists for those moments.

It runs in a browser alongside the MCP server and requires no separate installation — start the server in HTTP mode and open `http://localhost:3000`.

```bash
purecontext-mcp --transport http --port 3000
```

---

## When to use the UI instead of the chat

**The chat is better for:** Specific questions, targeted retrieval, workflows that need AI reasoning alongside code navigation. "Find the authentication logic and explain why the session expiry is set the way it is."

**The UI is better for:** Understanding the big picture, spotting patterns, navigating by clicking rather than typing, sharing a visual with your team, architecture reviews.

The two complement each other. Start a session in the chat to understand a specific feature, then open the UI to see where that feature sits in the larger dependency map.

---

## Repository browser

The sidebar lists every indexed repository with symbol counts, file counts, and language breakdown. Click a repository to open its file tree.

The file tree is collapsible and shows symbol counts per directory. Click any file to open its **symbol outline** — all symbols in the file with their signatures and summaries, like a live table of contents. Click any symbol to open its source.

This is the fastest way to get a feel for a module you haven't worked in before: expand the directory, scan the symbol outline, open the two or three symbols that seem most relevant.

---

## Symbol search

The search bar at the top is always available. Start typing and results appear within 300ms — no need to press Enter.

- **Keyword mode:** Searches symbol names and summaries. `processOrder` and `process order` return the same results.
- **Semantic mode:** Toggle to search by meaning. "function that validates credentials" finds relevant symbols even if none of them have "validate" or "credentials" in their name.
- **Filters:** Narrow by symbol kind (function, class, route, component, etc.) or file path pattern.

Results are navigable by keyboard: arrow keys to move, Enter to open. Query terms are highlighted in results so you can see why each result matched.

---

## Symbol viewer

Clicking any symbol opens a syntax-highlighted view of its source. The highlighter uses the same token definitions as VS Code — the rendering quality is the same as your editor.

The right panel shows three related sets:
- **Dependencies** — symbols this one imports, in order of relevance
- **Importers** — symbols that import this one (the blast radius, one level)
- **Same file** — other symbols defined in the same file

Clicking any of these navigates to that symbol. This lets you trace a dependency chain by clicking through the graph rather than running a series of queries.

URLs are shareable. Each symbol view has a stable URL — link a colleague directly to the function you want them to look at.

---

## Dependency graph viewer

The graph view renders the dependency relationships between files and symbols as a force-directed network. Nodes are files or symbols; edges are import relationships.

Open the graph viewer from any symbol with the **G** keyboard shortcut, or from the toolbar.

### Navigating the graph

| Action | How |
|--------|-----|
| Pan | Click and drag the background |
| Zoom | Scroll wheel |
| Fit everything in view | Double-click background |
| Select a node | Click it |
| Expand a node's connections | Click the **+** button on the node |
| Switch between dependency/importer view | Toggle in toolbar |

### Layout options

- **Force-directed** (default): Nodes cluster by how connected they are. Highly-connected files naturally cluster toward the center. Leaf nodes float outward. This reveals the structure of your codebase without any manual arrangement.
- **Hierarchical**: Root at top, dependencies flow downward. Clearer for trees with a single root.
- **Radial**: Selected node at center, connected nodes radiate out. Good for exploring one module's connections.

### Blast radius view

Switch to blast radius mode to see everything that depends on the selected node — color gradient from red (directly imports this) to yellow (transitively imports this). This is the visual equivalent of `get_blast_radius`, and it makes the scope of a change immediately legible in a way that a file list cannot.

**Practical use:** Before a code review or planning meeting, open the blast radius view for the symbols being changed. The visual immediately communicates whether this is a localized change or a cross-cutting concern.

### Depth control

The depth slider controls how many hops from the selected node are shown. At depth 1 you see direct connections. At depth 3 or 4 you see the full transitive graph. Large graphs at high depth can get dense — use the language and kind filters to focus on what matters.

### Cycle detection

Enable cycle detection to highlight circular dependencies in red. Circular dependencies are often a sign of architectural problems — modules that depend on each other can't be changed independently and are hard to test in isolation.

---

## Architecture heatmap

The heatmap overlays your file tree with color-coded quality signals. Select a metric from the dropdown and every file in the tree gets a color:

| Metric | What it shows |
|--------|--------------|
| **Churn** | Blue (stable) to red (high churn). High-churn files are actively changing or unstable. |
| **Complexity** | Green to red. Red files have high cyclomatic complexity — hard to understand and test. |
| **Quality score** | Green (healthy) to red (needs attention). Composite of complexity, coupling, and documentation coverage. |
| **Test coverage** | Green (well-covered) to red (uncovered). Requires uploading an lcov coverage report. |

Click any file cell in the heatmap to open its symbol outline. The heatmap is particularly effective for architecture reviews and sprint planning — it makes "where should we focus our technical debt effort?" a visual answer rather than a debate.

**Uploading test coverage:** Generate an lcov report from your test suite (`npx vitest --coverage`, `pytest --cov`, etc.) and upload it in Settings → Coverage. The coverage overlay then appears as an option in the heatmap dropdown.

---

## Symbol timeline

The symbol timeline shows a function's git history as a visual chart. Each commit that touched the symbol appears as a marker on the timeline.

Hover any marker to see the commit message, author, and date. Click to expand the diff for that function at that point — what lines were added, what were removed, what the function looked like before.

This is useful for three scenarios:

**Understanding why something is the way it is.** Follow the timeline backward. The function grew in a particular direction for a reason — the commit messages explain the decisions that accumulated over time.

**Finding when a bug was introduced.** Scan the timeline for changes around the date the bug was reported. The diff at that commit is usually the answer.

**Onboarding walkthroughs.** Show a new team member the history of a core function as a story — "here's where we started, here's when we added caching, here's when we refactored for the multi-region launch."

---

## Multi-repo workspace

When multiple repositories are indexed, the sidebar shows a repository switcher. The workspace view lists all repos with their key metrics. Cross-repo search results appear in a unified list with the source repository identified for each result.

This is particularly useful for microservices architectures or monorepos with multiple packages — you can search across the entire system from a single interface without switching contexts.

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

---

→ Reference: [Web UI](../docs/17-web-ui.md) — full feature reference including build instructions
