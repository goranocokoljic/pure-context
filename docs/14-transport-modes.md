# Transport Modes


PureContext supports two transport modes: **stdio** (local, default) and **HTTP/SSE** (team/cloud).

## stdio transport (default)

The standard transport for Claude Code and other MCP-native clients.

```bash
purecontext-mcp
```

Claude Code spawns `purecontext-mcp` as a child process and communicates over stdin/stdout using the JSON-RPC MCP protocol. No network, no authentication required.

**Claude Code setup:**

```bash
# Using npx (recommended)
claude mcp add purecontext-mcp -- npx purecontext-mcp

# Using global install
claude mcp add purecontext-mcp purecontext-mcp
```

**Best for:** Individual developers, local development, any situation where security and simplicity matter more than sharing.

## HTTP / SSE transport

For browser-based clients, remote development, or multi-client setups.

```bash
purecontext-mcp --transport http --port 3000
```

Or via `config.json`:

```json
{
  "transport": "http",
  "http": {
    "port": 3000,
    "host": "127.0.0.1",
    "corsOrigins": ["http://localhost:*"]
  }
}
```

**HTTP endpoints:**

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Server health check (always public) |
| `POST /mcp/sse` | MCP Streamable HTTP endpoint |
| `GET /` | Web UI (served when UI is built) |
| `GET /admin/*` | Admin API (requires admin key) |

**Connect Claude Code to an HTTP server:**

```json
// ~/.claude/claude_desktop_config.json
{
  "mcpServers": {
    "purecontext": {
      "transport": "http",
      "url": "http://localhost:3000/mcp/sse"
    }
  }
}
```

Or via CLI:

```bash
claude mcp add purecontext-remote \
  --transport http \
  --url https://purecontext.mycompany.com/mcp/sse \
  --header "Authorization: Bearer pctx_yourkey"
```

**Best for:** Team deployments, shared index, CI pipelines, Web UI access.

## Both transports simultaneously (development)

Run stdio and HTTP at the same time — useful during development to test the HTTP API while still using Claude Code via stdio:

```bash
purecontext-mcp --transport both
```

## Choosing a transport

| Scenario | Recommended transport |
|----------|-----------------------|
| Solo developer, local project | `stdio` |
| Team with shared codebase | `http` (server) |
| CI pipeline | `http` or `stdio` with cached index |
| Web UI access | `http` |
| Testing both simultaneously | `both` |

## Authentication in HTTP mode

When binding to a non-loopback address, always enable authentication:

```json
{
  "http": {
    "host": "0.0.0.0",
    "auth": {
      "enabled": true,
      "token": "${PURECONTEXT_API_TOKEN}"
    }
  }
}
```

If `token` is empty and `enabled` is `true`, a random 32-byte hex token is generated at startup and printed to stderr. Save it immediately — it is not persisted to disk.

All MCP requests must include:

```
Authorization: Bearer <token>
```

A warning is logged at startup if the server is bound to a non-loopback address with authentication disabled.

## TLS / HTTPS

PureContext does not terminate TLS itself. Put it behind a reverse proxy for HTTPS in production.

**nginx example:**

```nginx
server {
    listen 443 ssl;
    server_name purecontext.mycompany.com;

    ssl_certificate     /etc/letsencrypt/live/purecontext.mycompany.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/purecontext.mycompany.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection keep-alive;
        proxy_set_header Host $host;
        # Disable buffering for SSE
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

**Caddy example:**

```
purecontext.mycompany.com {
    reverse_proxy localhost:3000 {
        flush_interval -1
    }
}
```

## SSE keepalive

The HTTP server sends a `: ping` comment over the SSE stream every 30 seconds to keep connections alive through proxies and load balancers. If your proxy has a shorter idle timeout than 30 seconds, increase it (e.g., `proxy_read_timeout 3600s` in nginx).
