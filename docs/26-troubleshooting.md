# Troubleshooting


---

## Health check

Before investigating any problem, run the health check:

```bash
purecontext-mcp --health
```

```json
{
  "status": "ok",
  "version": "1.x.x",
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

In HTTP mode:

```bash
curl http://localhost:3000/health
```

A non-zero exit code (CLI) or non-200 response (HTTP) indicates something is wrong.

---

## Debug logging

```bash
purecontext-mcp --log-level debug
# or
LOG_LEVEL=debug purecontext-mcp
```

Debug logs show: file-by-file parsing progress, hash cache hits/misses, worker thread activity, query plan details, rate limit decisions.

**Use in production only temporarily** — debug logs are verbose and may include file paths.

---

## Common errors

### "Repo not indexed" / "Index not found"

The repository has not been indexed yet, or the `repoId` belongs to a different installation.

```
Fix: Call index_folder with the correct path.
     Use resolve_repo to check if the path is indexed.
```

---

### "Grammar file not found"

A `.wasm` grammar file is missing from the `grammars/` directory.

```bash
# Check which grammars are present:
purecontext-mcp config --check

# Fix: reinstall the package
npm install -g purecontext-mcp
# or
npm rebuild purecontext-mcp
```

---

### "better-sqlite3 bindings failed to load" / native ABI mismatch

The native `better-sqlite3` binary doesn't match your Node.js version or platform — e.g. `NODE_MODULE_VERSION 127 … requires 108` (an ABI mismatch, common under Volta or other per-project Node managers).

**You usually don't need to do anything.** As of 1.10.0, PureContext automatically falls back to a pure-WASM SQLite engine when the native addon can't load, so it keeps working — you'll see `SQLite backend: WASM (@sqlite.org/sqlite-wasm)` in the logs. The fallback is full-featured (FTS5 included), just slower on large indexes.

To restore the faster native engine, rebuild it for your current Node:

```bash
# Fix: rebuild the native module for the current Node
cd $(npm root -g)/purecontext-mcp
npm rebuild better-sqlite3

# If that fails, install build tools first:
# macOS: xcode-select --install
# Linux: apt install python3 make g++
# Windows: npm install -g windows-build-tools
```

---

### "MCP error -32000: Connection closed" / server won't connect

The MCP host shows this when the server process exits during startup. Two most common causes:

1. **Node < 18.** PureContext requires Node ≥ 18. As of 1.10.0 it prints a clear "requires Node.js >= 18" message and exits, instead of failing opaquely. Run the command directly to see it: `node <…>/dist/bin.js --version`. Fix: upgrade Node (20 or 22 LTS recommended).
2. **The server inherited the wrong Node** (Volta/nvm picked a project-pinned version). An MCP server is a global tool — pin it to your global Node so it doesn't inherit a project's pin. Re-run `npx purecontext-mcp install claude` and use the printed `claude mcp add … --scope user -- <node> <launcher>` command.

A native ABI mismatch no longer causes this (the WASM fallback handles it), so a remaining `-32000` is almost always cause #1 or #2.

---

### Missing symbols after indexing

Check this list in order:

1. **Is the file excluded?** Check `excludePatterns` and built-in exclusions (node_modules, dist, .env, etc.)
2. **Is the file too large?** Files > `maxFileSizeBytes` (default 1 MB) are skipped
3. **Is it a secret file?** `.pem`, `.key`, `credentials.json` etc. are always excluded
4. **Is it a private symbol?** Go unexported names, C `static` functions, Java/C# `private` members are excluded by design
5. **Is the language supported?** Check [Language Support](07-language-support.md)
6. **Did the adapter detect?** Run `purecontext-mcp config --check` — check "Detected adapters" for your project

Force a specific adapter if auto-detection fails:
```json
{ "adapters": ["vue", "nuxt"] }
```

---

### Adapter not activating

Run `purecontext-mcp config --check` and look at the detected adapters. Common detection requirements:

| Framework | Detection file |
|-----------|---------------|
| Vue | `vue` in `package.json` dependencies |
| Nuxt | `nuxt.config.ts` at project root |
| Django | `manage.py` at project root |
| Rails | `gem 'rails'` in `Gemfile` |
| Gin | `github.com/gin-gonic/gin` in `go.mod` |
| Spring Boot | `spring-boot-starter` in `pom.xml` |

---

### Incremental re-index not triggering

The file watcher uses a 2-second debounce. For manual force re-index:

```
Call index_folder again — it skips unchanged files via content hashing.
```

If the watcher seems stuck on Linux:

```bash
# Check inotify limit
cat /proc/sys/fs/inotify/max_user_watches

# Increase if needed
echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

---

### HTTP transport not accessible

1. **Check `http.host`** — default is `127.0.0.1` (loopback only). Set to `0.0.0.0` for network access.
2. **Check CORS** — `http.corsOrigins` must include the browser's origin.
3. **Check auth** — if `http.auth.enabled: true`, all requests need `Authorization: Bearer <token>`.
4. **Check firewall** — port 3000 must be open from the client's perspective.

---

### Semantic search not working

1. Verify `semantic.enabled: true` in config
2. Verify a provider is configured: `semantic.provider` is not `"none"`
3. Check if the repo meets the threshold: lower `semantic.threshold` for small repos
4. Verify the API key: test it with a direct API call
5. Re-index — the HNSW index is built during indexing, not at query time

---

### Config validation errors

```bash
purecontext-mcp config --check
```

Reports all schema violations with field names and expected types.

---

### Rate limit errors (HTTP mode)

`429 Too Many Requests` — the API key has hit its per-second token limit.

Check the `Retry-After` header for when to retry. If limits are too low for your use case, ask the server admin to raise `rateLimit.maxTokens` or `rateLimit.refillRate` for your key.

---

### "git not found" when using `index_repo`

```bash
# Verify git is installed and on PATH
git --version

# Install if missing:
# macOS: xcode-select --install
# Linux: apt install git
# Windows: https://git-scm.com/download/win
```

---

### Indexing is slow

- First index is always slower — subsequent runs are incremental (hash-based)
- AI summarization (`allowRemoteAI: true`) adds API latency — disable during testing
- Semantic indexing adds API latency — disable if not needed
- For large repos (> 10k files): increase `workerThreads` in config

---

## Re-indexing from scratch

```
Use invalidate_cache tool with your repoId, then call index_folder again.
```

Or manually:

```bash
rm ~/.purecontext/indexes/<repoId>.db
rm -rf ~/.purecontext/indexes/<repoId>/
```

Then call `index_folder` — a clean full index will be built.

---

## Getting more help

- **GitHub Issues:** Report bugs with version, OS, Node.js version, error log, and approximate repo size
- **`--log-level debug`** output is the most useful information to include in a bug report
