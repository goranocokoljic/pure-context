# PureContext MCP — Agent Instructions

Add these instructions to your agent's rules file to get token-efficient code navigation with PureContext MCP.

| Agent | Rules file |
|-------|-----------|
| Claude Code (global) | `~/.claude/CLAUDE.md` |
| Claude Code (project) | `CLAUDE.md` in the project root |
| Cursor | `.cursor/rules` |
| Windsurf | `.windsurf/rules` |
| VS Code Copilot | `.github/copilot-instructions.md` |

For complete tool parameter docs, all navigation patterns, and known limitations: see **`AGENT_REFERENCE.md`** in this repository.

---

## What PureContext MCP is

PureContext MCP is a structured code navigation server. It indexes codebases using tree-sitter AST parsing, stores symbol metadata in SQLite, and exposes MCP tools so you retrieve precisely the code you need — without reading entire files.

**Token savings:** Retrieving a 45-line function by name costs ~150 tokens. Reading the 800-line file it lives in costs ~2,000 tokens. PureContext saves 88–98% of context tokens on typical navigation tasks.

---

## Mandatory workflow — always follow this order

### Step 1 — Check if the project is indexed

```
list_repos()
```

If the project is missing, index it first:

```
index_folder({ path: "/absolute/path/to/project" })
```

`index_folder` returns the `repoId` you will use in every subsequent call. **Never skip this step** — all other tools require a `repoId`. Re-indexing is incremental; only changed files are re-parsed.

### Step 2 — Navigate by symbol, not by file

Do not read entire files to find code. Use the tools:

| Goal | Tool |
|------|------|
| Find a function/class/method by name | `search_symbols` |
| Find code by what it does | `search_semantic` |
| Find a literal string, comment, or config value | `search_text` |
| See all symbols in one file | `get_file_outline` |
| See the whole project structure | `get_repo_outline` |
| Browse directory layout | `get_file_tree` |
| Understand a function's dependencies | `get_context_bundle` |
| Know what breaks if I change a symbol | `get_blast_radius` |
| Find all call sites for a symbol | `find_references` |
| Non-symbol file content (imports block, config) | `get_file_content` with `startLine`/`endLine` |
| All implementations of an interface | `find_implementations` |
| Callers/callees execution tree | `get_call_hierarchy` |
| Class inheritance structure | `get_class_hierarchy` |
| Rename / delete / move safety check | `check_rename_safe` / `check_delete_safe` / `check_move_safe` |
| Codebase health score | `health_radar` |
| Detailed debt report | `get_debt_report` |
| All TODOs and FIXMEs | `get_todos` |
| Untested exported symbols | `find_untested_symbols` |
| Most complex functions | `get_complexity_hotspots` |
| Symbols by decorator | `search_by_decorator` |
| AST node type occurrences (try/catch, arrow functions, etc.) | `search_ast` |

### Step 3 — Read summaries before fetching source

`search_symbols` returns signatures and summaries — no source code. Read the `summary` field first to decide whether a symbol is relevant. Fetch source only for symbols you will actually work with:

```
get_symbol_source({ repoId, symbolId })
```

Summaries describe intent, not contract. For modification tasks, always read the source after using the summary to navigate — source code is ground truth.

---

## Anti-patterns — what NOT to do

**Do not read whole files to find a function.**
Use `search_symbols` + `get_symbol_source`. Reading an 800-line file to locate a 45-line function wastes ~1,850 tokens.

**Do not call `get_symbol_source` for every search result.**
Read `signature` and `summary` from `search_symbols` first. Fetch source only for symbols you will actually work with.

**Do not skip `list_repos` at the start of a session.**
You need a `repoId` for every tool call. Get it from `list_repos` or `index_folder` — do not guess.

**Do not use `search_text` for symbol lookups.**
`search_text` greps raw file content. It is slower and less precise than `search_symbols` for finding named code entities. Use `search_text` for literal strings, comments, config values, and local variables that are not indexed symbols.

**Do not use `get_file_content` as a fallback for reading whole files.**
If a symbol exists in the index, use `get_symbol_source`. Only use `get_file_content` for content that is not a named symbol.

**Do not ignore `_tokenEstimate` fields.**
Every response includes a `_tokenEstimate`. Use it to decide whether to fetch more context or stop. Cap `maxTokens` in `get_context_bundle` to avoid hitting context limits.

**Do not re-search when `search_symbols` returns `negative_evidence`.**
If the response includes `verdict: "no_match"`, the symbol does not exist in this codebase. Report the gap to the user rather than trying variant queries.

---

## Key navigation patterns

### Modify a function safely

```
1. search_symbols({ query: "functionName", kind: "function" })
2. get_blast_radius({ symbolId })               → know the impact scope BEFORE touching it
3. get_context_bundle({ symbolId, maxDepth: 2 }) → understand its dependencies
4. get_symbol_source({ symbolId })              → read the implementation
5. [make the change]
6. find_dead_code({ repoId })                   → verify no orphaned exports left behind
```

### Modify a high-risk symbol safely

```
1. search_symbols({ query: "functionName", kind: "function" })
2. get_churn_metrics({ repoId, symbolId })      → if churnScore > 6, warn the user
3. get_symbol_history({ symbolId })             → understand recent change context
4. get_blast_radius({ symbolId })               → know full impact scope
5. get_context_bundle({ symbolId, maxDepth: 2 })
6. get_symbol_source({ symbolId })
7. [make the change]
8. find_dead_code({ repoId })
```

### Find where something is called

```
1. search_symbols({ query: "symbolName" })
2. find_references({ symbolId })                → all call sites across the repo
3. get_symbol_source for relevant call sites
```

### Search when you know what the code does but not its name

```
1. search_semantic({ query: "validates user credentials and returns a session token", mode: "hybrid" })
2. Review signatures and summaries in results
3. get_symbol_source for the best match
```

### Refactor safely (rename / delete / move)

```
1. search_symbols({ query: "symbolName" })
2. check_rename_safe / check_delete_safe / check_move_safe  → binary verdict + affected sites
3. If safe: proceed.
   If not safe: resolve blockers listed in affectedSites first, then re-check.
4. find_dead_code({ repoId })                   → verify no orphaned exports remain
```

### Onboard to an unfamiliar codebase

```
1. list_repos() → index_folder({ path }) if needed
2. get_repo_outline({ repoId })                 → survey the structure
3. get_entry_points({ repoId })                 → where does the app start?
4. get_context_bundle({ symbolId: entryPointId }) → trace dependencies from root
5. get_todos({ repoId })                        → known rough edges
6. get_test_coverage_map({ repoId })            → where tests are thin
```

### Tech debt sprint

```
1. health_radar({ repoId })                     → 5-axis health baseline
2. get_debt_report({ repoId })                  → per-file rankings + recommendations
3. get_complexity_hotspots({ repoId })          → worst functions to tackle first
4. find_untested_symbols({ repoId })            → coverage gaps
5. find_cycles({ repoId })                      → circular deps to break
6. get_architecture_snapshot({ repoId })        → baseline snapshot before changes
7. [fix highest-priority items]
8. get_architecture_snapshot({ repoId })        → after snapshot
9. diff_health_radar({ before, after })         → prove the improvement
```

---

## Search tips

- **camelCase and snake_case are equivalent** — `processOrder` and `process_order` return the same results
- **Short queries rank better** — `auth` finds more than `authentication middleware function`
- **Use `kind` to narrow results** — `kind: "function"` eliminates class/method noise
- **Use `filePath` to scope** — `filePath: "src/auth/"` restricts results to a directory
- **Use `mode: "hybrid"` when unsure of the exact name** — blends keyword and semantic search
- **Use `debug: true` to diagnose ranking** — shows BM25 scores and name boost factors

---

## Keeping the index fresh

The file watcher triggers incremental re-indexing automatically. If the index seems stale:

```
index_folder({ path, force: false })   → incremental (changed files only)
index_folder({ path, force: true })    → full re-index
invalidate_cache({ repoId })           → clear hashes, then index_folder
```

### Claude Code hooks (optional but recommended)

Install the PureContext hooks to keep the index in sync automatically and preserve session orientation across context compaction:

```
npx purecontext-mcp hooks --install
```

This installs three hooks into `~/.claude/settings.json`:

| Hook | When it fires | What it does |
|------|--------------|-------------|
| **Index hook** | After `Edit` / `Write` | Re-indexes the modified file immediately |
| **Session snapshot** | Before context compaction | Injects indexed repo list into the next turn so orientation is preserved |
| **Edit guard** | Before `Edit` / `Write` | Soft warning suggesting `get_blast_radius` and `get_symbol_source` first |

All hooks are Node.js scripts — they work identically on Windows, Linux, and macOS.

---

## Full reference

For complete tool parameter documentation, all navigation patterns, and the known limitations table, see **`AGENT_REFERENCE.md`** in this repository.
