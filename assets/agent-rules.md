## PureContext MCP — Code Navigation & Safe Change

PureContext is an indexed symbol graph of the repo. It is the right tool for some jobs and the wrong tool for others — route by task, not by preference:

| Task | Use | Not |
|------|-----|-----|
| Locate a symbol by name / by what it does | `search_symbols` / `search_semantic` | reading files to find it |
| Read one symbol's code | `get_symbol_source` (or `get_symbols` for several) | whole-file reads |
| Every call site of a symbol (a caller census) | `find_references` | a wide grep |
| Impact before editing shared code | `get_blast_radius`, `find_importers`, `get_symbol_risk` | guessing |
| Is the index fresh? | `list_repos` → `head`/`freshness`; `check_index_staleness` | assuming |
| Prove NOTHING references X across a tree (absence proof) | `git grep` / `grep` | the index — it cannot prove absence |
| Build-file / settings / config facts | read the file (`get_file_content` or Read) | the index |
| Files already in the diff you are reviewing | read them | the index |
| Impact across a split build tree (several indexes in ONE checkout) | the same graph tools — check `list_repos` → `links` first; `linked` / `linkedImporters` carry the other side | assuming the seam is a wall (edges cross linked indexes since 1.32.0) |
| Anything across an UNLINKED boundary (another repo, worktree, unindexed subtree) | `find_cross_repo_usages` + grep | a blast radius — edges stop at an unlinked seam |

### Session start

1. `list_repos()` → `repoId` (all tools need it). Not listed? `index_folder({ path })`.
2. **Read each repo's `freshness` line before trusting it.** `behind` → `index_folder({ path, onlyChanged: true })` (git delta, seconds; no directory walk). `re-index in progress` → wait or use grep for now. Git hooks (`purecontext-mcp hooks --install --git`) keep it fresh on checkout/merge/rebase automatically.
3. Orient on a task: `get_task_context({ repoId, task })` → relevant symbols + files over the real dependency/co-change graph.

### For non-trivial changes — close the loop

PureContext is judgment, not actuation: you make the edit; these tools say what is safe and what you forgot. Use them when the change is risky or touches shared code; skip them for trivial edits.

- Pre-edit: `prepare_change` (existing code) or `check_consistency` (new symbols) → risk, forgotten co-change partners (`missingCoChange`), tests, and a `gate`.
- After a write: `index_file({ repoId, filePaths })` — one file, cheap. Never `index_folder` mid-task.
- Verify: `verify_change({ repoId, diff, predictedFilePaths, predictedCoChange })`; pre-merge: `merge_readiness`.
- Gate tools return `{ gate: "pass" | "warn" | "block", gateReasons, nextAction }` — `block` means fix first.

### Reading results honestly

- `verdict: "no_match"` from `search_symbols` = not in the index. Report the gap; do not retry many variants.
- `graphCoverage: "empty"` or `externalImports` on a graph result = the graph is missing or stops at an UNLINKED index seam; an empty blast radius there is NOT "safe to change". A link whose status is `moved` → `index_folder` on the root you are querying.
- Rename / delete / move: `check_rename_safe` / `check_delete_safe` / `check_move_safe` first.

Full tool reference: `AGENT_REFERENCE.md` in the project root; harness loop recipes: `docs/HARNESS-CONTRACT.md`.
