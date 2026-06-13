# Configuration


## Config file location

```
~/.purecontext/config.json
```

Generate a default file with:

```bash
purecontext-mcp config --init
```

View the effective configuration (defaults merged with your overrides):

```bash
purecontext-mcp config
```

Validate the config and check prerequisites:

```bash
purecontext-mcp config --check
```

## Full schema reference

```json
{
  "indexDir": "~/.purecontext/indexes",
  "fileLimit": 1000,
  "watchDebounceMs": 2000,
  "excludePatterns": [],
  "adapters": "auto",
  "maxFileSizeBytes": 1048576,
  "allowSymlinks": false,
  "transport": "stdio",

  "ai": {
    "provider": "none",
    "allowRemoteAI": false,
    "apiKey": "",
    "endpoint": null,
    "model": "claude-haiku-4-5-20251001",
    "batchSize": 50,
    "embeddingModel": null,
    "embeddingProvider": null,
    "openaiApiKey": ""
  },

  "semantic": {
    "enabled": false,
    "provider": "none",
    "localEmbeddingEndpoint": null,
    "dimension": null,
    "threshold": 50000,
    "batchSize": 500,
    "concurrency": 2
  },

  "http": {
    "port": 3000,
    "host": "127.0.0.1",
    "corsOrigins": ["http://localhost:*"],
    "auth": {
      "enabled": false,
      "token": ""
    }
  },

  "rateLimit": {
    "enabled": true,
    "maxTokens": 100,
    "refillRate": 10,
    "perToolLimits": {
      "index_folder": 10,
      "index_repo": 10,
      "get_context_bundle": 3,
      "get_blast_radius": 3,
      "get_repo_outline": 2,
      "find_dead_code": 5
    }
  },

  "telemetry": {
    "enabled": false,
    "endpoint": "https://telemetry.purecontext.dev/v1/event"
  },

  "layers": {
    "definitions": [],
    "rules": []
  }
}
```

## Field reference

### Storage and indexing

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `indexDir` | `string` | `~/.purecontext/indexes` | Directory where SQLite index files are stored |
| `fileLimit` | `number` | `1000` | Max files indexed per project. Increase for large repos. `0` means unlimited. |
| `watchDebounceMs` | `number` | `2000` | Milliseconds to wait after a file change before re-indexing |
| `excludePatterns` | `string[]` | `[]` | Additional glob patterns to exclude (on top of built-ins: `node_modules/`, `.git/`, `dist/`, etc.) |
| `adapters` | `string` or `string[]` | `"auto"` | `"auto"` = detect from project files; `"none"` = disable all; `["vue", "nuxt"]` = explicit list |
| `maxFileSizeBytes` | `number` | `1048576` | Files larger than this (default: 1 MB) are skipped |
| `allowSymlinks` | `boolean` | `false` | When `false`, symlinks that resolve outside the project root are blocked |

### Git & temporal coupling (`git.*`)

Powers `get_co_change`, `get_symbol_risk`, and `get_context_bundle`'s `historicalNeighbors` (Phase 76).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `git.coChangeDepth` | `number` | `300` | Recent commits captured at the repo root (one `git log --name-only`) for co-change analysis. `0` disables capture entirely — zero extra git work, identical behavior to before. |
| `git.megaCommitThreshold` | `number` | `30` | Commits touching more files than this (reformats, lockfile sweeps, codemods) are excluded / down-weighted so they don't manufacture spurious coupling. |

### Change-risk weights (`risk.weights.*`)

Tunable factor weights for `get_symbol_risk`. Each scales the repo-relative (0–1) normalized factor; weights need not sum to 1 (normalized at scoring time).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `risk.weights.churn` | `number` | `0.25` | How often the symbol's file changes (90 d) |
| `risk.weights.centrality` | `number` | `0.25` | Afferent coupling + reverse blast radius |
| `risk.weights.complexity` | `number` | `0.2` | Cyclomatic complexity of the symbol |
| `risk.weights.testGap` | `number` | `0.15` | Whether the symbol appears untested |
| `risk.weights.coChange` | `number` | `0.15` | How many files historically move with it |

### Transport

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `transport` | `string` | `"stdio"` | `"stdio"` for Claude Code; `"http"` for browser/remote; `"both"` for both simultaneously |

### AI summarization (`ai.*`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ai.provider` | `string` | `"none"` | `"none"`, `"anthropic"`, `"openai"`, `"openai-compatible"`, `"google"` |
| `ai.allowRemoteAI` | `boolean` | `false` | Must be `true` to enable any outbound AI API calls |
| `ai.apiKey` | `string` | `""` | API key. Prefer environment variable interpolation: `"${ANTHROPIC_API_KEY}"` |
| `ai.model` | `string` | `"claude-haiku-4-5-20251001"` | Model for summarization |
| `ai.batchSize` | `number` | `50` | Symbols per AI batch request |
| `ai.endpoint` | `string \| null` | `null` | Custom endpoint for `openai-compatible` providers (e.g., Ollama) |

### Semantic search (`semantic.*`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `semantic.enabled` | `boolean` | `false` | Enable HNSW vector search |
| `semantic.provider` | `string` | `"none"` | `"openai"`, `"local"`, or `"none"` |
| `semantic.localEmbeddingEndpoint` | `string \| null` | `null` | Local embedding server URL (e.g., Ollama) |
| `semantic.threshold` | `number` | `50000` | Min symbols before HNSW index is built. Lower for small repos. |
| `semantic.batchSize` | `number` | `500` | Symbols per embedding batch |
| `semantic.concurrency` | `number` | `2` | Concurrent embedding requests |

### HTTP server (`http.*`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `http.port` | `number` | `3000` | Port for HTTP transport |
| `http.host` | `string` | `"127.0.0.1"` | Bind address. Use `"0.0.0.0"` for network access. |
| `http.corsOrigins` | `string[]` | `["http://localhost:*"]` | Allowed CORS origins |
| `http.auth.enabled` | `boolean` | `false` | Require bearer token authentication |
| `http.auth.token` | `string` | `""` | Bearer token. If empty and auth is enabled, a random token is generated at startup. |

### Rate limiting (`rateLimit.*`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `rateLimit.enabled` | `boolean` | `true` | Enable token-bucket rate limiting |
| `rateLimit.maxTokens` | `number` | `100` | Bucket capacity |
| `rateLimit.refillRate` | `number` | `10` | Tokens refilled per second |
| `rateLimit.perToolLimits` | `object` | see above | Per-tool token cost overrides |

### Telemetry (`telemetry.*`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `telemetry.enabled` | `boolean` | `false` | Opt-in anonymous usage telemetry. **Never enabled without explicit opt-in.** |
| `telemetry.endpoint` | `string` | `"https://telemetry.purecontext.dev/v1/event"` | Override the telemetry endpoint |

See [Telemetry](TELEMETRY.md) for full details on what is and is not collected.

### Architecture layer rules (`layers.*`)

Used by the `get_layer_violations` tool to enforce import boundaries.

```json
{
  "layers": {
    "definitions": [
      { "name": "core",     "paths": ["src/core/**"] },
      { "name": "handlers", "paths": ["src/handlers/**"] }
    ],
    "rules": [
      { "from": "core", "to": "handlers", "allowed": false }
    ]
  }
}
```

## Environment variable interpolation

API keys in `config.json` can reference environment variables to avoid storing secrets in the file:

```json
{
  "ai": {
    "apiKey": "${ANTHROPIC_API_KEY}"
  },
  "http": {
    "auth": {
      "token": "${PURECONTEXT_API_TOKEN}"
    }
  }
}
```

The server also reads the following environment variables directly (they override `config.json`):

| Variable | Config field |
|----------|-------------|
| `PCTX_ADMIN_KEY` | Admin key for multi-tenant deployments |
| `PCTX_DATA_DIR` | `indexDir` |
| `PCTX_PORT` | `http.port` |
| `PCTX_HOST` | `http.host` |
| `ANTHROPIC_API_KEY` | `ai.apiKey` (when `ai.provider = "anthropic"`) |
| `OPENAI_API_KEY` | `ai.openaiApiKey` |
| `GEMINI_API_KEY` | Used when `ai.provider = "google"` |
