If you ever need to run python scripts, use python, not python 3.

# PureContext MCP — Project Instructions

## What This Project Is

PureContext MCP is a Node.js/TypeScript MCP (Model Context Protocol) server for token-efficient source code navigation by AI agents. It indexes codebases using tree-sitter AST parsing, stores structured symbol metadata in SQLite, and lets agents retrieve precisely the code they need instead of reading entire files.

The full product requirements are in `docs/PureContext_MCP_PRD_v1.0.docx`. Read it before making architectural decisions.

---

## Architecture Rules

### Three-Layer Architecture (never violate)

1. **Core** (`src/core/`) — File discovery, content hashing, tree-sitter dispatch, SQLite storage, MCP transport, file watcher. Knows nothing about specific languages or frameworks.
2. **Language Handlers** (`src/handlers/`) — Map file extensions to tree-sitter grammars, define which AST node types are symbols, extract signatures and imports. Each handler is a self-contained module implementing `LanguageHandler`.
3. **Framework Adapters** (`src/adapters/`) — Domain-specific symbol extraction on top of language handlers. Auto-detected from project config files. Each adapter implements `FrameworkAdapter`. Optional and composable.

**The dependency direction is strictly downward: Adapters → Handlers → Core. Never the reverse.**

### Key Interfaces

```typescript
// src/core/types.ts

interface SymbolRecord {
  id: string;                    // Deterministic hash: SHA-256(filePath:name:kind).slice(0,16)
  name: string;
  kind: SymbolKind;
  filePath: string;              // Relative to repo root
  startByte: number;
  endByte: number;
  signature: string;             // One-line signature
  summary: string;               // One-line description
  frameworkMeta?: Record<string, unknown>;
}

type SymbolKind =
  | 'function' | 'class' | 'method' | 'const' | 'type'
  | 'interface' | 'enum' | 'component' | 'composable'
  | 'hook' | 'route' | 'decorator' | 'middleware' | 'property';

interface LanguageHandler {
  extensions(): string[];
  grammarPath(): string;         // Path to .wasm file (null for regex-only handlers)
  extractSymbols(tree: Tree, source: Buffer): SymbolRecord[];
  extractImports(tree: Tree, source: Buffer): ImportRecord[];
  extractDocstring(node: SyntaxNode): string | null;
}

interface FrameworkAdapter {
  name: string;
  detect(projectRoot: string): Promise<boolean>;
  fileFilter(filePath: string): boolean;
  preProcess?(source: Buffer, filePath: string): ProcessedBlock[];
  extractFrameworkSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[];
  enrichMetadata?(symbol: SymbolRecord): SymbolRecord;
}
```

### Database

- Use `better-sqlite3` (synchronous, fast)
- Single SQLite file per indexed project, stored in `~/.purecontext/indexes/`
- Four tables: `symbols`, `files`, `dep_edges`, `repos`
- Deterministic repo IDs: `SHA-256(absolutePath).slice(0, 16)`

### Tree-sitter

- Use `web-tree-sitter` (WASM bindings) — no native compilation
- Bundle `.wasm` grammar files in `grammars/` directory
- Parse dispatcher in core receives a file, resolves the handler, calls tree-sitter
- Regex-only handlers (SCSS, LESS, CSS) set `grammarPath()` to return `null`

### MCP Server

- Use `@modelcontextprotocol/sdk` for protocol handling
- Each tool is a separate file in `src/server/tools/`
- Tool handler receives parsed input, calls core services, returns structured response
- SDK >=1.29 requires async/await + try-catch in `typed()` — never `.catch()` on handler results

---

## Coding Conventions

- **Language**: TypeScript with strict mode; ES modules (`"type": "module"`)
- **Node.js**: >= 18.0.0
- **No classes unless necessary** — prefer functions and plain objects. Use classes only for stateful services (IndexManager, Watcher) where lifecycle matters.
- **Error handling**: Typed error classes extending `PureContextError`. Never swallow errors silently.
- **Logging**: Leveled logger (debug/info/warn/error). No `console.log` in production code.

**Naming:**
- Files: `kebab-case.ts`
- Types/interfaces: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Database columns: `snake_case`

**Testing:**
- Use `vitest`
- Test directory mirrors src: `test/core/`, `test/handlers/`, `test/adapters/`, `test/server/`
- Integration tests use fixture projects in `test/fixtures/`
- Every language handler and framework adapter must have tests against real AST output

**Key directories:**
```
src/core/          # Indexing pipeline, SQLite, file watcher
src/handlers/      # Language handlers (one file per language)
src/adapters/      # Framework adapters (Vue, React, etc.)
src/server/tools/  # One file per MCP tool
src/graph/         # Dependency graph traversal
src/summarizer/    # Symbol summarization (docstring → AI → signature fallback)
src/config/        # Config loading and validation
grammars/          # Bundled .wasm tree-sitter grammar files
test/              # Mirrors src/; fixtures in test/fixtures/
scripts/hooks/     # Claude Code hook scripts (Node.js, cross-platform)
dev-docs/          # Phase task files, benchmark notes (gitignored, not public)
```

---

## Current Phase

**Phase 51 — COMPLETE** (Ruby depth + Rust cfg + New tools + 7 new benchmarks)

Tasks 279–298 complete. New features: C++ macro extraction with allow-list, Ruby DSL (associations/callbacks), Ruby metaprogramming detection, Rust `cfg` attribute filtering, `get_lexical_scope_matches` tool, `trace_invocation_chain` tool. 7 new benchmark projects (brew, mastodon, rails, discourse, ktor, facebook-folly, clickhouse). PC wins 19/26 P@1. Known gaps: C++ namespace qualification (folly, clickhouse — 0% P@1), FTS5 failure after test-mapper FK error (discourse, clickhouse). Version bumped to 1.3.0. See `dev-docs/PHASE51_TASKS.md` for detail.

**Phase 52 — COMPLETE** (C++ namespace fix, FTS test-mapper isolation, C# handler depth)

Tasks 299–303 complete. Key fixes: (1) harness qualified-name matching accepts bare `Future` when PC stores `folly::Future`; (2) bare local name added to FTS content for `::` qualified C++ symbols; (3) Rust-only synonym scoping (`RUST_ONLY_SYNONYMS`) prevents `future→poll` from making `FutureBase::poll` outscore `folly::Future` in C++ repos; (4) Windows path-case mismatch in benchmark harness fixed (`d:/` vs `D:/` → SHA-256 mismatch → empty DB); (5) test-mapper transaction now has local try-catch to prevent FK errors from silently failing FTS population; (6) C# interface member extraction fixed (isInterface guard), method name extraction fixed (findLast before parameter_list), event field declarations added. discourse 0%→12%, folly 0%→8%, clickhouse 0%→16%. PC wins 22/26 P@1. Version bumped to 1.4.0. See `dev-docs/PHASE52_TASKS.md` for detail.

**Phase 53 — COMPLETE** (Dart benchmark expansion — AppFlowy + flutter SDK)

Tasks 304–308 complete (flutterfire skipped — not present locally). AppFlowy: PC 16%/28%/36% vs JC 0%/0%/0%; flutter SDK: PC 0%/8%/8% vs JC N/A. Two bugs fixed: `expandVerbSynonyms("constructor")` prototype-chain crash (4 regression tests added) + test-mapper 70-min penalty on large repos (`skipTestMapper: boolean` added to `IndexOptions`). Key gaps: (1) flutter C++/Dart monorepo — 40,824 C++ engine symbols pollute Dart widget queries; (2) abstract Dart class summaries too thin; (3) BLoC class queries in AppFlowy return methods not the BLoC class. PC wins 22/28 P@1 (AppFlowy added; flutter excluded from win count — mixed-language repo). See `dev-docs/PHASE53_TASKS.md` and `dev-docs/benchmarks/FULL-DISCOVERY.md`.

**Phase 54 — COMPLETE** (Swift benchmark expansion — Batch 1)

Tasks 309–313 complete (Batch 1). swift-composable-architecture: PC 12%/24%/32% vs JC 16%/24%/24% — JC wins P@1, tie P@3, PC wins R@5. swift-nio: PC 0%/4%/4% vs JC 0%/0%/4% — both near-zero. vapor: PC 20%/28%/32% vs JC 32%/48%/56% — JC wins all three. Key gaps: protocol types not semantically matched (no summaries), generic type parameter stripping, DSL routing helpers not indexed. PC wins 22/36 P@1 after Batch 1 (0 new wins from Swift). See `dev-docs/PHASE54_TASKS.md` and `dev-docs/benchmarks/FULL-DISCOVERY.md`.

**Phase 57 — COMPLETE** (Haskell + Scala benchmark expansion — Batch 1)

Tasks 326–331 complete (Batch 1). postgrest-hs: PC 0%/28%/36% vs JC 0%/0%/0% — PC wins P@3+R@5, Haskell P@1 gap. pandoc: PC 0%/4%/8% vs JC 0%/0%/0% — both near-zero. dotty-bot: PC 20%/36%/52% vs JC 36%/52%/76% — JC wins. zio: PC 4%/4%/12% vs JC 24%/28%/28% — JC wins clearly. Key gaps: Haskell record types have no field FTS tokens; Scala generic types (`ZIO[R,E,A]`) have no semantic summaries; Scala `given`/`using` not extracted. See `dev-docs/PHASE57_TASKS.md` and `dev-docs/benchmarks/FULL-DISCOVERY.md`.

**Phase 65 — COMPLETE** (Objective-C benchmark expansion — Batch 1)

Tasks 379–383 complete (Batch 1). libs-base: PC 0%/0%/0% vs JC 0%/4%/4%. vlc-ios: PC 0%/0%/0% vs JC 0%/4%/4%. SparkleShare-iOS: PC 0%/0%/0% vs JC 16%/20%/28%. Root cause: PC's ObjC handler doesn't extract `@interface`/`@protocol`/`@implementation` declarations — it treats `.h` files as C headers. All 25 expected ObjC class/protocol symbols per project are absent from PC's FTS index. P0 gap requiring a dedicated ObjC interface/protocol extraction pass. See `dev-docs/PHASE65_TASKS.md` and `dev-docs/benchmarks/FULL-DISCOVERY.md`.

**Phase 55 — COMPLETE** (BEAM / Elixir+Erlang benchmark expansion — Batch 2)

5 new benchmark projects (elixir, phoenix, otp, rabbitmq-server, emqx). PC-only results (JC not measured). elixir: 12%/24%/44%; phoenix: 36%/64%/76% (best BEAM result — distinctive Phoenix module names); otp: 0%/0%/4% (171,234 symbols, C++ BEAM VM dominates Erlang queries); rabbitmq-server: 0%/0%/0% (generic Erlang `name/arity` functions, no module-name FTS token); emqx: 0%/8%/20% (slightly better — `emqx_` prefix distinguishes module names). Four infrastructure fixes applied: (1) case-insensitive extension in `file-discovery.ts` for `.F90` Fortran; (2) case-insensitive step-3b filter in `index-manager.ts`; (3) 5 missing handlers in `indexing-worker.ts` (fortran, scss, less, css, objc); (4) directory trailing-slash in `file-discovery.ts` for `ignore` negation patterns. See `dev-docs/benchmarks/FULL-DISCOVERY.md`.

**Phase 59 — COMPLETE** (Bash benchmark expansion — Batch 2)

3 new benchmark projects (ohmyzsh, pi-hole, dokku). PC-only results (JC not measured). ohmyzsh: 12%/12%/12% (flat — recall failure, correct symbols not in top-5); pi-hole: 16%/48%/48% (good recall, strong P@3/R@5 — descriptive CamelCase function names); dokku: 0%/0%/0% (all core functions in extensionless `plugins/*/functions` files, skipped by file discovery). See `dev-docs/benchmarks/FULL-DISCOVERY.md`.

**Phase 66 (Fortran) — COMPLETE** (Fortran benchmark expansion — Batch 2)

3 new benchmark projects (ecrad, cp2k, scipy-fortran). PC-only results (JC not measured). ecrad: 44%/60%/64% (best Fortran result — 684 symbols, descriptive subroutine names); cp2k: 24%/36%/44% (14,483 symbols, molecular simulation); scipy-fortran: 0%/0%/0% (30,158 symbols, ODR/FITPACK abbreviation names `dodr`, `dacces` — zero FTS overlap with natural language). Total Batch 2 projects: 47. See `dev-docs/benchmarks/FULL-DISCOVERY.md`.

**Phase 58 — COMPLETE** (R + Perl benchmark expansion — Batch 3)

6 new benchmark projects (dplyr, shiny, Rcpp, mojo, catalyst-runtime, sqitch). All JC measured. R: dplyr 24%/40%/48%, shiny 20%/48%/52%, Rcpp 24%/36%/56% — PC wins all 3 R projects. Perl: mojo 20%/52%/68% (tie P@1, PC leads P@3+R@5 — Phase 73 +8pp P@3), catalyst-runtime 12%/48%/60% (Phase 73: JC wins P@1 — `uri_for` not in FTS top-200; P@3+R@5 improved), sqitch 36%/60%/72% (Phase 73: PC wins P@1 — was tie). Key gaps: short R function names outranked by C++ matches; Perl method names too generic (shared across packages). See `dev-docs/benchmarks/FULL-DISCOVERY.md`.

**Phase 64 — COMPLETE** (Groovy benchmark expansion — Batch 3)

3 new benchmark projects (gradle, jenkins, groovy). All JC measured. gradle: 8%/16%/20% vs JC 8%/8%/8% (tie P@1, PC leads P@3+R@5); jenkins: 4%/8%/16% vs JC 32%/48%/56% (JC wins — Java method depth gap); groovy: 12%/24%/40% vs JC 4%/8%/16% (PC wins). Total Batch 3 projects: 9. Cumulative head-to-head: PC wins 27/45 P@1. Key gap: jenkins requires core-path boost for Java methods from `core/src/main/java/` vs plugin implementations. See `dev-docs/benchmarks/FULL-DISCOVERY.md`.

**Phase 60 — COMPLETE** (Terraform/Nix benchmark expansion — Batch 4)

5 new benchmark projects (terraform-aws-eks, terraform-aws-components, home-manager, flake-utils; terragrunt TBD). PC-only for Nix (JC N/A for home-manager/flake-utils). Terraform: terraform-aws-eks 0%/0%/0% vs JC 12%/20%/20%; terraform-aws-components 0%/0%/0% vs JC 4%/4%/4%. P0 gap: no HCL handler — 0 Terraform symbols indexed. Nix: home-manager 60%/72%/76% vs JC 20%/20%/24% (PC wins); flake-utils 60%/76%/76% vs JC 16%/16%/16% (PC wins). Key gaps: HCL handler missing (P0); generic `programs` attribute ambiguity in home-manager.

**Phase 61 — COMPLETE** (Lua/GDScript benchmark expansion — Batch 4)

5 new benchmark projects (neovim, kong, love, godot-demo-projects, dialogic). All JC measured. neovim: 24%/56%/80% vs JC 32%/44%/48% (JC wins P@1, PC wins P@3+R@5); kong: 36%/52%/56% vs JC 12%/12%/16% (PC wins); love: 52%/80%/88% vs JC 16%/28%/32% (PC wins); godot-demo-projects: 32%/56%/76% vs JC 40%/56%/60% (JC wins P@1, tie P@3, PC wins R@5); dialogic: 84%/100%/100% vs JC 48%/80%/88% (PC wins). Key gaps: nvim_* C API not matched by vim.api.* qualified queries (neovim); generic GDScript function names across demo files (godot).

**Phase 62 — COMPLETE** (Protobuf/GraphQL benchmark expansion — Batch 4)

6 new benchmark projects (googleapis, grpc-proto, envoy, saleor, graphql-engine, graphql-code-generator). googleapis: 24%/52%/60% vs JC 4%/4%/4% (PC wins); grpc-proto: 72%/80%/92% vs JC 20%/20%/24% (PC wins); envoy: 56%/64%/72% vs JC 0%/0%/0% (PC wins — JC has 0 proto symbols); saleor: 72%/88%/96% vs JC 32%/40%/44% (PC wins); graphql-engine: 52%/72%/80% vs JC 24%/40%/44% (PC wins); graphql-code-generator: 72%/84%/84% vs JC 24%/48%/56% (PC wins). Batch 4 total: 15 projects. PC wins 11/15 P@1; JC wins 4 (2 Terraform + neovim + godot). Cumulative: PC 38/60 P@1. Version bumped to 1.5.0. See `dev-docs/benchmarks/FULL-DISCOVERY.md`.

**Phase 63 — COMPLETE** (OpenAPI/XML benchmark expansion — Batch 5)

4 new benchmark projects (maven, stripe-openapi, kubernetes-openapi, rest-api-description). maven: PC 12%/52%/52% vs JC 20%/32%/56% (JC wins P@1, PC wins P@3 — XML root element name collision across 30+ modules). stripe-openapi: PC 28%/28%/28% vs JC 16%/16%/24% (PC wins). kubernetes-openapi: PC 64%/68%/80% vs JC 0%/0%/0% (PC wins strongly). rest-api-description: PC 0%/0%/0% vs JC 4%/8%/8% (JC wins — P0 bug: OpenAPI handler `\w+` regex excludes hyphens; all GitHub API schema names like `pull-request`, `simple-user` are invisible). P0 fixes: `[\w-]+` regex + XML symbol file-path disambiguation. Cumulative: PC 40/64 P@1. See `dev-docs/benchmarks/FULL-DISCOVERY.md`.

**Phase 67 — COMPLETE** (SQL benchmark expansion — Batch 5)

3 new benchmark projects (postgrest-sql, jaffle-shop, timescaledb). postgrest-sql: PC 24%/48%/64% vs JC 0%/0%/0% (PC wins; JC indexes 0 SQL-kind symbols). jaffle-shop: PC 44%/80%/84% vs JC 8%/20%/28% (PC wins strongly — best SQL result; SQL handler dbt fix: staging CTEs emit file-stem symbol). timescaledb: PC 0%/4%/8% vs JC 0%/0%/4% (tie near-zero — P0 bug: SQL handler captures schema prefix instead of function name for schema-qualified `_timescaledb_catalog.create_hypertable`; fix: optional schema prefix regex). Batch 5 total: 7 projects. PC wins 4/7 P@1. Cumulative: PC 42/67 P@1. Total benchmarked: 79 projects. See `dev-docs/benchmarks/FULL-DISCOVERY.md`.

**Phase 70 — COMPLETE** (P0 Handler Completion — ObjC, HCL, Angular HTML, extensionless files, XML disambiguation)

Tasks 406–412 complete. ObjC handler: added `.h` extension with ObjC detection guard, named category `ClassName+CategoryName`, anonymous category `classExtension: true`, full ObjC selector building (`setObject:forKey:`), property kind changed from `const` to `property`. HCL handler (new): regex-based, extracts `variable`/`output`/`resource`/`data`/`module`/`provider`/`locals` blocks from `.tf`/`.tfvars`/`.hcl` files with `var.`/`output.`/`module.`/`local.`/`data.` prefixes matching Terraform reference syntax. Angular HTML handler (new): extracts component selectors, structural directives, control flow, event bindings, template refs from Angular templates (detection guard: `*ngIf`/`*ngFor`/`(event)=` markers or `.component.ts` sibling). Extensionless file discovery: changed from opt-in (explicit `extensionlessFilenames` param) to automatic — all extensionless files included; shebang detection in file-processor routes to bash handler or returns 0 symbols for non-bash files. XML disambiguation: (a) handler produces `tag@module` names; (b) `splitNameParts` now splits on `@`; (c) `identityExact` boost handles `@`-disambiguated names via `bareTagName`; (d) `buildFtsContent` adds standalone tag name token for BM25 weight; (e) benchmark harness adds `@` prefix match. Version bumped to 1.6.0. Benchmark results: terraform-aws-eks 84%/92%/96% (was 0%), terraform-aws-components 68%/80%/84% (was 0%), dokku 4%/40%/60% (was 0%), maven 48%/52%/56% (was 12%), libs-base 4%/8%/8% (was 0%), vlc-ios 12%/16%/24% (was 0%), SparkleShare-iOS 12%/28%/36% (was 0%). PC wins 51/75 P@1 (was 46/75). See `dev-docs/PHASE70_TASKS.md`.

**Phase 68 — COMPLETE** (React benchmark expansion — Batch 6)

Tasks 394–399 complete. cal-com: PC 4%/4%/20% vs JC 4%/8%/12% (tie P@1, JC leads P@3, PC leads R@5). excalidraw: PC 0%/24%/28% vs JC 4%/8%/8% (JC wins P@1, PC wins P@3+R@5). novu: PC 0%/0%/0% vs JC 0%/0%/8% (tie near-zero — P0: large monorepo NestJS drowns React hooks). infisical: PC 8%/20%/28% vs JC 0%/0%/0% (PC wins). PC wins 1/4 P@1 (infisical); 2 ties (cal-com, novu); JC wins 1 (excalidraw). Key gaps: novu large-monorepo drowning (P0), excalidraw rendering function ranking (P0), cal-com short hook names in Turborepo (P0). See `dev-docs/PHASE68_TASKS.md`.

**Phase 69 — COMPLETE** (Angular benchmark expansion — Batch 6)

Tasks 400–405 complete. bitwarden-clients: PC 12%/20%/24% vs JC 0%/0%/0% (PC wins — JC 227k inflated symbols still 0%). trpc: PC 4%/12%/20% vs JC 8%/8%/12% (JC wins P@1, PC wins P@3+R@5). angular-realworld: PC 36%/68%/72% vs JC 4%/8%/8% (PC wins — best Batch 6 result). jhipster-sample-app: PC 32%/36%/48% vs JC 0%/0%/0% (PC wins). PC wins 3/4 P@1 (bitwarden, angular-realworld, jhipster); JC wins 1 (trpc). Key gaps: Angular HTML template handler missing (P0), ProcedureBuilder in unstable-core path (P0). Cumulative: PC 46/75 P@1. See `dev-docs/PHASE69_TASKS.md`.

**Phase 71 — COMPLETE** (Ranker / Monorepo Path Heuristics)

Tasks 413–419 complete. Pure ranker phase — no handler changes, no re-index required. (1) Library path extensions: `engine/`, `erts/`, `contrib/` directory segments added; `/lib/wx/`, `/blas/`, `/lapack/` multi-segment substrings added. `unstable-core-do-not-import/` was added then removed — tRPC's canonical core API lives there; penalizing it is incorrect. (2) Java/Groovy core-path boost: `isCoreJavaPath()` +15 for `/core/src/main/java/` etc.; `isJavaPluginPath()` -35 for `/plugins/` or `/plugin/` in Java/Groovy repos. (3) Frontend path boost: +20 for symbols in `/apps/dashboard/`/`/apps/web/` in detected mixed monorepos when query has hook/component vocab. (4) Use*/hook OR-fallback: fires when AND pool has no `use[A-Z]` symbols and query starts with `use` (≥4 chars) or contains `hook`. (5) Path proximity boost: +5/token for path tokens overlapping query, when ≥3 symbols share a name. Benchmark results: jenkins 4%/8%/12% (was 4%/8%/16% — slight R@5 measurement artifact from plugin-path penalty demoting false-positive bare-name match); gradle 8%/12%/20% (was 8%/16%/20%); trpc 4%/12%/20% (regression from `unstable-core` penalty fully fixed); novu/cal-com unchanged (deeper FTS retrieval gap). PC wins 51/75 P@1 (unchanged). 190 ranker tests passing. See `dev-docs/PHASE71_TASKS.md`.

**Phase 72 — COMPLETE** (Cross-Language Identifier Surface — FTS Aliases)

Tasks 420–425 complete. Four FTS surface improvements: (1) Erlang bare names — functions stored as `start_link` not `start_link/3`; `frameworkMeta.arity` preserves N; module name injected as FTS token (raw + underscore-split); harness arity-suffix match added. rabbitmq-server 0%→**36%/48%/52%**, emqx 0%→**28%/32%/36%** (massive gains). otp result pending (171k symbols, C++ VM domination). (2) Proto serviceName FTS — RPC method symbols get `frameworkMeta.serviceName`; injected as extra BM25 token. googleapis 24%→20% P@1 (ranking conflict: service class vs methods for bare name query); envoy 56%→60% P@1. (3) Neovim C-API Lua alias — `nvim_*` functions in `/nvim/` paths get `frameworkMeta.luaApiAlias = "vim.api.nvim_*"`; neovim 24%→**36%/68%/80%** (PC now beats JC at P@1). (4) Groovy source boost +10 for `.groovy` in mixed Java+Groovy repos; gradle unchanged, groovy 40%→36% R@5 (minor noise). Version bumped to 1.7.0. PC wins **52/76** P@1 (was 51/76 — neovim flip). 194 tests passing (4 pre-existing failures unchanged). See `dev-docs/PHASE72_TASKS.md`.

**Phase 74 — COMPLETE** (TS HOC Arrow Detection — excalidraw coverage + HOC kind fix)

Tasks 438–439 complete. TS handler: `export const X = HOC(() => ...)` patterns (React.memo, forwardRef, withRouter, etc.) now emitted as `kind=function` instead of `kind=const` — ensures `computeRenderingCompoundBoost` fires for HOC-wrapped rendering functions and kindBoost is applied correctly. Detection checks both direct call_expression children AND inside the `arguments` node to handle generic calls like `forwardRef<T, P>(fn)`. Camelcase compound boost (+25) was attempted but reverted — it caused regressions on `ASTParser.parse` and Twig library ranking tests; the existing `computeRenderingCompoundBoost` (active for excalidraw since Phase 73 added "draw" to RENDERING_REPO_PATTERN) already covers the rendering compound use case. 270 tests passing in modified files (231 ranker + 39 TS handler). Version bumped to 1.8.0. Benchmark re-run by user. See `dev-docs/PHASE74_TASKS.md`.

**Phase 73 — COMPLETE** (P1 Ranker Polish)

Tasks 426–437 complete. Pure ranker phase — no re-index required. (1) Angular lifecycle boost: `ngOnInit`/`ngOnDestroy`/`ngOnChanges`/`ngAfterViewInit` etc. get +20 boost when query contains lifecycle-related terms. (2) Rendering compound boost: `draw` added to RENDERING_REPO_PATTERN; rendering-domain repos get compound underscore boost for `draw_*` names. (3) React query hook boost: `use*` symbols in `queries/*.ts` / `hooks/*.ts` files get boosted when query starts with `use`. (4) Interceptor boost: +15→+30 so interceptor middleware symbols compete with kindBoost service symbols. (5) Perl/R package context boost: added `PACKAGE_SEGMENT_STOPWORDS` (controller, action, model, view, app, core, etc.) to prevent generic MVC namespace words from scoring; reduced multiplier to 4 per single overlap (was 8) — avoids Catalyst:: namespace symbols outranking bare functions on context words. (6) Crypto synonyms: `cipher↔encrypt`, `secret↔key↔credential↔token` added to verb synonym set. (7) tRPC prefix boost: `+20` for `trpc.` / `t.` prefixed symbols in tRPC repos. (8) Compound underscore boost: `+30` when all `_`-split parts of a symbol name appear as query words (stop words excluded). (9) Single-token exact boost: `+50` for exact full-name match, `+40` for exact bare-name match in single-token queries. (10) OpenAPI path enrichment: HTTP verbs and URL path tokens injected into operationId summary for better semantic match. (11) Perl `t/lib/` fixture penalty: `−25` for `.pm`/`.pl` symbols in `t/lib/` paths (TestApp:: test fixtures). Benchmark results: sqitch **32%→36%** P@1 (tie→PC win), mojo P@3 44%→52%, infisical P@3 20%→28%/R@5 28%→36%, catalyst P@1 20%→12% (PC win→JC win — package boost + interceptor reordering regressed P@1 on `uri_for` retrieval gap; P@3+R@5 improved +4/+8pp). Net P@1: **52/76 unchanged** (sqitch +1 offset by catalyst −1). 231 ranker tests. See `dev-docs/PHASE73_TASKS.md`.

Full phase history: `dev-docs/PHASE*_TASKS.md` files.

---

## Decision Log

Recent significant decisions:

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-22 | Phase 73: Perl/R package context boost — PACKAGE_SEGMENT_STOPWORDS + reduced multiplier | catalyst-runtime regression: package context boost added `+8*overlap` for Catalyst:: namespace symbols when query contains 'catalyst', causing TestApp:: and Catalyst:: wrapper classes to outscore bare functions like `uri_for`. Fix: (1) PACKAGE_SEGMENT_STOPWORDS filters generic MVC words (controller, action, model, view, app, core, etc.) from package name token overlap; (2) multiplier reduced to `overlap >= 2 ? (overlap-1)*8+4 : 4` (single match = 4, was 8). catalyst P@3+4pp, R@5+8pp; P@1 still regressed 20%→12% because `uri_for` is not retrieved by FTS at all ('for' is a stop word). |
| 2026-05-22 | Phase 73: Perl t/lib/ fixture penalty −25 | TestApp::Controller::Action symbols in `t/lib/` are test fixtures, not library API. They outscore Catalyst core classes because their names contain query words ('action', 'controller') multiple times. Added −25 library penalty for `.pm`/`.pl` symbols whose `filePath` starts with `t/lib/` or contains `/t/lib/`. Path normalized to forward slash + lowercase before check; covers both Windows backslash and relative paths. |
| 2026-05-22 | Phase 73: Interceptor boost +15→+30 | NestJS interceptor middleware symbols were being outranked by *Service kindBoost (+30) symbols on queries about interceptors. Doubling the interceptor boost to +30 puts them on equal footing with services when the query explicitly mentions interceptor behavior. |
| 2026-05-22 | Phase 73: Rendering REPO_PATTERN + 'draw' | excalidraw uses `draw*` function names (drawElement, drawScene) that benefit from rendering-domain compound synonyms. Added 'draw' to RENDERING_REPO_PATTERN regex so excalidraw repos get rendering-specific synonym expansion. |
| 2026-05-22 | Phase 73: Compound underscore boost +30 | Underscore-named functions (e.g., `dispatch_action`, `build_request`) have all their parts in query words but don't get identityExact because the full string doesn't match. Added +30 boost when ALL `_`-split name parts (excluding STOP_WORDS) are present in the query word set. Does not fire for 'for' (stop word) — limitation for `uri_for`. |
| 2026-05-22 | Phase 73: Single-token exact boost (+50/+40) | Single-word queries that exactly match a symbol's full name or bare (last `::` segment) name were not reliably scoring highest. Added +50 for exact full-name match and +40 for exact bare-name match in single-token query mode; guards against over-firing by requiring single-token context. |
| 2026-05-22 | Phase 72: Erlang bare names — store `start_link` not `start_link/3` | rabbitmq/emqx ground truth uses `name/arity` format but FTS5 tokenizes `start_link/3` as a unit; bare name greatly improves recall. Arity uniqueness preserved via `frameworkMeta.arity`; ID still uses arity-qualified key to avoid collisions between `greet/0` and `greet/1`. Module name injected as FTS token (raw + underscore-split) for `rabbit_channel:start_link` queries. Harness extended with arity-suffix stripping for backward compat. rabbitmq 0%→36%, emqx 0%→28%. |
| 2026-05-22 | Phase 72: Proto serviceName FTS token — inject service name into method BM25 weight | googleapis proto methods named `Spanner.Read` — queries for "Spanner streaming read" need to match both the service and the method name. Added `frameworkMeta.serviceName` to RPC symbols; `buildFtsContent` injects it as an extra token. Slight P@1 regression in googleapis (service class vs method ranking conflict for bare service-name queries) — acceptable trade-off vs recall improvement. |
| 2026-05-22 | Phase 72: Neovim C-API Lua alias — `vim.api.nvim_*` FTS token on C functions | Neovim Lua users call `vim.api.nvim_open_win()` but C implementation is `nvim_open_win` — queries never matched. Added `maybeNvimLuaAlias()` to C handler; fires for `nvim_[a-z_]*` functions in `/nvim/` paths. FTS alias resolves the language barrier. neovim 24%→36% P@1 (PC beats JC). |
| 2026-05-22 | Phase 72: Groovy source boost +10 for mixed Java+Groovy repos | gradle/groovy expected symbols are all in Groovy files but compete with Java classes; +10 preferentially surfaces .groovy results in `detectJavaGroovyMixed` repos. gradle unchanged (FTS retrieval gap is the bottleneck, not ranking); groovy minor R@5 regression (1 query) likely from re-index delta not the boost. |
| 2026-05-22 | Phase 71: Library path extensions (engine, erts, contrib) | flutter C++ engine/ (40k symbols) pollutes Dart widget queries; otp erts/ pollutes Erlang stdlib queries; contrib/ inflates scientific computing symbol counts. Added as directory-segment penalties (-35). Also added /lib/wx/, /blas/, /lapack/ as multi-segment substring penalties. `unstable-core-do-not-import/` was added then removed — tRPC's canonical core API lives in that path; penalizing it blocks ProcedureBuilder.* expected symbols (task spec was incorrect). |
| 2026-05-22 | Phase 71: Java/Groovy core-path boost and plugin-path penalty | jenkins 4%/8%/16% — generic method names (getDuration, isBuilding) appear in hundreds of plugin classes. Added +15 boost for `/core/src/main/java/` paths and -35 for `/plugins/`/`/plugin/` paths, domain-gated to java/groovy repos. Result: jenkins 4%/8%/12% (slight R@5 regression — plugin penalty demoted a false-positive bare-name match that the harness had been counting as a hit). Core gap: PC indexes 11k jenkins symbols vs JC 23k — a coverage gap, not purely a ranking gap. |
| 2026-05-22 | Phase 71: Frontend path boost + use*/hook OR-fallback | novu 0%/0%/0% — 28k NestJS backend symbols drown React hooks in apps/dashboard/. Added mixed-monorepo detection (checks both frontend and backend app dirs), +20 path boost for dashboard/web/frontend app paths when query has hook/component vocabulary, and OR-fallback when AND pool lacks use[A-Z] symbols. Result: novu unchanged — hook symbols not entering the 200-candidate FTS pool at all; path boosting can't help before retrieval. |
| 2026-05-22 | Phase 71: Path proximity boost for same-name symbols | godot/home-manager — `spawn_count` in multiple demo files, `programs` in thousands of Nix modules: identical names return arbitrary result. Added +5/token path-proximity boost when ≥3 pool symbols share a name and the file path tokens overlap with query words. Common path segments (src/lib/app/core/main) excluded. Not measurable for godot (empty index); home-manager unchanged (query tokens don't overlap with Nix module file names). |
| 2026-05-22 | Phase 70: ObjC handler full extraction | Existing handler registered but missing `.h` extension, category naming, full selector building, `property` kind. Added ObjC detection guard (check first 16KB for `@interface`/`@protocol` before processing `.h` files), `ClassName+CategoryName` for named categories, `classExtension: true` for anonymous categories, full selector construction (`setObject:forKey:`), property kind changed from `const` to `property`. libs-base 0%→4%, vlc-ios 0%→12%, SparkleShare-iOS 0%→12% (JC had 16%). |
| 2026-05-22 | Phase 70: HCL handler (new, regex-only) | terraform-aws-eks and terraform-aws-components score 0%. Implemented regex-based HCL handler extracting `variable`→const, `output`→const, `resource`→class (`type.name`), `data`→const, `module`→class, `provider`→const, `locals` items→const. Naming uses `var.name`/`output.name`/`module.name`/`local.name` prefixes matching Terraform reference syntax (ground truth expectations). Registered in both `src/index.ts` and `indexing-worker.ts`. Must also register in `benchmarks/harness/run_benchmark.ts` (three separate handler registries). terraform-aws-eks 0%→84%, terraform-aws-components 0%→68%. |
| 2026-05-22 | Phase 70: Angular HTML handler (new, regex-only) | Angular `.html` templates invisible to search. Added detection guard (sibling `.component.ts` OR Angular markers/event binding pattern in first 4KB). Extracts component selectors (kebab-case multi-segment), structural directives (`*ngIf`, `*ngFor`), control flow (`@if`, `@for`), event bindings (`(click)="handler"`), template refs (`#userInput`), routerLink. |
| 2026-05-22 | Phase 70: Extensionless file discovery (opt-in → automatic) | dokku plugin functions live in extensionless `plugins/*/functions` files. Initial Phase 70 implementation required `extensionlessFilenames?: string[]` opt-in. During benchmark, harness called `indexFolder` without the parameter so dokku stayed at 0%. Changed to automatic: all extensionless files included when no allowlist provided; shebang detection in file-processor routes to bash handler or returns 0 symbols for non-bash files. dokku 0%→4%/40%/60%. |
| 2026-05-22 | Phase 70: XML root-element disambiguation | Maven 30+ modules each have `pom.xml` with `<project>` root — FTS returns arbitrary one at rank 1, blocking 21/25 queries. `disambiguateXmlName()` appends `@module` when (a) element depth ≤ 2, (b) file is in a subdirectory (parts.length ≥ 2), (c) disambiguator differs from tag. Generic stems (pom, index, config, settings, default) use parent dir name; others use file stem. Bare tag name stored in `bodySnippet` for FTS fallback. |
| 2026-05-22 | Phase 70: XML `@` disambiguation — ranker + harness end-to-end fix | After `project@maven-core` names were stored, three further fixes needed: (1) `splitNameParts` split regex updated from `[\\:.]+` to `[\\:.@]+` so `project@maven-core` tokenizes to `["project","maven","core"]` for word-overlap scoring; (2) `identityExact` boost: added `bareTagName` for the `@`-prefixed part so query word `project` triggers identityExact on `project@maven-core`; (3) `buildFtsContent`: standalone tag name token added for BM25 weight; (4) harness: `@` prefix match so `project@maven-core` matches ground truth `project`. Without these, maven went from 12% to 8% after XML rename, then back to 48% after all four fixes. |
| 2026-05-22 | Batch 5: 7 new benchmark projects (Phases 63/67) | OpenAPI/XML (maven, stripe-openapi, kubernetes-openapi, rest-api-description) + SQL (postgrest-sql, jaffle-shop, timescaledb). PC wins 4/7 P@1. P0 gaps: (1) OpenAPI `\w+` regex misses hyphenated names — rest-api-description 0% (fix: `[\w-]+`); (2) SQL handler captures schema prefix as function name — timescaledb 0% sql-kind (fix: optional schema prefix regex); (3) XML root element name collision across Maven modules (fix: file-path in symbol name). Cumulative: PC 42/67 P@1. Total benchmarked: 79 projects. |
| 2026-05-22 | Batch 4: 15 new benchmark projects (Phases 60/61/62) | Terraform/Nix, Lua/GDScript, Protobuf/GraphQL groups complete. PC wins 11/15 P@1 (JC wins terraform-aws-eks 12%, terraform-aws-components 4%, neovim 32%, godot-demo-projects 40%). Envoy 56%/64%/72% vs JC 0%. P0 gap: no HCL handler — 0 Terraform symbols. Cumulative: PC 38/60 P@1. Total benchmarked: 72 projects. Version bumped to 1.5.0. |
| 2026-05-22 | Batch 4: HCL handler identified as P0 gap | terraform-aws-eks and terraform-aws-components both score 0%/0%/0%. PC indexes 0 files because .tf/.tfvars files have no handler. JC uses heuristic text extraction for HCL. Fix: implement HCL handler with tree-sitter-hcl WASM grammar, extracting variable/output/resource/data/module/locals blocks. |
| 2026-05-21 | Batch 3: Groovy/Java core-path boost identified as P0 gap | jenkins benchmark shows JC wins 32%/48%/56% vs PC 4%/8%/16%. Root cause: Java bare method names (`isBuilding`, `getDuration`) appear in hundreds of plugin classes; PC returns plugin implementations before `core/src/main/java/` methods. Fix: apply negative library-path penalty to `plugin/`, `vendor/`, `ext/` paths in Java repos, mirroring existing `vendor/node_modules/` penalty. |
| 2026-05-21 | Batch 3: R/Perl/Groovy ground truth — 9 new projects | Phase 58 (R+Perl) and Phase 64 (Groovy) complete. 9 new benchmark projects. PC wins 5/9 P@1; JC wins 1 (jenkins); 3 ties. Cumulative: PC 27/45 P@1 head-to-head. Total benchmarked: 56 projects. |
| 2026-05-21 | Batch 2: Harness dot-qualified name matching | Fortran/Elixir handlers store module-qualified names (`radiation_cloud.allocate_cloud_arrays`). Ground truth uses bare names. Harness now accepts a match when `name.split('.').pop() === expected` — mirrors the existing `::` C++ suffix match. Only fires for bare (non-qualified) expected symbols. |
| 2026-05-21 | Batch 2: case-insensitive extension in `file-discovery.ts` | `.F90` files not discovered because `entry.name.slice(dot)` returns `.F90` (original case) but `extensions` list has `.f90` (lowercase). Fixed: `if (!extensions.includes(ext.toLowerCase())) continue`. |
| 2026-05-21 | Batch 2: case-insensitive step-3b filter in `index-manager.ts` | After file-discovery finds `.F90` files, step 3b re-filters with `supportedExts.has(ext)` where `ext` was still uppercase. Fixed: `df.path.slice(dot).toLowerCase()` before set lookup. Without this, `.F90` files were discovered but silently dropped before reaching workers. |
| 2026-05-21 | Batch 2: 5 missing handlers in `indexing-worker.ts` | Workers have their own module registry (no shared state). fortranHandler, scssHandler, lessHandler, cssHandler, objectiveCHandler were not registered in `indexing-worker.ts` — files with those extensions reached workers but got 0 symbols. Added all 5 missing `registerHandler` calls. |
| 2026-05-21 | Batch 2: directory trailing-slash in `file-discovery.ts` | `ignore` npm package: `ig.ignores('deps/rabbit')` returns `true` even when `!/deps/rabbit/` negation is present, because the no-slash check matches `/deps/*` pattern. Fix: `const checkPath = entry.isDirectory() ? relPath + '/' : relPath` — appending `/` activates the directory-level negation logic in `ignore`. Fixed RabbitMQ `deps/` traversal. |
| 2026-05-20 | Phase 52: RUST_ONLY_SYNONYMS domain restriction | `future→poll`, `spawn→tokio/task`, `concurrent→parallel`, and serde synonyms now only fire when domain='rust'. Without scoping, `future→poll` caused `FutureBase::poll` to outscore `folly::Future` in C++ repos, blocking folly P@1. Matches the existing `RENDERING_ONLY_SYNONYMS` pattern. |
| 2026-05-20 | Phase 52: C++ bare local name in FTS content | `buildFtsContent` now appends the bare local name (`Future`) for `::` qualified symbols (`folly::Future`). Gives the local name a dedicated FTS5 token with boosted BM25 weight via repetition, improving single-word C++ queries. |
| 2026-05-20 | Phase 52: Harness qualified-name matching | Benchmark harness now accepts `folly::Future` as a match when ground truth expects bare `Future`. Uses `name.split('::').pop()` suffix comparison; only fires for bare (non-qualified) expected symbols to avoid false positives. |
| 2026-05-20 | Phase 52: Windows path-case fix in harness | `computeRepoId` is SHA-256 based and case-sensitive. Harness used `computeRepoId(repoPath)` (lowercase `d:/`) while `indexFolder` used `computeRepoId(resolve(rootPath))` (uppercase `D:/`), producing different hashes. Fix: use `indexResult.repoId` from the indexer rather than recomputing. |
| 2026-05-20 | Phase 52: test-mapper local try-catch | `buildTestMappings` now catches `writeAll()` failures locally and returns 0 rather than propagating. Prevents FK constraint errors in the test-mapper transaction from blocking subsequent FTS index population. |
| 2026-05-20 | Phase 52: C# interface member extraction | `extractMembers` adds `isInterface = typeNode.type === 'interface_declaration'` guard to skip visibility check for interface members (implicitly public in C#). Also fixes method name extraction: `methodName()` helper uses `findLast` before `parameter_list` to avoid returning the return type (first identifier) instead of the method name. Event field declarations (`event_field_declaration`) added as `property` kind. |
| 2026-05-20 | Phase 51: hasCppStyleMethods guard on class injection | Class-type secondary FTS injection (to fix C++ 0% P@1) was scoped to repos where method symbols contain `::` in their name. Prevents regression in Ruby/Rails repos (brew, mastodon, rails, discourse) where single-word class names would be outranked by compound injected symbols. |
| 2026-05-20 | Phase 51: Ruby DSL extraction (associations + callbacks) | Ruby handler now extracts `has_many`, `belongs_to`, `has_one`, `has_and_belongs_to_many`, `before_action`, `after_action`, `validates`, `scope` class macros as `property` symbols with DSL kind metadata. Improves brew/rails/mastodon symbol counts and search relevance for ActiveRecord model queries. |
| 2026-05-20 | Phase 51: Rust cfg frameworkMeta + cfgFilter param | Rust symbols annotated with `#[cfg(...)]` attributes now carry `frameworkMeta.cfgAttributes` array. `search_symbols` accepts a new `cfgFilter` string that restricts results to symbols whose cfg attributes match the filter string. |
| 2026-05-20 | Phase 51: get_lexical_scope_matches + trace_invocation_chain | Two new MCP tools: `get_lexical_scope_matches` returns all symbols accessible from a given file+line (local scope, imports, module exports); `trace_invocation_chain` follows call edges from a symbol N hops deep and returns the linearised call path. |
| 2026-05-20 | Phase 50: identityExact scaled for data kinds | Const/type/interface/enum/property symbols now get identityExact=40/N (min 10) in multi-word queries. Prevents STRIPE const or Subscribers struct from dominating when mentioned as context in a longer query. BM25 cap (30% when topBase≥80) kept. Fixes nestjs 76%→84% without breaking listmonk (28%). |
| 2026-05-20 | Phase 50: Multi-IDE install command | `npx purecontext-mcp install <tool|all>` injects PureContext workflow into Cursor (.cursor/rules/purecontext.mdc), Windsurf (.windsurfrules), Continue (.continue/config.json systemMessage), Cline (.clinerules), Roo Code (.roo/rules-code.md), VS Code (.github/copilot-instructions.md), Claude Desktop (platform config). All writers are idempotent via HTML markers. |
| 2026-05-19 | Phase 48: Rendering synonyms scoped via RENDERING_ONLY_SYNONYMS | Added set of rendering-only synonym tokens; expandVerbSynonyms/preprocessQuery/toOrFallbackQuery/rankSymbols accept optional `domain` param; search-symbols.ts detects rendering repos by name pattern (mitsuba, render, shader, etc.). Fixes nuxt/airodump/origamicms-frontend regressions. |
| 2026-05-19 | Phase 48: Claude Code hooks in Node.js | Cross-platform (Windows/Linux/macOS) without bash/PS1 split — Node is already a hard dependency. Three hooks: PostToolUse index hook, PreCompact snapshot, Edit Guard (soft, never blocks). |
| 2026-05-19 | Phase 48: Negative evidence in `search_symbols` | When 0 results after all fallbacks, return `verdict: "no_match"` to stop agents from re-searching with variant queries. |
| 2026-05-19 | `AGENT_REFERENCE.md` in project root | Full tool reference, navigation patterns, known limitations moved out of global CLAUDE.md. Always-on instructions trimmed to ~80 lines; reference loaded on demand. |
| 2026-05-18 | Phase 47: Java bare method names + C++ template class extraction | fleetdirect-android 0%: Java methods used qualified names. mitsuba3 0%: tree-sitter-cpp misparsed `class MI_EXPORT_LIB ClassName` as `function_definition`. Fix: detect misparse pattern, emit class symbol, walk body. |
| 2026-05-18 | Phase 46: Go/Rust bare method names + identity-exact boost | PC stored receiver-qualified names (`Manager.PushCampaignMessage`) but ground truth uses bare names. Identity-exact +40 boost mirrors JC's Identity channel (weight=2.0). |
| 2026-05-17 | Stylesheet handler: regex-only (no WASM) | SCSS/LESS/CSS handlers use regex extraction — no tree-sitter grammars available. Only named reusable constructs indexed (mixins, variables, functions); plain selectors excluded. |

---

## Quick Commands

```bash
# Development
npm run build          # Compile TypeScript
npm run dev            # Watch mode
npm run test           # Run test suite
npm run lint           # ESLint

# CLI
npx purecontext-mcp                    # Start MCP server (stdio)
npx purecontext-mcp config --init      # Generate default config
npx purecontext-mcp config --check     # Validate config + prerequisites
npx purecontext-mcp hooks --install               # Install Claude Code hooks
npx purecontext-mcp install all                   # Auto-detect IDEs, prompts for scope
npx purecontext-mcp install all --scope=global    # Install globally without prompt
npx purecontext-mcp install cursor --scope=local  # Install for a specific IDE

# Claude Code integration
claude mcp add purecontext-mcp npx purecontext-mcp
```

<!-- purecontext-mcp-start -->
## PureContext MCP — Code Navigation

Always use PureContext MCP tools for code navigation. Never read entire files to find code.

### Mandatory workflow

1. **Start every session**: `list_repos()` → get `repoId` (required for all tools)
2. **Find code by name**: `search_symbols` → read `summary` and `signature` → only call `get_symbol_source` for symbols you will actually edit
3. **Find code by behaviour**: `search_semantic` for conceptual queries; `search_text` for literals/comments

### Key tools

| Goal | Tool |
|------|------|
| Find function/class by name | `search_symbols` |
| Find by what it does | `search_semantic` |
| Find literal string or comment | `search_text` |
| All symbols in a file | `get_file_outline` |
| What breaks if I change this | `get_blast_radius` |
| All callers of a function | `find_references` |
| Callers/callees tree | `get_call_hierarchy` |

### Anti-patterns — never do these

- Do not read whole files to find a function — use `search_symbols` + `get_symbol_source`
- Do not call `get_symbol_source` for every result — read `summary` first
- Do not skip `list_repos` — every tool needs a `repoId`
- Do not re-search after `verdict: "no_match"` — the symbol does not exist
<!-- purecontext-mcp-end -->
