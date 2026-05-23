# Team Setup & Multi-Tenant — Reference

This is the reference page: API key permissions, rate-limit configuration, admin API endpoints, and the production hardening checklist.

For the **user-friendly walkthrough** — why a shared server matters, deployment options, end-to-end setup with examples — see [`TEAM-SETUP.md`](../TEAM-SETUP.md) at the project root.

---

## Workspace and key model

| Concept | Description |
|---------|-------------|
| Workspace | The unit of isolation. One team = one workspace. All repos and keys belong to a workspace. |
| API key | A per-developer credential. Shown once on creation and never displayed again. Stored as a SHA-256 hash. |
| Admin key | A long-lived secret (`PCTX_ADMIN_KEY`) that authenticates workspace and key management calls. Set via env var only. |

---

## Permission levels

| Permission | Allowed operations |
|------------|--------------------|
| `read` | Search symbols, get outlines, fetch source |
| `write` | + `index_folder`, `index_repo`, `invalidate_cache` |
| `admin` | + Manage keys and workspaces |

For AI agents that only query, use `read`. For CI pipelines that re-index on push, use `write`. Never issue `admin` to a developer or agent — keep it on the admin key alone.

---

## Rate limiting

HTTP mode uses a token-bucket per API key.

| Field | Default | Description |
|-------|--------:|-------------|
| `rateLimit.enabled` | `true` | Disable to allow unbounded usage (single-tenant only) |
| `rateLimit.maxTokens` | `100` | Bucket capacity per key |
| `rateLimit.refillRate` | `10` | Tokens added per second |
| `rateLimit.perToolLimits.<tool>` | varies | Per-tool cost override |

Default per-tool costs:

| Tool | Cost |
|------|-----:|
| `search_symbols`, `search_text`, `search_semantic` | 1 |
| `get_symbol_source`, `get_file_outline`, `get_context_bundle` | 1 |
| `index_folder`, `index_repo` | 10 |
| `health_radar`, `get_debt_report`, `detect_antipatterns` | 5 |

When a bucket empties, the server returns `429 Too Many Requests` with a `Retry-After` header.

Example config:

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

All endpoints require `Authorization: Bearer <PCTX_ADMIN_KEY>`. Base URL: the server's bind address (default `http://localhost:3000`).

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/workspaces` | `POST` | Create workspace. Body: `{name, plan}`. Returns `{id, name, plan, created_at}`. |
| `/admin/workspaces` | `GET` | List workspaces. |
| `/admin/workspaces/:id` | `DELETE` | Delete workspace and all data. |
| `/admin/keys` | `POST` | Create API key. Body: `{label, permissions[], workspace_id}`. **Raw key returned once.** |
| `/admin/keys` | `GET` | List keys (label + prefix + permissions; never raw key). |
| `/admin/keys/:prefix` | `DELETE` | Revoke key by hash prefix. |
| `/admin/keys/:prefix/usage` | `GET` | Per-key usage counters. |
| `/admin/stats` | `GET` | Server-wide statistics. |
| `/health` | `GET` | Public health check (no auth). Returns `{status, version, repoCount}`. |

---

## Server-mode environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PCTX_ADMIN_KEY` | yes | Admin secret. Minimum 32 hex chars recommended. |
| `PCTX_DATA_DIR` | no | Override default `/data` (Docker) or `~/.purecontext` (npm). |
| `PCTX_BIND_HOST` | no | Default `0.0.0.0` in server mode. |
| `PCTX_BIND_PORT` | no | Default `3000`. |
| `PCTX_LOG_LEVEL` | no | `debug` / `info` / `warn` / `error`. |

CLI flags `--server`, `--host`, `--port` take precedence over env vars.

---

## Production hardening checklist

- [ ] `PCTX_ADMIN_KEY` is a ≥32-char random secret, set via env var only — never in a committed config file
- [ ] Server is behind a reverse proxy (nginx, Caddy) with TLS
- [ ] Port 3000 is not directly exposed to the public internet (terminate TLS at the proxy)
- [ ] `/data` volume sits on a backed-up disk
- [ ] `restart: unless-stopped` set in docker-compose
- [ ] Developers have `read` permission only unless they specifically need to re-index
- [ ] Admin key is rotated if ever exposed
- [ ] Rate limiting enabled and tuned for your team size

---

## Related reference

- [Transport Modes](14-transport-modes.md) — stdio vs HTTP/SSE deep dive
- [Docker Deployment](16-docker.md) — container image, compose examples, reverse-proxy templates
- [Security](24-security.md) — threat model, API-key storage, path-traversal protections
- [Configuration](04-configuration.md) — full `config.json` schema
