# PureContext MCP — Agent Instructions

PureContext indexes codebases with tree-sitter and serves symbols via MCP. Retrieving a 45-line function by name costs ~150 tokens vs ~2,000 tokens for reading the whole file. Use these tools instead of reading files.

---

## Mandatory first step

Always call `list_repos` before any code navigation. If the project is not listed, call `index_folder` with the absolute project path. Every other tool requires the `repoId` returned by these two calls.

---

## Pick the right tool

| I need to… | Use |
|---|---|
| Find a function/class/method by name | `search_symbols` |
| Find code by what it does (meaning, not name) | `search_semantic` |
| Find a literal string, comment, or config value | `search_text` |
| Read a symbol's implementation | `get_symbol_source` |
| Fetch several symbols at once | `get_symbols` |
| Survey all symbols in one file | `get_file_outline` |
| Survey the whole project layout | `get_repo_outline` or `get_file_tree` |
| Read a non-symbol file section (imports, config block) | `get_file_content` with `startLine`/`endLine` |
| Understand what a symbol depends on | `get_context_bundle` |
| Know what breaks if I change a symbol | `get_blast_radius` |
| Find all call sites of a symbol | `find_references` |
| Check who imports a file directly | `find_importers` |
| Find unused exports | `find_dead_code` |
| Check if similar code exists across repos | `find_similar` |
| Search all indexed repos at once | `search_cross_repo` |
| Trace a dbt column's lineage | `search_columns` |
| Understand symbol-level git history | `get_symbol_history` |
| Identify high-churn / high-risk files | `get_churn_metrics` |
| Get per-file quality scores (complexity, coupling) | `get_quality_metrics` |
| Find god classes, circular deps, dead code | `detect_antipatterns` |
| Generate an architecture overview doc | `get_architecture_doc` |

---

## Rules

**1. Never read whole files to find code.** Use `search_symbols` + `get_symbol_source`. Reading files wastes tokens.

**2. `search_symbols` returns no source.** It returns signatures and summaries only. Call `get_symbol_source` only for symbols you will actually work with — not for every result.

**3. Trust summaries, but verify before modifying.** Summaries describe intent, not contract. Use the `summary` field to navigate; always read the source before making a change.

**4. Before modifying a symbol:** call `get_churn_metrics` first. If `churnScore > 6`, warn the user. Then call `get_blast_radius` for impact scope and `get_context_bundle` for dependencies.

**5. `search_text` is grep, not symbol search.** Use it only for literal strings, comments, and values that are not named symbols.

**6. Use `get_symbols` for batches.** When you need source for multiple symbols, one `get_symbols` call beats multiple `get_symbol_source` calls.

**7. camelCase = snake_case for queries.** `processOrder`, `process_order`, and `process order` return the same results. Use `kind:` to narrow (e.g. `kind: "function"`).

**8. Use `mode: "hybrid"` when unsure of the exact name.** Combines keyword precision with semantic recall.

**9. Check for duplicates before implementing new code.** Call `find_similar` (cross-repo) to discover existing implementations before writing something new.

**10. Use `get_architecture_doc` when onboarding.** Call it early on an unfamiliar codebase to build a mental model before diving into symbols.

**11. For dbt projects:** always run `dbt compile` before `index_folder`. Use `search_columns` for column lineage, `get_context_bundle` for model dependencies, and `search_symbols` with `kind: "route"` for API endpoints.

---

## Common patterns

**Explore an unfamiliar codebase**
```
list_repos → (index_folder if missing) → get_architecture_doc → get_quality_metrics → get_repo_outline → search_symbols → get_context_bundle
```

**Modify a function safely**
```
search_symbols → get_churn_metrics → get_symbol_history → get_blast_radius → get_context_bundle → get_symbol_source → [edit]
```

**Find where a symbol is used**
```
search_symbols → find_references → get_symbol_source for relevant call sites
```

**Before implementing new functionality**
```
find_similar (crossRepo: true) → search_cross_repo → [only build if nothing equivalent exists]
```

**Debug a recent regression**
```
get_churn_metrics → get_symbol_history for changed symbols → search_symbols → get_symbol_source
```

**Architecture / code health review**
```
get_quality_metrics → detect_antipatterns → get_architecture_doc (before) → [refactor] → detect_antipatterns (after)
```
