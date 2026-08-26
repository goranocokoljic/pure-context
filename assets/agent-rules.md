## PureContext MCP — Code Navigation & Safe Change

Prefer PureContext MCP tools for code navigation and impact checks — one indexed lookup usually replaces several whole-file reads. These are defaults, not hard rules: fall back to plain file reads when the index lacks what you need or you already know exactly where to look.

### Recommended workflow

1. `list_repos()` once per session → `repoId` (all tools need it). Not indexed? `index_folder({ path })`.
2. Orient: `get_task_context({ repoId, task })` → the most relevant symbols + files, walked over the real dependency/co-change graph. Empty result → name a real symbol, or use `search_symbols` / `search_semantic`.
3. Find: `search_symbols` (names), `search_semantic` (concepts), `search_text` (literals). Read `summary`/`signature` first; fetch `get_symbol_source` for what you will actually work with.

### For non-trivial changes — close the loop

PureContext is judgment, not actuation: you make the edit; these tools say what's safe and what you forgot. Use them when the change is risky or touches shared code; skip them for trivial edits.

- Pre-edit: `prepare_change` (existing code) or `check_consistency` (new symbols) → risk, forgotten co-change partners (`missingCoChange`), tests, and a `gate`.
- After a write: `index_file({ repoId, filePaths })` — one file, cheap. Prefer it over full `index_folder` mid-task.
- Verify: `verify_change({ repoId, diff, predictedFilePaths, predictedCoChange })`; pre-merge: `merge_readiness`.
- Gate tools return `{ gate: "pass" | "warn" | "block", gateReasons, nextAction }` — `block` means fix first.

### Useful defaults

- Impact before changing a shared symbol: `get_blast_radius`; every call site: `find_references`; risk verdict: `get_symbol_risk`.
- Rename / delete / move pre-flight: `check_rename_safe` / `check_delete_safe` / `check_move_safe`.
- A `verdict: "no_match"` from `search_symbols` means the symbol is not in the index — report the gap instead of retrying many query variants.

Full tool reference: `AGENT_REFERENCE.md` in the project root; harness loop recipes: `docs/HARNESS-CONTRACT.md`.
