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

**Phase 53 — Next** (TBD)

Candidate items:
- clickhouse: C++ namespace qualification gap still causes 0% P@1 (codebase was too large to index in benchmark window; fix applied but not yet verified)
- C# depth re-benchmark: fleetdirect-saas and origamicms not re-run in Phase 52 (project paths unavailable); interface member fix should improve both
- Further C++ namespace depth: many C++ symbols in large codebases still unranked due to deep namespace nesting

Full phase history: `dev-docs/PHASE*_TASKS.md` files.

---

## Decision Log

Recent significant decisions:

| Date | Decision | Rationale |
|------|----------|-----------|
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
npx purecontext-mcp hooks --install    # Install Claude Code hooks
npx purecontext-mcp install all        # Auto-detect IDEs and install each
npx purecontext-mcp install cursor     # Install for a specific IDE

# Claude Code integration
claude mcp add purecontext-mcp npx purecontext-mcp
```
