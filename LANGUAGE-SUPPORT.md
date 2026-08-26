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
| Python | `.py` | functions, classes, methods, module-level consts — docstrings used as summaries |
| PHP | `.php` | functions, classes, interfaces, traits, enums, methods, properties, constants — PHP 8 attributes supported |
| Ruby | `.rb` | functions, classes, methods, modules, constants |
| Go | `.go` | functions, methods (bare names, no receiver prefix), structs, interfaces, consts, types — unexported names are skipped |
| Java | `.java` | classes, interfaces, enums, methods (including package-private), inner classes |
| Kotlin | `.kt`, `.kts` | functions, extension functions, classes, interfaces, objects, enums, typealiases — KDoc summaries |
| C# | `.cs` | classes, interfaces, enums, structs, records, methods, properties, consts — `internal` and modifier-less types included with visibility metadata |
| Scala | `.scala`, `.sc` | classes, traits, objects, case classes, functions, methods, types, enums |
| Dart | `.dart` | classes, mixins, extensions, enums, functions, methods — `_`-prefixed names are skipped |
| Swift | `.swift` | classes, structs, protocols, actors, extensions, methods, enums |
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
| C++ | `.cpp`, `.cxx`, `.cc`, `.hpp`, `.hxx`, `.hh` | All C kinds plus namespaces, templates, template classes with export macros |
| Rust | `.rs` | functions, methods (bare names), structs, enums, traits, consts, types — `pub` filter for impl methods |
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
| Imports are literal file paths | C, C++, Dart, SCSS/LESS/CSS, Terraform/HCL, Protobuf, Nix, Perl, XML, Bash |
| **Not yet resolved — symbols only, no dependency edges** | Python, Go, PHP, Rust, Haskell, Fortran, and other languages with package-style imports (`import numpy`, Go module paths, PHP namespaces, …) |

For languages in the last row, the graph-based tools return empty or partial results: an empty blast radius there means "no graph", **not** "nothing depends on this symbol". `find_references` (a content scan) and `get_co_change` (git history) work for every language and are the graph-independent alternatives.

JVM notes: resolution keys on each file's declared `package` (captured at index time), so it works even when packages don't match directory layout. When the same package + class name exists in several Gradle/Maven modules, edges prefer the importing file's own module and otherwise go to **all** candidates — over-approximating is the safe direction for blast radius. Re-index a repo indexed before v1.15.0 to populate the package data.

C# notes (v1.16.0): every `using X.Y` imports a whole namespace, so it resolves to **all** files declaring that namespace (capped by `graph.maxWildcardFanout`, default 100 — first N in deterministic order, 0 = uncapped). `using static` and alias usings resolve to the type's file. Project boundaries come from `*.csproj`/`*.sln` markers. A file with nested `namespace A { namespace B { … } }` blocks stores only the outermost namespace; inner names still resolve partially via the symbol-table fallback. Re-index a repo indexed before v1.16.0 to populate the namespace data.

---

## What is filtered out automatically

Some things you don't want in the index — they bloat it and pollute search results. PureContext excludes:

- Standard build and dependency directories: `node_modules/`, `.git/`, `dist/`, `build/`, `target/`, `.next/`, `.nuxt/`, `.claude/`
- Lock files (`*.lock`) and environment files (`.env*`)
- Binary files (detected by null-byte scanning of the first 8 KB — works without a hardcoded extension list)
- Files larger than 1 MB (raise the limit with `maxFileSizeBytes` in config)
- Secret files: `*.pem`, `*.key`, `id_rsa`, `credentials.json`, `serviceAccountKey*.json`

It also respects language-level visibility:

- **Go**: unexported names (lowercase first letter)
- **C**: `static` functions (translation-unit internal)
- **Java / PHP**: `private` members
- **C#**: `private` members and no-modifier members (implicitly private). `internal` and modifier-less top-level types (implicitly internal) ARE indexed, with `frameworkMeta.visibility` recorded — assembly-visible types are exactly the unit being indexed
- **Dart**: `_`-prefixed names

Public API tools (`get_public_api`) rely on these rules being applied consistently — they assume the index already reflects what is externally visible.

---

## Known limitations

- **Import resolution is not universal** — languages with package-style imports other than the JVM family and C# (Python, Go, PHP, Rust, …) index symbols but produce **no dependency edges** today, so graph tools return empty results there. See [Which languages get dependency edges](#which-languages-get-dependency-edges) above.
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
