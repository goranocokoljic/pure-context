# Installation


## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | >= 18.0.0 | 18, 20, and 22 are tested |
| npm | >= 9.0.0 | Ships with Node 18+ |
| Git | any | Required only for `index_repo` (remote repo cloning) |

## Install via npm (recommended)

```bash
npm install -g purecontext-mcp
```

After this, `purecontext-mcp` is available as a global command.

If you prefer not to install globally, use `npx` to run without installing:

```bash
npx purecontext-mcp
```

`npx` downloads the package on first use and caches it. This is the recommended approach for most AI client integrations because it picks up new versions automatically without a manual upgrade step.

## Prebuilt binaries

PureContext uses `better-sqlite3` for SQLite access. Pre-built native binaries are bundled for:

| Platform | Node 18 | Node 20 | Node 22 |
|----------|---------|---------|---------|
| Windows x64 | ✓ | ✓ | ✓ |
| macOS x64 | ✓ | ✓ | ✓ |
| macOS arm64 | ✓ | ✓ | ✓ |
| Linux x64 | ✓ | ✓ | ✓ |
| Linux arm64 | ✓ | ✓ | ✓ |

When a prebuilt binary matches your platform, `npm install` completes without any native compilation. No Python, no `node-gyp`, no build tools needed.

If your platform/Node combination is not in the table above, `npm install` will attempt a native compile. You will need:
- Python 3.x
- A C++ compiler (MSVC on Windows, clang/gcc on macOS/Linux)
- `node-gyp`: `npm install -g node-gyp`

---

## Connecting to your AI client

PureContext works with any MCP-compatible AI client. Choose the setup that matches your environment.

### Claude Code (CLI)

```bash
claude mcp add purecontext-mcp -- npx purecontext-mcp
```

Verify:

```bash
claude mcp list
# purecontext-mcp   connected   npx purecontext-mcp
```

### Claude Desktop

Edit `~/.claude/claude_desktop_config.json` (create it if it doesn't exist):

```json
{
  "mcpServers": {
    "purecontext": {
      "command": "npx",
      "args": ["purecontext-mcp"]
    }
  }
}
```

If you installed globally (`npm install -g purecontext-mcp`), you can use the binary directly:

```json
{
  "mcpServers": {
    "purecontext": {
      "command": "purecontext-mcp"
    }
  }
}
```

Restart Claude Desktop after saving the file.

### Cursor

Create or edit `.cursor/mcp.json` in your project directory for a project-scoped connection, or `~/.cursor/mcp.json` for a global one:

```json
{
  "mcpServers": {
    "purecontext": {
      "command": "npx",
      "args": ["purecontext-mcp"]
    }
  }
}
```

Reload the Cursor window after saving (`Ctrl+Shift+P` → "Developer: Reload Window").

### Windsurf

Open Windsurf Settings and navigate to the MCP section, or edit the MCP configuration file directly:

```json
{
  "mcpServers": {
    "purecontext": {
      "command": "npx",
      "args": ["purecontext-mcp"]
    }
  }
}
```

### VS Code (with MCP support)

Create `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "purecontext": {
      "type": "stdio",
      "command": "npx",
      "args": ["purecontext-mcp"]
    }
  }
}
```

### Connecting to a shared team server (HTTP)

If your team runs a shared PureContext server, connect with an HTTP transport instead of launching a local process. The config format is the same across all clients — only the transport section changes:

**Claude Code CLI:**

```bash
claude mcp add purecontext-shared \
  --transport http \
  --url https://purecontext.yourcompany.com/mcp/sse \
  --header "Authorization: Bearer pctx_yourpersonalkey"
```

**Claude Desktop / Cursor / Windsurf (config file):**

```json
{
  "mcpServers": {
    "purecontext": {
      "transport": "http",
      "url": "https://purecontext.yourcompany.com/mcp/sse",
      "headers": {
        "Authorization": "Bearer pctx_yourpersonalkey"
      }
    }
  }
}
```

Your API key is issued by your team's PureContext administrator. See [Team Setup](15-team-setup.md) for how to deploy and manage a shared server.

---

## Teaching your AI agent to use PureContext well

Installing PureContext gives your AI agent access to the tools. Adding the agent instructions tells it *how* to use them efficiently — which tool to pick for each situation, in what order to call them, and what patterns to avoid.

Without them, an AI agent given access to PureContext may default to reading entire files (wasting tokens) rather than using `search_symbols`, or may not know to call `list_repos` first to get the `repoId` required by every tool. The instructions encode the correct workflow: check if indexed → search by name or meaning → retrieve source only for what you'll use.

### Recommended: `purecontext-mcp install`

PureContext ships with a multi-IDE installer that writes the workflow rules into the conventions file each tool expects. Run it once inside your project root:

```bash
npx purecontext-mcp install all
```

This auto-detects which AI tools are configured in the project (by looking for marker files such as `.cursor/`, `.windsurfrules`, `CLAUDE.md`, `.continue/`, etc.) and installs the rules for each.

When no `--scope` flag is given, the CLI prompts you to choose where to install:

```
Where should PureContext be installed?
  1) Local  — this project only
  2) Global — all projects (user-level config)
  3) Both
```

Pass `--scope` to skip the prompt:

```bash
npx purecontext-mcp install all --scope=local    # this project only
npx purecontext-mcp install all --scope=global   # user-level, all projects
npx purecontext-mcp install all --scope=both     # both places at once
```

For a single tool:

```bash
npx purecontext-mcp install cursor --scope=global
npx purecontext-mcp install windsurf
npx purecontext-mcp install continue
# ...etc.
```

Useful flags:

```bash
npx purecontext-mcp install --list           # show detection state, write nothing
npx purecontext-mcp install all --dry-run    # preview which writers would run
```

### Supported tools

| Tool | Local | Global | Notes |
|------|-------|--------|-------|
| `claude` | `CLAUDE.md` in project | `~/.claude/CLAUDE.md` + hooks | Global registers seven hook events — see [Claude Code hooks](#claude-code-hooks) below. |
| `cursor` | `.cursor/rules/purecontext.mdc` | `~/.cursor/rules/purecontext.mdc` | MDC frontmatter with `alwaysApply: true`. |
| `windsurf` | `.windsurfrules` | `~/.windsurfrules` | Marked block appended or replaced in place. |
| `continue` | `.continue/config.json` | `~/.continue/config.json` | JSON-aware merge; other fields are preserved. |
| `cline` | `.clinerules` | local only | No known global config path. |
| `roo-code` | `.roo/rules-code.md` | local only | No known global config path. |
| `vscode` | `.github/copilot-instructions.md` | local only | Picked up by GitHub Copilot in VS Code. |
| `claude-desktop` | always global | always global | Merges MCP server entry; leaves other servers untouched. |

### Claude Code hooks

When you run `npx purecontext-mcp install claude` (or the standalone `npx purecontext-mcp hooks --install`), PureContext registers seven hook events in `~/.claude/settings.json`. Each hook is a CLI-style command — no scripts are copied to `~/.claude/hooks/`; the hook logic lives inside the installed package and updates automatically when you upgrade.

| Hook event | Command | What it does |
|------------|---------|--------------|
| `PostToolUse` | `hook-posttooluse` | Re-indexes files modified by Edit/Write/MultiEdit |
| `PreToolUse` | `hook-pretooluse` | Soft edit guard — suggests read tools before editing unread files |
| `PreCompact` | `hook-precompact` | Injects the list of indexed repos before context is compacted |
| `WorktreeCreate` | `hook-worktree-create` | Auto-indexes a newly created agent worktree |
| `WorktreeRemove` | `hook-worktree-remove` | Fires when an agent worktree is removed (reserved for cleanup) |
| `TaskCompleted` | `hook-taskcompleted` | Post-task diagnostics: complexity hotspots, TODO count, suggested tools |
| `SubagentStart` | `hook-subagentstart` | Injects a condensed repo orientation for newly spawned subagents |

Running `hooks --install` more than once is safe. It replaces existing PureContext entries (including old `.mjs`-path style entries from versions prior to 1.8.0) while leaving other tools' hooks untouched.

To see the current registration status without making changes:

```bash
npx purecontext-mcp hooks --list
```

### Idempotency

Every writer is safe to re-run. The Markdown writers wrap their content in HTML comment markers:

```html
<!-- purecontext-mcp-start -->
... PureContext workflow rules ...
<!-- purecontext-mcp-end -->
```

On re-run, the marked block is replaced in place. Anything outside the markers (your own rules, other tools' rules) is preserved. The JSON writers (`continue`, `claude-desktop`) parse and merge structurally rather than re-emitting the whole file.

### Manual install (if you'd rather paste)

The two source-of-truth files are at the repository root:

- **`AGENT_INSTRUCTIONS_SHORT.md`** — Compact (~2 KB). Mandatory first step, tool selection table, core rules, common usage patterns. Use for agents with limited system prompt space.
- **`AGENT_INSTRUCTIONS.md`** — Full (~15 KB). Adds parameter notes, every usage pattern, known limitations, decision trees, anti-patterns. Use for complex multi-step workflows.

To use these manually:

```bash
# Claude Code
cat AGENT_INSTRUCTIONS_SHORT.md >> CLAUDE.md

# Cursor — paste into .cursorrules or via Cursor Settings → Rules
# Windsurf — paste into .windsurfrules or workspace memory
# Anything else — paste into whatever rule/memory config it supports
```

---

## Verifying the installation

```bash
purecontext-mcp --version
# 1.x.x

purecontext-mcp config --check
# ✓ Node.js 20.11.0
# ✓ SQLite (better-sqlite3 9.x)
# ✓ Grammar: tree-sitter-typescript.wasm
# ✓ Grammar: tree-sitter-javascript.wasm
# ... (all 34 grammars)
# ✓ Config: ~/.purecontext/config.json
```

`config --check` validates the installation, verifies all grammar files are present, and reports the effective configuration.

## Upgrading

Run the command that matches how you installed PureContext:

**Installed with Volta:**
```bash
volta install purecontext-mcp
```

**Installed with npm globally:**
```bash
npm install -g purecontext-mcp@latest
```

**Running via npx (no global install):** npx may serve a cached older version. Force the latest:
```bash
npx purecontext-mcp@latest
```
To always get the latest version automatically, use `purecontext-mcp@latest` in your MCP client config instead of the bare package name.

**Installed from source:**
```bash
cd /path/to/purecontext-mcp
git pull
npm install
npm run build
```

> **Note:** `npm update -g purecontext-mcp` does not work reliably — use `npm install -g purecontext-mcp@latest` instead.

Index files (SQLite databases) are forward-compatible within a major version. After upgrading from `1.x` to `1.y`, existing indexes continue to work. A major version upgrade (e.g., `1.x` → `2.0`) may require a re-index — the CLI will warn if it detects an incompatible index version.

## Install from source

Use this when contributing, testing unreleased features, or running a local build.

```bash
git clone <repository-url> purecontext-mcp
cd purecontext-mcp
npm install
npm run build
npm link   # makes 'purecontext-mcp' available globally from this build
```

## Uninstalling

```bash
npm uninstall -g purecontext-mcp
```

This removes the binaries. Index files and configuration are not removed. To clean everything up:

```bash
rm -rf ~/.purecontext   # Removes indexes, config, savings stats
```
