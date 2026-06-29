## PureContext MCP — Code Navigation & Safe Change

Use PureContext MCP tools to read and change code. Never read whole files to find code, and assess impact before you edit.

### Mandatory workflow

1. **Start every session**: `list_repos()` → get `repoId` (required for all tools). Not indexed? `index_folder({ path })`.
2. **Orient on a task**: `get_task_context({ repoId, task })` → the symbols and files most relevant to the work, walked over the real dependency + co-change graph (not just keyword matches), plus `evidenceGaps` for what you haven't seen yet. If it returns nothing, your task text shares no terms with indexed symbols and no embeddings are configured — name a real symbol/term, or fall back to `search_symbols`/`search_semantic`.
3. **Find code**: `search_symbols` (by name) → read `summary`/`signature` → `get_symbol_source` only for what you'll edit. `search_semantic` for concepts, `search_text` for literals.

### Changing code safely — close the loop

PureContext is judgment, not actuation: it never edits files. You make the edit; these tools say what's safe and what you forgot.

1. **Before editing existing code**: `prepare_change({ repoId, intent, targetSymbolId | query })` → predicted files, risk, co-changing files you'd forget (`missingCoChange`), tests, and a `gate`. Keep `predictedFilePaths` + `missingCoChange` for step 5.
2. **Before writing a NEW symbol** (greenfield): `check_consistency({ repoId, name, kind, signature, intendedFilePath })` → duplicates ("you already wrote this"), the pattern to follow, where it belongs.
3. **Make the edit.**
4. **Refresh the index**: `index_file({ repoId, filePaths })` after each write — O(one file). Never `index_folder` mid-task (it re-scans the whole tree).
5. **Verify**: `verify_change({ repoId, diff, predictedFilePaths, predictedCoChange })` → did you address everything (and only what) you planned?
6. **Before merge**: `merge_readiness({ repoId, diff, ... })` → one go/no-go folding completeness + architecture regression.

Every gate tool returns `{ gate: "pass" | "warn" | "block", gateReasons, nextAction }` — branch on `gate`: `pass`=proceed, `warn`=proceed with judgment, `block`=fix first.

### Pick the right tool

| I need to… | Use |
|------------|-----|
| Orient on a task (relevant symbols + files) | `get_task_context` |
| Find a function/class/method by name | `search_symbols` |
| Find code by what it does (meaning) | `search_semantic` |
| Find a literal string / comment / config value | `search_text` |
| Read a symbol's implementation | `get_symbol_source` |
| Survey one file / whole project | `get_file_outline` / `get_repo_outline` |
| Know what breaks if I change a symbol | `get_blast_radius` |
| Find every call site of a symbol | `find_references` |
| Judge how risky a symbol is to change | `get_symbol_risk` |
| Files that historically change together | `get_co_change` |
| Impact verdict BEFORE an edit | `prepare_change` |
| Dedup / pattern check before writing NEW code | `check_consistency` |
| Re-index a file after editing it (mid-task) | `index_file` |
| Confirm a finished edit is complete | `verify_change` |
| Did my change add a cycle / layer violation? | `compare_change_impact` |
| One go/no-go before merging | `merge_readiness` |
| Pre-flight a rename / delete / move | `check_rename_safe` / `check_delete_safe` / `check_move_safe` |
| Find exported symbols with no tests | `find_untested_symbols` |
| Codebase health / debt report | `health_radar` / `get_debt_report` |

### Anti-patterns — never do these

- Do not read whole files to find a function — use `search_symbols` + `get_symbol_source`
- Do not call `get_symbol_source` for every result — read `summary` first
- Do not skip `list_repos` — every tool needs a `repoId`
- Do not run `index_folder` after every edit — use `index_file` (single-file, cheap)
- Do not use `search_text` for symbol lookups — use `search_symbols`
- Do not re-search after `verdict: "no_match"` — the symbol does not exist

Full tool reference, navigation patterns, and harness loop recipes: **`AGENT_REFERENCE.md`** and **`docs/HARNESS-CONTRACT.md`**.
