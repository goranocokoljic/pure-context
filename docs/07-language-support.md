# Language Support — Reference

This is the reference page: the per-language symbol-kind table and grammar notes.

For the **user-friendly tour** — category groupings, framework integration notes, "Adding a new language" guide — see [`LANGUAGE-SUPPORT.md`](../LANGUAGE-SUPPORT.md) at the project root.

---

PureContext supports **34 languages** via tree-sitter WASM grammars plus four regex-based handlers for CSS-family languages. All grammars are bundled in `grammars/` — no separate install needed.

---

## Symbol-kind matrix (tree-sitter handlers)

| Language | Extensions | Symbol Kinds | Doc Comments |
|----------|-----------|--------------|--------------|
| TypeScript | `.ts`, `.tsx`, `.mts`, `.cts` | function, class, method, const, type, interface, enum | JSDoc `/** */` |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | function, class, method, const | JSDoc `/** */` |
| Python | `.py` | function, class, method, const | `"""` docstrings |
| Go | `.go` | function, method, class (struct), interface, const, type | `//` preceding comments |
| Rust | `.rs` | function, method, class (struct), enum, interface (trait), const, type | `///` doc comments |
| Java | `.java` | class, interface, enum, method, const | Javadoc `/** */` |
| C# | `.cs` | class, interface, enum, struct, record, method, const, property | XML docs `/// <summary>` |
| PHP | `.php` | function, class, interface, trait, enum, method, const, property | PHPDoc `/** */` |
| Ruby | `.rb` | function, class, method, module, const, property (DSL macros) | `#` comments |
| Kotlin | `.kt`, `.kts` | function, class, interface, enum, method, typealias, object, property | KDoc `/**` |
| C | `.c`, `.h` | function, struct, enum, macro, type | `//` and `/* */` |
| C++ | `.cpp`, `.cxx`, `.cc`, `.hpp`, `.hxx`, `.hh` | All C kinds + namespace, template, template-class | `///` Doxygen |
| Lua | `.lua` | function, method, const | `--` comments |
| Dart | `.dart` | class, mixin, extension, enum, function, method, const, type | `///` doc comments |
| Swift | `.swift` | class, struct, protocol, actor, extension, method, enum, type | `///` DocC |
| Elixir | `.ex`, `.exs` | module (class), function, macro, struct, protocol | `@doc` attribute |
| Haskell | `.hs`, `.lhs` | function, data (class), typeclass (interface), instance, type, newtype | Haddock `-- \|` |
| Scala | `.scala`, `.sc` | class, trait, object, case class, function, method, type, enum | Scaladoc `/** */` |
| R | `.r`, `.R`, `.Rmd` | function, const, S3/S4/R6 class | Roxygen2 `#'` |
| Bash | `.sh`, `.bash`, extensionless (shebang-detected) | function | — |
| Perl | `.pl`, `.pm` | function, package | — |
| Groovy | `.groovy` | function, class, method | — |
| Erlang | `.erl`, `.hrl` | function (bare name; arity in `frameworkMeta`), module | — |
| Gleam | `.gleam` | function, type | — |
| GDScript | `.gd` | function, class, signal | — |
| Objective-C | `.m`, `.h` (guarded) | function, class, protocol, method (full selector), property, category | — |
| Fortran | `.f90`, `.f95`, `.for`, `.f`, `.F90` (case-insensitive) | function, subroutine, module | — |
| Terraform / HCL | `.tf`, `.tfvars`, `.hcl` | variable, output, resource, data, module, provider, locals | — |
| Nix | `.nix` | function, attribute | — |
| SQL | `.sql` | table, view, function, procedure | — |
| Protobuf | `.proto` | message, service, enum, rpc | — |
| GraphQL | `.graphql`, `.gql` | type, query, mutation, subscription, fragment | — |
| OpenAPI / YAML | `.yaml`, `.yml` (content-detected) | endpoint, schema | — |
| XML | `.xml` | element (disambiguated as `tag@module` in multi-module repos) | — |
| Angular HTML | `.html` (guarded) | component selector, structural directive, control flow, event binding, template ref | — |

---

## Symbol-kind matrix (regex handlers, no WASM grammar)

| Language | Extensions | Symbol Kinds |
|----------|-----------|--------------|
| SCSS / SASS | `.scss`, `.sass` | `@mixin` → function, `@function` → function, top-level `$var` → const, `%placeholder` → class, `@keyframes` → type |
| LESS | `.less` | `.mixin(@params)` → function, top-level `@var` → const, `@keyframes` → type |
| CSS | `.css` | `--custom-property` → const (opt-in via `indexing.cssVariables: true`) |

CSS-family languages don't have a stable tree-sitter grammar, so PureContext uses targeted regex extraction. Only named, reusable constructs are indexed — plain selectors would flood the index with noise.

---

## Visibility filtering

| Language | What is excluded |
|----------|------------------|
| Go | Nothing since v1.17.0 — unexported identifiers are indexed with `frameworkMeta.visibility: 'unexported'` |
| C | `static` functions (translation-unit internal) |
| Java | `private` members |
| C# | `private` members; interface members are implicitly public |
| PHP | `private` members |
| Dart | `_`-prefixed identifiers |
| Rust | Nothing since v1.20.0 — `pub(crate)`-family items record `frameworkMeta.visibility: 'crate'`, no-modifier items record `'module'` |

`get_public_api` and related tools depend on these rules being applied consistently.

---

## File-system exclusions

Applied before any handler runs:

- Directories: `node_modules/`, `.git/`, `dist/`, `build/`, `target/`, `.next/`, `.nuxt/`, `.claude/`
- Lock files (`*.lock`), env files (`.env*`)
- Binary files (null-byte scan of first 8 KB; no hardcoded extension list)
- Files larger than 1 MB (override via `indexing.maxFileSizeBytes`)
- Secret patterns: `*.pem`, `*.key`, `id_rsa`, `credentials.json`, `serviceAccountKey*.json`

---

## Grammar notes and known limitations

- **TypeScript JSX** (`.tsx`) uses `tree-sitter-tsx`, a separate grammar from `tree-sitter-typescript`. Both are bundled.
- **Python stubs** (`.pyi`) are not indexed — only `.py` files.
- **Objective-C** `.h` files are guarded: parsed as ObjC only if the first 16 KB contain `@interface` or `@protocol`; otherwise treated as C.
- **Angular HTML** `.html` files are guarded: parsed as Angular templates only if a sibling `.component.ts` exists or the first 4 KB contain Angular markers.
- **Terraform**: complex `dynamic` blocks may not be fully extracted.
- **XML**: element extraction uses configurable patterns; not every tag is indexed by default. Root-element symbols are stored as `tag@module` in multi-module repos to avoid collisions.
- **OpenAPI**: schema-name extraction supports hyphens (`[\w-]+`), so GitHub-style schemas like `pull-request` are indexed.

---

## Related reference

- [Framework Adapters](08-framework-adapters.md) — adapter layer that adds framework-specific symbols on top of these handlers
- [Configuration](04-configuration.md) — `indexing.*` flags including `cssVariables`, `maxFileSizeBytes`, `xmlElementPatterns`
- [Architecture Overview](25-architecture-overview.md) — three-layer design (Core → Handlers → Adapters)
