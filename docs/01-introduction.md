# Introduction


## What is PureContext MCP?

PureContext MCP is a **token-efficient source code navigation server** for AI agents. Instead of reading entire files, AI agents can retrieve exactly the symbols they need — functions, classes, methods, routes, and more — saving 90–98% of context tokens.

It implements the **Model Context Protocol (MCP)** so it works natively with Claude Code and any other MCP-compatible AI client.

## The token efficiency problem

When an AI agent wants to understand a `validateToken` function inside an 800-line file, the naive approach is to read the entire file. That costs roughly 2,000 tokens just to locate one 45-line function.

With PureContext, the agent asks for `validateToken` by name and gets back those 45 lines — roughly 150 tokens. The rest of the file is never loaded.

```
Without PureContext:  800-line file → ~2,000 tokens
With PureContext:     45-line symbol → ~150 tokens
                      Savings: 93%
```

This compounds quickly. A typical agent conversation that touches 20 symbols across 10 files saves hundreds of thousands of tokens per session.

## How PureContext solves it

PureContext builds a **structured index** of your codebase using tree-sitter AST parsing:

1. **Index** — Scan the project, parse each file with a tree-sitter grammar, extract every symbol (functions, classes, routes, components…) with its byte offsets, signature, and docstring.
2. **Store** — Write structured symbol metadata to a SQLite database. Build a dependency graph from import/require statements.
3. **Serve** — Expose MCP tools so AI agents can search by name, retrieve source, traverse dependencies, and explore the project structure — all without reading whole files.

## Key concepts

| Term | Meaning |
|------|---------|
| **repo** | An indexed project directory. Identified by a deterministic `repoId`. |
| **symbol** | A named, addressable code entity: function, class, method, route, component, etc. |
| **kind** | The category of a symbol: `function`, `class`, `method`, `route`, `component`, `hook`, and more. |
| **signature** | A one-line human-readable declaration: `function validateToken(token: string): boolean` |
| **summary** | A one-line description, sourced from docstring → framework inference → AI → signature fallback. |
| **repoId** | 16-char hex, deterministic: `SHA-256(absolutePath).slice(0, 16)` |
| **symbolId** | 16-char hex, deterministic: `SHA-256(filePath:name:kind).slice(0, 16)` |
| **dep edge** | An import relationship: file A imports file B. Used to build the dependency graph. |

## Key capabilities

- Index TypeScript, JavaScript, Python, Go, Rust, Java, C#, PHP, Ruby, Kotlin, C, C++, Lua, Dart, Swift, Elixir, Haskell, Scala, R, Bash, Terraform, Protobuf, GraphQL, and 10 more — **34 languages total**
- Framework-aware extraction: Vue, React, Nuxt, Next.js, Angular, NestJS, Express, Fastify, Django, Flask, FastAPI, Gin, Rails, Laravel, Spring Boot, and more
- Dependency graph: find what a symbol depends on (`get_context_bundle`) and what depends on it (`get_blast_radius`)
- Full-text search (FTS5) and semantic search (HNSW vector index) for finding code by name or meaning
- Web UI for visual codebase exploration — graph viewer, heatmap, symbol timeline
- Multi-tenant hosting for team deployments
- Git integration: symbol-level history, churn metrics, diff analysis
- Cross-repo search across multiple indexed projects

## Who is this for?

- **Developers using Claude Code or other AI agent locally** — index your project once, then use PureContext tools in every conversation to navigate code without burning context tokens.
- **Teams with a shared codebase** — deploy PureContext as a shared server so everyone queries the same index. No per-developer re-indexing.
- **AI application developers** — use the MCP API directly to build agents that navigate source code efficiently.

## What PureContext is not

PureContext is a navigation and indexing layer, not a general-purpose tool:

- Not a code editor or IDE
- Not a runtime debugger or test runner
- Not a full language server (no type-checking, no completions)
- Not a replacement for reading code — it makes targeted reading fast and cheap
