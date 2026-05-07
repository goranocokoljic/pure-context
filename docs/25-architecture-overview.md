# Architecture Overview


This section explains PureContext's internal design. Useful for contributors, developers building on top of PureContext, or anyone who wants to understand why it works the way it does.

---

## Three-layer architecture

```
┌──────────────────────────────────────────┐
│  Framework Adapters  (src/adapters/)     │  Vue, React, Django, Spring, ...
└───────────────────┬──────────────────────┘
                    │ uses
┌───────────────────▼──────────────────────┐
│  Language Handlers  (src/handlers/)      │  TypeScript, Python, Go, ...
└───────────────────┬──────────────────────┘
                    │ uses
┌───────────────────▼──────────────────────┐
│  Core              (src/core/)           │  Parse, Store, Search, Watch, MCP
└──────────────────────────────────────────┘
```

**The dependency direction is strictly downward: Adapters → Handlers → Core. Never the reverse.**

This constraint means:
- Core knows nothing about specific languages or frameworks
- Handlers know nothing about frameworks
- Adding a new language never touches Core
- Adding a new framework never touches Core or existing Handlers

---

## Core layer (`src/core/`)

The core is language and framework agnostic. Responsibilities:

| Module | Responsibility |
|--------|----------------|
| `index-manager.ts` | Orchestrates the full indexing pipeline |
| `file-processor.ts` | Reads files, checks hash cache, dispatches to handlers |
| `parse-dispatcher.ts` | Routes files to the correct LanguageHandler by extension |
| `types.ts` | Core type definitions (SymbolRecord, ImportRecord, etc.) |
| `errors.ts` | Typed error classes extending `PureContextError` |
| `db/schema.ts` | SQLite table definitions and migrations |
| `db/symbol-store.ts` | Symbol CRUD — insert, search, retrieve |
| `db/file-store.ts` | Raw file content cache for `get_file_content` |
| `db/embedding-store.ts` | HNSW vector index management |
| `watcher/file-watcher.ts` | Chokidar wrapper with debounce and fast incremental path |

The MCP server (`src/server/`) and semantic search (`src/semantic/`) also build on Core.

---

## Language handler layer (`src/handlers/`)

Each handler implements `LanguageHandler`:

```typescript
interface LanguageHandler {
  extensions(): string[];           // ['.ts', '.tsx']
  grammarPath(): string;            // path to .wasm grammar file
  extractSymbols(tree: Tree, source: Buffer): SymbolRecord[];
  extractImports(tree: Tree, source: Buffer): ImportRecord[];
  extractDocstring(node: SyntaxNode): string | null;
}
```

Handlers know how to:
- Load their tree-sitter WASM grammar
- Walk the AST to find symbol-bearing nodes
- Extract names, byte offsets, signatures, and docstrings
- Extract import statements and resolve specifiers

Handlers know **nothing** about frameworks, adapters, or the database.

---

## Framework adapter layer (`src/adapters/`)

Each adapter implements `FrameworkAdapter`:

```typescript
interface FrameworkAdapter {
  name: string;
  detect(projectRoot: string): Promise<boolean>;
  fileFilter(filePath: string): boolean;
  preProcess?(source: Buffer, filePath: string): ProcessedBlock[];
  extractFrameworkSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[];
  enrichMetadata?(symbol: SymbolRecord): SymbolRecord;
}
```

Adapters compose on top of language handlers. Multiple adapters can be active at once. Auto-detection runs at index time by calling `detect()` on every registered adapter.

---

## Data flow: indexing pipeline

```
index_folder(path)
    ↓
FileDiscovery
  - scan directory recursively
  - apply exclude patterns (node_modules, .git, *.pem, etc.)
  - prioritize by type (source files before config files)
    ↓
FileProcessor (per file, parallel via worker threads)
  - read file content
  - compute SHA-256 hash
  - compare with hash cache → skip if unchanged
    ↓
ParseDispatcher
  - route file to LanguageHandler by extension
    ↓
LanguageHandler.parse(buffer) → tree-sitter AST
    ↓
LanguageHandler.extractSymbols(AST) → SymbolRecord[]
LanguageHandler.extractImports(AST) → ImportRecord[]
    ↓
FrameworkAdapter.extractFrameworkSymbols(AST) → SymbolRecord[] (if active)
FrameworkAdapter.enrichMetadata(symbol) → SymbolRecord (if active)
    ↓
AISummarizer (optional)
  - fill in missing summaries via AI API
    ↓
SymbolStore.insertBatch(symbols) → SQLite (symbols table)
PathResolver.resolve(imports) → DepEdge[]
DepStore.insertBatch(edges) → SQLite (dep_edges table)
SemanticIndexer.index(symbols) → HNSW index (if enabled)
```

---

## Data flow: query pipeline

```
MCP tool call (e.g., search_symbols)
    ↓
Tool handler (src/server/tools/search-symbols.ts)
  - parse and validate input
    ↓
SymbolStore.search(query)
  - FTS5 query → BM25 ranked results
  - RelevanceRanker re-scores and sorts
    ↓
Tool handler
  - compute _tokenEstimate
  - record token savings in savings tracker
    ↓
JSON response → MCP client
```

---

## SQLite schema

Four tables:

```sql
CREATE TABLE repos (
  id TEXT PRIMARY KEY,          -- SHA-256(absolutePath).slice(0,16)
  root_path TEXT NOT NULL,
  indexed_at INTEGER,
  file_count INTEGER,
  symbol_count INTEGER
);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  file_path TEXT NOT NULL,      -- relative to repo root
  content_hash TEXT,
  content BLOB,                 -- cached raw content
  last_modified INTEGER
);

CREATE TABLE symbols (
  id TEXT PRIMARY KEY,          -- SHA-256(filePath:name:kind).slice(0,16)
  repo_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  file_path TEXT NOT NULL,
  start_byte INTEGER,
  end_byte INTEGER,
  signature TEXT,
  summary TEXT,
  framework_meta TEXT           -- JSON blob
);

CREATE TABLE dep_edges (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  source_file TEXT NOT NULL,
  target_file TEXT NOT NULL,
  specifier TEXT,               -- raw import path
  imported_names TEXT           -- JSON array
);
```

FTS5 virtual table on `symbols(name, summary, signature)` provides full-text search.

---

## Deterministic IDs

IDs are deterministic and stable across re-indexes:

- `repoId = SHA-256(absolutePath).slice(0, 16)`
- `symbolId = SHA-256(filePath:name:kind).slice(0, 16)`

This means the same symbol in the same file always has the same ID. Agents can store symbol IDs in long-term memory and retrieve them reliably on the next session.

---

## File watcher

`chokidar` watches the indexed directory for file changes. A 2-second debounce (configurable) prevents thrashing on bulk saves.

**Fast path for single file changes:**
1. Re-parse only the changed file
2. Delete old symbols for that file from SQLite
3. Insert new symbols
4. Update dep_edges for that file
5. Skip full re-scan

This makes editor save → symbol update latency typically < 200ms.

---

## Storage locations

| Path | Contents |
|------|----------|
| `~/.purecontext/indexes/` | SQLite databases (one per project) |
| `~/.purecontext/indexes/{repoId}/hnsw.idx` | HNSW vector index |
| `~/.purecontext/clones/` | Remote repo clones (via `index_repo`) |
| `~/.purecontext/config.json` | Configuration file |
| `~/.purecontext/_savings.json` | Cumulative token savings |
| `~/.purecontext/telemetry.jsonl` | Local telemetry audit log (if enabled) |
