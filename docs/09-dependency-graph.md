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
- **Package-style imports in languages without a resolver** (e.g., Ruby requires) — these are currently indistinguishable from external packages, so repos in those languages have few or zero edges. Graph tools built on `dep_edges` return empty results there; that is a missing graph, not an empty dependency set. Rust resolves since v1.20.0 (mod-tree resolver: `src/` layout per Cargo crate, `crate::`/`self::`/`super::`, workspace crates by name). See the support matrix in [LANGUAGE-SUPPORT.md](../LANGUAGE-SUPPORT.md#which-languages-get-dependency-edges).

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

Both walks are **file-granular** and depth-capped (default 3). `get_blast_radius` reports `granularity: "file"`, the effective `depth`, and `truncated: true` when the cap cut the walk short — treat a truncated result as a lower bound.

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
