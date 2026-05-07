# Language Support


PureContext supports **34 languages** via tree-sitter WASM grammars. All grammars are bundled in the `grammars/` directory — no separate install needed.

---

## Supported languages

| Language | Extensions | Symbol Types | Doc Comments |
|----------|-----------|--------------|--------------|
| TypeScript | `.ts`, `.tsx`, `.mts`, `.cts` | function, class, method, const, type, interface, enum | JSDoc `/** */` |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | function, class, method, const | JSDoc `/** */` |
| Python | `.py` | function, class, method, const | Docstrings `"""` |
| Go | `.go` | function, method, class (struct), interface, const, type | `//` preceding comments |
| Rust | `.rs` | function, method, class (struct), enum, interface (trait), const, type | `///` doc comments |
| Java | `.java` | class, interface, enum, method, const | Javadoc `/** */` |
| C# | `.cs` | class, interface, enum, struct, record, method, const, property | XML docs `/// <summary>` |
| PHP | `.php` | function, class, interface, trait, enum, method, const | PHPDoc `/** */` |
| Ruby | `.rb` | function, class, method, module, const | `#` comments |
| Kotlin | `.kt`, `.kts` | function, class, interface, enum, method, typealias, object | KDoc `/**` |
| C | `.c`, `.h` | function, struct, enum, macro, type | `//` and `/* */` |
| C++ | `.cpp`, `.cxx`, `.cc`, `.hpp`, `.hxx`, `.hh` | All C types + namespace, template | `///` Doxygen |
| Lua | `.lua` | function, method, const | `--` comments |
| Dart | `.dart` | class, mixin, extension, enum, function, method, const, type | `///` doc comments |
| Swift | `.swift` | class, struct, protocol, actor, extension, method, enum, type | `///` DocC |
| Elixir | `.ex`, `.exs` | module (class), function, macro, struct, protocol | `@doc` attribute |
| Haskell | `.hs`, `.lhs` | function, data (class), typeclass (interface), instance, type, newtype | Haddock `-- \|` |
| Scala | `.scala`, `.sc` | class, trait, object, case class, function, method, type, enum | Scaladoc `/** */` |
| R | `.r`, `.R`, `.Rmd` | function, const, S3/S4/R6 class | Roxygen2 `#'` |
| Bash | `.sh`, `.bash` | function |
| Perl | `.pl`, `.pm` | function, package |
| Terraform / HCL | `.tf`, `.hcl` | resource, module, variable, output |
| Nix | `.nix` | function, attribute |
| Protobuf | `.proto` | message, service, enum, rpc |
| GraphQL | `.graphql`, `.gql` | type, query, mutation, subscription, fragment |
| Groovy | `.groovy` | function, class, method |
| Erlang | `.erl`, `.hrl` | function, module |
| Gleam | `.gleam` | function, type |
| GDScript | `.gd` | function, class, signal |
| XML | `.xml` | element (configurable patterns) |
| Objective-C | `.m`, `.h` | function, class, method |
| Fortran | `.f90`, `.f95`, `.for`, `.f` | function, subroutine, module |
| SQL | `.sql` | table, view, function, procedure |
| OpenAPI / YAML | `.yaml`, `.yml` (OpenAPI detected by content) | endpoint, schema |

---

## What gets indexed

For all languages, the indexer extracts:

- **Symbol name** — the identifier as it appears in source
- **Symbol kind** — function, class, method, route, component, etc.
- **Byte offsets** (`startByte`, `endByte`) — for precise source retrieval without reading the whole file
- **Signature** — a one-line declaration (TypeScript shows full type annotations, Python shows type hints if present)
- **Summary** — sourced from docstring, framework inference, AI, or signature fallback
- **Import/dependency edges** — for the dependency graph

---

## What is excluded automatically

The indexer skips these automatically:

- `node_modules/`, `.git/`, `dist/`, `build/`, `.claude/`, `target/`, `.next/`, `.nuxt/`
- `*.lock` files, `.env*` files
- Binary files (detected by null-byte scanning of the first 8 KB)
- Files > 1 MB (configurable via `maxFileSizeBytes`)
- Secret files: `*.pem`, `*.key`, `id_rsa`, `credentials.json`, `serviceAccountKey*.json`, etc.
- Language-specific private symbols:
  - Go: unexported names (lowercase)
  - C: `static` functions (translation-unit internal)
  - Java/C#/PHP: `private` members
  - Dart: `_`-prefixed names

---

## Grammar notes

Grammars are bundled as `.wasm` files in the `grammars/` directory. They are loaded once per worker thread at startup. Grammar versions are pinned in `package.json` and tested against the test fixtures in `test/handlers/`.

Known limitations:
- **TypeScript JSX** (`.tsx`): the `tree-sitter-tsx` grammar is separate from `tree-sitter-typescript` and is used for all `.tsx` files.
- **Python**: type hints in stubs (`.pyi`) are not indexed — only `.py` files.
- **Terraform**: complex `dynamic` blocks may not be fully extracted.
- **XML**: element extraction uses configurable patterns — not all XML files are indexed by default.

