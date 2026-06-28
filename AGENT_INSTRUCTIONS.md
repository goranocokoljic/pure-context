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

PureContext MCP is a code-intelligence server for coding agents. It indexes codebases using tree-sitter AST parsing, stores symbol metadata in SQLite, and exposes MCP tools that do two things: let you **retrieve precisely the code you need** without reading whole files, and let you **assess the impact and risk of a change before you make it** — blast radius, temporal co-change, and a composite per-symbol risk score.

**Foundation — token efficiency:** Retrieving a 45-line function by name costs ~150 tokens; reading the 800-line file it lives in costs ~2,000. PureContext saves 88–98% of context tokens on typical navigation, which is what makes the impact/risk checks cheap enough to run on every edit.

**Differentiation — safe change:** Before modifying unfamiliar code, you can ask what depends on it (`get_blast_radius`), what historically changes with it (`get_co_change`), and how risky it is to touch (`get_symbol_risk`) — the context a careful senior engineer has and a fresh agent doesn't.

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
| Orient on a task (relevant symbols + files from a description) | `get_task_context` |
| Find a function/class/method by name | `search_symbols` |
| Find code by what it does | `search_semantic` |
| Find a literal string, comment, or config value | `search_text` |
| See all symbols in one file | `get_file_outline` |
| See the whole project structure | `get_repo_outline` |
| Browse directory layout | `get_file_tree` |
| Understand a function's dependencies | `get_context_bundle` |
| Know what breaks if I change a symbol | `get_blast_radius` |
| How risky is a symbol to change (composite verdict) | `get_symbol_risk` |
| Files that historically change together with this one | `get_co_change` |
| Impact verdict BEFORE editing existing code | `prepare_change` |
| Dedup / pattern check before writing NEW code | `check_consistency` |
| Re-index a file right after editing it (mid-task) | `index_file` |
| Confirm a finished edit is complete (plan vs actual) | `verify_change` |
| Did my change add a cycle / layer violation? | `compare_change_impact` |
| One go/no-go before merging a change | `merge_readiness` |
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

## Changing code safely — close the loop

PureContext is **judgment, not actuation** — it never edits files. You make the edit; these tools tell you what's safe before you start and what you missed after you finish. Run the loop for any non-trivial change:

```
1. get_task_context({ repoId, task })       → orient: relevant symbols/files + evidenceGaps
2a. EXISTING code → prepare_change({ repoId, intent, targetSymbolId | query })
                                            → predicted files, risk, missingCoChange, tests, gate
                                            → keep predictedFilePaths + missingCoChange for step 5
2b. NEW symbol   → check_consistency({ repoId, name, kind, signature, intendedFilePath })
                                            → duplicates, pattern to follow, where it belongs
3. [make the edit]
4. index_file({ repoId, filePaths })        → refresh the index, O(one file) — NOT index_folder
5. verify_change({ repoId, diff, predictedFilePaths, predictedCoChange })
                                            → unaddressedCoChange, unplannedChanges, coverage gaps
6. merge_readiness({ repoId, diff, ... })   → one go/no-go: completeness + architecture regression
```

**Gate envelope.** `prepare_change`, `verify_change`, `compare_change_impact`, `check_consistency`, and `merge_readiness` each return `{ gate: "pass" | "warn" | "block", gateReasons, nextAction }`. Branch on `gate`: `pass` = proceed · `warn` = proceed with judgment · `block` = fix what `gateReasons` lists first.

- **`prepare_change`** intents: `rename` / `delete` / `modify` / `extract`. Returns `ambiguous_target` + candidates when a `query` has no clear winner (it never guesses) and `no_target` when nothing matches.
- **`verify_change`** is **stateless** — pass `predictedFilePaths` and `predictedCoChange` back inline from `prepare_change`. Co-change reconciliation is suppressed on low git signal (it won't invent "you forgot X").
- **`compare_change_impact`** reports only the regression *delta* vs a baseline `get_architecture_snapshot` — new cycles / layer violations the change introduced, never pre-existing ones.

> Mid-task freshness is the linchpin: after every write call `index_file` (single-file, repo-size-independent), never `index_folder` (it re-scans the whole tree and stalls). See `docs/HARNESS-CONTRACT.md` for full greenfield/brownfield loop recipes.

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
2. get_symbol_risk({ repoId, symbolId })        → composite verdict (band + factors + reasons)
3. If band is "high": inspect co-changers and callers BEFORE editing
   - get_co_change({ repoId, symbolId })        → files that move with it but don't import it
   - get_blast_radius({ symbolId })             → full reverse-dependency impact
   - get_symbol_history({ symbolId })           → recent change context
4. get_context_bundle({ symbolId, maxDepth: 2 }) → also returns historicalNeighbors when co-change data exists
5. get_symbol_source({ symbolId })
6. [make the change — and the co-changing files, if they need to move together]
7. find_dead_code({ repoId })
```

> `get_symbol_risk` fuses churn, centrality, complexity, test gap, and co-change into one banded score with `reasons[]`. For a quick inline signal, pass `includeRisk: true` to `search_symbols` or `get_symbol_source` to get a compact `{ band, riskScore }` per result. Risk is **code-centered** — it models no author/ownership metrics.

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

Searches are only as good as the index. The cheap, mid-task path is the single most important freshness habit:

```
index_file({ repoId, filePaths })      → re-index just the files you edited (O(one file))
check_index_staleness({ repoId, filePaths }) → is the index current? (no discovery pass)
index_folder({ path })                 → cold start / first index of a repo (re-scans the whole tree)
index_folder({ path, force: true })    → full re-index (rebuild everything)
invalidate_cache({ repoId })           → clear hashes, then index_folder
```

**After editing a file, call `index_file` — never `index_folder`.** `index_folder` stats every file in the tree (discovery-bound, slow on large repos); `index_file` skips discovery entirely and re-indexes only what you pass. Reserve `index_folder` for the first index of a repo. Use `check_index_staleness` at task start to decide between a cold `index_folder` and targeted `index_file`.

### Claude Code hooks (optional but recommended)

Install the PureContext hooks to keep the index in sync automatically and preserve session orientation across context compaction:

```
npx purecontext-mcp hooks --install
```

The hooks register as CLI commands in `~/.claude/settings.json` (no scripts copied — they update with the package). Highlights:

| Hook event | What it does |
|------------|-------------|
| **PostToolUse** | After `Edit`/`Write`, re-indexes the modified file via the cheap `index_file` path (bootstraps a full index on first sight) |
| **PreToolUse** | Soft edit guard — suggests `get_blast_radius` / `get_symbol_source` before editing |
| **PreCompact** | Injects the indexed-repo list before context compaction so orientation survives |
| **SubagentStart** | Injects condensed repo orientation for newly spawned subagents |

All hooks are Node.js — identical on Windows, Linux, and macOS.

---

## Full reference

For complete tool parameter documentation, all navigation patterns, and the known limitations table, see **`AGENT_REFERENCE.md`** in this repository.
