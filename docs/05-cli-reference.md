# CLI Reference


## Synopsis

```
purecontext-mcp [command] [options]
npx purecontext-mcp [command] [options]
```

## Commands

### (default — no command)

Start the MCP server. The default transport is `stdio` (for Claude Code).

```bash
purecontext-mcp
purecontext-mcp --transport http --port 3001
purecontext-mcp --transport both
```

CLI flags override the corresponding `config.json` fields.

### `config`

Manage configuration.

```bash
# Generate ~/.purecontext/config.json with defaults and comments
purecontext-mcp config --init

# Validate config + check all prerequisites (grammars, DB, API keys)
purecontext-mcp config --check

# Print effective configuration as JSON (defaults merged with overrides)
purecontext-mcp config
```

### `install`

Set up PureContext for an AI tool: write its workflow-rules/instructions file **and** register the `purecontext-mcp` MCP server so its tools are actually available (not merely referenced by the rules). The server is pinned to your global Node — see [MCP server registration](#mcp-server-registration) below.

```bash
# Auto-detect installed tools and set up each
npx purecontext-mcp install all

# Install for a specific tool
npx purecontext-mcp install cursor
npx purecontext-mcp install windsurf
npx purecontext-mcp install continue
npx purecontext-mcp install cline
npx purecontext-mcp install roo-code
npx purecontext-mcp install copilot
npx purecontext-mcp install claude
npx purecontext-mcp install claude-desktop
```

When no `--scope` flag is given, the CLI prompts interactively:

```
Where should PureContext be installed?
  1) Local  — this project only
  2) Global — all projects (user-level config)
  3) Both
```

Pass `--scope` to skip the prompt:

```bash
npx purecontext-mcp install all --scope=global   # user-level for all IDEs
npx purecontext-mcp install cursor --scope=both  # project + home dir
npx purecontext-mcp install all --scope=local    # this project only
```

Useful flags:

```bash
npx purecontext-mcp install --list              # show detection state, write nothing
npx purecontext-mcp install all --dry-run       # preview which writers would run
npx purecontext-mcp install all --scope=global  # install globally without prompt
```

**Rules/instructions file per tool:**

| Tool | Local | Global |
|------|-------|--------|
| `claude` | `CLAUDE.md` in project | `~/.claude/CLAUDE.md` + hooks |
| `cursor` | `.cursor/rules/purecontext.mdc` | `~/.cursor/rules/purecontext.mdc` |
| `windsurf` | `.windsurf/rules/purecontext.md` | `~/.windsurf/rules/purecontext.md` |
| `continue` | `.continue/config.json` | `~/.continue/config.json` |
| `cline` | `.clinerules` | local only (no global path) |
| `roo-code` | `.roo/rules-code.md` | local only (no global path) |
| `copilot` | `.github/copilot-instructions.md` | local only (no global path) |
| `claude-desktop` | always global | always global |

These writers are idempotent: re-running updates the marked block in place without touching anything outside it.

#### MCP server registration

Besides the rules file, `install` registers the `purecontext-mcp` server with each agent so its tools are actually available. The server command is **pinned to your global/default Node** (Volta's default, else the system Node), independent of any project's Node pin, so it works in every project. Registration is at user scope and merges into existing config (other servers are preserved):

| Tool | MCP config written |
|------|--------------------|
| `claude` | `claude mcp add --scope user` (`--scope local` for a `--scope=local` install) |
| `claude-desktop` | `claude_desktop_config.json` |
| `cursor` | `~/.cursor/mcp.json` |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` |
| `cline` | VS Code `globalStorage/.../cline_mcp_settings.json` |
| `roo-code` | VS Code `globalStorage/.../mcp_settings.json` |
| `continue` | `~/.continue/config.yaml` (`mcpServers` list) |
| `copilot` | VS Code user `mcp.json` (`servers` map, `"type": "stdio"`) |

For `claude`, registration uses the `claude` CLI (falling back to printing the command if it isn't on PATH). For `cline`, `roo-code`, `continue`, and `copilot` — whose config locations vary by editor and version — `install` writes only when the target config/dir already exists; otherwise it prints the entry to add manually rather than guess a path. Set `PCTX_SKIP_MCP_REGISTER=1` to skip server registration (rules only).

### `hooks`

Install or inspect Claude Code hook registrations.

```bash
# Register all PureContext hooks in ~/.claude/settings.json
npx purecontext-mcp hooks --install

# List current hook registration status
npx purecontext-mcp hooks --list
```

Hooks are registered as CLI commands in `~/.claude/settings.json`. Re-running `--install` is safe — it replaces existing PureContext entries (including any old `.mjs`-path style entries from earlier versions) while leaving other tools' hooks untouched.

### `hook-*` (Claude Code hook handlers)

These are the hook handlers invoked by Claude Code. They are not meant to be called directly; they are registered by `hooks --install` and executed automatically by Claude Code as events fire.

| Command | Hook event | What it does |
|---------|-----------|--------------|
| `hook-posttooluse` | `PostToolUse` | Re-indexes files modified by Edit/Write/MultiEdit |
| `hook-pretooluse` | `PreToolUse` | Soft edit guard — suggests read tools before editing |
| `hook-precompact` | `PreCompact` | Injects the list of indexed repos before context compaction |
| `hook-worktree-create` | `WorktreeCreate` | Auto-indexes a newly created agent worktree |
| `hook-worktree-remove` | `WorktreeRemove` | Fires when an agent worktree is removed (no-op, reserved) |
| `hook-taskcompleted` | `TaskCompleted` | Post-task diagnostics: complexity hotspots, TODO count, tool suggestions |
| `hook-subagentstart` | `SubagentStart` | Injects condensed repo orientation for newly spawned subagents |

All handlers read from stdin (the JSON payload Claude Code sends) and write a `systemMessage` JSON object to stdout when they have context to inject. They always exit 0 and never block tool execution.

### `keys`

Manage API keys for hosted deployments.

```bash
# Create a key for a tenant/workspace
purecontext-mcp keys create --tenant <tenantId> --permissions read,write --label "alice-laptop"

# List keys for a tenant
purecontext-mcp keys list --tenant <tenantId>

# Revoke a key by prefix
purecontext-mcp keys revoke <key-prefix>
```

## Global options

| Flag | Default | Description |
|------|---------|-------------|
| `--version` | — | Print version and exit |
| `--help` | — | Print help and exit |
| `--log-level` | `info` | Log verbosity: `debug`, `info`, `warn`, `error` |
| `--config <path>` | `~/.purecontext/config.json` | Path to config file |
| `--transport` | `stdio` | `stdio`, `http`, or `both` |
| `--port <n>` | `3000` | HTTP port (overrides `http.port`) |
| `--host <addr>` | `127.0.0.1` | Bind address (overrides `http.host`) |

## Health check

```bash
purecontext-mcp --health
```

Checks server health without starting the MCP server. Output is JSON:

```json
{
  "status": "ok",
  "version": "1.2.0",
  "uptime": 0,
  "nodeVersion": "20.11.0",
  "platform": "linux",
  "indexDir": "/home/user/.purecontext/indexes",
  "repoCount": 3,
  "grammars": {
    "tree-sitter-typescript.wasm": true,
    "tree-sitter-javascript.wasm": true
  }
}
```

If anything is wrong, the corresponding field is `false` and the exit code is non-zero.

HTTP health check (when running in server mode):

```bash
curl http://localhost:3000/health
```

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Configuration error |
| `2` | Fatal startup error (missing grammar, SQLite failure, etc.) |

## Examples

```bash
# Start MCP server for Claude Code (default)
purecontext-mcp

# Start HTTP server for Web UI or team use
purecontext-mcp --transport http --port 3000

# Start both stdio and HTTP simultaneously (development)
purecontext-mcp --transport both

# Generate a config file
purecontext-mcp config --init

# Validate everything before deploying
purecontext-mcp config --check

# Debug startup issues
purecontext-mcp --log-level debug

# Check health without starting the server
purecontext-mcp --health
```
