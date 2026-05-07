# PureContext MCP — AI Agent Instructions

These instructions tell AI agents how to use PureContext MCP correctly for token-efficient code navigation. Add this file to your agent's rules (CLAUDE.md, Windsurf rules, Cursor rules, etc.).

---

## What PureContext MCP is

PureContext MCP is a structured code navigation server. It indexes a codebase using tree-sitter AST parsing, stores symbol metadata in SQLite, and exposes MCP tools so you can retrieve precisely the code you need — without reading entire files.

**Token savings:** Retrieving a 45-line function by name costs ~150 tokens. Reading the 800-line file it lives in costs ~2,000 tokens. PureContext saves 88–98% of context tokens on typical navigation tasks.

---

## Mandatory workflow — always follow this order

### Step 1 — Check if the project is indexed

Before doing any code navigation, call `list_repos` to see what is already indexed.

```
list_repos()
```

If the current project is not in the list, index it first:

```
index_folder({ path: "/absolute/path/to/project" })
```

**Never skip this step.** All other tools require a `repoId`. `index_folder` returns the `repoId` you will use in every subsequent call. Save it.

### Step 2 — Navigate by symbol, not by file

Do **not** read entire files to find code. Use the tools:

| Goal | Tool to use |
|------|-------------|
| Find a function/class/method by name | `search_symbols` |
| Find code by what it does | `search_semantic` |
| Find a literal string, comment, or config value | `search_text` |
| See all symbols in one file | `get_file_outline` |
| See the whole project structure | `get_repo_outline` |

### Step 3 — Read summaries before fetching source

`search_symbols` returns signatures and summaries — **no source code**. This is intentional. Read the `summary` field first to decide whether a symbol is relevant. Fetch the implementation only for symbols you will actually work with:

```
get_symbol_source({ repoId, symbolId })
```

Do not call `get_symbol_source` for every result in a search. Summaries let you navigate without reading source, saving 10–50× tokens on typical lookups.

**Trust but verify:** summaries describe intent, not contract. For modification tasks, always read the source after using the summary to navigate. An AI-generated summary describes what a function is meant to do — source code is ground truth.

---

## Tool reference — when to use each tool

### Indexing tools

#### `list_repos`
Always call this first. Returns all indexed repos with their `repoId`, path, file count, and last indexed time.

#### `index_folder`
Index a local directory. Returns `repoId`. Re-indexing is incremental — only changed files are re-parsed. Call it again if files have changed since the last index.

**Parameters:**
- `path` (required) — absolute path to project root
- `force` (optional) — set `true` to force re-index of all files, even unchanged ones
- `fileLimit` (optional) — override the configured file limit for this run

#### `resolve_repo`
Convert a local path to its `repoId` without indexing. Use this when you know the project is already indexed but don't have the `repoId` at hand.

#### `invalidate_cache`
Force a full re-index by clearing content hashes. Use when the index seems stale and `index_folder` is not picking up changes.

---

### Symbol search & retrieval

#### `search_symbols` — primary navigation tool
Search by name fragment. Use this for almost all navigation tasks.

```json
{
  "repoId": "a1b2c3d4e5f60001",
  "query": "authenticate",
  "kind": "function",
  "limit": 10
}
```

- Returns signatures and summaries — **no source code**
- Use the `kind` filter to narrow results: `function`, `class`, `method`, `route`, `component`, `hook`, `middleware`, etc.
- `camelCase`, `snake_case`, and space-separated queries are equivalent: `processOrder`, `process_order`, and `process order` return the same results
- Use `mode: "hybrid"` for best recall when unsure of the exact name

#### `search_semantic`
Search by meaning, not name. Use when you know what the code does but not what it is called.

```json
{
  "repoId": "...",
  "query": "function that validates user credentials and returns a session token",
  "mode": "hybrid",
  "max_results": 10
}
```

Requires semantic search to be enabled in config. Falls back to FTS5 keyword search automatically if the HNSW index is not available.

#### `search_text`
Grep-style full-text search across file content. Use for finding literal strings, error messages, config values, comments, or anything that is not a symbol name.

```json
{
  "repoId": "...",
  "query": "TODO: fix this",
  "context_lines": 3
}
```

Do **not** use `search_text` when you are looking for a function or class — use `search_symbols` instead. `search_text` searches raw file content, not the symbol index.

#### `get_symbol_source`
Retrieve the source code of a specific symbol by its ID.

```json
{
  "repoId": "...",
  "symbolId": "8f3a2c1d0e4b5f9a",
  "context_lines": 2
}
```

- `symbolId` comes from `search_symbols` or `get_file_outline` results
- Use `context_lines` to include surrounding lines for additional context
- Use `verify: true` when you need to confirm the source on disk matches the index (after recent file edits)

#### `get_symbols`
Batch-fetch multiple symbols by ID in a single call. Prefer this over calling `get_symbol_source` repeatedly when you need several symbols.

```json
{
  "repoId": "...",
  "symbolIds": ["id1", "id2", "id3"]
}
```

#### `get_file_content`
Retrieve raw file content with optional line range. Use only when you need to read a section of a file that is not a named symbol — for example, top-level imports, configuration blocks, or non-symbol prose.

```json
{
  "repoId": "...",
  "filePath": "src/config/settings.ts",
  "startLine": 1,
  "endLine": 40
}
```

Do **not** use `get_file_content` as a substitute for `get_symbol_source`. Always prefer symbol-level retrieval.

#### `get_file_outline`
All symbols in a single file with signatures and summaries. Use to survey a file without reading its content.

#### `get_repo_outline`
All files in the repo with their top-level symbols. Use to orient yourself in an unfamiliar project.

#### `get_file_tree`
Directory tree with file counts. Use when you need to understand the project's folder structure.

#### `find_references`
Find all usage sites (call sites, references) for a symbol across the repo. Use before renaming or modifying a symbol to understand all places that use it.

---

### Dependency graph tools

#### `get_context_bundle`
Forward-walk from a symbol — returns the symbol and everything it transitively imports. Use **before modifying a function** to understand its full context.

```json
{
  "repoId": "...",
  "symbolId": "...",
  "maxDepth": 2,
  "maxTokens": 4000
}
```

Use `maxTokens` to cap the response size when working with deeply connected code.

#### `get_blast_radius`
Reverse-walk — all files that transitively import a symbol. Use **before modifying or deleting a symbol** to understand what would break.

```json
{
  "repoId": "...",
  "symbolId": "...",
  "maxDepth": 5
}
```

#### `find_importers`
Direct (one-hop) importers of a file. Faster than `get_blast_radius` when you only need the immediate callers.

#### `find_dead_code`
Exported symbols that nothing else imports. Use for cleanup audits. Note: may produce false positives for dynamic imports and symbols consumed by external npm consumers.

---

### Architecture & quality tools

#### `get_layer_violations`
Detect architectural import boundary violations. Use when enforcing layered architecture rules.

#### `get_quality_metrics`
Per-file complexity, coupling, cohesion, and documentation coverage scores. Always use this instead of making subjective assessments from reading source code. Treat complexity scores as directional signals — cyclomatic complexity is estimated from symbol count and nesting depth, not exact AST branch-counting.

#### `detect_antipatterns`
Detect common architectural anti-patterns (god classes, circular dependencies, dead code) across the repo. Returns structured results with severity levels and actionable locations. Only detects static patterns — cannot find runtime coupling or dynamic dispatch issues.

#### `get_architecture_doc`
Auto-generate an architecture summary in Markdown or Mermaid format. Requires `ai.allowRemoteAI: true`. Use early when onboarding to an unfamiliar codebase. The generated doc is always accurate because it derives from the actual index, not hand-written documentation.

**Pre-refactoring workflow:**
```
get_quality_metrics → find worst files
detect_antipatterns → find structural issues
get_blast_radius    → understand impact scope
get_architecture_doc → generate "before" snapshot
[make changes]
detect_antipatterns → verify anti-patterns resolved
```

---

### Git & history tools

#### `get_symbol_history`
Symbol-level git commit history. Returns structured JSON with commits, authors, and diffs — no shell commands needed. Use to understand why a function was written the way it is, and to answer "who wrote this?" or "who should review this change?" without running `git log` or `git blame`.

**Limitations:** Rename/move breaks history continuity — symbols in renamed files start fresh history from the rename commit. After a rebase, run `invalidate_cache` + `index_folder` to rebuild accurate history.

#### `get_churn_metrics`
File and symbol churn metrics. Use to identify high-risk files before making changes. **Before modifying any symbol, check churn:** if `churnScore > 6`, mention this to the user and suggest extra testing. High-churn files are under active development (merge conflict risk) or chronically buggy (regression risk).

**For debugging:** Use `get_churn_metrics` to identify recently-changed symbols — recent changes are the most likely source of new bugs. This narrows the search space dramatically.

**Note:** The default `maxCommits: 500` cap means long-lived projects may lose early history. Increase `git.maxCommits` for history-sensitive workflows.

---

### Cross-repo tools

#### `search_cross_repo`
Search symbols across multiple indexed repositories simultaneously. Use for architectural questions like "which services handle email sending?" or "where is `UserProfile` defined?" — a single call replaces N per-repo queries.

#### `find_similar`
Find semantically similar code across repos using the HNSW vector index. **Before implementing new functionality**, call this to check if equivalent code already exists elsewhere in the organization. Requires semantic search enabled (`semantic.enabled: true` with a configured provider).

**Before modifying shared library code**, use `get_blast_radius` with `crossRepo: true` to understand the full downstream impact across all repos.

**Note:** `crossRepoDeps` requires explicit package name configuration — there is no auto-detection of Nx/Turborepo/Lerna workspaces. Monorepo packages must each be indexed separately with `index_folder`.

---

### Ecosystem & data tools

#### `search_columns`
Search column definitions across dbt models. Returns upstream/downstream lineage — not just where a column is defined, but the full chain from source tables through staging models to final fact tables. Use for data lineage questions like "where does the `revenue` column come from?"

**Note:** `search_columns` is dbt-only — it does not search columns in raw SQL `CREATE TABLE` statements. For those, use `get_symbol_source` on the `CREATE TABLE` symbol directly.

**dbt workflow notes:**
- Always run `index_folder` after `dbt compile` to ensure `manifest.json` is current — stale manifests produce incorrect column lineage.
- Use `get_context_bundle` to traverse dbt model dependencies just like code dependencies.
- Use `search_symbols` with `kind: "route"` to find API endpoints via the OpenAPI provider.

**Templating coverage:** Jinja preprocessing is implemented only for dbt's SQL dialect. Helm/Go templates, Ansible Jinja2, Kubernetes YAML, ERB, and Kustomize are not preprocessed — those files are indexed as raw text or skipped. Terraform is fully supported.

---

## Decision rules — which tool to pick

```
I need to find a symbol by name
  → search_symbols

I know what the code does but not its name
  → search_semantic (or search_symbols with mode: "hybrid")

I need to find a literal string, comment, or config value
  → search_text

I need the source code of a specific symbol
  → get_symbol_source (use symbolId from search_symbols)

I need source for several symbols at once
  → get_symbols (batch)

I need to understand a function's dependencies
  → get_context_bundle

I need to know what breaks if I change a symbol
  → get_blast_radius (before modifying)
  → find_references (for call sites specifically)

I need to survey a file's contents
  → get_file_outline

I need to understand the project layout
  → get_repo_outline or get_file_tree

I need a non-symbol section of a file (imports block, config)
  → get_file_content with startLine/endLine
```

---

## Anti-patterns — what NOT to do

**Do not read whole files to find a function.**
Use `search_symbols` + `get_symbol_source`. Reading an 800-line file to locate a 45-line function wastes ~1,850 tokens.

**Do not call `get_symbol_source` for every search result.**
Read the `signature` and `summary` from `search_symbols` first. Fetch source only for symbols you will actually work with.

**Do not skip `list_repos` at the start of a session.**
You need a `repoId` for every tool call. Get it from `list_repos` or `index_folder` — do not guess.

**Do not use `search_text` for symbol lookups.**
`search_text` is a grep over raw file content. It is slower and less precise than `search_symbols` for finding named code entities.

**Do not use `get_file_content` as a fallback for reading whole files.**
If a symbol exists in the index, use `get_symbol_source`. Only use `get_file_content` for content that is not a named symbol.

**Do not ignore `_tokenEstimate` fields.**
Every response includes a `_tokenEstimate`. Use it to decide whether to fetch more context or stop.

---

## Efficient navigation patterns

### Pattern: understand an unfamiliar codebase

```
1. list_repos()                          → check if indexed
2. index_folder({ path })                → index if needed, get repoId
3. get_repo_outline({ repoId })          → survey the structure
4. search_symbols({ query: "main entry point concept" }) → locate key symbols
5. get_context_bundle({ symbolId })      → understand the entry + dependencies
```

### Pattern: modify a function safely

```
1. search_symbols({ query: "functionName", kind: "function" })
2. get_blast_radius({ symbolId })        → know the impact scope BEFORE touching it
3. get_context_bundle({ symbolId, maxDepth: 2 }) → understand its context
4. get_symbol_source({ symbolId })       → read the implementation
5. [make the change]
6. find_dead_code({ repoId })            → verify no orphaned exports left behind
```

### Pattern: find where something is called

```
1. search_symbols({ query: "symbolName" })
2. find_references({ symbolId })         → all call sites
3. get_symbol_source for relevant call sites
```

### Pattern: search when you know the concept but not the name

```
1. search_semantic({ query: "natural language description", mode: "hybrid" })
2. Review signatures and summaries in results
3. get_symbol_source for the best match
```

### Pattern: large batch of symbols

```
1. search_symbols({ query: "...", limit: 20 })
2. Filter results by signature/summary to pick the ones you need
3. get_symbols({ symbolIds: ["id1", "id2", "id3"] })  ← one call, not three
```

### Pattern: modify a high-risk symbol safely

```
1. search_symbols({ query: "functionName", kind: "function" })
2. get_churn_metrics({ repoId, symbolId })   → if churnScore > 6, warn user
3. get_symbol_history({ symbolId })          → understand recent change context
4. get_blast_radius({ symbolId })            → know full impact scope
5. get_context_bundle({ symbolId, maxDepth: 2 }) → understand dependencies
6. get_symbol_source({ symbolId })           → read the implementation
7. [make the change]
8. find_dead_code({ repoId })                → verify no orphaned exports
```

### Pattern: architecture review / onboarding

```
1. list_repos → index_folder if needed
2. get_architecture_doc({ repoId })          → generate project overview
3. get_quality_metrics({ repoId })           → identify weakest files
4. detect_antipatterns({ repoId })           → find structural issues
5. get_repo_outline({ repoId })              → survey specific areas
```

### Pattern: before implementing new functionality

```
1. find_similar({ query: "description", crossRepo: true })  → check for existing code
2. search_cross_repo({ query: "conceptName" })              → find related symbols across repos
3. get_blast_radius({ symbolId, crossRepo: true })          → understand cross-repo impact
```

### Pattern: debug a recent regression

```
1. get_churn_metrics({ repoId })             → find recently-changed files
2. get_symbol_history({ symbolId })          → check commits in the affected area
3. search_symbols in changed files           → find the suspect functions
4. get_symbol_source → get_context_bundle    → read and understand the change
```

### Pattern: PR review

```
1. [obtain list of changed files from PR]
2. get_symbol_history for changed symbols    → understand prior context
3. get_churn_metrics for changed files       → flag hotspots
4. get_blast_radius for each modified symbol → identify affected downstream code
5. detect_antipatterns({ repoId })           → flag new structural issues
```

---

## Search tips

- **camelCase and snake_case are equivalent** — `processOrder` and `process_order` return the same results.
- **Short queries rank better** — `auth` finds more than `authentication middleware function`.
- **Use `kind` to narrow results** — `kind: "function"` eliminates class/method noise.
- **Use `filePath` to scope** — `filePath: "src/auth/"` restricts to a directory.
- **Use `debug: true` to diagnose ranking** — shows BM25 scores and name boost factors.
- **For hybrid mode** — `semantic_weight: 0.6, keyword_weight: 0.4` is a good default when you are unsure of the exact name.

---

## Notes on `_tokenEstimate` and `_meta`

Every response includes:

```json
"_meta": {
  "timing_ms": 3,
  "tokens_saved": 1842,
  "total_tokens_saved": 45231
}
```

And most responses include `_tokenEstimate` — a rough count of tokens in the returned payload. Use this to:
- Decide whether to fetch additional context or stop
- Avoid hitting context limits by capping `maxTokens` in `get_context_bundle`
- Track cumulative savings with `get_savings_stats`

---

## Keeping the index fresh

The file watcher triggers incremental re-indexing automatically on file changes. If you suspect the index is stale:

```
index_folder({ path, force: false })   → incremental (changed files only)
index_folder({ path, force: true })    → full re-index (all files)
invalidate_cache({ repoId })           → clear hashes, then index_folder
```

---

## Known limitations

These are documented gaps — understand them so you can work around them rather than being confused when a tool behaves unexpectedly.

| Area | Limitation | Workaround |
|------|-----------|-----------|
| **AI Summaries** | Summaries describe intent, not contract. Stale summaries exist until re-index. | Always verify with `get_symbol_source` before modifying. |
| **AI Summaries** | `get_architecture_doc` requires `ai.allowRemoteAI: true`. | `detect_antipatterns` and `get_quality_metrics` work without AI. |
| **Git History** | Rename/move breaks history continuity — prior history is lost after a rename. | Future: `git log --follow` tracking. |
| **Git History** | Rebase invalidates commit hashes — re-index required after significant rebase. | Run `invalidate_cache` + `index_folder` post-rebase. |
| **Git History** | Default `maxCommits: 500` drops early history on long-lived projects. | Increase `git.maxCommits` in config for history-sensitive workflows. |
| **Git History** | No SVN/Mercurial/Perforce support. | Git is a hard requirement for history features. |
| **Cross-Repo** | `crossRepoDeps` is manual — no auto-detection of Nx/Turborepo/pnpm workspaces. | Explicitly list package names in each repo's config. |
| **Cross-Repo** | `find_similar` requires semantic search enabled and an embedding provider. | Use a local Ollama model as a zero-cost alternative. |
| **Cross-Repo** | MCP Resources `resources/subscribe` is not yet supported by Claude Code or Cursor. | Polling with `search_cross_repo` is the current alternative. |
| **Architecture** | Quality metrics use estimated complexity (nesting heuristics), not true AST branch-counting. | Treat scores as directional signals, not precise measurements. |
| **Architecture** | `detect_antipatterns` cannot detect runtime coupling or dynamic dispatch. | Complementary to profiling and runtime observability — not a replacement. |
| **Architecture** | `get_layer_violations` needs layer boundaries defined in config before it delivers value. | Requires upfront config investment. |
| **Ecosystem** | Jinja preprocessing is dbt SQL only — Helm, Ansible, ERB, Kustomize not supported. | Use Terraform for IaC where possible; raw file reads otherwise. |
| **Ecosystem** | `search_columns` is dbt-only — does not cover `CREATE TABLE` SQL columns. | Use `get_symbol_source` on the `CREATE TABLE` symbol instead. |
| **Ecosystem** | dbt indexer does not detect stale `manifest.json`. | Always run `dbt compile` before `index_folder` on dbt projects. |
| **Ecosystem** | BigQuery STRUCT/ARRAY, Snowflake QUALIFY, and DuckDB LIST/MAP may not parse fully. | Model-level symbols are still extracted even when the body fails to parse. |
