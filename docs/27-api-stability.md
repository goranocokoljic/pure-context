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

For the full list of tools and their exact parameter/response contracts, see the [MCP Tools Reference](06-tools-reference.md).

---

## Stable tools (1.x)

**Every tool listed in the [MCP Tools Reference](06-tools-reference.md) is stable in 1.x** under the SemVer policy above: a tool's name and required parameters will not change or be removed within the `1.x` line, and new tools arrive as minor releases. There is currently no separate `@experimental` tool tier — the reference is the single source of truth for the tool surface.

The tool surface has grown well beyond the original 1.0 core. Families added since:

| Family | Tools | Since |
|--------|-------|-------|
| Relationship analysis | `find_implementations`, `get_call_hierarchy`, `get_class_hierarchy`, `find_cycles`, `get_coupling_map` | 1.2.0 |
| Architecture & visualization | `get_layer_violations`, `detect_antipatterns`, `render_diagram` (+ variants), `get_architecture_snapshot` | 1.2.0+ |
| Git & temporal | `get_symbol_history`, `get_churn_metrics`, `get_co_change`, `get_symbol_risk` | 1.8.0 |
| Change & refactoring | `analyze_diff`, `prepare_change`, `verify_change`, `compare_change_impact`, `merge_readiness` | 1.9.0–1.12.0 |
| Harness freshness & consistency | `index_file`, `check_index_staleness`, `check_consistency` | 1.12.0 |
| Active context | `get_task_context` (`mode:"associative"`) | 1.13.0 |

When a tool is on track for removal in a future major, it follows the deprecation process below (`_deprecated: true` in responses for one minor cycle first).

---

## Stable symbol kinds

The following `SymbolKind` values are stable in 1.x:

`function` · `class` · `method` · `const` · `type` · `interface` · `enum` · `component` · `composable` · `hook` · `route` · `decorator` · `middleware` · `property` · `model` · `view` · `struct` · `macro` · `signal`

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
| `1.0.0` | Core symbol indexing (TS/JS): prebuilt binaries, 19 languages, 20+ framework adapters, FTS5 search, HNSW semantic search, Web UI, rate limiting, Docker |
| `1.1.0` | New tools: `find_references`, `get_file_content`, `get_symbols`, `invalidate_cache` |
| `1.2.0` | Advanced relationship analysis (call/class hierarchy, cycles, coupling) |
| `1.3.0` | Search quality (FTS5 ranking, synonyms); dbt `search_columns`, OpenAPI, SQL |
| `1.4.0` | New MCP tools + expanded language handlers |
| `1.5.0` | New language handlers; cross-repo search, code similarity, MCP Resources |
| `1.7.0` | Svelte and Astro single-file-component support (Phase 75) |
| `1.8.0` | Temporal risk intelligence — `get_co_change`, `get_symbol_risk` (Phase 76) |
| `1.9.0` | Change-impact synthesis — `analyze_diff` reviews by impact (Phase 77) |
| `1.10.0` | Node-version independence — WASM SQLite fallback (Phase 78) |
| `1.11.0` | Refactoring loop — `prepare_change` → `verify_change` → `compare_change_impact` (Phase 79) |
| `1.12.0` | Harness Loop Fit — `index_file`, `check_consistency`, `merge_readiness`, gate envelope (Phase 80) |
| `1.13.0` | Active context reconstruction — `get_task_context` associative mode (Phase 81) |
