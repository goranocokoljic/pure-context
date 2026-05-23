# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

**Claude Code hook system overhaul**

Hooks now use CLI-style commands (`npx purecontext-mcp hook-*`) registered directly in `~/.claude/settings.json`. No scripts are copied to `~/.claude/hooks/` — the commands invoke the installed package directly, so hook logic updates automatically when the package updates.

Seven hook events are now supported (up from three):

| Hook event | Command | What it does |
|------------|---------|--------------|
| `PostToolUse` | `hook-posttooluse` | Re-indexes modified files after Edit/Write/MultiEdit |
| `PreCompact` | `hook-precompact` | Injects indexed repo list into context before compaction |
| `PreToolUse` | `hook-pretooluse` | Soft edit guard — suggests read tools before editing |
| `WorktreeCreate` | `hook-worktree-create` | Auto-indexes a newly created agent worktree |
| `WorktreeRemove` | `hook-worktree-remove` | Fires when an agent worktree is removed |
| `TaskCompleted` | `hook-taskcompleted` | Post-task diagnostics: complexity stats, TODO count, tool suggestions |
| `SubagentStart` | `hook-subagentstart` | Injects condensed repo orientation for newly spawned subagents |

*TaskCompleted* — after the agent finishes a task, queries each indexed repo for high-complexity symbols (cyclomatic complexity > 5) and TODO/FIXME annotations, then injects a diagnostic summary plus a reminder of relevant tools: `find_dead_code`, `find_untested_symbols`, `get_todos`, `get_complexity_hotspots`, `health_radar`.

*SubagentStart* — when a subagent spawns it has no session context. This hook injects the indexed repo list (repoId, path, file and symbol counts, last-indexed timestamp) plus the mandatory workflow table so the subagent is oriented without needing an extra tool call.

*WorktreeCreate* — Claude Code's Agent tool can create isolated git worktrees for sub-tasks. This hook calls `index-folder` on the new worktree automatically so PureContext tools work immediately inside it.

Re-running `npx purecontext-mcp hooks --install` upgrades existing installations: old `node ~/.claude/hooks/purecontext-*.mjs` entries are replaced with the new CLI form, and the four new hook events are added.

---

## [1.5.0] - 2026-05-22

### Added

**New language handlers**

- **HCL / Terraform** (`.tf`, `.tfvars`, `.hcl`) — extracts `variable`, `output`, `resource`, `data`, `module`, `provider`, and `locals` blocks; names follow Terraform reference syntax (`var.name`, `module.name`, `local.name`, `output.name`) so queries match the way you write them in code
- **Angular HTML templates** (`.html`) — extracts component selectors, structural directives (`*ngIf`, `*ngFor`, `@if`, `@for`), event bindings (`(click)="handler"`), template references (`#userInput`), and `routerLink` directives; auto-detected via a sibling `.component.ts` file or Angular marker patterns
- **Extensionless scripts** — extensionless files (e.g. `plugins/*/functions` in Bash-heavy projects) are now discovered and indexed automatically; shebang detection routes each file to the correct handler

**Objective-C handler overhaul**

- `@interface`, `@protocol`, and `@implementation` declarations now fully extracted from both `.m` and `.h` files
- Named categories stored as `ClassName+CategoryName`; anonymous categories flagged with `classExtension: true`
- Full Objective-C selector building (`setObject:forKey:`) instead of plain method names
- Properties extracted with `property` kind (was `const`)
- `.h` files guarded by an ObjC detection pass — C headers that happen to use `.h` are not misidentified

**XML symbol disambiguation**

- Root-element symbols in multi-module XML repositories (e.g. `pom.xml` across 30+ Maven modules) are now stored as `tag@module` names, eliminating collisions where every module shared the same top-level element name
- Bare tag name retained as an FTS token so single-word queries still find the right file

**Search relevance improvements**

- *Monorepo path heuristics* — frontend app directories (`apps/dashboard/`, `apps/web/`) get a score boost when the query contains hook or component vocabulary; avoids backend symbols drowning React/Angular results in mixed monorepos
- *Java/Groovy core-path boost* — symbols in `/core/src/main/java/` paths boosted; symbols in plugin directories penalised; reduces noise from plugin implementations when querying for core API methods
- *Library path penalties* extended to cover `engine/`, `erts/`, and `contrib/` directory segments (common in projects that embed a runtime)
- *Compound underscore boost* — fires when all underscore-separated parts of a symbol name are present in the query, without requiring an exact full-name match
- *Single-token exact match boost* — single-word queries reliably surface the best exact match at rank 1
- *Cross-language FTS aliases* — Neovim `nvim_*` C functions get a `vim.api.nvim_*` alias so Lua-style queries (`vim.api.nvim_open_win`) find the C implementation; Proto RPC method symbols include their service name as an FTS token
- *Erlang bare function names* — Erlang symbols stored without arity suffix (`start_link` instead of `start_link/3`); arity preserved in `frameworkMeta`; module name injected as an FTS token so `module:function` queries work
- *TypeScript HOC detection* — `export const X = React.memo(() => ...)`, `forwardRef(...)`, and similar HOC-wrapped arrow functions emitted as `kind=function` instead of `kind=const`, ensuring rendering-domain boosts fire correctly

### Fixed

- Case-insensitive file extension matching in file discovery (`.F90` Fortran files were silently skipped)
- Directory trailing-slash handling in `ignore` negation patterns — fixes traversal of directories with explicit `!negation` rules
- Index workers were missing registrations for the Fortran, SCSS, LESS, CSS, and Objective-C handlers; files with those extensions were silently dropped before parsing
- C++ qualified name FTS — bare local name (`Future`) now stored as a separate FTS token alongside the fully-qualified name (`folly::Future`), improving single-word C++ queries
- Rust synonym scoping — `future→poll`, `spawn→tokio/task`, and serde-specific synonyms now fire only in Rust repositories, preventing them from polluting C++ search results

---

## [1.4.0] - 2026-05-20

### Added

**New MCP tools**

- `get_lexical_scope_matches` — returns all symbols accessible from a given file and line (local scope, module imports, and exported API), letting agents reason about what identifiers are in scope without reading whole files
- `trace_invocation_chain` — follows call edges from a symbol N hops deep and returns the linearised invocation path; useful for tracing a request from an entry point through to storage

**Language handler depth**

- *Ruby* — DSL macro extraction: `has_many`, `belongs_to`, `has_one`, `has_and_belongs_to_many`, `before_action`, `after_action`, `validates`, and `scope` class macros extracted as `property` symbols; metaprogramming patterns (`define_method`, `method_missing`) flagged in `frameworkMeta`
- *Rust* — `#[cfg(...)]` attributes now captured in `frameworkMeta.cfgAttributes`; new `cfgFilter` parameter on `search_symbols` restricts results to symbols matching a specific cfg condition (e.g. `target_os = "linux"`)
- *C++* — export-macro class extraction: `class MY_EXPORT ClassName` and similar patterns now correctly identified as class declarations rather than function definitions
- *TypeScript* — `export const X = forwardRef(...)` / `React.memo(...)` and similar HOC patterns emitted as `kind=function`; decorator extraction inside `export_statement` wrapper fixed (was silently dropping `@Injectable` and similar decorators on exported classes)
- *C#* — interface member extraction fixed (interface members are implicitly public; visibility guard removed); method name extraction uses `findLast` before `parameter_list` to avoid returning the return type; event field declarations (`event_field_declaration`) extracted as `property` kind
- *Kotlin* — extension function extraction; primary constructor property parameters extracted as `property` symbols
- *PHP* — PHP 8 `#[Attribute]` syntax parsed correctly; Symfony route and controller patterns added to quality-gate trigger; property declarations, `define()` constants, closures, abstract methods, enum cases, and interface constants all extracted

**Search quality**

- FTS BM25 raw rank exposed to the relevance ranker — high keyword-match scores contribute a 0–50 point bonus on top of structural scoring; prevents purely-structural boosts from overriding strong keyword matches
- Docstring extraction extended — Python and C++ full-paragraph docstrings (not just the first line) fed to the FTS index; improves matches for queries that use documentation vocabulary rather than identifier names
- Nuxt/Vue-specific vocabulary synonyms added (`composable`, `setup`, `defineComponent`, `useNuxt`, etc.)
- `search_symbols` returns `verdict: "no_match"` with `negative_evidence` details when all retrieval strategies are exhausted, allowing agents to stop retrying instead of looping through variant queries

**Multi-IDE installer**

`npx purecontext-mcp install <tool|all>` now supports:

| IDE / Tool | Config location |
|------------|----------------|
| Cursor | `.cursor/rules/purecontext.mdc` |
| Windsurf | `.windsurfrules` |
| Continue | `.continue/config.json` system message |
| Cline | `.clinerules` |
| Roo Code | `.roo/rules-code.md` |
| VS Code Copilot | `.github/copilot-instructions.md` |
| Claude Desktop | Platform config (`claude_desktop_config.json`) |

All writers are idempotent — running `install` a second time updates the existing block rather than appending a duplicate.

**Claude Code hooks**

- *PostToolUse index hook* — re-indexes modified files automatically after any Edit/Write tool call, keeping the symbol index in sync with in-session edits
- *PreCompact snapshot hook* — captures an architecture snapshot before context is compacted
- *Edit guard hook* (soft) — warns when an edit target has dependents with high blast radius; never blocks

Install via `npx purecontext-mcp hooks --install`.

### Fixed

- `expandVerbSynonyms`: prototype-chain collision on the `constructor` key — calling `expandVerbSynonyms("constructor")` previously returned the built-in `Function.prototype.constructor`; fixed by using `Object.create(null)` for the synonym map
- Test-mapper transaction: FK constraint errors no longer propagate and block FTS index population
- Windows path-case mismatch: repo ID computation now uses the canonical absolute path from the indexer output rather than recomputing from a potentially different-cased input string

---

## [1.3.0] - 2026-05-16

### Added

**Search quality**

- *OR-fallback retrieval* — when the FTS5 AND query returns too few results, the engine automatically retries with an OR query and re-ranks the combined pool; improves recall for longer, natural-language queries
- *Abbreviation expansion* — common abbreviations in queries expanded before FTS: `db→database`, `auth→authentication`, `cfg→configuration`, `mgr→manager`, `ctrl→controller`, and 40+ more; C/C++ abbreviations included
- *camelCase boundary tokenisation* — FTS5 index now correctly splits `getUserById` into `get`, `user`, `by`, `id` at index time, not just at query time; improves recall when query uses word-boundary terms that appear inside camelCase identifiers
- *Verb synonym expansion* — common verb synonyms expanded at query time: `fetch↔get↔retrieve`, `create↔insert↔add`, `delete↔remove↔drop`, `update↔modify↔edit`, `authenticate→login`, `list↔find`, and more
- *Stop-word expansion* — 30 additional stop words filtered from multi-word queries: `with`, `without`, `using`, `via`, `existing`, `before`, `after`, `during`, and others
- *Service/repository kind boost* — `*Service` method symbols +30, `*Repository`/`*Manager`/`*Store` method symbols +15; surfaces application-layer API methods before utility helpers with similar names
- *Method verb bonus* — fires when the first camelCase part of a method name (the action verb) matches a query word, differentiating `ProductsService.create` from `buildProductListCacheKey`
- *Quality-gate OR-fallback* — if the AND pool contains no `*Service`/`*Repository` methods even after the first OR-fallback, a second OR pass retrieves the broader candidate pool
- *Stem matching* — pluralised name parts (`products→product`) now match singular query words
- *Library path penalty* — symbols from `vendor/`, `node_modules/`, `bower_components/`, `third_party/`, and similar paths penalised to prevent dependency code from ranking above project code

**New stylesheet handlers**

- *SCSS / SASS* (`.scss`, `.sass`) — `@mixin` → function, `@function` → function, top-level `$variable` → const, `%placeholder` → class, `@keyframes` → type
- *LESS* (`.less`) — `.mixin(@params){}` → function, top-level `@variable` → const, `@keyframes` → type
- *CSS* (`.css`) — CSS custom properties (`--token-name`) indexed as const (opt-in via `indexing.cssVariables: true` in config)

**Handler depth improvements**

- *Go* — interface `method_spec` extraction; top-level `var` declarations; `*Handler`/`*DB`/`*Client` receiver types added to kind-boost patterns
- *Java* — inner-class extraction no longer gated on `isStatic`; package-private methods included; Android `Activity`/`Fragment`/`ViewModel` pattern boosts
- *Rust* — `impl` methods filtered to `pub` visibility by default; `trait` implementations boosted; Rust-specific synonyms scoped to Rust repos only
- *PHP* — UTF-8 multibyte character offset bug fixed (was producing broken symbol names for methods after accented characters in source); property declarations, closures, `define()` global constants, abstract methods, PHP 8.1 enum cases, and interface constants all extracted
- *TypeScript* — decorator extraction inside `export_statement` wrapper fixed

### Fixed

- FTS5 syntax error in synonym OR-groups: tokens joined as `(a OR b)` were concatenated without an explicit `AND` connector when followed by another group, producing invalid FTS5 queries; fixed by inserting explicit ` AND ` between groups and checking for top-level OR context before switching to OR-fallback mode
- `namePrefix` word-boundary guard: stem matching no longer fires when a name only contains the query word as an interior substring (e.g. query `user` no longer matches `superuser` via stem)
- Short-token filter in multi-word query branch: tokens shorter than 2 characters no longer enter the AND query, preventing FTS5 from returning zero results on trivially-true constraints

---

## [1.2.0] - 2026-05-13

### Added

**Advanced relationship analysis**
- `find_implementations` — find all concrete implementations of a TypeScript interface or abstract class; returns implementing classes with `implementedMethods` and `missingMethods` arrays compared against the interface contract
- `get_call_hierarchy` — callers and callees of a function N levels deep as a hierarchical tree; supports `callers`, `callees`, and `both` directions; recursive calls marked `cyclic: true`
- `get_class_hierarchy` — full inheritance tree rooted at a class, showing both ancestors and descendants; use before refactoring a base class to understand the full polymorphism surface
- `find_cycles` — detect circular import dependencies across the repo or a subtree; returns strongly-connected components with severity rating
- `get_coupling_map` — afferent/efferent coupling metrics and instability scores (`I = efferent / (afferent + efferent)`) for every file; highlights highest-risk refactoring candidates

**Architectural visualization**
- `render_diagram` — general-purpose Mermaid or DOT dependency diagram (module, call graph, class hierarchy); output renders natively in GitHub, VS Code, and Claude
- `render_call_graph` — specialized call graph diagram rooted at a symbol with call-graph-specific layout options
- `render_import_graph` — file-level import graph for a directory or whole repo; nodes clustered by directory
- `render_class_hierarchy` — class inheritance diagram in Mermaid `classDiagram` format; shows fields, methods, and inheritance/implementation relationships
- `render_dep_matrix` — dependency matrix diagram showing coupling between modules as a grid; surfaces structural hotspots at a glance
- `get_architecture_snapshot` — captures architectural state (file count, symbol count, module breakdown, coupling summary, health scores); take two snapshots to prove structural improvement objectively

**Refactoring safety checks**
- `check_rename_safe` — pre-flight check before renaming a symbol; returns `safe` verdict and all `affectedSites` (call, import, type-reference, string-literal, comment) with file, line, column, and context snippet
- `check_delete_safe` — pre-flight check before deleting a symbol; returns `safe: false` if anything in the repo still imports or references the symbol
- `check_move_safe` — pre-flight check before moving a symbol to a different file; validates no import conflicts and lists all import statements that need updating
- `plan_refactoring` — generate a sequenced, dependency-ordered plan for a structural change from a natural-language description; steps ordered so lower-risk changes happen first

**Health dashboards & debt reporting**
- `health_radar` — five-axis health score (complexity, coupling, maintainability, documentation, stability), each 0–100; returns `overallHealth` score and letter grade (A–F); designed for CI health gates
- `diff_health_radar` — compare two health radar snapshots (before/after a refactoring) with axis-by-axis deltas and regression/improvement verdicts
- `get_debt_report` — detailed technical debt report with per-file rankings, priority tiers, worst files by each metric, specific symbols to address, and estimated effort indicators

**AST-level search**
- `search_ast` — find every occurrence of a specific tree-sitter node type across all indexed files (e.g. `try_statement`, `arrow_function`, `await_expression`); returns file, line, column, and snippet
- `search_by_signature` — search symbols by type signature pattern (regex or substring); find all functions returning `Promise<void>` or methods accepting a `Request` parameter
- `search_by_decorator` — find all symbols annotated with a specific decorator; works for TypeScript (`@Injectable`, `@Controller`) and Python (`@app.route`, `@property`) decorators
- `search_by_complexity` — find symbols above or below a complexity threshold; returns symbols ranked by complexity score; use before refactoring sprints or to enforce complexity budgets

**Code intelligence helpers**
- `get_entry_points` — identify all runnable entry points: main functions, CLI handlers, HTTP server startups, Lambda handlers, test suites, and scripts; each result includes `kind`, `confidence`, and reason
- `get_public_api` — all exported symbols grouped by file; use to document a library, audit what is exposed, or check for accidental exports
- `get_todos` — find all TODO, FIXME, HACK, NOTE, and XXX comments across the repo with file, line, tag type, and comment text
- `get_complexity_hotspots` — symbols ranked by complexity score, highest first; use to identify the worst functions before a refactoring sprint
- `get_type_graph` — type dependency graph showing which types reference which other types, rooted at a specific type or across the whole repo; supports `uses`, `usedBy`, and `both` directions
- `find_untested_symbols` — exported symbols with no corresponding test coverage, ranked by complexity (highest priority first); uses import-based heuristics
- `get_test_coverage_map` — per-file coverage map showing which symbols are referenced by test files and which are not; produces `coverageRatio` per file and aggregated totals

**Documentation guides**
- `AST-SEARCH.md` — guide to AST-level search tools and tree-sitter node types
- `CODE-INTELLIGENCE.md` — guide to code intelligence helper tools
- `HEALTH-DASHBOARDS.md` — guide to health radar, debt reporting, and architecture snapshots
- `REFACTORING-SAFELY.md` — guide to refactoring safety check tools and pre-flight workflows
- `UNDERSTANDING-RELATIONSHIPS.md` — guide to relationship analysis tools (call hierarchy, class hierarchy, coupling)
- `VISUALIZING-CODE.md` — guide to diagram rendering tools and Mermaid output
- `WORKFLOW-TECH-DEBT.md` — end-to-end tech debt sprint workflow

### Fixed

- Token savings tracker: corrected cumulative savings calculation and fixed display in web UI
- Web UI: dependency graph and repo detail pages now render correctly after token tracker refactor
- Docker: UI workspace panel and repo list routing fixes

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
