# Language Support

PureContext indexes **34 languages** out of the box, plus a small set of regex-based handlers for stylesheets. Every grammar is bundled as a WASM file — no separate install, no native compilation, no language servers to start. When you point it at a polyglot repo, all handlers run in parallel.

This page is the user-facing tour: what's supported, what gets pulled out, and what to expect from each major category. For parameter-level details (every node kind, every signature shape), see the [reference manual](docs/07-language-support.md).

---

## The full list

### Web and application languages

| Language | Extensions | What you get |
|----------|-----------|-------------|
| TypeScript | `.ts`, `.tsx`, `.mts`, `.cts` | functions, classes, methods, consts, types, interfaces, enums — full type annotations in signatures |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | functions, classes, methods, exported consts |
| Python | `.py` | functions, classes, methods, module-level consts — docstrings used as summaries; dependency edges since v1.17.0 |
| PHP | `.php` | functions, classes, interfaces, traits, enums, methods, properties, constants — PHP 8 attributes supported |
| Ruby | `.rb` | functions, classes, methods, modules, constants |
| Go | `.go` | functions, methods (bare names, no receiver prefix), structs, interfaces, consts, types — unexported names indexed with visibility metadata since v1.17.0; dependency edges via `go.mod` since v1.17.0 |
| Java | `.java` | classes, interfaces, enums, methods, constructors, fields, inner classes — everything except `private` since v1.31.0; package-private and `protected` declarations carry `frameworkMeta.visibility` |
| Kotlin | `.kt`, `.kts` | functions, extension functions, classes, interfaces, objects, enums, typealiases — KDoc summaries |
| C# | `.cs` | classes, interfaces, enums, structs, records, methods, properties, consts — `internal` and modifier-less types included with visibility metadata |
| Scala | `.scala`, `.sc` | classes, traits, objects, case classes, functions, methods, types, enums — `protected` and `private[pkg]` included since v1.31.0 with `frameworkMeta.visibility`; only unqualified `private` is skipped |
| Dart | `.dart` | classes, mixins, extensions, enums, functions, methods — `_`-prefixed (library-private) names included since v1.31.0 with `frameworkMeta.visibility: 'library'`; `package:` imports resolve to edges via `pubspec.yaml` |
| Swift | `.swift` | classes, structs, protocols, actors, extensions, methods, enums — `private`/`fileprivate` TYPES and EXTENSIONS (and their members) included since v1.31.0 with `frameworkMeta.visibility: 'file'`; private members stay skipped |
| Elixir | `.ex`, `.exs` | modules, functions, macros, structs, protocols |
| Haskell | `.hs`, `.lhs` | functions, data types, typeclasses, instances, type aliases, newtypes |
| Lua | `.lua` | functions, methods, consts |
| R | `.r`, `.R`, `.Rmd` | functions, consts, S3/S4/R6 classes — Roxygen2 doc comments |
| Perl | `.pl`, `.pm` | functions, packages |
| Groovy | `.groovy` | functions, classes, methods |
| Erlang | `.erl`, `.hrl` | functions, modules |
| Gleam | `.gleam` | functions, types |

### Systems languages

| Language | Extensions | What you get |
|----------|-----------|-------------|
| C | `.c`, `.h` | functions, structs, enums, macros, types — `static` functions skipped (translation-unit internal) |
| C++ | `.cpp`, `.cxx`, `.cc`, `.hpp`, `.hxx`, `.hh` | All C kinds plus namespaces, templates, template classes with export macros; anonymous-namespace members since v1.31.0 (`frameworkMeta.visibility: 'file'`) |
| Rust | `.rs` | functions, methods (bare names), structs, enums, traits, consts, types — everything indexed since v1.20.0; non-`pub` items carry `frameworkMeta.visibility` (`crate` for `pub(crate)`/`pub(super)`/`pub(in …)`, `module` for no modifier) |
| Fortran | `.f90`, `.f95`, `.for`, `.f` | functions, subroutines, modules |
| Objective-C | `.m`, `.h` | functions, classes, methods |

### Scripting and game

| Language | Extensions | What you get |
|----------|-----------|-------------|
| Bash | `.sh`, `.bash` | functions |
| GDScript | `.gd` | functions, classes, signals |

### Infrastructure and config

| Language | Extensions | What you get |
|----------|-----------|-------------|
| Terraform / HCL | `.tf`, `.hcl` | resources, modules, variables, outputs |
| Nix | `.nix` | functions, attributes |

### Data and API

| Language | Extensions | What you get |
|----------|-----------|-------------|
| SQL | `.sql` | tables, views, functions, procedures |
| Protobuf | `.proto` | messages, services, enums, RPCs |
| GraphQL | `.graphql`, `.gql` | types, queries, mutations, subscriptions, fragments |
| OpenAPI / YAML | `.yaml`, `.yml` | endpoints, schemas (OpenAPI detected by content) |
| Angular HTML | `.html` | component tags, structural directives, `@if`/`@for` control flow, event bindings, template refs, routerLink — only for files with a same-stem sibling `.ts` or ≥2 distinct Angular markers; plain HTML yields nothing |
| XML | `.xml` | elements (configurable patterns — opt-in) |

### Stylesheets (regex-based, no WASM grammar)

CSS-family languages don't have a stable tree-sitter grammar, so PureContext extracts a focused subset using regex. Only named, reusable constructs are indexed — plain selectors are skipped because they would flood the index with noise.

| Language | Extensions | What you get |
|----------|-----------|-------------|
| SCSS / SASS | `.scss`, `.sass` | `@mixin`, `@function`, top-level `$variables`, `%placeholders`, `@keyframes` |
| LESS | `.less` | `.mixin(@params)`, top-level `@variables`, `@keyframes` |
| CSS | `.css` | `--custom-properties` (opt-in via `indexing.cssVariables: true`) |

---

## What gets indexed for every language

Regardless of language, every symbol you find through `search_symbols` carries:

- **Name** — the identifier as it appears in source
- **Kind** — function, class, method, route, component, etc.
- **Byte offsets** — `startByte` / `endByte` for precise source retrieval; no need to re-read the whole file to grab a function body
- **Signature** — a one-line declaration with the full type information available in that language
- **Summary** — sourced from the docstring/JSDoc/Javadoc/Roxygen comment if present, otherwise inferred from framework context (route path, ORM table, etc.), otherwise a one-line AI summary, otherwise the signature itself

The summary chain (docstring → framework inference → AI → signature fallback) is what makes search across an undocumented codebase still work. See [AI Summaries](AI-SUMMARIES.md) for how to enable LLM summaries on legacy projects.

---

## Which languages get dependency edges

Symbol extraction and search work for all 34 languages. **Import / dependency edges** — the data behind `get_blast_radius`, `find_importers`, `find_cycles`, `get_call_hierarchy`, `get_dependency_graph`, the architecture tools, and the centrality axis of `get_symbol_risk` — currently exist only where the import specifier can be resolved to a file in the repo:

| Resolution | Languages |
|------------|-----------|
| Module resolver (relative paths + `tsconfig` path aliases) | TypeScript, JavaScript |
| Declared-module resolver (JVM + C#: declared `package`/`namespace` → file, incl. wildcards, member/static imports, and Gradle/Maven/`.csproj` multi-project disambiguation) | Kotlin, Java, Scala, Groovy, C# |
| Hilt/Dagger DI edges (v1.18.0, Android repos: `@Provides`/`@Binds`/`@Inject` metadata → `di` edges, consumer file → provider file — coupling the import graph cannot see; name-based, ambiguous names edge to all providers; excluded from `find_cycles`) | Kotlin, Java (android adapter active) |
| Layout-convention resolver (dotted module path → file path; absolute, from-, and relative imports; source roots = `src/`, `lib/` + `pyproject` package-dir / poetry `from` (v1.31.0 allowlist); stdlib names reserved) | Python |
| `go.mod` resolver (module path → package directory → every `.go` file in it; nested modules / workspaces supported) | Go |
| PSR-4 + declared-namespace resolver (`use X\Y\Class` → declared `namespace` map first, composer.json PSR-4 map as fallback; composer roots disambiguate) | PHP |
| Declared-module resolver, exact form (`module A.B.C where` → one module per file; path-suffix fallback for headerless files) | Haskell |
| Module-symbol resolver (`alias`/`import`/`use` → `defmodule` symbol map; nested modules fall back to the longest known prefix) | Elixir |
| Basename resolver (module == file basename: `-import(mod, …)` → `mod.erl`; `-include`/`-include_lib` → `.hrl` basename) | Erlang |
| Module-symbol resolver (`USE module_name` → files declaring that MODULE, case-insensitive) | Fortran |
| Mod-tree resolver (`use crate::a::b::Item` → module map derived from the `src/` file layout per Cargo crate; `self::`/`super::` relative to the source file's module; workspace crates by `Cargo.toml` name) | Rust |
| `pubspec.yaml` resolver (`package:<name>/<path>` → that package's `lib/<path>`; nested packages in monorepos) | Dart (v1.31.0) |
| Imports are literal file paths, VALIDATED against the index since v1.31.0 (sibling / include-root / suffix / stylesheet-partial / Lua module / Terraform directory probes; a target that names no indexed file is dropped, never stored as a dangling edge) | C, C++, Objective-C, Lua, SCSS/LESS/CSS, Terraform/HCL, Protobuf, Nix, Perl, XML, Bash, R, Gleam |
| **Not yet resolved — symbols only, no dependency edges** | Ruby and the long tail without a clear module→file rule (GDScript, …) |

Every resolver above also runs **across linked indexes** since v1.32.0: when a local lookup finds nothing, the same family resolver is asked over each linked index's files in turn (declared JVM packages, Python source roots of THAT root, `go.mod` modules, …), and TypeScript/JavaScript relative paths that leave the root are matched against the linked root's files. Indexes link automatically when their roots are disjoint directories of one git checkout; see [Index boundaries](AGENT_REFERENCE.md) for what still stays per index.

For languages in the last row, the graph-based tools return empty or partial results: an empty blast radius there means "no graph", **not** "nothing depends on this symbol". `find_references` (a content scan) and `get_co_change` (git history) work for every language and are the graph-independent alternatives.

JVM notes: resolution keys on each file's declared `package` (captured at index time), so it works even when packages don't match directory layout. When the same package + class name exists in several Gradle/Maven modules, edges prefer the importing file's own module and otherwise go to **all** candidates — over-approximating is the safe direction for blast radius. Re-index a repo indexed before v1.15.0 to populate the package data.

Edge hygiene (v1.22.0, from a production-Android verification report): **reserved namespaces** (`graph.reservedNamespaces`, default `android`/`androidx`/`java`/`javax`/`kotlin`/`kotlinx`/`dalvik`/`com.android.internal`/`sun`/`jdk`) never resolve locally — a vendored AOSP shim or unit-test stub declaring `package android.util` cannot capture `import android.util.Log`; set `[]` on a repo that genuinely owns those namespaces (an AOSP fork). And **production files never get edges into test source sets** (`src/test/`, `src/androidTest/`, `src/testFixtures/`, .NET `*.Tests/` projects) — test → main and test → test stay allowed. Both rules also apply to Hilt/Dagger DI edges (reserved types are checked before package stripping; test-double providers are dropped for production consumers).

C# notes (v1.16.0): every `using X.Y` imports a whole namespace, so it resolves to **all** files declaring that namespace (capped by `graph.maxWildcardFanout`, default 100 — first N in deterministic order, 0 = uncapped). `using static` and alias usings resolve to the type's file. Project boundaries come from `*.csproj`/`*.sln` markers. A file with nested `namespace A { namespace B { … } }` blocks stores only the outermost namespace; inner names still resolve partially via the symbol-table fallback. Re-index a repo indexed before v1.16.0 to populate the namespace data.

Python notes (v1.17.0, hygiene v1.31.0): module identity is the file path, so no stored header is needed — `a/b.py` answers to `a.b`, `a/b/__init__.py` to `a.b`. Source roots are a strict allowlist — `src/`, `lib/` (config `graph.pythonSourceRoots`) plus `pyproject.toml` package-dir / poetry `from` — so `mypkg.core` finds `src/mypkg/core.py` while `tests/logging.py` stays `tests.logging` and can never capture `import logging`. Stdlib top-level names are reserved (`graph.reservedPythonModules`, default = CPython's list, `[]` to disable): they resolve to nothing even if a repo file shadows them. Production files never resolve to test files. Relative imports (`from . import x`, `from ..pkg import y`) resolve exactly by directory walk. `from a.b import c` prefers the submodule `a/b/c.py`, else the module file itself (symbol-table tiebreak when the name is ambiguous). Unknown modules (numpy, django) produce no edge. Not yet supported: `sys.path` manipulation, editable installs, `pyproject` package-dir remapping. Re-index a repo indexed before v1.17.0 to build the edges.

Go notes (v1.17.0): resolution parses every `go.mod` above an indexed `.go` file (`module` directive → directory; nested modules / workspaces supported, longest prefix wins). An import path resolves to **every** indexed `.go` file of the target package directory — that's the true Go package semantic, not over-approximation. `_test.go` files are included; stdlib and third-party imports produce no edge; edges are never emitted into `vendor/`. Build tags and cgo are ignored. Re-index a repo indexed before v1.17.0 to build the edges.

Rust notes (v1.20.0): the module map is derived from the file layout under each crate's `src/` (`src/a/b.rs` and `src/a/b/mod.rs` both answer to `a::b`; both 2015 and 2018 layouts work) — `#[path]` overrides and `build.rs`-generated modules are not followed (v1 limitation; layout and `mod` declarations agree in almost all real code). Crate boundaries come from the nearest ancestor `Cargo.toml`; crate names (`[package] name`, dash→underscore) let same-workspace crates resolve by name. `crate::`/`self::`/`super::` resolve against the source file's own module position; grouped uses are flattened (one edge target per leaf); globs (`use x::*`) expand to the module subtree, capped by `graph.maxWildcardFanout`; leaf items check the symbol table scoped to the resolved module's files, falling back to the module file itself (inline `mod` blocks, macro-generated items). `std` and crates.io imports produce no edge. A repo with no `Cargo.toml` still resolves a plain root `src/` layout. Re-index a repo indexed before v1.20.0 to build the edges.

Resolver hygiene (v1.31.0, gap-analysis follow-up): every family resolver applies two rules — a first-party importer never resolves INTO a foreign directory (`node_modules/`, `vendor/`, `third_party/`, `deps/`, `_build/`, `.venv/`, `site-packages/`, `Pods/`, `testdata/`; an importer that itself lives there keeps resolving its siblings, which is how rabbitmq-server lays out its components), and a non-test importer never resolves to a test file. Language specifics: Haskell never registers a one-segment path suffix (`**/Types.hs` used to answer `import Types` repo-wide); PHP ignores `composer.json` files under `vendor/` and serves `autoload-dev` PSR-4 entries to test-file importers only; Erlang prefers the header sharing the most leading directories with the importer; Fortran treats intrinsic modules (`iso_fortran_env`, `iso_c_binding`, `ieee_*`, `omp_lib`, `mpi`, …) as external; Go includes a package's `_test.go` files only for same-directory importers.

Wave 2 notes (v1.19.0 — PHP, Haskell, Elixir, Erlang, Fortran): all five ride the same family-resolver seam. PHP resolves `use` clauses against declared namespaces (captured per file) plus the fully-qualified symbol table, then falls back to composer.json PSR-4 maps (`autoload` + `autoload-dev`, root and nested); whole-namespace `use App\Models;` expands to all namespace files, capped by `graph.maxWildcardFanout`; multi-namespace files store only the FIRST namespace (v1 limitation). Haskell resolves `import A.B.C` by exact declared module header (one module per file). Elixir builds its module map from `defmodule`/`defprotocol` symbols, so multi-module files work; `A.B.C` without an exact match falls back to the longest known module prefix. Erlang maps `module:fun` to `module.erl` by basename (collisions edge to all candidates) and `-include`/`-include_lib` to `.hrl` files by header basename — include dirs are build configuration the indexer cannot see. Fortran maps `USE name` to files declaring `MODULE name` (case-insensitive). External/stdlib specifiers (`Symfony\…`, `Data.Map`, `Ecto.*`, `lists:`, `iso_fortran_env`) produce no edge. Re-index a repo indexed before v1.19.0 to build the edges.

---

## What is filtered out automatically

Some things you don't want in the index — they bloat it and pollute search results. PureContext excludes:

- Standard build and dependency directories: `node_modules/`, `.git/`, `dist/`, `build/`, `target/`, `.next/`, `.nuxt/`, `.claude/`, and since v1.31.0 `.venv/`, `venv/`, `site-packages/`, `Pods/`, `_build/`, `__pycache__/` (never first-party source). Everything discovery drops for other reasons is counted in `index_folder`'s `dropped` report (unsupported extension, secret, unreadable, oversized, binary, special, unreadable dirs).
- Lock files (`*.lock`) and environment files (`.env*`)
- Binary files (detected by null-byte scanning of the first 8 KB — works without a hardcoded extension list)
- Files larger than 1 MB (raise the limit with `maxFileSizeBytes` in config)
- Secret files: `*.pem`, `*.key`, `id_rsa`, `credentials.json`, `serviceAccountKey*.json`

It also respects language-level visibility:

- **Go**: nothing skipped since v1.17.0 — unexported names (lowercase first letter) ARE indexed with `frameworkMeta.visibility: 'unexported'` recorded, because they are package-visible and the package sits inside the indexed unit
- **Rust**: nothing skipped since v1.20.0 — Rust has no true `private` keyword, so everything is indexed: `pub` items carry no metadata, `pub(crate)`/`pub(super)`/`pub(in …)` record `frameworkMeta.visibility: 'crate'`, and no-modifier items (module-private, but visible to child modules and the same file) record `'module'`
- **C**: `static` functions (translation-unit internal)
- **C++**: label-less (default-private) class members; anonymous `namespace { }` members ARE indexed since v1.31.0 with `frameworkMeta.visibility: 'file'`
- **Java**: only `private` since v1.31.0 — package-private types (previously dropped WITH all their members), constructors, fields and methods, and `protected` declarations are indexed with `frameworkMeta.visibility: 'package'` / `'protected'`
- **Scala**: only unqualified `private` since v1.31.0 — `protected` (`'protected'`) and `private[pkg]` (`'package'`) are indexed with metadata
- **PHP**: `private` members
- **C#**: `private` members and no-modifier members (implicitly private). `internal` and modifier-less top-level types (implicitly internal) ARE indexed, with `frameworkMeta.visibility` recorded — assembly-visible types are exactly the unit being indexed
- **Dart**: nothing skipped since v1.31.0 — `_`-prefixed names are library-private (visible to every file of the library, and the core Flutter idiom `_MyHomePageState`) and are indexed with `frameworkMeta.visibility: 'library'`
- **Swift**: `private`/`fileprivate` MEMBERS; a private/fileprivate TYPE or EXTENSION (and everything inside it) IS indexed since v1.31.0 with `frameworkMeta.visibility: 'file'`

Public API tools (`get_public_api`) rely on these rules being applied consistently — they assume the index already reflects what is externally visible. The ranker applies a mild −20 to `visibility` values `unexported`, `module`, `package`, `file` and `library` (findable, but not first on a natural-language query); `protected`, `internal` and `crate` are unpenalized API surface.

---

## Known limitations

- **Import resolution is not universal** — Ruby (plus the long tail without a clear module→file rule) indexes symbols but produces **no dependency edges** today, so graph tools return empty results there. See [Which languages get dependency edges](#which-languages-get-dependency-edges) above.
- **TypeScript `.tsx`** uses a separate `tree-sitter-tsx` grammar from `.ts`. Both are bundled.
- **Python stubs** (`.pyi`) are not indexed — only `.py` files.
- **Terraform** `dynamic` blocks with complex expressions may not be fully extracted.
- **XML** element extraction uses configurable patterns rather than indexing every tag — turn it on per project if you need it.
- **CSS** custom properties (`--foo`) are off by default; enable with `indexing.cssVariables: true` when you have a design system worth indexing.

---

## Adding a new language

If a grammar you care about is missing, the path to support is straightforward:

1. Add a new file in `src/handlers/`, implementing `LanguageHandler`
2. Bundle the `.wasm` grammar in `grammars/`
3. Register the handler in the language dispatcher
4. Add tests against fixture files in `test/handlers/`

Regex-only handlers (like SCSS) skip step 2 entirely — they return `null` from `grammarPath()`.

See `docs/25-architecture-overview.md` for the three-layer design (Core → Handlers → Adapters) and the conventions every handler follows.

---

→ Full parameter-level reference: [docs/07-language-support.md](docs/07-language-support.md)
→ Adapter layer that adds framework-specific symbols on top: [FRAMEWORK-ADAPTERS.md](FRAMEWORK-ADAPTERS.md)
