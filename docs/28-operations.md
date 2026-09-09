# Operations Guide — Large Repos, Branches, Verification, Privacy

Operational knowledge for running PureContext on large, real-world codebases.
Distilled from a production evaluation on a ~90k-file automotive polyrepo
(every number below was measured there), updated for the fixes that evaluation
drove (v1.22.0–v1.24.0).

---

## Install on current Node

`better-sqlite3` ships prebuilt binaries for common Node LTS lines. Since
v1.24.0 it is an **optional dependency**: on a Node version with no prebuilt
binary and no local C++ toolchain, `npm install` still succeeds and the server
runs on the pure-WASM SQLite tier (slower, fully functional, FTS5 included).

Check which tier you are on:

```bash
npx purecontext-mcp config --check     # prints "tier: native better-sqlite3" or "tier: WASM"
```

For native speed on such a system: install Python 3 + a C++ toolchain and run
`npm rebuild better-sqlite3`.

## Registration

```bash
claude mcp add purecontext-mcp --scope local -- npx -y purecontext-mcp@<version>
```

- **Pin the version.** `@latest` silently moves you off the build you validated.
- `--scope local` registers under the **git repo root**, not your cwd —
  registering from a subdirectory covers the whole repo.
- MCP servers connect at **session start**: restart the session after
  registering. To confirm the tools are live, ask the session
  "do you have a list_repos tool?" — `claude mcp list` reports what is
  *configured*, not what a session *loaded*.
- In harnesses that defer tool schemas, a bare tool name carries little
  signal — **name the tool explicitly** in your prompt when you want it used.

The installer is safe by default since v1.24.0: `install claude` registers the
server and writes the instruction block only. Hooks are opt-in
(`--with-hooks`), and the per-edit stderr reminder is a separate opt-in
(`--with-reminders`).

## Indexing large trees

**One index per build tree.** Since v1.24.0 `index_folder` commits progress in
batches (`indexing.commitBatchSize`, default 500 files per transaction), so a
big tree is durable while it indexes:

- The main `.db` grows monotonically during the run — progress is visible.
- A killed run keeps every committed batch. Re-running resumes via the
  content-hash cache: unchanged files skip.
- The response reports `batchesCommitted`.

Earlier versions of this guide recommended splitting a large tree into
several scoped indexes. **Do not do that for size.** Every split is a seam:
dependency edges never cross an index boundary, so a blast radius rooted in
one module never reaches its callers in another, `find_importers` reads
"nobody", and the graph tools silently under-report. Since v1.30.0 those
tools attach `externalImports` when a queried file imports across a seam
(with `siblingIndexes` naming the other roots), but the fix is structural:
index the whole build tree as one root.

Scope an index only for a reason other than size:

- **Privacy / exclusion** — a vendored fork or a third-party SDK you do not
  want in the index at all (`excludePatterns` inside one root is usually the
  better tool).
- **Edge hygiene on polluted trees** — measured: excluding one vendored fork
  raised clean first-party edges from 56.1% to 78.2%; a cleanly scoped SDK
  root scored **96.9% clean edges with 0.0% ambiguity**. AOSP-style forks
  declare platform packages (`package android.util` test stubs) that pollute
  resolution; `graph.reservedNamespaces` (v1.22.0) short-circuits the
  standard platform namespaces, and `excludePatterns` handles the rest —
  both keep ONE index.
- **Nested git repos** — they need separate indexes anyway (churn/co-change
  read the index root's own history).

Useful `index_folder` options:

- `fileLimit: 0` — unlimited within the root (default 10,000; truncation is
  reported via `limitReached` / `totalBeforeLimit`).
- `skipTestMapper: true` — the test mapper can dominate wall-clock on big
  trees; skip it unless you need `find_untested_symbols` or the `testGap`
  axis of `get_symbol_risk`.
- `onlyChanged: true` — after the first index, re-index from git's change
  list instead of walking the tree (see Branch discipline).

## Exclusions

Precedence (fixed in v1.24.0): **built-ins → repo `.gitignore` → your
`excludePatterns`** — later rules win, so a negation in config can rescue a
directory the repo `.gitignore` hides:

```jsonc
// ~/.purecontext/config.json
{ "excludePatterns": ["!protected/"] }
```

`index_folder` also reports top-level directories that ignore rules dropped
entirely (`excludedDirs` on the response, with the rule source), so a
`.gitignore` silently hiding a nested repo is visible.

## Verify after indexing

Do not trust that it worked. Check:

1. `edges > 0` — zero edges means import resolution failed for the language
   mix (see the per-language matrix in `docs/07-language-support.md`).
2. `declared_package` coverage ≈ 100% of `.kt`/`.java`/`.cs` files.
3. Spot check: pick a symbol you know, compare `get_blast_radius` /
   `find_importers` against `git grep` for its import.

If a graph tool returns empty, look for `graphCoverage: "empty"` in the
response — attached exactly so an empty blast radius is not mistaken for
"nothing depends on this".

## Branch discipline

`repoId = sha256(absolutePath)` — path only, no branch. Every branch checked
out at a path shares one index. Since v1.30.0 the index records the commit
it was last brought up to (`head` on `list_repos` / `check_index_staleness`:
indexed sha, current HEAD, `behindBy`, `dirtyFiles`, `inProgress`, and a
one-line `freshness`), and three things keep it current:

**1. Git hooks (recommended — the "hooks for branch change" ask):**

```bash
npx purecontext-mcp hooks --install --git            # in the repo (any worktree)
npx purecontext-mcp hooks --uninstall --git
npx purecontext-mcp hooks --list                     # shows git-hook status
```

Writes `post-checkout`, `post-merge` and `post-rewrite` shims into the
directory git actually runs hooks from (`core.hooksPath` when set — husky /
lefthook — else the repository's common `hooks/`, so one install covers
every worktree). A pre-existing hook body is kept; our block chains after
its shebang and is marker-delimited (idempotent, removable). The shims
**never block git**: a change set up to `hooks.inlineFileLimit` (200) files
re-indexes inline with a 10 s cap; anything larger, a fresh worktree, or a
run that needs the full path is handed to a detached process, and a job
marker makes `list_repos` say `re-index in progress` until it finishes.

**2. Changed-only re-index (what the hooks call):**

```
index_folder({ path, onlyChanged: true })          # MCP
npx purecontext-mcp index-changed --repo <path>    # CLI
```

Asks git for the paths that differ between the stored sha and HEAD (a tree
diff — still valid after a rebase or force-push as long as the old commit
exists) plus the working-tree changes, and hands them to the targeted
re-index. **No directory walk** — seconds on a 26k-file tree instead of the
minutes a discovery pass costs. It falls back to a full index, visibly
(`mode: "full"` + `reason`), when there is no stored sha (pre-1.30 index),
the folder is not a git checkout, the old sha is gone, or more than
`indexing.changedOnlyMaxFiles` (5,000) paths changed. `verifyIndexed: true`
(`--verify`) additionally re-hashes every indexed file — the post-checkout
hook uses it for `git checkout -- <path>`, which git cannot report.

**3. Worktrees — clone, do not re-parse.** A new `git worktree add` of an
already-indexed repository seeds its index by copying a sibling worktree's
`.db` (checkpointed first; `repo_id` rewritten in every table by schema
enumeration) and then applies the git delta since the sibling's stored sha.
Both `index_folder` and `index-changed` do this automatically on a linked
worktree with no index (`clonedFrom` in the response); the Claude Code
`WorktreeCreate` hook runs it detached with no timeout (the old 120 s cap
died on big trees and left a silent partial index). The result is
byte-identical to a from-scratch index (proven in
`test/core/worktree-clone.test.ts`). A clone is a full copy on disk —
sharing between clones is not attempted.

Without hooks, the old rules still apply: after an in-place switch or pull,
run `index_folder({ onlyChanged: true })` before trusting a result; after a
rebase, the same call (old commits still exist in the reflog) — only when
`reason: "since_unreachable"` appears do you need the full run. Mid-task:
`check_index_staleness({ filePaths })` then `index_file` on what it flags;
avoid a full `index_folder` mid-task. Targeted re-index is graph-correct since
v1.22.0 (incoming edges survive re-parses; newly added files receive edges
from unchanged importers via stored import records).

Index of a worktree you removed by hand: `npx purecontext-mcp delete-index
<path>`. Claude-managed worktrees (`.claude/worktrees/<name>`) are cleaned up
by the `WorktreeRemove` hook.

## Privacy defaults

Verified in source; safe for proprietary code:

```
telemetry.enabled   false
ai.provider         'none'
semantic.enabled    false
```

Nothing leaves the machine — indexing, parsing, and search are local. AI
summaries and embeddings are opt-in and ship symbol text to the configured
provider; do not enable them without clearance.

The **usage ledger** (v1.30.0, `telemetry.usageLedger`, default on) is local
too: `<dataDir>/usage.jsonl` holds one line per MCP tool call — tool name,
repo id, timestamp, duration, a per-process session id — and nothing else
(no query text, no paths, no results). It feeds `get_savings_stats.calls`
and the TaskCompleted hook's first line (`PureContext this task: N calls
(…)`), so a human can see whether the agent used the index without asking
it. Rotates at 5 MB (one generation kept). `telemetry.usageLedger: false`
stops the writes.

## Where things live

```
~/.purecontext/indexes/<repoId>.db   one SQLite file per indexed root
~/.purecontext/jobs/<repoId>.json    marker while a detached re-index runs (hooks)
~/.purecontext/usage.jsonl           local usage ledger (tool names + ids + timestamps)
~/.purecontext/config.json           config
PCTX_DATA_DIR                        env var — overrides the data directory
~/.claude.json                       MCP registration, keyed by git repo root
```

The test suite honours `PCTX_DATA_DIR` and leaves `~/.purecontext` untouched
(since v1.22.0).

To see what an index actually covers, open the `.db` and run:

```sql
SELECT root_path FROM repos;
SELECT COUNT(*) FROM files;
SELECT COUNT(*) FROM dep_edges;
```

## Known limitations

- **Edges are file-level, not symbol-level.** Every symbol in a file shares
  the file's blast radius; `get_blast_radius` responses carry
  `granularity: "file"` to say so.
- **Edges never cross index boundaries.** `find_cross_repo_usages` spans
  indexes but is word-boundary text search, explicitly heuristic. Since
  v1.30.0 `get_blast_radius` / `find_importers` / `get_context_bundle`
  attach `externalImports` (unresolved internal-looking imports of the
  queried files + `siblingIndexes`) when a file sits on such a seam — the
  radius is a lower bound there. The fix is one index per build tree.
- **The index cannot prove absence.** "Nothing anywhere references X" is a
  `git grep` job; the always-on rules say so.
- Per-language import-resolution coverage varies — see
  `docs/07-language-support.md` before relying on graph tools for a language.
