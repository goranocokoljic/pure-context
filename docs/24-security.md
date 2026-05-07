# Security


---

## Threat model

PureContext stores and serves source code metadata. Security measures focus on:

**Protected:**
- Symbol names, signatures, summaries — stored in SQLite
- Raw source returned by `get_symbol_source` / `get_file_content`
- Admin API (workspace/key management)

**Not in scope:**
- The source repository itself — PureContext only reads it during indexing
- Network transport — handle TLS at a reverse proxy
- Host OS security — standard server hardening applies

---

## Path traversal prevention

All file paths are validated before any read:

1. Resolved to an absolute path
2. Verified to start within the project root (the indexed directory)
3. Symlinks that resolve outside the root are blocked unless `allowSymlinks: true`

This prevents tools like `get_file_content` from being used to read arbitrary files on the server.

---

## Secret file exclusion

The following files are automatically excluded from indexing (never stored in the index):

- `.env`, `.env.*`, `.env.local`, `.env.production`
- `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.crt`, `*.cer`
- `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`
- `credentials.json`, `credentials.yaml`, `secrets.json`
- `serviceAccountKey*.json`, `*-service-account.json`
- `*.token`, `*.secret`

These patterns are built into the file discovery layer and cannot be overridden by `excludePatterns`.

---

## Binary file detection

Files are scanned for null bytes in the first 8 KB. Files with null bytes are treated as binary and skipped — preventing large binary files (which may contain embedded secrets) from entering the index.

---

## API key security

Keys are stored as **bcrypt hashes** in the auth database — plaintext is never persisted after the key is generated.

- Keys are shown once on creation — store in a password manager or CI secrets
- Key format: `pctx_<workspaceId>_<24-char-random>_<checksum>`
- The checksum allows fast format validation without a database lookup
- Rotate keys by revoking the old one and creating a new one
- Use `read` permission for agents that only query, not `write` or `admin`

---

## Workspace isolation

Every query is scoped to the workspace of the API key used:

- A key from workspace A cannot query repos in workspace B
- Workspace scoping is enforced in all SQL queries via `workspace_id` column
- The admin key (`PCTX_ADMIN_KEY`) bypasses workspace isolation — protect it like a root password

---

## Rate limiting

Per-key rate limits (token bucket algorithm):

- `rateLimit.maxTokens` — bucket capacity (default: 100)
- `rateLimit.refillRate` — tokens/second refill rate (default: 10)
- Heavy tools (e.g., `index_folder`) cost more tokens per call

When exceeded: `429 Too Many Requests` with `Retry-After` header.

---

## HTTP security

- **Default host: `127.0.0.1`** — loopback only, not exposed on the network
- A warning is logged at startup if `host` is not loopback and `auth.enabled` is false
- **Timing-safe comparison** — `crypto.timingSafeEqual()` used for token comparison (prevents timing attacks)
- **Request body limit** — 1 MB maximum
- **CORS** — whitelist-controlled via `http.corsOrigins`

---

## Remote repository cloning

When using `index_repo`:

- Only `https://`, `http://`, and `git@` URL schemes are accepted
- Clone tokens (`token` parameter) are never logged
- Clones are isolated under `~/.purecontext/clones/`

---

## Self-hosting hardening checklist

- [ ] Run behind a TLS-terminating reverse proxy (nginx, Caddy)
- [ ] Set `PCTX_ADMIN_KEY` via environment variable, never in `config.json`
- [ ] Restrict developer API keys to `read` permission where possible
- [ ] Restrict server bind address to internal network if not public-facing
- [ ] Use firewall rules to limit access to port 3000
- [ ] Monitor `/health` endpoint and set up uptime alerts
- [ ] Rotate API keys regularly
- [ ] Back up the `/data` volume (contains indexes and auth database)

---

## Data at rest

SQLite files are stored in `indexDir` (`~/.purecontext/indexes/` by default). No encryption at rest is applied by PureContext itself.

For sensitive codebases, use OS-level disk encryption:
- macOS: FileVault
- Windows: BitLocker
- Linux: LUKS

Docker: use encrypted volumes if the host is shared.

---

## Audit logging

The HTTP server logs every MCP tool call with:
- Timestamp
- API key label (not the key itself)
- Tool name
- `repoId`
- Response status and duration

At `debug` level, full request/response bodies are included. Pipe logs to your SIEM or log aggregator for audit trails.
