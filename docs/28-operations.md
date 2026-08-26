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

Since v1.24.0, `index_folder` commits progress in batches
(`indexing.commitBatchSize`, default 500 files per transaction), so:

- The main `.db` grows monotonically during the run — progress is visible.
- A killed run keeps every committed batch. Re-running resumes via the
  content-hash cache: unchanged files skip.
- The response reports `batchesCommitted`.

Scoped indexes are still recommended, for **edge hygiene** rather than
durability:

- Measured: excluding one vendored fork raised clean first-party edges from
  56.1% to 78.2%; a cleanly scoped SDK root scored **96.9% clean edges with
  0.0% ambiguity**.
- Vendored trees and AOSP forks declare platform packages
  (`package android.util` test stubs, etc.) that pollute resolution. The
  `graph.reservedNamespaces` config (v1.22.0) short-circuits the standard
  platform namespaces; excluding vendored trees handles the rest.
- Nested git repos need **separate indexes** — also correct for git metadata,
  since churn/co-change read the index root's own history.

Useful `index_folder` options:

- `fileLimit: 0` — unlimited within the scoped root (default 10,000;
  truncation is reported via `limitReached` / `totalBeforeLimit`).
- `skipTestMapper: true` — the test mapper can dominate wall-clock on big
  trees; skip it unless you need `find_untested_symbols` or the `testGap`
  axis of `get_symbol_risk`.

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
out at a path shares one index. The recommended pattern is
**worktree-per-branch**: each worktree path gets its own index by
construction.

If you switch branches in place: since v1.22.0 `index_folder` **prunes** files
that vanished from disk, so a re-run converges the index onto the current
branch instead of accreting the union of branches (reported as `filesPruned`).

- After a pull: `index_folder` again — incremental by content hash.
- After a **rebase**: commit hashes change wholesale — `invalidate_cache`,
  then a full `index_folder` (git metadata is stale otherwise).
- Mid-task: `check_index_staleness({ filePaths })` (cheap, no discovery),
  then `index_file` on what it flags. Avoid `index_folder` mid-task.
- Targeted re-index is graph-correct since v1.22.0: incoming edges survive
  re-parses, and newly added files receive edges from unchanged importers
  (stored import records, schema v10).

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

## Where things live

```
~/.purecontext/indexes/<repoId>.db   one SQLite file per indexed root
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
  indexes but is word-boundary text search, explicitly heuristic.
- Per-language import-resolution coverage varies — see
  `docs/07-language-support.md` before relying on graph tools for a language.
