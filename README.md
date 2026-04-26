# PureContext MCP

[![CI](https://github.com/Goran-Ocokoljic/purecontext-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Goran-Ocokoljic/purecontext-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/purecontext-mcp.svg)](https://www.npmjs.com/package/purecontext-mcp)
[![Stable](https://img.shields.io/badge/stability-stable-brightgreen.svg)](docs/API_STABILITY.md)

Token-efficient source code navigation for AI agents. Indexes TypeScript/JavaScript projects using tree-sitter AST parsing, stores structured symbol metadata in SQLite, and exposes a Model Context Protocol (MCP) server so AI agents can retrieve precisely the code they need — signatures, dependencies, and source — without reading entire files.

## What's New in 1.0

Version 1.0.0 is the first stable release. The tool API is now under semver — breaking changes require a major version bump. See [CHANGELOG.md](CHANGELOG.md) for the full history and [docs/API_STABILITY.md](docs/API_STABILITY.md) for the public API contract.

Highlights since the initial prototype:
- **16 languages** — TypeScript, JavaScript, Python, Go, Rust, Java, C/C++, C#, Swift, Kotlin, Dart, Elixir, Haskell, Scala, R, PHP, Lua, Ruby
- **20+ framework adapters** — Vue, Nuxt, React, Next.js, Angular, Express, Fastify, Django, FastAPI, Flask, Spring, and more
- **FTS5 + semantic search** — keyword search with camelCase splitting and HNSW vector index
- **Dependency graph tools** — blast radius, context bundle, dead code detection
- **Worker thread pool** — parallel parsing for 10k–50k file enterprise repos
- **Zero-build install** — prebuilt `better-sqlite3` binaries for Node 18/20/22 × Windows/macOS/Linux

---

## Quick Start

### Install and connect to Claude Code

```bash
# Add to Claude Code (uses npx to run without global install)
claude mcp add purecontext-mcp -- npx purecontext-mcp

# Or install globally first
npm install -g purecontext-mcp
claude mcp add purecontext-mcp -- purecontext-mcp
```

### Index a project

Once connected, tell Claude to index your project:

```
Index my project at /path/to/my-project using the index_folder tool
```

Then use any of the tools below to navigate it.

### Configuration (optional)

```bash
# Generate a config file with all defaults and comments
npx purecontext-mcp config --init

# Validate config and check prerequisites
npx purecontext-mcp config --check

# Show effective configuration
npx purecontext-mcp config
```

---

## Tool Reference

All tools return JSON. Responses include a `_tokenEstimate` field (where applicable) so agents can gauge context size before loading full source.

### Indexing

| Tool | Description |
|------|-------------|
| `index_folder` | Index a project directory. Discovers source files, parses symbols and imports, builds a dependency graph. Returns `repoId` and statistics. |
| `resolve_repo` | Resolve a local path to its `repoId`. Reports whether the project has been indexed and its metadata. |
| `list_repos` | List all indexed repositories with their metadata. |

### Symbol Search and Retrieval

| Tool | Description |
|------|-------------|
| `search_symbols` | Search symbols by name fragment. Filters by `kind`, `filePath`, and `limit`. Returns signatures and summaries — no source code. |
| `get_symbol_source` | Retrieve the raw source of one symbol using its byte offsets. Use after `search_symbols` to drill into a specific definition. |
| `get_file_outline` | All symbols defined in a file with signatures and summaries. Token-efficient alternative to reading the file. |
| `get_repo_outline` | All files with their top-level symbols. Useful for understanding project structure. |
| `get_file_tree` | Directory tree of an indexed project with file counts per directory. |

### Dependency Graph

| Tool | Description |
|------|-------------|
| `get_context_bundle` | Forward-walk from a symbol: returns everything needed to understand it (transitive imports). Includes token estimate. |
| `get_blast_radius` | Reverse-walk from a symbol: returns all files that (transitively) import it. Use before modifying or deleting a symbol. |
| `find_importers` | Direct importers of a file, with their symbols. |
| `find_dead_code` | Exported symbols in files that nothing else imports. Helps identify unused code. |

---

## Configuration Reference

Config file location: `~/.purecontext/config.json`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `indexDir` | `string` | `~/.purecontext/indexes/` | Where SQLite index files are stored |
| `fileLimit` | `number` | `1000` | Max files indexed per project |
| `watchDebounceMs` | `number` | `2000` | File watcher debounce window (ms) |
| `excludePatterns` | `string[]` | `[]` | Additional glob patterns to exclude |
| `adapters` | `'auto'`\|`'none'`\|`string[]` | `'auto'` | Framework adapter activation |
| `ai.provider` | `'none'`\|`'anthropic'`\|`'openai'` | `'none'` | AI summarization provider (Phase 2) |
| `ai.allowRemoteAI` | `boolean` | `false` | Allow outbound AI API calls |

---

## Architecture Overview

PureContext MCP follows a strict three-layer architecture:

```
Adapters  (src/adapters/)    Framework-specific extraction (Vue, Nuxt, React — Phase 2)
    ↓
Handlers  (src/handlers/)    Language-specific AST parsing (TypeScript, JavaScript)
    ↓
Core      (src/core/)        File discovery, SQLite storage, MCP transport
```

Dependencies flow strictly downward. Core knows nothing about specific languages or frameworks.

### Key components

- **Index Manager** (`src/core/index-manager.ts`) — orchestrates the full pipeline: discover → parse → extract → store → graph
- **Parse Dispatcher** (`src/core/parse-dispatcher.ts`) — routes files to language handlers via web-tree-sitter (WASM)
- **Graph Traversal** (`src/graph/graph-traversal.ts`) — BFS forward/reverse walks over the dependency graph
- **File Watcher** (`src/core/watcher/file-watcher.ts`) — chokidar-based incremental re-indexing on file changes
- **MCP Server** (`src/server/mcp-server.ts`) — registers all tools, handles stdio transport

For detailed design decisions and requirements, see `docs/PureContext_MCP_PRD_v1.0.docx`.

---

## Development

```bash
npm run build      # Compile TypeScript
npm run dev        # Watch mode
npm run test       # Run test suite (vitest)
npm run lint       # ESLint
```

### Requirements

- Node.js >= 18.0.0
- The `grammars/` directory must contain the bundled `.wasm` grammar files (included in the package)
