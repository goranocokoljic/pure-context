# Docker Deployment


---

## Quick start

```bash
docker run -d \
  --name purecontext \
  -p 3000:3000 \
  -v /path/to/data:/data \
  -e PCTX_ADMIN_KEY="$(openssl rand -hex 32)" \
  --restart unless-stopped \
  purecontext/purecontext-mcp:latest
```

Verify:

```bash
curl http://localhost:3000/health
# {"status":"ok","version":"1.x.x","repoCount":0}
```

---

## Docker Compose (recommended)

The `docker-compose.yml` in the project root is ready to use:

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
      PCTX_ADMIN_KEY: "${PCTX_ADMIN_KEY}"
      PCTX_PORT: "3000"
      PCTX_HOST: "0.0.0.0"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

```bash
export PCTX_ADMIN_KEY="$(openssl rand -hex 32)"
docker compose up -d
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PCTX_ADMIN_KEY` | *(required)* | Admin key for `/admin/*` endpoints. Set via environment, never in config files. |
| `PCTX_DATA_DIR` | `/data` | Data directory inside container — mount a volume here. |
| `PCTX_PORT` | `3000` | HTTP port. |
| `PCTX_HOST` | `0.0.0.0` | Bind address. |
| `PCTX_LOG_LEVEL` | `info` | Log verbosity: `debug`, `info`, `warn`, `error`. |
| `ANTHROPIC_API_KEY` | — | For AI summarization (Anthropic provider). |
| `OPENAI_API_KEY` | — | For AI summarization or semantic search (OpenAI). |
| `GEMINI_API_KEY` | — | For AI summarization (Google Gemini). |

---

## Volume mounts

| Container path | Purpose |
|---------------|---------|
| `/data` | SQLite index databases, auth database, config. **Must be a persistent volume.** |

Without a volume mount, all indexes and API keys are lost when the container restarts.

Optional: mount local repo directories for faster indexing (avoids git clone):

```yaml
volumes:
  - ./data:/data
  - /home/user/projects:/projects:ro   # read-only, for indexing
```

Then call `index_folder` with `/projects/my-repo` as the path.

---

## Updating

```bash
docker compose pull
docker compose up -d --force-recreate
```

The `/data` volume is unaffected. Index files are forward-compatible within a major version.

---

## Health check

The Docker image includes a built-in health check:

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
```

Check status:

```bash
docker inspect --format='{{.State.Health.Status}}' purecontext
# healthy
```

---

## Resource requirements

| Repo size | RAM (at rest) | RAM (during index) | CPU |
|-----------|---------------|--------------------|-----|
| < 1k files | ~100 MB | ~200 MB | any |
| 1k–10k files | ~200 MB | ~500 MB | 2+ cores recommended |
| 10k–50k files | ~500 MB | ~1 GB | 4+ cores recommended |

SQLite uses WAL mode — reads don't block writes, no special IO requirements.

---

## Reverse proxy (TLS termination)

### nginx

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
        proxy_set_header X-Real-IP $remote_addr;
        # Required for SSE: disable buffering
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

### Caddy

```
purecontext.mycompany.com {
    reverse_proxy localhost:3000 {
        flush_interval -1   # disable buffering for SSE
    }
}
```

Caddy handles TLS automatically via Let's Encrypt.

---

## Server logs

```bash
# Stream logs
docker logs -f purecontext

# Last 100 lines
docker logs --tail 100 purecontext
```

Log format: structured JSON lines when `PCTX_LOG_LEVEL=info` or higher. Each line includes timestamp, level, tool name (for MCP calls), repoId, and duration.
