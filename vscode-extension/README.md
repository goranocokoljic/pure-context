# PureContext VS Code Extension

Inline code intelligence powered by PureContext MCP — symbol outline, blast radius on hover, and quick symbol search, directly in your editor.

## Features

### Symbol Outline (Explorer sidebar)
Opens a **PureContext Outline** panel in the Explorer sidebar that lists every indexed symbol in the active file, grouped by kind. Click any symbol to jump to its definition.

### Hover Info
Hover over any function, class, or method name to see:
- Its **signature** and **summary** from the PureContext index
- **Blast radius** — how many files depend on it
- A link to the full blast radius view in the Web UI

### Quick Symbol Search
**Command Palette → PureContext: Search Symbols** (or `Ctrl+Shift+P` / `Cmd+Shift+P`)

Opens a debounced search across all indexed symbols in the current repo. Select a result to jump to it.

## Requirements

The PureContext server must be running before the extension can function. Start it with:

```bash
npx purecontext-mcp --server   # HTTP server mode
# or
npx purecontext-mcp            # stdio MCP mode (does not expose REST API)
```

The extension uses the REST API, so `--server` mode (Port 3000 by default) is required.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `purecontext.serverUrl` | `http://localhost:3000` | URL of the running PureContext server |
| `purecontext.repoId` | *(auto-detect)* | Override the repo ID. Leave blank to auto-detect from workspace path |
| `purecontext.enableHover` | `true` | Show symbol info on hover |
| `purecontext.enableOutline` | `true` | Show symbol outline in Explorer sidebar |

## Graceful Degradation

When the PureContext server is not running, the extension:
- Shows **PureContext: offline** in the status bar
- Disables hover and outline silently (no errors)
- Re-enables automatically when the server comes back online

## Building from Source

```bash
cd vscode-extension
npm install
npm run build
# Install the VSIX locally:
vsce package
code --install-extension purecontext-vscode-1.0.0.vsix
```

## Publishing

```bash
cd vscode-extension
vsce publish
```

Requires a Personal Access Token from the VS Code Marketplace. The extension is published as `purecontext.purecontext-vscode`.
