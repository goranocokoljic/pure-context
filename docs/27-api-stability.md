# API Stability & Changelog


---

## Versioning policy

PureContext follows **semantic versioning (semver)**:

| Change type | Version bump |
|-------------|-------------|
| Remove or rename a tool | `2.0.0` (major) |
| Remove or rename a required parameter | `2.0.0` (major) |
| Remove a top-level response field | `2.0.0` (major) |
| Change the type or semantics of a stable field | `2.0.0` (major) |
| Add a new tool | `1.x.0` (minor) |
| Add an optional parameter | `1.x.0` (minor) |
| Add a new response field | `1.x.0` (minor) |
| Bug fix with no API surface change | `1.0.x` (patch) |

Agents and integrations built against `v1.x` will not break until `v2.0`.

---

## Public API contract

### What is stable in 1.x

| Surface | Stable? |
|---------|---------|
| MCP tool names | Yes |
| Required tool parameters | Yes |
| Top-level response field names and types | Yes |
| CLI flag names and exit codes | Yes |
| Symbol ID format (deterministic hash) | Yes |
| `repoId` format (deterministic hash) | Yes |

### What is NOT covered by the stability guarantee

| Surface | Notes |
|---------|-------|
| Internal module paths (`src/core/...`) | For contributors only, may change freely |
| SQLite schema column names | Subject to migration with version upgrades |
| HTTP admin API (`/admin/*`) | Stable at `1.0` but less strictly than MCP tools |
| `ai.*` config group | May change as AI summarization matures |
| Response field order | JSON objects — do not rely on ordering |

For the full list of stable tools and their exact parameter/response contracts, see [docs/API_STABILITY.md](API_STABILITY.md).

---

## Stable tools (1.x)

All tools listed in [MCP Tools Reference](06-tools-reference.md) are stable in 1.x, with the exception of tools in the experimental list below which are marked `@experimental` until a future stabilization release.

**Stable tool list:**
`index_folder` · `index_repo` · `resolve_repo` · `list_repos` · `search_symbols` · `search_text` · `get_symbol_source` · `get_file_outline` · `get_repo_outline` · `get_file_tree` · `get_context_bundle` · `get_blast_radius` · `find_importers` · `find_dead_code` · `get_savings_stats` · `get_layer_violations`

**Experimental:**
`invalidate_cache` · `get_file_content` · `get_symbols` · `find_references` · `search_semantic` · `search_cross_repo` · `find_similar` · `get_symbol_history` · `get_churn_metrics` · `get_quality_metrics` · `detect_antipatterns` · `get_architecture_doc` · `search_columns`

---

## Stable symbol kinds

The following `SymbolKind` values are stable in 1.x:

`function` · `class` · `method` · `const` · `type` · `interface` · `enum` · `component` · `composable` · `hook` · `route` · `decorator` · `middleware`

New kinds may be added in minor releases. Clients should handle unknown kinds gracefully (do not throw on unknown kind values).

---

## Deprecation process

Before removing anything in a major version:

1. The deprecated item is marked `_deprecated: true` in the response for one minor release cycle
2. A note is added to `CHANGELOG.md` and the release notes
3. The deprecated item is removed in the next major version

---

## Index file compatibility

SQLite index files are forward-compatible within a major version. Upgrading from `v1.0` to `v1.5` requires no action — the migrator runs automatically at startup.

A `v1.x` → `v2.0` upgrade may require a re-index. The CLI warns at startup if it detects an incompatible index version:

```
Warning: Index at ~/.purecontext/indexes/abc123.db was created by v1.x
and is not compatible with v2.0. Run index_folder to re-index.
```

---

## Changelog

See [CHANGELOG.md](../CHANGELOG.md) for the full version history.

**Key milestones:**

| Version | Highlights |
|---------|-----------|
| `1.0.0` | Stable release: prebuilt binaries, 19 languages, 20+ framework adapters, FTS5 search, HNSW semantic search, Web UI, rate limiting, Docker |
| `1.1.0` | `find_references`, `get_file_content`, `get_symbols`, `invalidate_cache` |
| `1.2.0` | search debug mode, `context_lines`/`verify`, GitHub API indexing, Gemini Flash |
| `1.3.0` | context providers, dbt, `search_columns`, OpenAPI, SQL handler |
| `1.4.0` | 15 new language handlers (34 total) |
| `1.5.0` | cross-repo search, code similarity, MCP Resources |
| `1.6.0` | git & history integration |
| `1.7.0` | AI-powered architecture analysis |
| `1.8.0` | enhanced Web UI |
| `1.9.0` | distribution & platform (registry, webhooks, GitHub Actions, VS Code extension) |
