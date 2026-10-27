If you ever need to run python scripts, use python, not python 3.

# PureContext MCP — Project Instructions

## What This Project Is

PureContext MCP is a Node.js/TypeScript MCP (Model Context Protocol) code-intelligence server for AI agents. It indexes codebases using tree-sitter AST parsing, stores structured symbol metadata in SQLite, and serves two layers: **token-efficient retrieval** (let agents pull the exact symbols they need instead of reading whole files — the original, benchmarked foundation) and **change intelligence** (blast radius, temporal co-change, composite per-symbol risk, and refactor-safety checks so an agent can assess the impact and risk of an edit before making it). Retrieval is the foundation; safe autonomous change is the differentiation.

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

## Current Status

- **Version:** 1.40.1. Phases 1–108 are COMPLETE (latest: Phase 108 — Nuxt Alias Edges + Task-Context Discovery + Resolver Stamp: tsconfig `extends` chains followed (kurirfe 420 → 1,174 edges), Nuxt default aliases when `.nuxt/tsconfig.json` is absent, `get_task_context` FTS discovery uses the `search_symbols` query shape (OR fallback — "login form" 0 → 15 items), `PathResolver.configStamp` in `provider_metadata` re-resolves the whole graph once when the alias inputs or rules change (1,786 records in 1.4 s, no re-parse). No schema change, guard byte-identical. Findings: `dev-docs/in-progress/phase108-findings.md`. Before it, Phase 107 — Incremental Cost Follow-ups: compact test-mapping store (`test_mappings` bitsets over stable test-file ordinals + `test_name_runs`, schema v16 additive, mapper algo 3 — flutter 560 MB of 1.37 JSON rows → 8 MB, jenkins 83 → 0.8 MB); token-delta remap on `index_file` of a test file (`mode: 'delta'`; jenkins 0.6–0.9 s → 33–43 ms, flutter 4–9 s → 0.14–0.23 s, parity with a forced rebuild 24/24); `strictness: 'ref'` + `coverageEvidence` on `find_untested_symbols` / `get_symbol_risk` (opt-in — jenkins 7,056 mention-tested vs 1,159 ref-tested); per-link graph stamp `repo_links.linked_stamp` (content hash, never HEAD / row ids — jenkins `core` no-op 3.3 → 1.4 s, parity nuxt 10 + jenkins 5 roots 0 mismatches); `indexFolder` carries changed-file content up to 256 MB then re-reads per batch (the rest-api-description 3.9 GB was every changed file held at once). No ranking change. Findings: `dev-docs/in-progress/phase107-findings.md`).
- **Next:** not planned. Open: npm publish of 1.40.0 (reply note `dev-docs/purecontext-reply-1.40.0.md` — the reporter's `testMapper` line is still the ask); the RANKING gap on the three author-independent hold-outs (restic-dev, scala-steward-dev, go-git-dev at 0–4% P@1 vs the 66/79 scorecard — expected symbols never enter the FTS pool; needs query rewriting / a semantic channel in `search_symbols`, its own design); the ~1.3 s floor of a no-op whole-tree run on a 10-root workspace (link discovery opens every index in the data dir).
- **Re-index note:** none forced since 1.31.0; resolver stamp (1.40.1) — every repo re-resolves its whole graph once on its next whole-tree run ("first stamped run", no re-parse); schema v16 (1.40.0) is additive — the test mapping rebuilds itself once (lazily, mapper algo 3) and `onlyChanged` takes one full hash-skipping walk on a v15 index; SQL `sql_table` / OpenAPI `openapi_schema` tags appear on each SQL/OpenAPI repo's next whole-tree run (1.39.0); Go structs carry `go_struct` and Scala companions/member vals appear on each repo's next whole-tree run (1.38.0); test-mapper token rows + mapping build on each repo's next whole-tree run or first coverage-needing tool call (1.37.0); Ruby/Swift edges and Elixir/C++ private symbols appear on each repo's next whole-tree run (1.36.0); symbol refs backfill on each repo's next whole-tree run (`list_repos.symbolRefs` = 0 until then); content migrates to the blob store the same way; cross-index DI edges appear on an android root's next run.
- **History:** phase summaries for 75–100 are in `dev-docs/PHASE-HISTORY.md`; earlier phases in `dev-docs/PHASE*_TASKS.md`; the full decision log (181 rows) is in `dev-docs/DECISION-LOG.md`. Read those before making an architectural decision, and append new decisions to `dev-docs/DECISION-LOG.md`.

**Working rules that came out of the history (keep these):**
- Measure before and after; take a FRESH baseline first (stored benchmark rows go stale). One lever per sweep. Revert by default when a change is net negative; record it, do not carry it.
- Run `npm run bench:guard` on the finished tree BEFORE the version bump of every phase (rule P8) and paste its table into the findings file; a >4pp P@1 drop on any repo does not ship until it is explained or reverted. Judge every ranking lever on a blind hold-out (rule P6, `benchmarks/HOLDOUTS.md`) — replaying a hold-out burns it. Every lever states its language fact (P7); no fact, no lever.
- A passing fixture is a hypothesis until a real repo confirms it.
- Handlers, workers and the benchmark harness must register the same list (`src/core/bootstrap-registry.ts`); harness ranking helpers are imported from production, never copied.
- Storage is TRUE bytes (`src/core/offsets.ts`); handlers emit tree-sitter char indices and the pipeline converts once.
- Index everything reachable inside the indexed unit and tag visibility in `frameworkMeta`; never drop symbols to fix a score.
- Every pre-1.32 `dep_edges` reader is local-only (`target_repo_id IS NULL`); file content goes through `src/core/db/file-store.ts` only (hygiene test enforces both).
- Judgment, not actuation: no edit-applying tools, no author/ownership metrics.

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
## PureContext MCP — Code Navigation & Safe Change

PureContext is an indexed symbol graph of the repo. It is the right tool for some jobs and the wrong tool for others — route by task, not by preference:

| Task | Use | Not |
|------|-----|-----|
| Locate a symbol by name / by what it does | `search_symbols` / `search_semantic` | reading files to find it |
| Read one symbol's code | `get_symbol_source` (or `get_symbols` for several) | whole-file reads |
| Every call site of a symbol (a caller census) | `find_references` | a wide grep |
| Impact before editing shared code | `get_blast_radius` (`granularity: 'symbol'` for who mentions THIS symbol; `fileRadius` = upper bound), `find_importers`, `get_symbol_risk` | guessing |
| Is the index fresh? | `list_repos` → `head`/`freshness`; `check_index_staleness` | assuming |
| Disk full of old indexes? (removed worktrees, crashed runs) | `list_repos` → `store`; `gc_indexes({})` (dry run) then `apply: true` | deleting `.db` files by hand |
| Prove NOTHING references X across a tree (absence proof) | `git grep` / `grep` | the index — it cannot prove absence |
| Build-file / settings / config facts | read the file (`get_file_content` or Read) | the index |
| Files already in the diff you are reviewing | read them | the index |
| Impact across a split build tree (several indexes in ONE checkout) | the same graph tools — check `list_repos` → `links` first; `linked` / `linkedImporters` carry the other side | assuming the seam is a wall (edges cross linked indexes since 1.32.0) |
| Anything across an UNLINKED boundary (another repo, worktree, unindexed subtree) | `find_cross_repo_usages` + grep | a blast radius — edges stop at an unlinked seam |

### Session start

1. `list_repos()` → `repoId` (all tools need it). Not listed? `index_folder({ path })`.
2. **Read each repo's `freshness` line before trusting it.** `behind` → `index_folder({ path, onlyChanged: true })` (git delta, seconds; no directory walk). `re-index in progress` → wait or use grep for now. Git hooks (`purecontext-mcp hooks --install --git`) keep it fresh on checkout/merge/rebase automatically.
3. Orient on a task: `get_task_context({ repoId, task })` → relevant symbols + files over the real dependency/co-change graph.

### For non-trivial changes — close the loop

PureContext is judgment, not actuation: you make the edit; these tools say what is safe and what you forgot. Use them when the change is risky or touches shared code; skip them for trivial edits.

- Pre-edit: `prepare_change` (existing code) or `check_consistency` (new symbols) → risk, forgotten co-change partners (`missingCoChange`), tests, and a `gate`.
- After a write: `index_file({ repoId, filePaths })` — one file, cheap. Never `index_folder` mid-task.
- Verify: `verify_change({ repoId, diff, predictedFilePaths, predictedCoChange })`; pre-merge: `merge_readiness`.
- Gate tools return `{ gate: "pass" | "warn" | "block", gateReasons, nextAction }` — `block` means fix first.

### Reading results honestly

- `verdict: "no_match"` from `search_symbols` = not in the index. Report the gap; do not retry many variants.
- `graphCoverage: "empty"` or `externalImports` on a graph result = the graph is missing or stops at an UNLINKED index seam; an empty blast radius there is NOT "safe to change". A link whose status is `moved` → `index_folder` on the root you are querying.
- Rename / delete / move: `check_rename_safe` / `check_delete_safe` / `check_move_safe` first.

Full tool reference: `AGENT_REFERENCE.md` in the project root; harness loop recipes: `docs/HARNESS-CONTRACT.md`.
<!-- purecontext-mcp-end -->
