# PureContext MCP — Project Instructions

## What This Project Is

PureContext MCP is a Node.js/TypeScript MCP (Model Context Protocol) server for token-efficient source code navigation by AI agents. It indexes codebases using tree-sitter AST parsing, stores structured symbol metadata in SQLite, and lets agents retrieve precisely the code they need instead of reading entire files.

The full product requirements are in `docs/PureContext_MCP_PRD_v1.0.docx`. Read it before making architectural decisions.

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
  | 'hook' | 'route' | 'decorator' | 'middleware';

interface ImportRecord {
  sourceFile: string;
  specifier: string;             // Raw import path
  resolvedPath: string | null;   // Resolved relative path (null for external)
  importedNames: string[];
  isTypeOnly: boolean;
}

interface LanguageHandler {
  extensions(): string[];
  grammarPath(): string;         // Path to .wasm file
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

interface ProcessedBlock {
  content: Buffer;
  language: string;              // 'typescript' | 'javascript' | 'html' | 'css'
  offsetInOriginal: number;      // Byte offset where this block starts in the original file
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
- Phase 1 grammars: `tree-sitter-typescript`, `tree-sitter-javascript`
- Parse dispatcher in core receives a file, resolves the handler, calls tree-sitter

### MCP Server

- Use `@modelcontextprotocol/sdk` for protocol handling
- Phase 1: stdio transport only
- Each tool is a separate file in `src/server/tools/`
- Tool handler receives parsed input, calls core services, returns structured response

## Coding Conventions

### General

- **Language**: TypeScript with strict mode
- **Module system**: ES modules (`"type": "module"` in package.json)
- **Node.js**: >= 18.0.0
- **No classes unless necessary** — prefer functions and plain objects. Use classes only for stateful services (IndexManager, Watcher) where lifecycle matters.
- **Error handling**: Use typed error classes extending a base `PureContextError`. Never swallow errors silently.
- **Logging**: Use a simple leveled logger (debug/info/warn/error). No console.log in production code.

### Naming

- Files: `kebab-case.ts` (e.g., `symbol-store.ts`, `typescript-handler.ts`)
- Types/interfaces: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Database columns: `snake_case`

### Testing

- Use `vitest` for unit and integration tests
- Test directory mirrors src: `test/core/`, `test/handlers/`, `test/adapters/`
- Integration tests use fixture projects in `test/fixtures/` (small but representative)
- Every language handler and framework adapter must have tests against real AST output

### File Organization

```
purecontext-mcp/
├── src/
│   ├── core/
│   │   ├── index-manager.ts      # Orchestrates indexing pipeline
│   │   ├── file-discovery.ts     # Scan, filter, prioritize files
│   │   ├── hash-cache.ts         # In-memory + SQLite content hashes
│   │   ├── parse-dispatcher.ts   # Route files to language handlers
│   │   ├── types.ts              # Core type definitions
│   │   ├── errors.ts             # Error classes
│   │   ├── logger.ts             # Leveled logger
│   │   ├── db/
│   │   │   ├── schema.ts         # Table definitions, migrations
│   │   │   ├── symbol-store.ts   # Symbol CRUD operations
│   │   │   ├── file-store.ts     # File content cache
│   │   │   └── dep-store.ts      # Dependency edge storage + traversal
│   │   └── watcher/
│   │       └── file-watcher.ts   # Chokidar wrapper with debounce + fast path
│   ├── server/
│   │   ├── mcp-server.ts         # Server setup, tool registration
│   │   ├── transport.ts          # stdio + HTTP/SSE abstraction
│   │   └── tools/
│   │       ├── index-folder.ts
│   │       ├── resolve-repo.ts
│   │       ├── list-repos.ts
│   │       ├── search-symbols.ts
│   │       ├── get-symbol-source.ts
│   │       ├── get-file-outline.ts
│   │       ├── get-repo-outline.ts
│   │       ├── get-file-tree.ts
│   │       ├── get-context-bundle.ts
│   │       ├── get-blast-radius.ts
│   │       ├── find-importers.ts
│   │       └── find-dead-code.ts
│   ├── handlers/
│   │   ├── handler-registry.ts   # Auto-discover and register handlers
│   │   ├── typescript.ts
│   │   └── javascript.ts
│   ├── adapters/
│   │   ├── adapter-registry.ts   # Auto-detect and activate adapters
│   │   └── (Phase 2+: vue.ts, nuxt.ts, react.ts, etc.)
│   ├── graph/
│   │   ├── graph-builder.ts      # Build dep edges from ImportRecords
│   │   ├── graph-traversal.ts    # Forward/reverse walks, blast radius
│   │   └── path-resolver.ts     # Resolve import paths (tsconfig aliases, relative)
│   ├── summarizer/
│   │   ├── summarizer.ts         # Orchestrator: docstring → framework → AI → signature
│   │   ├── docstring-extractor.ts
│   │   └── ai-summarizer.ts      # Optional AI batch summarization
│   ├── config/
│   │   ├── config-loader.ts      # Load and validate config.json
│   │   ├── config-schema.ts      # JSON schema definition
│   │   └── cli.ts                # --init, --check, --config commands
│   └── index.ts                  # Entry point
├── grammars/                     # Bundled .wasm files
│   ├── tree-sitter-typescript.wasm
│   ├── tree-sitter-tsx.wasm
│   └── tree-sitter-javascript.wasm
├── docs/
│   └── PureContext_MCP_PRD_v1.0.docx
├── test/
│   ├── core/
│   ├── handlers/
│   ├── adapters/
│   ├── server/
│   └── fixtures/
│       ├── basic-ts-project/     # Minimal TS project for core tests
│       ├── vue-project/          # Small Vue app for adapter tests
│       └── react-project/        # Small React app for adapter tests
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── CLAUDE.md                     # This file
└── README.md
```

## Current Phase

**Phases 1–36 complete.** Phase 37 (Search Quality Part 2) is next.

| Phase | Focus | Tasks |
|-------|-------|-------|
| 28 — Advanced Relationship Analysis | `find_implementations`, `get_call_hierarchy`, `get_class_hierarchy`, `find_cycles`, `get_coupling_map` | 173–177 ✓ |
| 29 — Architectural Visualization | `render_diagram`, `render_call_graph`, `render_import_graph`, `render_class_hierarchy`, `render_dep_matrix`, `get_architecture_snapshot` | 178–183 ✓ |
| 30 — Refactoring Safety Checks | `check_rename_safe`, `check_delete_safe`, `check_move_safe`, `plan_refactoring` | 184–187 ✓ |
| 31 — Health Dashboards & Debt Reporting | `health_radar`, `diff_health_radar`, `get_debt_report` | 188–190 ✓ |
| 32 — AST-Level Search | `search_ast`, `search_by_signature`, `search_by_decorator`, `search_by_complexity` | 191–194 ✓ |
| 33 — Code Intelligence Helpers | `get_entry_points`, `get_public_api`, `get_todos`, `get_complexity_hotspots`, `get_type_graph`, `find_untested_symbols`, `get_test_coverage_map` | 195–201 ✓ |
| **34 — Search Quality (Body Snippets)** | Index first ~200 bytes of function/method body into FTS5. Target: lift eu-za-tebe P@1 from 0% to ≥ 20%. Body snippets indexed correctly (21 tests); P@1 still 0% — FTS5 AND mode blocks on English connectives. OR-fallback (Phase 37) needed to activate the snippets. | 202 ✓, 203 ✓, 204 ✓, 205 ✓ |
| **35 — Coverage Gap Discovery** | Structured audit of jCodeMunch vs PureContext PHP extraction. Key findings: (1) original 5× gap was CSS contamination + stale index; PHP-only gap is 1.02×; (2) JC property_declaration extraction silently fails (wrong name field); (3) PC extracts 373 PHP const symbols, JC gets 0; (4) UTF-8 broken-name bug in PC for methods after multibyte chars. Phase 36: P0=UTF-8 fix, P1=property_declaration. | 206 ✓, 207 ✓, 208 ✓, 209 ✓ |
| **36 — PHP Handler Depth** | Implement top-tier extraction gaps from Phase 35: class property declarations, define() constants, closures. Benchmark result: +1,284 symbols (+29.9%), 4,291→5,575; property kind added (1,250 new symbols); const 114→154 (+35%); symbols/kLOC 38.8→50.2; P@1 stays 0% (FTS AND-mode — Phase 37 fix). | 210a ✓ (UTF-8 fix — parse-dispatcher callback now uses sourceStr.slice() so all grammar re-reads use char indices; typescript.ts buildSignature/extractBodySnippet updated to match; all 21 PHP tests pass), 210 ✓ (property_declaration, 26 tests), 211 ✓ (define() constants — expression_statement→function_call_expression detection; quote stripping; identifier validation; namespace-qualified; 37 tests total), 212 ✓ (abstract methods + enum cases + interface constants — abstract_method_declaration in extractMembers; extractEnumCases walks enum_declaration_list; interface constants already worked via extractMembers; fixture updated with BaseController abstract class + backed Status enum + Countable::MAX_COUNT; 58 tests total), 213 ✓ (closures — expression_statement→assignment_expression; rhs is anonymous_function or arrow_function; buildClosureSignature helper; bodySnippet only for compound_statement bodies; arrow function expression body excluded; 71 tests total), 214 ✓ (benchmark — eu-za-tebe re-run post Phase 36) |
| **37 — Search Quality Part 2** | OR-fallback for zero-result AND queries + abbreviation expansion in preprocessor ("db"→"database"). Target: P@1 ≥ 35%. Benchmark result: P@1 0%→24%, P@3 0%→48%, R@5 0%→56%; PC now beats JC on P@3 and R@5; P@1 target 35% not yet met (6/25 hits vs 9/25 needed). | 215 ✓ (OR-fallback — toOrFallbackQuery + search-symbols retry, 18 tests), 216 ✓ (abbreviation expansion — expandToken bidirectional dict; single-token expansion including camelCase/snake_case embedded abbrevs; 33 new tests, 57 total in query-preprocessor.test.ts), 217 ✓ (benchmark — harness updated to use toOrFallbackQuery + rankSymbols; P@1 24%, P@3 48%, R@5 56%) |
| **38 — Search Quality Part 3** | Three structural fixes for the 11 remaining benchmark misses. Root causes: (A) FTS5 camelCase token boundary — "FrontController" is one token, "controller" can't match it; (B) verb/synonym gaps — "remove"≠"delete", "sign-in"≠"login", "pagination"≠"paging"; (C) ranking precision — tied BM25 scores with no stemming and loose substring matching. Target: P@1 ≥ 36% (9+/25). Actual: P@1 28% (7/25), P@3 52% (13/25), R@5 60% (15/25) — all three metrics up +4pp vs Phase 37. Also discovered and fixed FTS5 syntax error: Task 220 produced synonym OR-groups like "(remove OR delete)" but preprocessQuery joined with implicit space which FTS5 rejects after a parenthesised group; fix uses explicit " AND " when any part is a group; toOrFallbackQuery updated to detect only top-level OR (not OR inside groups) and flatten synonym groups when building OR fallback. | 218 ✓ (stop word filtering — STOP_WORDS set of 38 words; isStopWord() exported; multi-word branch in preprocessQuery filters before AND join; toOrFallbackQuery filters before OR join; extractQueryWords in ranker skips stop words so 30-pt "all words in name" rule becomes achievable; 29 new tests, 5040 total passing), 219 ✓ (FTS split-name indexing — splitNameForFts() + splitCamelParts() + buildFtsContent() in symbol-store.ts; camelCase/PascalCase split at index time so "controller" finds "FrontController"; hybrid snake_case+camelCase segments handled too; simple snake_case skipped (FTS5 splits on _); 19 tests in test/core/fts-split-name.test.ts), 220 ✓ (verb synonym expansion — VERB_SYNONYMS dict; expandVerbSynonyms() exported; multi-word AND path wraps synonym words as FTS5 OR-groups "(remove OR delete)"; toOrFallbackQuery adds synonyms to OR list; 26 new tests, 112 total in query-preprocessor.test.ts), 221 ✓ (ranker improvements — splitNameParts() splits camelCase/snake_case/namespace names into word-boundary parts; addStemsOf() adds -s/-ing/-ed/-tion stem variants to query words; extractQueryWords splits hyphens ("front-end"→["front","end"]); word-overlap rules replaced with partExact matching (30/20/10pt); confirms fixes for gt-12/gt-21/gt-22; 18 new tests, 33 total in relevance-ranker.test.ts), 222 ✓ (benchmark re-run — FTS5 syntax error found & fixed: explicit " AND " between synonym OR-groups + hasTopLevelOr() in toOrFallbackQuery; 8 new tests; P@1 28%, P@3 52%, R@5 60%) |

**Total tools:** 50+ MCP tools across all phases. See `src/server/tools/` for implementations and `test/` for coverage.

## Decision Log

Record significant design decisions here as the project evolves:

| Date | Decision | Rationale                                                                                                                                          |
|------|----------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| 2026-04-10 | Project initiated | PRD v1.0 finalized                                                                                                                                 |
| 2026-04-20 | Competitive benchmark added (`benchmarks/`) | Head-to-head vs other tools on token efficiency, search quality, symbol coverage, semantic search                                                  |
| 2026-04-20 | Phase 14: FTS5 search upgrade | Benchmark revealed 0% keyword search quality; fix by wiring existing FTS5 infrastructure, adding camelCase query preprocessor and relevance ranker |
| 2026-04-21 | Phase 15: Worker thread pool for parallel parsing | Enterprise target requires viable indexing at 10k–50k files; sequential WASM parsing is the bottleneck                                             |
| 2026-04-25 | Phase 16: npm release readiness | better-sqlite3 prebuilt binaries + CI + package hygiene + v1.0.0                                                                                   |
| 2026-04-25 | Phase 17: Public launch polish | fileLimit raised, actionable errors, --health, opt-in telemetry                                                                                    |
| 2026-04-25 | Phase 18: Team/cloud features | API keys, workspaces, Docker, MCP-over-HTTP — monetization foundation                                                                              |
| 2026-05-02 | Phase 19: Missing core tools | find_references, get_file_content, get_symbols, invalidate_cache — closes other tools parity gap                                                   |
| 2026-05-02 | Phase 20: Tool capability enhancements | Search debug mode, context_lines/verify, GitHub API indexing, Gemini Flash                                                                         |
| 2026-05-02 | Phase 21: Ecosystem & data tools | Context provider framework, dbt, search_columns, OpenAPI/Swagger, SQL handler                                                                      |
| 2026-05-02 | Phase 22: Language coverage expansion | 14 new handlers: Bash, Terraform, Protobuf, GraphQL, and 10 more                                                                                   |
| 2026-05-02 | Phase 23: Cross-repo intelligence | Cross-repo search, code similarity (HNSW), cross-repo deps, MCP Resources                                                                          |
| 2026-05-02 | Phase 24: Git & history integration | Symbol-level git history, PR diff analysis, churn metrics                                                                                          |
| 2026-05-02 | Phase 25: AI-powered architecture analysis | Quality metrics, anti-patterns, arch docs, smart context, refactoring detector                                                                     |
| 2026-05-02 | Phase 26: Enhanced Web UI | Heatmap, symbol timeline, coverage overlay, multi-repo workspace, advanced graph                                                                   |
| 2026-05-02 | Phase 27: Distribution & platform | Index export/import, public registry CDN, webhooks, GitHub Actions, VS Code extension                                                              |
| 2026-05-11 | Phases 28–33: jCodeMunch gap closure | Gap analysis vs jCodeMunch v1.4.1 (see docs/dev/jcodemunch-gap-analysis.md); 6 phases add 29 tools closing graph traversal, visualization, refactoring safety, health dashboards, AST search, and code intelligence gaps |

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

# Claude Code integration
claude mcp add purecontext-mcp npx purecontext-mcp
```
