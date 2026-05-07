# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - 2026-05-07

### Added

**New MCP tools**
- `find_references` — find all usage/call sites for a symbol across the repo (identifier-level, not import-level)
- `get_file_content` — retrieve raw cached file content with optional line-range slicing (`startLine`/`endLine`)
- `get_symbols` — batch-fetch multiple symbols by ID, returning source in a single round-trip
- `invalidate_cache` — force a full or per-file re-index by clearing content hashes; accepts optional `filePath` to scope invalidation

**Tool capability enhancements**
- `search_symbols`: new `debug` parameter — includes per-result relevance scoring breakdown (FTS5 rank, kind boost, exact-match bonus)
- `get_symbol_source`: new `context_lines` parameter (extra lines above/below) and `verify` flag (re-reads from disk to confirm source is current)
- `index_repo`: clone and index a remote Git repository by URL; supports private repos via `token`; clones stored at `~/.purecontext/clones/`
- AI summarization via Gemini Flash — configurable as an embedding/summarization provider alongside Anthropic and OpenAI

**Ecosystem & data tools**
- Context provider framework — plugin interface (`ContextProvider`) for domain-specific symbol enrichment; providers auto-detected from project config
- dbt integration — indexes models, sources, seeds, macros, and exposures; dbt Jinja pre-processor expands `{{ ref() }}` / `{{ source() }}` before SQL parsing; column definitions from `schema.yml` stored in `frameworkMeta.columns`
- OpenAPI/Swagger handler — parses `.yaml`/`.yml` files detected as OpenAPI specs; indexes endpoints and schemas as symbols
- SQL handler — indexes tables, views, functions, and stored procedures; works standalone and with dbt Jinja expansion
- `search_columns` tool — search dbt/SQL column definitions by name or description, with upstream/downstream lineage

**Language coverage expansion to 34 languages**

16 new language handlers added (previously 18):

| Language | Extensions | Key symbol types |
|----------|-----------|-----------------|
| Bash | `.sh`, `.bash` | function |
| Perl | `.pl`, `.pm` | function, package |
| Terraform / HCL | `.tf`, `.hcl` | resource, module, variable, output |
| Nix | `.nix` | function, attribute |
| Protobuf | `.proto` | message, service, enum, rpc |
| GraphQL | `.graphql`, `.gql` | type, query, mutation, subscription, fragment |
| Groovy | `.groovy` | function, class, method |
| Erlang | `.erl`, `.hrl` | function, module |
| Gleam | `.gleam` | function, type |
| GDScript | `.gd` | function, class, signal |
| XML | `.xml` | element (pattern-configurable) |
| Objective-C | `.m`, `.h` | function, class, method |
| Fortran | `.f90`, `.f95`, `.for`, `.f` | function, subroutine, module |
| SQL | `.sql` | table, view, function, procedure |
| OpenAPI / YAML | `.yaml`, `.yml` | endpoint, schema |
| PHP (doc coverage) | existing | PHPDoc `/** */` extraction improved |

**Cross-repo intelligence**
- `search_cross_repo` tool — unified symbol search across all repos in a workspace; supports keyword, semantic, and hybrid modes; results include `repoId` and `repoPath`
- `find_similar` tool — find semantically similar code across repos using HNSW cosine similarity; configurable `minSimilarity` threshold (requires semantic search enabled)
- Cross-repo dependency tracking — `dep_edges` extended with `sourceRepoId`/`targetRepoId` columns; `get_blast_radius` and `find_importers` can now follow edges across repo boundaries
- MCP Resources — indexed symbol outlines exposed as MCP Resources (`purecontext://repo/<repoId>/outline`) for clients that support resource subscriptions

**Git & history integration**
- Git metadata indexing — during `index_folder`, PureContext walks `git log` and maps commits to symbols via byte-range overlap; stored in new `git_metadata` SQLite table; configurable via `git.enabled`, `git.maxCommits`, `git.branches`
- `get_symbol_history` tool — symbol-level commit history (hash, author, date, message, diff) without agents needing to run git commands
- `get_churn_metrics` tool — file or symbol churn scores (commits, lines changed, authors, churn score) with optional `since` date filter; surfaces high-risk files

**AI-powered architecture analysis**
- `get_quality_metrics` tool — per-file quality scores: cyclomatic complexity, coupling (fan-in/fan-out), cohesion, doc coverage, and a composite 0–100 score
- `detect_antipatterns` tool — detects god classes, circular dependencies, deep inheritance, feature envy, and other common anti-patterns; results include severity and symbol ID
- `get_architecture_doc` tool — auto-generates a Markdown or Mermaid architecture summary from the dependency graph and quality metrics
- `get_layer_violations` tool — detects import boundary violations given a layer definition (e.g., controllers must not import repositories directly)

**Enhanced Web UI**
- Architecture heatmap — colour-coded file tree where heat indicates churn score or quality score; helps identify hot spots at a glance
- Symbol timeline — visual history of commits touching a symbol, linked to `get_symbol_history` data
- Test coverage overlay — when a coverage JSON report is present, file tree nodes show line coverage percentages
- Multi-repo workspace view — repository picker with cross-repo search tab; switch between repos without reloading
- Advanced dependency graph — zoom/pan, node grouping by directory, edge filtering by kind, and path highlighting between two selected nodes

**Distribution & platform**
- Index export (`npx purecontext-mcp export`) — archives the SQLite database and HNSW index into a portable `.pctx.tar.gz` file
- Index import (`npx purecontext-mcp import`) — restores an exported archive; repo is immediately searchable, no re-indexing required
- Public registry — pre-built indexes for popular open-source projects hosted on CDN; pull with `npx purecontext-mcp pull <package>@<version>`; browse with `npx purecontext-mcp registry list`
- Webhook auto-reindex — HTTP endpoint (`POST /webhook/reindex`) accepts GitHub/GitLab push payloads and triggers incremental re-indexing automatically
- GitHub Actions composite action — `.github/actions/purecontext-cache/action.yml`; caches the index between CI runs using `actions/cache`, exports after indexing, imports on cache hit
- VS Code extension — `vscode-purecontext` extension wraps the MCP server with a sidebar panel for symbol search, file outline, and dependency graph directly in the editor

### Changed

- `search_symbols` response now includes `repoId` in every result (was implicit from the request parameter) — enables direct use in cross-repo result lists
- `list_repos` now includes `gitEnabled` and `lastGitIndexed` fields when git metadata indexing is active
- Default `fileLimit` raised from 1000 to 5000 (language expansion makes larger repos viable)
- `_meta` envelope included in all tool responses (previously only retrieval tools); fields: `timing_ms`, `tokens_saved`, `total_tokens_saved`, `cost_avoided`

---

## [1.0.0] - 2026-04-26

This is the first stable release of PureContext MCP. The public tool API is now under
semver: breaking changes require a major version bump, new tools and fields increment
the minor version, and bug fixes increment the patch version.

### Added

**Core symbol indexing (TypeScript and JavaScript)**
- Tree-sitter AST parsing via WASM bindings (`web-tree-sitter`) — no native compilation required for the parser itself
- Extracts functions, classes, methods, constants, types, interfaces, and enums with one-line signatures
- Deterministic symbol IDs (SHA-256 of `filePath:name:kind`) for stable cross-session references
- SQLite storage (`better-sqlite3`) with four tables: `symbols`, `files`, `dep_edges`, `repos`
- Incremental re-indexing via chokidar file watcher with debounce

**Language support (16 languages)**
- TypeScript and JavaScript (full symbol + import extraction)
- Python, Go, Rust, Java, C, C++, C#, Swift, Kotlin, Dart
- Elixir, Haskell, Scala, R
- PHP, Lua, Ruby

**Framework adapters (20+ frameworks)**
- Vue 3 (SFC `<script setup>`, composables, components)
- Nuxt 3 (pages, layouts, composables, server routes, plugins)
- React and Next.js (components, hooks, server/client components, API routes)
- Angular (components, services, pipes, guards, modules, directives)
- Express and Fastify (routes, middleware, plugins)
- Django, FastAPI, Flask (views, serializers, models, routers, dependencies)
- SQLAlchemy and Prisma (models, schemas, migrations)
- Axum and Actix-web (handlers, middleware, extractors)
- Echo, Fiber, Gin (handlers, middleware, groups)
- Spring and Hibernate (controllers, services, repositories, entities)

**MCP tool surface (12 tools)**
- `index_folder` — index a project directory
- `resolve_repo` — resolve a path to its repo ID
- `list_repos` — list all indexed repositories
- `search_symbols` — search by name fragment with kind and path filters
- `get_symbol_source` — retrieve raw source by byte offsets
- `get_file_outline` — all symbols in a file with signatures
- `get_repo_outline` — all files with top-level symbols
- `get_file_tree` — directory tree with file counts
- `get_context_bundle` — transitive forward-walk from a symbol
- `get_blast_radius` — reverse-walk to find all dependents
- `find_importers` — direct importers of a file
- `find_dead_code` — exported symbols that nothing imports

**Dependency graph**
- Import resolution with tsconfig path alias support
- Forward (context bundle) and reverse (blast radius) BFS traversal
- Dead code detection across the entire project graph

**FTS5 keyword search with relevance ranking**
- Full-text search over symbol names and signatures
- camelCase query preprocessor (`getUserById` → `get user by id`)
- Hyphen-aware tokenization
- Relevance ranker: exact name match → prefix match → content match

**Semantic search — HNSW vector index**
- Optional embedding-based symbol search via `hnswlib-wasm`
- Configurable embedding provider (Anthropic, OpenAI, or none)
- Index persists alongside the SQLite database

**Token savings tracker**
- Each tool response includes `_tokenEstimate` so agents can gauge context size
- Cumulative session savings reported by `list_repos`

**Multi-tenant rate limiting**
- Per-client request quotas configurable in `config.json`
- Token bucket algorithm with burst allowance

**Web UI**
- Vite + Vue 3 dashboard served from the MCP process
- Symbol search, file outline, dependency graph visualisation
- 28 Playwright end-to-end tests

**Worker thread pool for enterprise repos**
- Parallel tree-sitter parsing across a configurable thread pool
- Designed for 10k–50k file codebases
- Graceful degradation to single-threaded mode when the pool is unavailable

**npm release infrastructure**
- `prebuildify` prebuilt binaries for Node 18/20/22 × Windows/macOS/Linux
- GitHub Actions CI: 9-job matrix (3 OS × 3 Node versions) on every push and PR
- Release workflow: prebuild + publish triggered by `v*` tags
- `files` allowlist in `package.json` — published package < 20 MB
- `scripts/check-sqlite.js` postinstall canary with actionable error message
- `scripts/verify-package.sh` pre-release verification helper

**Public launch polish**
- `--health` flag — checks prerequisites (grammars, SQLite, index directory) and exits with JSON output; non-zero exit code on any failure
- Actionable error messages throughout: missing grammar files, SQLite open failures, and config validation all produce human-readable guidance instead of raw stack traces
- Opt-in telemetry — reports anonymised usage counts (tool invocations, file counts); disabled by default, enabled via `telemetry.enabled: true` in config

**Team and cloud features**
- HTTP/SSE transport — start the server with `--transport http` (or `--transport both` for stdio + HTTP simultaneously); port and bind address configurable via `--port`/`--host` or `config.json`
- API key management — `purecontext-mcp keys create/list/revoke` CLI; keys stored as bcrypt hashes, shown once on creation; format `pctx_<workspaceId>_<24-char-random>_<checksum>`
- Workspace support — logical namespaces that group repos and API keys; managed via the admin key (`PCTX_ADMIN_KEY` env var)
- Docker deployment — official `purecontext/purecontext-mcp` image; `docker-compose.yml` included in the repo; `/health` HTTP endpoint for container health checks

### Changed

- Minimum Node.js version: **18.0.0** (uses native `fetch`, `worker_threads`, `structuredClone`)
- Default `fileLimit` raised from 500 to 1000

### Fixed

- `web-tree-sitter` character-vs-byte offset bug in handler text extraction (all language handlers now use byte offsets throughout)
- Forward-slash normalisation for file paths stored in SQLite (Windows compatibility)
- FTS5 hyphen tokenization — hyphens in symbol names are now indexed correctly

---

## [0.1.0] - 2026-04-10

Initial internal release. Core TypeScript/JavaScript indexing, SQLite storage, and MCP stdio transport.
