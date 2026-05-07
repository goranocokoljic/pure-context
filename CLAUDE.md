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

**Phase 19 — Missing Core Tools**

Focus: Close the four largest tool-level gaps vs other tools: `find_references` (identifier-level usage search), `get_file_content` (raw cached file retrieval with line slicing), `get_symbols` (batch symbol fetch by ID), and `invalidate_cache` (force re-index).

See `docs/PHASE19_TASKS.md` for the sequenced task breakdown (Tasks 131–134).

**Upcoming phases (parity with other tools):**
- Phase 20: Tool Capability Enhancements — search debug mode, `context_lines`/`verify` on symbol retrieval, GitHub API indexing, Gemini Flash summarization (Tasks 135–138)
- Phase 21: Ecosystem & Data Tools — context provider framework, dbt provider, `search_columns`, OpenAPI/Swagger handler, SQL handler with dbt Jinja (Tasks 139–143)
- Phase 22: Language Coverage Expansion — Bash, Perl, Terraform/HCL, Nix, Protobuf, GraphQL, Groovy, Erlang, Gleam, GDScript, XML, Objective-C, Fortran (Tasks 144–149)

**Differentiation phases (beyond other tools):**
- Phase 23: Cross-Repo Intelligence — cross-repo search, code similarity search, cross-repo dep tracking, MCP Resources (Tasks 150–153)
- Phase 24: Git & History Integration — git metadata indexing, symbol history, PR/diff analysis, churn metrics (Tasks 154–157)
- Phase 25: AI-Powered Architecture Analysis — quality metrics, anti-pattern detection, architecture docs, smart context bundling, refactoring detector (Tasks 158–162)
- Phase 26: Enhanced Web UI — architecture heatmap, symbol timeline, test coverage overlay, multi-repo workspace, advanced graph (Tasks 163–167)
- Phase 27: Distribution & Platform — index export/import, pre-built registry, webhook auto-reindex, GitHub Actions, VS Code extension (Tasks 168–172)

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
