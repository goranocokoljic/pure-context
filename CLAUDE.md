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

**Phase 48 — Claude Code Hooks + Negative Evidence + Benchmark Regressions**

Tasks 263–268. See `dev-docs/PHASE48_TASKS.md` for full detail.
Full phase history: `dev-docs/PHASE*_TASKS.md` files.

---

## Decision Log

Recent significant decisions:

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-19 | Phase 48: Claude Code hooks in Node.js | Cross-platform (Windows/Linux/macOS) without bash/PS1 split — Node is already a hard dependency. Three hooks: PostToolUse index hook, PreCompact snapshot, Edit Guard (soft, never blocks). |
| 2026-05-19 | Negative evidence in `search_symbols` | When 0 results after all fallbacks, return `verdict: "no_match"` to stop agents from re-searching with variant queries. |
| 2026-05-19 | `AGENT_REFERENCE.md` in project root | Full tool reference, navigation patterns, known limitations moved out of global CLAUDE.md. Always-on instructions trimmed to ~80 lines; reference loaded on demand. |
| 2026-05-18 | Phase 47: Java bare method names + C++ template class extraction | fleetdirect-android 0%: Java methods used qualified names. mitsuba3 0%: tree-sitter-cpp misparsed `class MI_EXPORT_LIB ClassName` as `function_definition`. Fix: detect misparse pattern, emit class symbol, walk body. |
| 2026-05-18 | Phase 47: Rendering domain synonyms scoped to rendering repos | light↔emitter, camera↔sensor, glass↔dielectric etc. caused regressions in nuxt/airodump/origamicms-frontend when applied globally. Phase 48 Task 268 scopes them to rendering-domain repos only. |
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

# Claude Code integration
claude mcp add purecontext-mcp npx purecontext-mcp
```
