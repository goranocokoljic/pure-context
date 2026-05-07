# Team Setup & Multi-Tenant


Run PureContext as a shared server so your whole team queries the same index — no per-developer re-indexing.

---

## Overview

```
Local mode:                        Server mode (shared):
  Claude Code (each dev)             Claude Code (each dev)
      ↓ stdio                            ↓ HTTP + API key
  PureContext (local)                PureContext (shared server)
      ↓                                  ↓
  Local SQLite index             Shared SQLite index(es)
```

**Why a shared server?** Each developer re-indexes the same codebase independently in local mode. A shared server indexes once and serves all team members — consistent results and no redundant work.

---

## Step 1 — Deploy the server

### Docker (recommended)

```bash
mkdir -p ./purecontext-data

docker run -d \
  --name purecontext \
  -p 3000:3000 \
  -v "$(pwd)/purecontext-data:/data" \
  -e PCTX_ADMIN_KEY="$(openssl rand -hex 32)" \
  --restart unless-stopped \
  purecontext/purecontext-mcp:latest
```

Note your `PCTX_ADMIN_KEY` — you need it to manage workspaces and keys.

### Docker Compose

```yaml
version: '3.8'
services:
  purecontext:
    image: purecontext/purecontext-mcp:latest
    ports:
      - "3000:3000"
    volumes:
      - ./data:/data
    environment:
      PCTX_ADMIN_KEY: "change-me-before-deploying"
    restart: unless-stopped
```

```bash
docker compose up -d
```

### npm (no Docker)

```bash
npm install -g purecontext-mcp
PCTX_ADMIN_KEY=your-secret purecontext-mcp --server --host 0.0.0.0 --port 3000
```

### Verify the server is running

```bash
curl http://localhost:3000/health
# {"status":"ok","version":"1.x.x","repoCount":0}
```

---

## Step 2 — Create a workspace

A workspace is the unit of isolation — one team = one workspace. All repos and API keys belong to a workspace.

```bash
export ADMIN_KEY="your-pctx-admin-key"
export SERVER="http://localhost:3000"

curl -s -X POST "$SERVER/admin/workspaces" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-team", "plan": "team"}' | jq .
```

Response:

```json
{"id": "ws_abc123", "name": "my-team", "plan": "team", "created_at": 1714000000}
```

Save the `id` — you'll use it when creating API keys.

---

## Step 3 — Create API keys

Each developer gets their own API key. Keys are shown once on creation and never again.

```bash
curl -s -X POST "$SERVER/admin/keys" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "label": "alice-macbook",
    "permissions": ["read", "write"],
    "workspace_id": "ws_abc123"
  }' | jq .
```

**Response (key shown only once):**

```json
{
  "key": "pctx_00000000_..._1234",
  "label": "alice-macbook",
  "permissions": ["read", "write"],
  "key_hash_prefix": "deadbeef"
}
```

### Permission levels

| Permission | Allowed operations |
|------------|-------------------|
| `read` | Search symbols, get outlines, get source |
| `write` | + `index_folder`, `index_repo` |
| `admin` | + Manage keys and workspaces |

For AI agents that only query (not index), use `read` permission. For CI pipelines that re-index on push, use `write`.

---

## Step 4 — Index the shared codebase

Connect Claude Code (step 5) and ask it to index, or call the API directly:

```bash
curl -s -X POST "$SERVER/mcp/sse" \
  -H "Authorization: Bearer pctx_yourwritekey" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {"name": "index_folder", "arguments": {"path": "/path/to/repo"}},
    "id": 1
  }'
```

---

## Step 5 — Connect each developer

Each developer runs this once:

```bash
claude mcp add purecontext-remote \
  --transport http \
  --url https://purecontext.mycompany.com/mcp/sse \
  --header "Authorization: Bearer pctx_yourpersonalkey"
```

After adding, verify in Claude Code:

```
/mcp
# Should show purecontext-remote as connected

List my indexed repositories using list_repos
```

---

## Step 6 — Manage keys over time

```bash
# List all keys (shows label, prefix, permissions — never the raw key)
curl -s "$SERVER/admin/keys" -H "Authorization: Bearer $ADMIN_KEY" | jq .

# Revoke a key (e.g., when someone leaves the team)
curl -s -X DELETE "$SERVER/admin/keys/deadbeef" \
  -H "Authorization: Bearer $ADMIN_KEY"

# Check key usage stats
curl -s "$SERVER/admin/keys/deadbeef/usage" \
  -H "Authorization: Bearer $ADMIN_KEY" | jq .
```

---

## Rate limiting

HTTP mode uses a token-bucket algorithm to prevent any single client from overwhelming the server:

- Each key gets a bucket with capacity `rateLimit.maxTokens` (default: 100)
- Tokens refill at `rateLimit.refillRate` per second (default: 10)
- Expensive tools (e.g., `index_folder`) cost more tokens

When rate limited, responses return `429 Too Many Requests` with a `Retry-After` header.

Configure per-tool costs in `config.json`:

```json
{
  "rateLimit": {
    "enabled": true,
    "maxTokens": 200,
    "refillRate": 20,
    "perToolLimits": {
      "index_folder": 10,
      "search_symbols": 1
    }
  }
}
```

---

## Admin API reference

All endpoints require `Authorization: Bearer <PCTX_ADMIN_KEY>`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/workspaces` | `POST` | Create workspace |
| `/admin/workspaces` | `GET` | List workspaces |
| `/admin/workspaces/:id` | `DELETE` | Delete workspace and all data |
| `/admin/keys` | `POST` | Create API key |
| `/admin/keys` | `GET` | List keys |
| `/admin/keys/:prefix` | `DELETE` | Revoke key |
| `/admin/keys/:prefix/usage` | `GET` | Key usage stats |
| `/admin/stats` | `GET` | Server-wide statistics |

---

## Production checklist

- [ ] `PCTX_ADMIN_KEY` is a long random secret (≥ 32 hex chars), set via env var only — never in a committed config file
- [ ] Server is behind a reverse proxy (nginx, Caddy) with TLS
- [ ] Port 3000 is not directly exposed to the internet (terminate TLS at the proxy)
- [ ] `/data` volume is on a backed-up disk
- [ ] `restart: unless-stopped` is set in docker-compose
- [ ] Developers have `read` permission only unless they need to re-index
- [ ] Admin key is rotated if ever exposed

See [Docker Deployment](16-docker.md) for full reverse proxy examples.
