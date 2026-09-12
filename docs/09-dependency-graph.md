# Dependency Graph Tools


The dependency graph tracks import relationships between files. Four tools let agents query it at different granularities — from a single hop to a full transitive walk.

---

## Concepts

During indexing, each `import` / `require` / `use` statement is resolved to a dependency edge:

```
dep_edge: sourceFile → resolvedTargetFile (via import specifier)
```

Edges are stored in the `dep_edges` SQLite table. An edge is created only when the import specifier can be resolved to a file inside the repo. Two cases resolve to nothing and produce **no edge**:

- **External packages** (e.g., `from 'react'`, `java.util.*`) — correctly excluded. Since v1.22.0 this includes **reserved namespaces** (`graph.reservedNamespaces`, default `android.*`/`java.*`/`kotlin.*`/…): even when a repo file DECLARES such a package (vendored AOSP shims, JVM unit-test stubs shadowing `android.util.Log` — standard Android practice), an import of that namespace means the platform SDK and produces no edge. Set `[]` on an AOSP fork that genuinely owns those namespaces.
- **Imports into a LINKED index** (v1.32.0) — when a build tree is indexed as several roots inside ONE git checkout, an import whose target lives in a sibling root becomes a cross-index edge (`target_repo_id` set, validated against the sibling's files). `get_blast_radius` / `find_importers` / `get_context_bundle` follow them and return the sibling's files under `linked`; `list_repos.links` shows the links and their drift. Since v1.35.0 `find_cycles`, `get_layer_violations`, `get_architecture_snapshot` / `compare_change_impact`, `get_coupling_map`, `render_import_graph` and `render_dep_matrix` follow them too when called with `crossIndex: true` (one union adjacency over the workspace; linked files appear as `<linkedRepoId>:<path>`, layer rules name a linked root as `<rootName>:<glob>`), `find_dead_code` reports `keptAliveByLinks`, and android DI edges cross into a linked root's providers. Worktrees and unrelated repositories never link automatically (`graph.linkedRepos` for the explicit case; `graph.crossIndex: 'off'` disables it).
- **Package-style imports in languages without a resolver** (Protobuf, SQL/dbt, GDScript, and Gleam/Lua/R beyond literal paths) — these are currently indistinguishable from external packages, so repos in those languages have few or zero edges. Graph tools built on `dep_edges` return empty results there; that is a missing graph, not an empty dependency set. Rust resolves since v1.20.0 (mod-tree resolver: `src/` layout per Cargo crate, `crate::`/`self::`/`super::`, workspace crates by name); Dart `package:` imports resolve since v1.31.0 (`pubspec.yaml` name → `lib/`); Ruby `require`/`require_relative` and Zeitwerk class-body constant references resolve since v1.36.0 (load-path roots discovered by convention and by evidence, stdlib names reserved via `graph.reservedRubyModules`); Swift `import X` resolves since v1.36.0 to every file of the SwiftPM target X (`Package.swift` parsed; `Sources/<X>` stands in without a manifest).
- **Dangling edges from older indexes** — before v1.31.0 a handler-prefilled literal target (`"auth.h"`, `a/b.lua`, `@use 'variables'`) was stored verbatim even when no indexed file matched, so edge counts could look healthy while every graph query answered nothing. Since v1.31.0 those targets are validated (sibling / include-root / suffix / stylesheet-partial / Lua module / Terraform directory probes) and dropped otherwise; `graphCoverage` counts only RESOLVABLE rows (`'empty'`) and reports `'partial'` with `danglingEdges`/`resolvableEdges` when an old index still carries phantom rows — re-run `index_folder` to heal. See the support matrix in [LANGUAGE-SUPPORT.md](../LANGUAGE-SUPPORT.md#which-languages-get-dependency-edges).

JVM imports (Kotlin, Java, Scala, Groovy) ARE resolved: each file's declared `package` is captured at index time and `com.example.Foo` maps to the file that declares it, including wildcard imports, Kotlin top-level member imports, and same-package-in-several-modules disambiguation (own Gradle/Maven module preferred, otherwise edges to all candidates). Repos indexed before v1.15.0 need one re-index to populate the package data.

C# `using` directives ARE resolved the same way (v1.16.0): each file's declared `namespace` (file-scoped or outermost block) is captured at index time. A plain `using X.Y` imports the whole namespace, so it produces edges to **every** file declaring it — capped at `graph.maxWildcardFanout` files (default 100, deterministic order, 0 = uncapped). `using static X.Y.T` and alias `using F = X.Y.T` resolve to the type's file. Cross-project ambiguity prefers the importing file's own `*.csproj`/`*.sln` project. Repos indexed before v1.16.0 need one re-index to populate the namespace data.

Python imports ARE resolved (v1.17.0): module identity is the file path (`a/b.py` ↔ `a.b`, `a/b/__init__.py` ↔ `a.b`), with `src/` and other non-package first-level source dirs stripped. Relative imports (`from . import x`, `from ..pkg import y`) resolve by exact directory walk; `from a.b import c` prefers the submodule `a/b/c.py`, else the module file (symbol-table tiebreak on ambiguity). `sys.path` manipulation, editable installs, and `pyproject` package-dir remapping are not supported. Repos indexed before v1.17.0 need one re-index.

Go imports ARE resolved (v1.17.0): every `go.mod` above an indexed `.go` file contributes `module <path>` → directory (nested modules / workspaces supported, longest prefix wins). An import path resolves to **every** indexed `.go` file of the target package directory — the true Go package semantic. stdlib/third-party imports produce no edge; edges never point into `vendor/`. Repos indexed before v1.17.0 need one re-index.

PHP, Haskell, Elixir, Erlang, and Fortran imports ARE resolved (v1.19.0, "Declared-Module Wave 2"): PHP `use` clauses resolve against declared namespaces + the qualified symbol table, with composer.json PSR-4 maps as fallback (whole-namespace uses are capped by `graph.maxWildcardFanout`); Haskell `import A.B.C` matches the file declaring `module A.B.C where` (one module per file); Elixir `alias`/`import`/`use` matches `defmodule` symbols, with a longest-known-prefix fallback for nested module names; Erlang `-import(mod, …)` resolves by file basename (`mod.erl`) and `-include`/`-include_lib` by `.hrl` basename; Fortran `USE name` matches files declaring `MODULE name` (case-insensitive). External specifiers (`Symfony\…`, `Data.Map`, `Ecto.*`, OTP modules, compiler intrinsics) produce no edge. Repos indexed before v1.19.0 need one re-index.

Edge hygiene (v1.22.0): a **production file never gets an edge into a test source set** (`src/test/`, `src/androidTest/`, `src/testFixtures/`, .NET `*.Tests/` projects) — a `src/main/` file cannot depend on a test stub; the dependency only runs the other way (test → main stays allowed). The same rule applies to Hilt/Dagger DI edges (a production consumer never depends on a `@TestInstallIn` fake).

Freshness (v1.22.0): re-indexing a file clears only its OUTGOING edges (incoming edges from unchanged importers survive — previously the `index_file` loop eroded them); adding a new file re-resolves the graph from stored import records so unchanged importers gain their edges; and `index_folder` prunes files that vanished from disk (`filesPruned` in the response), so an in-place branch switch converges instead of accreting a union of branches.

Two directions of traversal:
- **Forward walk** — "what does X depend on?" (imports, transitively)
- **Reverse walk** — "what depends on X?" (importers, transitively)

Both walks are **file-granular by default** and depth-capped (default 3). `get_blast_radius` reports `granularity: "file"`, the effective `depth`, and `truncated: true` when the cap cut the walk short — treat a truncated result as a lower bound.

### Symbol-level edges (v1.34.0)

Next to the file edges the index stores **`ref` edges: symbol → symbol**, derived at index time from three stored facts — a file's import records (which names it imported from where), the target file's symbol table, and each symbol's byte span over the file bytes. One alternation regex runs over each importing file; every hit is attributed to the innermost enclosing symbol. No new parse. Rules per language live in `dev-docs/in-progress/phase101-design.md` §3 (named / default / namespace imports, Java and Kotlin wildcards, Go package qualifiers, Rust `m::f`, Python `pkg.mod.x`, barrel re-export chains up to 3 hops, `export … from` recorded as an import).

- **Opt-in per call:** `granularity: "symbol"` on `get_blast_radius` (reverse: who mentions this symbol) and `get_context_bundle` (forward: what this symbol mentions). The response carries `depth` per symbol, `via` (the matched name), `refCount`, and the file-level answer as `fileRadius` / `fileBundle`.
- **`confidence: "lexical"`**, always. A shadowed parameter, a string or a comment can produce a false positive; a name the importing file declares itself is never matched; a bare token right after `.` (member access on another object) is not matched; open imports (`*`, package/namespace imports) expand to at most `graph.maxWildcardFanout` names.
- **Cross-file only.** A same-file call is never a `ref` (there is no import to derive it from). `get_call_hierarchy` and `trace_invocation_chain` use refs for cross-file callers/callees and scan only the symbol's own file for the rest (`edgeSource: "ref"`); an index without refs keeps the whole-repo scan (`edgeSource: "scan"`).
- **Depth arithmetic.** A barrel's re-export is one symbol hop but two file hops, so at equal depth a symbol walk can reach a file the file walk reaches one hop later. The invariant that holds is "no ref without an import path".
- **Availability.** Built on every index run (`graph.symbolEdges: "auto"`, env `PCTX_SYMBOL_EDGES=off|auto`, `skipSymbolEdges` per run). A pre-1.34 index gets them on its next whole-tree `index_folder` (one-time backfill); until then symbol-granularity calls answer at file level with a `note`, and `list_repos.symbolRefs` is 0. Cross-index refs follow the Phase-99 workspace; a linked root rebuilds all its refs on every whole-tree run because a chain through a sibling's barrel depends on the sibling's edges.

---

## `get_context_bundle`

**Purpose:** Forward-walk from a symbol — returns everything an agent needs to understand it (the symbol itself plus its transitive imports).

**When to use:** Before modifying a function — understand its full context without reading whole files.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `repoId` | `string` | required | Target repository |
| `symbolId` | `string` | required | Starting symbol |
| `maxDepth` | `number` | `3` | Traversal depth |
| `maxTokens` | `number` | — | Stop collecting when estimate exceeds this |
| `granularity` | `"file" \| "symbol"` | `"file"` | v1.34.0: `"symbol"` follows `ref` edges (what this symbol mentions) and reports `fileBundle` alongside |

**Example:**

```
"Give me everything needed to understand the processOrder function."

→ get_context_bundle({ symbolId: "processOrder-id", maxDepth: 2 })
→ Returns: processOrder + validateCart + calculateTax + formatPrice
  _tokenEstimate: 820
```

**Response:**

```json
{
  "symbols": [
    { "id": "...", "name": "processOrder", "signature": "...", "source": "..." },
    { "id": "...", "name": "validateCart", "signature": "...", "source": "..." }
  ],
  "files": ["src/orders/processor.ts", "src/cart/validator.ts"],
  "_tokenEstimate": 820
}
```

---

## `get_blast_radius`

**Purpose:** Reverse-walk — all files that (transitively) import a given symbol. Tells you what would break if you change or delete it.

**When to use:** Before modifying or deleting a symbol.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `repoId` | `string` | required | Target repository |
| `symbolId` | `string` | required | Symbol to analyze |
| `maxDepth` | `number` | `5` | Traversal depth |
| `granularity` | `"file" \| "symbol"` | `"file"` | v1.34.0: `"symbol"` walks `ref` edges (who mentions this symbol) and reports `fileRadius` alongside |

**Example:**

```
"What breaks if I change UserService.authenticate?"

→ get_blast_radius({ symbolId: "UserService.authenticate-id" })
→ Returns: 14 files at depth 1–3
  (AuthController, LoginPage, SessionMiddleware, tests/...)
```

**Response:**

```json
{
  "importers": [
    "src/controllers/auth.ts",
    "src/middleware/session.ts",
    "src/pages/Login.tsx",
    "test/auth.test.ts"
  ],
  "count": 14,
  "_tokenEstimate": 120
}
```

---

## `find_importers`

**Purpose:** Direct (one-hop) importers of a file — faster and narrower than `get_blast_radius`.

**When to use:** Quick check — "who imports this module directly?"

**Parameters:** `{ repoId, filePath }` — `filePath` is relative to repo root.

**Response:**

```json
{
  "importers": [
    {
      "filePath": "src/controllers/auth.ts",
      "importedNames": ["UserService", "AuthToken"]
    }
  ],
  "_tokenEstimate": 80
}
```

---

## `find_dead_code`

**Purpose:** Exported symbols in files that nothing else imports — potential dead code.

**When to use:** Cleanup sprints, pre-refactor audits.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `repoId` | `string` | required | Target repository |
| `limit` | `number` | `50` | Max results |

**Response:**

```json
{
  "symbols": [
    {
      "id": "...",
      "name": "legacyFormatDate",
      "kind": "function",
      "filePath": "src/utils/date-old.ts",
      "signature": "function legacyFormatDate(d: Date): string"
    }
  ],
  "_tokenEstimate": 240
}
```

**False positive sources:**
- **Dynamic imports** — `import('./module')` are not tracked by the static graph
- **Side-effect imports** — `import './setup'` (no names imported) create edges but no `importedNames`
- **External consumers** — if this repo is itself an npm package, external consumers won't appear in the index
- **Test files** — test imports are included in the graph; symbols only used by tests are not dead

---

## Combining graph tools

A typical refactoring workflow:

```
1. get_blast_radius(symbolId)
   → See the full impact scope before touching anything

2. get_context_bundle(symbolId, maxDepth: 2)
   → Understand the symbol and its immediate dependencies

3. Make the change

4. find_dead_code(repoId)
   → Verify no orphaned exports were left behind
```
