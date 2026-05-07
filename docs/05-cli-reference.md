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
