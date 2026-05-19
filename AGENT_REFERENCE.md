# PureContext MCP — Agent Reference

Full tool reference, navigation patterns, search tips, and known limitations.
The always-on instructions (mandatory workflow, decision rules, anti-patterns) live in `~/.claude/CLAUDE.md`.

---

## Indexing tools

### `list_repos`
Always call this first. Returns all indexed repos with their `repoId`, path, file count, and last indexed time.

### `index_folder`
Index a local directory. Returns `repoId`. Re-indexing is incremental — only changed files are re-parsed.

- `path` (required) — absolute path to project root
- `force` (optional) — set `true` to force re-index of all files, even unchanged ones
- `fileLimit` (optional) — override the configured file limit for this run

### `resolve_repo`
Convert a local path to its `repoId` without indexing. Use when the project is already indexed but you don't have the `repoId` at hand.

### `invalidate_cache`
Force a full re-index by clearing content hashes. Use when the index seems stale and `index_folder` is not picking up changes.

### Keeping the index fresh

The file watcher triggers incremental re-indexing automatically. If you suspect the index is stale:

```
index_folder({ path, force: false })   → incremental (changed files only)
index_folder({ path, force: true })    → full re-index (all files)
invalidate_cache({ repoId })           → clear hashes, then index_folder
```

---

## Symbol search & retrieval

### `search_symbols` — primary navigation tool
Search by name fragment. Use this for almost all navigation tasks.

```json
{ "repoId": "...", "query": "authenticate", "kind": "function", "limit": 10 }
```

- Returns signatures and summaries — no source code
- `kind` filter: `function`, `class`, `method`, `route`, `component`, `hook`, `middleware`, etc.
- `camelCase`, `snake_case`, and space-separated queries are equivalent
- Use `mode: "hybrid"` for best recall when unsure of the exact name
- When the response includes `negative_evidence.verdict: "no_match"` — the symbol does not exist; do not re-search

### `search_semantic`
Search by meaning, not name. Use when you know what the code does but not what it is called.

```json
{ "repoId": "...", "query": "validates user credentials and returns a session token", "mode": "hybrid", "max_results": 10 }
```

Requires semantic search enabled in config. Falls back to FTS5 keyword search automatically if unavailable.

### `search_text`
Grep-style full-text search. Use for literal strings, error messages, config values, comments — anything that is not a symbol name.

```json
{ "repoId": "...", "query": "TODO: fix this", "context_lines": 3 }
```

### `get_symbol_source`
Retrieve the source code of a specific symbol by its ID.

```json
{ "repoId": "...", "symbolId": "8f3a2c1d0e4b5f9a", "context_lines": 2 }
```

- `symbolId` comes from `search_symbols` or `get_file_outline` results
- `context_lines` — include surrounding lines for additional context
- `verify: true` — confirm the source on disk matches the index (after recent file edits)

### `get_symbols`
Batch-fetch multiple symbols by ID in a single call. Prefer this over calling `get_symbol_source` repeatedly.

```json
{ "repoId": "...", "symbolIds": ["id1", "id2", "id3"] }
```

### `get_file_content`
Retrieve raw file content with optional line range. Use only for content that is not a named symbol — top-level imports, configuration blocks, non-symbol prose.

```json
{ "repoId": "...", "filePath": "src/config/settings.ts", "startLine": 1, "endLine": 40 }
```

### `get_file_outline`
All symbols in a single file with signatures and summaries. Use to survey a file without reading its content.

### `get_repo_outline`
All files in the repo with their top-level symbols. Use to orient yourself in an unfamiliar project.

### `get_file_tree`
Directory tree with file counts. Use when you need to understand the project's folder structure.

### `find_references`
Find all usage sites for a symbol across the repo. Use before renaming or modifying a symbol.

---

## Dependency graph tools

### `get_context_bundle`
Forward-walk from a symbol — returns the symbol and everything it transitively imports. Use before modifying a function to understand its full context.

```json
{ "repoId": "...", "symbolId": "...", "maxDepth": 2, "maxTokens": 4000 }
```

Use `maxTokens` to cap the response size when working with deeply connected code.

### `get_blast_radius`
Reverse-walk — all files that transitively import a symbol. Use before modifying or deleting a symbol to understand what would break.

```json
{ "repoId": "...", "symbolId": "...", "maxDepth": 5 }
```

### `find_importers`
Direct (one-hop) importers of a file. Faster than `get_blast_radius` when you only need the immediate callers.

### `find_dead_code`
Exported symbols that nothing else imports. Use for cleanup audits. May produce false positives for dynamic imports and symbols consumed by external npm consumers.

---

## Architecture & quality tools

### `get_layer_violations`
Detect architectural import boundary violations. Requires layer boundaries defined in config.

### `get_quality_metrics`
Per-file complexity, coupling, cohesion, and documentation coverage scores. Use instead of making subjective assessments from reading source code. Complexity scores are directional signals, not exact measurements.

### `detect_antipatterns`
Detect common architectural anti-patterns (god classes, circular dependencies, dead code). Returns structured results with severity levels. Cannot detect runtime coupling or dynamic dispatch issues.

### `get_architecture_doc`
Auto-generate an architecture summary in Markdown or Mermaid format. Requires `ai.allowRemoteAI: true`.

**Pre-refactoring workflow:**
```
get_quality_metrics  → find worst files
detect_antipatterns  → find structural issues
get_blast_radius     → understand impact scope
get_architecture_doc → generate "before" snapshot
[make changes]
detect_antipatterns  → verify anti-patterns resolved
```

---

## Git & history tools

### `get_symbol_history`
Symbol-level git commit history. Returns structured JSON with commits, authors, and diffs.

- Rename/move breaks history continuity — symbols in renamed files start fresh history from the rename commit
- After a rebase, run `invalidate_cache` + `index_folder` to rebuild accurate history
- Default `maxCommits: 500` cap — increase `git.maxCommits` for history-sensitive workflows

### `get_churn_metrics`
File and symbol churn metrics. Before modifying any symbol, check churn: if `churnScore > 6`, mention this to the user and suggest extra testing. High-churn files are under active development or chronically buggy.

For debugging, use `get_churn_metrics` to find recently-changed symbols — recent changes are the most likely source of new bugs.

---

## Cross-repo tools

### `search_cross_repo`
Search symbols across multiple indexed repositories simultaneously.

### `find_similar`
Find semantically similar code across repos. Before implementing new functionality, call this to check if equivalent code already exists. Requires semantic search enabled.

Before modifying shared library code, use `get_blast_radius` with `crossRepo: true`.

**Note:** `crossRepoDeps` requires explicit package name configuration — no auto-detection of Nx/Turborepo/Lerna workspaces.

---

## Ecosystem & data tools

### `search_columns`
Search column definitions across dbt models. Returns full upstream/downstream lineage.

- dbt-only — does not search columns in raw SQL `CREATE TABLE` statements
- Always run `dbt compile` before `index_folder` — stale manifests produce incorrect lineage
- Use `search_symbols` with `kind: "route"` to find API endpoints via the OpenAPI provider

**Templating coverage:** Jinja preprocessing is dbt SQL only. Helm, Ansible Jinja2, Kubernetes YAML, ERB, and Kustomize are not preprocessed. Terraform is fully supported.

---

## Advanced relationship analysis tools

### `find_implementations`
Find all concrete implementations of an interface or abstract class. Returns `implementedMethods` and `missingMethods` per class. Use before modifying an interface to know every class that must be updated.

- `includeAbstract` (optional) — also include abstract subclasses (default false)
- `limit` (optional) — max results (default 50)

### `get_call_hierarchy`
Return callers and callees of a function, N levels deep, as a tree. Recursive calls marked `cyclic: true`.

```json
{ "repoId": "...", "symbolId": "...", "direction": "callees", "maxDepth": 3, "maxNodes": 50 }
```

- `direction`: `"callees"`, `"callers"`, or `"both"`
- Uses import-edge graph, not runtime call data — dynamic dispatch, `eval`, and reflection are invisible

### `get_class_hierarchy`
Full inheritance tree rooted at a class — ancestors (what it extends) and descendants (what extends it).

- `direction`: `"ancestors"`, `"descendants"`, or `"both"` (default)
- `maxDepth` (optional, default 5)

### `find_cycles`
Detect circular import dependencies. Returns strongly-connected components with severity ratings.

- `scope` (optional) — directory prefix to restrict analysis
- `minCycleLength` (optional) — ignore trivial self-referential entries (default 2)

### `get_coupling_map`
Afferent/efferent coupling metrics per file. Returns instability scores (`I = efferent / (afferent + efferent)`).

- `scope` (optional), `limit` (optional, default 50)

---

## Visualization tools

### `render_diagram`
Generate a Mermaid or DOT diagram from the dependency graph.

```json
{ "repoId": "...", "type": "module", "format": "mermaid", "maxNodes": 30, "maxDepth": 3 }
```

- `type`: `"module"` / `"import"` (file-level), `"call"` (call graph, requires `rootSymbolId`), `"class"` (hierarchy, requires `rootSymbolId`)
- `format`: `"mermaid"` (renders in GitHub, VS Code, Claude) or `"dot"` (Graphviz)
- Diagrams with >50 nodes become unreadable — use `maxNodes` to cap

### `render_call_graph` / `render_import_graph` / `render_class_hierarchy` / `render_dep_matrix`
Specialized variants of `render_diagram` for specific diagram types.

### `get_architecture_snapshot`
Capture the current architectural state: file count, symbol count, module breakdown, coupling summary, health scores. Take two snapshots (before/after a refactoring) to prove structural improvement objectively.

---

## Refactoring safety tools

Always run these before executing a structural change. They give a binary `safe` verdict.

### `check_rename_safe`
```json
{ "repoId": "...", "symbolId": "...", "newName": "processOrderV2" }
```
Returns `safe`, `verdict`, and all `affectedSites` with file, line, column, context snippet, and change type. `safe: false` when the new name conflicts with an existing symbol, or when string-literal references exist that require human judgment.

### `check_delete_safe`
Returns `safe: false` if anything still imports or references the symbol. Lists all blocking references.

### `check_move_safe`
Validates the move won't break imports, that the target file doesn't already define the same name, and returns all import statements that will need updating.

### `plan_refactoring`
Generate a sequenced, dependency-ordered plan for a structural change.

```json
{ "repoId": "...", "description": "Extract auth logic from UserService into AuthService", "scope": "src/services/" }
```

Step ordering is heuristic — validate against actual dependency analysis.

---

## Health & debt tools

### `health_radar`
Five-axis health radar. Each axis scores 0–100 (100 = perfectly healthy).

| Axis | What it measures |
|------|-----------------|
| `complexity` | Inverse of average/peak cyclomatic complexity |
| `coupling` | Inverse of high-coupling file density |
| `maintainability` | Inverse of dead-code and god-class density |
| `documentation` | Percentage of symbols with non-trivial summaries |
| `stability` | Inverse of churn-hotspot density (requires git metadata) |

```json
{ "repoId": "...", "scope": "src/core/", "includeStability": true }
```

Set `includeStability: false` if the repo has no git history.

### `diff_health_radar`
Compare two health radar snapshots axis-by-axis. Use with `get_architecture_snapshot` for before/after evidence.

### `get_debt_report`
Detailed debt report with per-file rankings, priority tiers, and actionable recommendations.

- `scope` (optional), `maxFiles` (optional, default 10), `includeDead` (optional)

---

## AST-level search tools

These re-parse stored file content using tree-sitter grammars. Only files backed by a WASM grammar are searched — regex-only handlers are silently skipped; use `search_text` for those.

### `search_ast`
Find every occurrence of a specific tree-sitter node type.

```json
{ "repoId": "...", "nodeType": "try_statement", "filePath": "src/", "limit": 50 }
```

Common node types:

| Language | Node types |
|----------|-----------|
| TypeScript/JS | `arrow_function`, `function_declaration`, `class_declaration`, `interface_declaration`, `try_statement`, `await_expression`, `call_expression`, `import_statement`, `jsx_element`, `throw_statement`, `type_alias_declaration` |
| Python | `function_definition`, `class_definition`, `for_statement`, `with_statement`, `decorated_definition`, `lambda` |
| Rust | `function_item`, `struct_item`, `impl_item`, `match_expression`, `closure_expression`, `trait_item` |
| Go | `function_declaration`, `method_declaration`, `go_statement`, `defer_statement`, `type_declaration` |

### `search_by_signature`
Search symbols by type signature pattern (regex or substring).

```json
{ "repoId": "...", "pattern": "Promise<.*>", "kind": "function" }
```

### `search_by_decorator`
Find all symbols annotated with a specific decorator.

```json
{ "repoId": "...", "decorator": "Injectable", "kind": "class" }
```

### `search_by_complexity`
Find symbols above a complexity threshold.

```json
{ "repoId": "...", "minComplexity": 10, "kind": "function", "limit": 20 }
```

---

## Code intelligence tools

### `get_entry_points`
Identify all runnable entry points: main functions, CLI handlers, HTTP server startups, Lambda handlers, test suites, scripts. Each result includes `kind`, `confidence` (`high`/`medium`/`low`), and the reason for classification.

- `kind` (optional): `main_function`, `cli_handler`, `server_startup`, `lambda_handler`, `test_suite`, `script`
- `minConfidence` (optional): `"high"`, `"medium"`, or `"low"` (default)

### `get_public_api`
All exported symbols grouped by file — the public API surface of the repo or a module.

- `filePath` (optional), `kind` (optional), `includeMembers` (optional), `groupByFile` (optional, default true)

### `get_todos`
All TODO, FIXME, HACK, NOTE, and XXX comments. Returns file, line, tag type, and comment text.

- `tags` (optional), `filePath` (optional), `limit` (optional, default 200)

### `get_complexity_hotspots`
Symbols ranked by complexity score, highest first.

- `kind` (optional), `filePath` (optional), `limit` (optional, default 20), `minComplexity` (optional)

### `get_type_graph`
Type dependency graph — which types reference which other types.

- `symbolId` (optional) — root at a specific type
- `maxDepth` (optional, default 3)
- `direction`: `"uses"`, `"usedBy"`, or `"both"`

### `find_untested_symbols`
Exported symbols with no corresponding test coverage (import-based heuristics, not runtime coverage).

- `filePath` (optional), `kind` (optional), `limit` (optional, default 50)

### `get_test_coverage_map`
Per-file coverage map with `coverageRatio` per file and aggregated totals.

- `filePath` (optional), `includeSymbols` (optional, default false)

---

## Navigation patterns

### Understand an unfamiliar codebase
```
1. list_repos()                            → check if indexed
2. index_folder({ path })                  → index if needed, get repoId
3. get_repo_outline({ repoId })            → survey the structure
4. search_symbols({ query: "..." })        → locate key symbols
5. get_context_bundle({ symbolId })        → understand entry + dependencies
```

### Modify a function safely
```
1. search_symbols({ query: "functionName", kind: "function" })
2. get_blast_radius({ symbolId })          → know the impact scope BEFORE touching it
3. get_context_bundle({ symbolId, maxDepth: 2 }) → understand its context
4. get_symbol_source({ symbolId })         → read the implementation
5. [make the change]
6. find_dead_code({ repoId })              → verify no orphaned exports left behind
```

### Modify a high-risk symbol safely
```
1. search_symbols({ query: "functionName", kind: "function" })
2. get_churn_metrics({ repoId, symbolId }) → if churnScore > 6, warn the user
3. get_symbol_history({ symbolId })        → understand recent change context
4. get_blast_radius({ symbolId })          → know full impact scope
5. get_context_bundle({ symbolId, maxDepth: 2 })
6. get_symbol_source({ symbolId })
7. [make the change]
8. find_dead_code({ repoId })
```

### Find where something is called
```
1. search_symbols({ query: "symbolName" })
2. find_references({ symbolId })           → all call sites
3. get_symbol_source for relevant call sites
```

### Search when you know the concept but not the name
```
1. search_semantic({ query: "natural language description", mode: "hybrid" })
2. Review signatures and summaries
3. get_symbol_source for the best match
```

### Modify an interface or base class safely
```
1. search_symbols({ query: "InterfaceName", kind: "interface" })
2. find_implementations({ symbolId })      → all classes that must be updated
3. get_class_hierarchy({ symbolId, direction: "descendants" })
4. get_blast_radius({ symbolId })
5. [make the change]
6. find_implementations({ symbolId })      → verify missingMethods is empty
```

### Refactor safely (rename / delete / move)
```
1. search_symbols({ query: "symbolName" })
2. check_rename_safe / check_delete_safe / check_move_safe
3. If safe: proceed. If not safe: resolve blockers in affectedSites first, then re-check.
4. find_dead_code({ repoId })              → verify no orphaned exports remain
```

### Tech debt sprint
```
1. health_radar({ repoId })                → 5-axis baseline
2. get_debt_report({ repoId })             → per-file rankings + recommendations
3. get_complexity_hotspots({ repoId })     → worst functions first
4. find_untested_symbols({ repoId })       → coverage gaps
5. find_cycles({ repoId })                 → circular deps to break
6. get_architecture_snapshot({ repoId })   → baseline snapshot before changes
7. [fix highest-priority items]
8. get_architecture_snapshot({ repoId })   → after snapshot
9. diff_health_radar({ before, after })    → prove the improvement
```

### Debug a recent regression
```
1. get_churn_metrics({ repoId })           → find recently-changed files
2. get_symbol_history({ symbolId })        → check commits in the affected area
3. search_symbols in changed files         → find the suspect functions
4. get_symbol_source → get_context_bundle  → read and understand the change
```

### PR review
```
1. [obtain list of changed files from PR]
2. get_symbol_history for changed symbols  → understand prior context
3. get_churn_metrics for changed files     → flag hotspots
4. get_blast_radius for each modified symbol
5. detect_antipatterns({ repoId })         → flag new structural issues
```

### Architecture review / onboarding
```
1. list_repos → index_folder if needed
2. get_architecture_doc({ repoId })        → generate project overview
3. get_quality_metrics({ repoId })         → identify weakest files
4. detect_antipatterns({ repoId })         → find structural issues
5. get_repo_outline({ repoId })            → survey specific areas
```

---

## Search tips

- **camelCase and snake_case are equivalent** — `processOrder` and `process_order` return the same results
- **Short queries rank better** — `auth` finds more than `authentication middleware function`
- **Use `kind` to narrow results** — `kind: "function"` eliminates class/method noise
- **Use `filePath` to scope** — `filePath: "src/auth/"` restricts to a directory
- **Use `debug: true` to diagnose ranking** — shows BM25 scores and name boost factors
- **For hybrid mode** — `semantic_weight: 0.6, keyword_weight: 0.4` is a good starting point

---

## `_tokenEstimate` and `_meta`

Every response includes:

```json
"_meta": { "timing_ms": 3, "tokens_saved": 1842, "total_tokens_saved": 45231 }
```

`_tokenEstimate` — rough token count of the returned payload. Use it to:
- Decide whether to fetch additional context or stop
- Cap `maxTokens` in `get_context_bundle` to avoid hitting context limits
- Track cumulative savings with `get_savings_stats`

---

## Known limitations

| Area | Limitation | Workaround |
|------|-----------|-----------|
| **AI Summaries** | Summaries describe intent, not contract. Stale summaries exist until re-index. | Always verify with `get_symbol_source` before modifying. |
| **AI Summaries** | `get_architecture_doc` requires `ai.allowRemoteAI: true`. | `detect_antipatterns` and `get_quality_metrics` work without AI. |
| **Git History** | Rename/move breaks history continuity. | Future: `git log --follow` tracking. |
| **Git History** | Rebase invalidates commit hashes — re-index required. | Run `invalidate_cache` + `index_folder` post-rebase. |
| **Git History** | Default `maxCommits: 500` drops early history on long-lived projects. | Increase `git.maxCommits` in config. |
| **Git History** | No SVN/Mercurial/Perforce support. | Git is a hard requirement for history features. |
| **Cross-Repo** | `crossRepoDeps` is manual — no auto-detection of Nx/Turborepo/pnpm workspaces. | Explicitly list package names in each repo's config. |
| **Cross-Repo** | `find_similar` requires semantic search and an embedding provider. | Use a local Ollama model as a zero-cost alternative. |
| **Cross-Repo** | MCP Resources `resources/subscribe` not yet supported by Claude Code or Cursor. | Poll with `search_cross_repo`. |
| **Architecture** | Quality metrics use estimated complexity (nesting heuristics), not true AST branch-counting. | Treat scores as directional signals. |
| **Architecture** | `detect_antipatterns` cannot detect runtime coupling or dynamic dispatch. | Complement with runtime profiling. |
| **Architecture** | `get_layer_violations` needs layer boundaries defined in config first. | Requires upfront config investment. |
| **Ecosystem** | Jinja preprocessing is dbt SQL only — Helm, Ansible, ERB, Kustomize not supported. | Use Terraform for IaC where possible. |
| **Ecosystem** | `search_columns` is dbt-only — does not cover `CREATE TABLE` SQL columns. | Use `get_symbol_source` on the `CREATE TABLE` symbol. |
| **Ecosystem** | dbt indexer does not detect stale `manifest.json`. | Always run `dbt compile` before `index_folder`. |
| **Relationship Analysis** | `find_implementations` may miss implementations in files that don't import the interface. | Check `get_blast_radius` for files that transitively depend on the interface file. |
| **Relationship Analysis** | `get_call_hierarchy` uses import-edge graph — dynamic dispatch, `eval`, and reflection are invisible. | Complement with runtime profiling for highly dynamic code. |
| **Visualization** | Mermaid diagrams with >50 nodes become unreadable. | Use `maxNodes` to cap; use `scope`/`filePath` to restrict to a module. |
| **Visualization** | DOT output requires Graphviz — not available natively in Claude or GitHub. | Use `format: "mermaid"`. |
| **Refactoring Safety** | `check_rename_safe` flags string-literal references but cannot determine if they are intentional. | String-literal blockers always require human review. |
| **Refactoring Safety** | `plan_refactoring` generates heuristic step ordering — effort is approximate. | Validate step order against actual dependency analysis. |
| **Health & Debt** | `health_radar` stability axis requires git metadata. | Set `includeStability: false` if no git history. |
| **Code Intelligence** | `find_untested_symbols` uses import heuristics, not runtime coverage. | Combine with Istanbul/c8 for precise branch-level coverage data. |
| **AST Search** | `search_ast` only searches files backed by a WASM grammar — regex-only handlers silently skipped. | Use `search_text` for content in unsupported file types. |
