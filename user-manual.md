# PureContext MCP — User Manual

## Table of Contents

1. [What is PureContext MCP?](#1-what-is-purecontext-mcp)
2. [Installation](#2-installation)
3. [Connecting to Claude Code (Quick Start)](#3-connecting-to-claude-code-quick-start)
4. [Configuration](#4-configuration)
5. [CLI Commands](#5-cli-commands)
6. [MCP Tools Reference](#6-mcp-tools-reference)
7. [Language Support](#7-language-support)
8. [Framework Adapters](#8-framework-adapters)
9. [Transport Modes](#9-transport-modes)
10. [AI Summarization](#10-ai-summarization)
11. [Semantic Search (HNSW)](#11-semantic-search-hnsw)
12. [Token Savings Tracker](#12-token-savings-tracker)
13. [Multi-Tenant Hosting](#13-multi-tenant-hosting)
14. [Web UI](#14-web-ui)
15. [Security](#15-security)
16. [Architecture Overview](#16-architecture-overview)
17. [Troubleshooting](#17-troubleshooting)

---

## 1. What is PureContext MCP?

PureContext MCP is a **token-efficient source code navigation server** for AI agents. Instead of reading entire files, AI agents can retrieve exactly the symbols they need — functions, classes, methods, routes, and more — saving 90–98% of context tokens.

It implements the **Model Context Protocol (MCP)** so it works natively with Claude Code and any other MCP-compatible AI client.

**Key capabilities:**
- Index TypeScript, JavaScript, Python, Go, Rust, Java, C#, PHP, Ruby, Kotlin, C, C++, Lua, Dart, Swift, Elixir, Haskell, Scala, and R
- Framework-aware extraction: Vue, React, Nuxt, Next.js, Angular, NestJS, Express, Fastify, Django, Flask, FastAPI, Gin, Rails, Laravel, and more
- Dependency graph: find what a symbol depends on and what depends on it
- Semantic search: find symbols by meaning, not just keywords
- Web UI for visual codebase exploration
- Multi-tenant hosting for team deployments

---

## 2. Installation

### Prerequisites

- **Node.js** >= 18.0.0
- **npm** >= 9.0.0
- **Git** (required for `index_repo` to clone remote repositories)

### Install from source

```bash
git clone <repository-url> purecontext-mcp
cd purecontext-mcp
npm install
npm run build
```

### Install globally

```bash
npm install -g .
```

After this, `purecontext-mcp` is available as a command globally.

### Verify installation

```bash
purecontext-mcp config --check
```

This validates your installation and checks that all prerequisites (tree-sitter grammars, SQLite) are working.

---

## 3. Connecting to Claude Code (Quick Start)

### Step 1 — Add PureContext as an MCP server

```bash
claude mcp add purecontext-mcp npx purecontext-mcp
```

Or, if installed globally:

```bash
claude mcp add purecontext-mcp purecontext-mcp
```

### Step 2 — Index your project

In Claude Code, ask:

> "Index this project so I can search its symbols."

Claude will call the `index_folder` tool. Or explicitly:

> "Use index_folder to index /path/to/your/project."

### Step 3 — Start navigating

```
search_symbols         → find functions/classes by name
get_file_outline       → see all symbols in a file
get_symbol_source      → retrieve a symbol's source code
get_blast_radius       → see what a symbol affects
get_context_bundle     → get a symbol + everything it depends on
```

### Workflow example

```
User: "Find the authentication logic in this project."

Claude:
1. search_symbols(query: "auth", kind: "function")
   → Returns: validateToken, hashPassword, verifySession (3 matches)

2. get_symbol_source(id: "validateToken-id")
   → Returns: 45 lines of source (instead of the entire 800-line file)

Token cost: ~150 tokens instead of ~2,000 tokens → 93% savings
```

---

## 4. Configuration

The configuration file lives at `~/.purecontext/config.json`. Generate a default one with:

```bash
purecontext-mcp config --init
```

View the effective configuration with:

```bash
purecontext-mcp config
```

### Complete configuration reference

```json
{
  "indexDir": "~/.purecontext/indexes",
  "fileLimit": 1000,
  "watchDebounceMs": 2000,
  "excludePatterns": [],
  "adapters": "auto",
  "maxFileSizeBytes": 1048576,
  "allowSymlinks": false,
  "transport": "stdio",

  "ai": {
    "provider": "none",
    "allowRemoteAI": false,
    "apiKey": "",
    "endpoint": null,
    "model": "claude-haiku-4-5-20251001",
    "batchSize": 50,
    "embeddingModel": null,
    "embeddingProvider": null,
    "openaiApiKey": ""
  },

  "semantic": {
    "enabled": false,
    "provider": "none",
    "localEmbeddingEndpoint": null,
    "dimension": null,
    "threshold": 50000,
    "batchSize": 500,
    "concurrency": 2
  },

  "http": {
    "port": 3000,
    "host": "127.0.0.1",
    "corsOrigins": ["http://localhost:*"],
    "auth": {
      "enabled": false,
      "token": ""
    }
  },

  "rateLimit": {
    "enabled": true,
    "maxTokens": 100,
    "refillRate": 10,
    "perToolLimits": {
      "index_folder": 10,
      "index_repo": 10,
      "get_context_bundle": 3,
      "get_blast_radius": 3,
      "get_repo_outline": 2,
      "find_dead_code": 5
    }
  },

  "layers": {
    "definitions": [
      { "name": "core",     "paths": ["src/core/**"] },
      { "name": "handlers", "paths": ["src/handlers/**"] },
      { "name": "adapters", "paths": ["src/adapters/**"] },
      { "name": "server",   "paths": ["src/server/**"] }
    ],
    "rules": [
      { "from": "core",     "to": "handlers", "allowed": false },
      { "from": "core",     "to": "adapters", "allowed": false },
      { "from": "handlers", "to": "adapters", "allowed": false }
    ]
  }
}
```

### Key configuration options explained

| Option | Default | Description |
|--------|---------|-------------|
| `indexDir` | `~/.purecontext/indexes` | Where SQLite databases are stored |
| `fileLimit` | `1000` | Max files to index per project. Increase for large repos. |
| `watchDebounceMs` | `2000` | Delay in ms before re-indexing after file changes |
| `excludePatterns` | `[]` | Additional glob patterns to exclude (on top of built-ins like `node_modules/`, `.git/`) |
| `adapters` | `"auto"` | `"auto"` detects frameworks automatically; `"none"` disables; or `["vue", "nuxt"]` for explicit list |
| `maxFileSizeBytes` | `1048576` | Files larger than 1 MB are skipped. Increase if needed. |
| `allowSymlinks` | `false` | When false, symlinks that resolve outside the project root are blocked |
| `transport` | `"stdio"` | `"stdio"` for Claude Code; `"http"` for browser/remote; `"both"` for both simultaneously |

### Environment variable support in config

API keys can reference environment variables:

```json
{
  "ai": {
    "apiKey": "${ANTHROPIC_API_KEY}"
  }
}
```

---

## 5. CLI Commands

### Start the MCP server (default)

```bash
purecontext-mcp
```

Starts in stdio transport mode — the default for Claude Code integration.

### HTTP transport

```bash
purecontext-mcp --transport http
purecontext-mcp --transport http --port 3001
purecontext-mcp --transport both
```

CLI flags override `config.json` values.

### Configuration commands

```bash
# Generate a default config.json
purecontext-mcp config --init

# Validate config + check prerequisites
purecontext-mcp config --check

# Show effective configuration (merged with defaults)
purecontext-mcp config
```

### API key management (for hosted deployments)

```bash
# Create an API key for a tenant
purecontext-mcp keys create --tenant <tenantId> --permissions read,write

# List API keys for a tenant
purecontext-mcp keys list --tenant <tenantId>

# Revoke an API key
purecontext-mcp keys revoke <key-prefix>
```

---

## 6. MCP Tools Reference

All tools return a `_meta` envelope with:
- `timing_ms` — how long the call took
- `tokens_saved` — tokens saved vs. reading raw files (where applicable)
- `total_tokens_saved` — cumulative session total
- `cost_avoided` — estimated USD saved at current model rates
- `powered_by: "PureContext MCP"`

---

### `index_folder`

Index a local project directory.

```json
{
  "path": "/path/to/your/project",
  "fileLimit": 1000
}
```

**Returns:** `{ repoId, symbolCount, fileCount, duration, languages }`

Subsequent calls are incremental — only changed files are re-indexed. The file watcher automatically triggers re-indexing on file changes.

---

### `index_repo`

Clone and index a remote Git repository.

```json
{
  "url": "https://github.com/owner/repo",
  "branch": "main",
  "token": "ghp_...",
  "fileLimit": 5000
}
```

**Returns:** Same as `index_folder`. The clone is stored under `~/.purecontext/clones/`. Use `delete_index` to remove it.

Requires `git` on your `PATH`. Shallow clones (`--depth=1`) are used for efficiency.

---

### `list_repos`

List all indexed repositories.

```json
{}
```

**Returns:** Array of `{ repoId, rootPath, symbolCount, fileCount, languages, indexedAt }`

---

### `resolve_repo`

Get metadata for a specific repository.

```json
{
  "path": "/path/to/project"
}
```

**Returns:** Repo metadata, or a hint to call `index_folder` if not indexed.

---

### `search_symbols`

Search for symbols by name, kind, or file pattern. The primary tool for code navigation.

```json
{
  "repo": "repoId or path",
  "query": "validateToken",
  "kind": "function",
  "file": "src/auth/**",
  "limit": 20,
  "mode": "keyword"
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Name to search for (substring match) |
| `kind` | string | Filter by symbol kind (see [Symbol Kinds](#symbol-kinds)) |
| `file` | string | Glob pattern to restrict to specific files |
| `limit` | number | Max results (default 20) |
| `mode` | string | `"keyword"` (default), `"semantic"`, or `"hybrid"` |

**Returns:** Array of `{ id, name, kind, filePath, signature, summary, score }`

Does **not** return source code — use `get_symbol_source` for that.

---

### `get_symbol_source`

Retrieve the full source code of a symbol by ID.

```json
{
  "id": "abc123def456"
}
```

**Returns:** `{ symbol, source, filePath, startLine, endLine }`

Extremely token-efficient: returns only the specific symbol's bytes, not the entire file.

---

### `get_file_outline`

List all symbols in a file with signatures and summaries.

```json
{
  "repo": "repoId or path",
  "file": "src/auth/validator.ts"
}
```

**Returns:** `{ file, symbols: [{ name, kind, signature, summary, startLine }] }`

---

### `get_repo_outline`

High-level view of all files and their top-level symbols.

```json
{
  "repo": "repoId or path",
  "maxDepth": 2
}
```

**Returns:** Nested structure of directories → files → top-level symbols.

---

### `get_file_tree`

Directory structure with file counts. Useful for understanding project layout.

```json
{
  "repo": "repoId or path",
  "maxDepth": 3
}
```

**Returns:** Nested directory/file tree with symbol counts per file.

---

### `get_context_bundle`

Get a symbol plus all of its forward dependencies (what it imports/calls).

```json
{
  "repo": "repoId or path",
  "symbolId": "abc123",
  "depth": 2
}
```

**Returns:** `{ symbol, dependencies: SymbolRecord[], _tokenEstimate }`

Ideal for understanding a symbol in context without reading entire files.

---

### `get_blast_radius`

Reverse dependency analysis — find everything that depends on a symbol.

```json
{
  "repo": "repoId or path",
  "symbolId": "abc123",
  "depth": 3
}
```

**Returns:** `{ symbol, dependents: SymbolRecord[], _tokenEstimate }`

Use before changing a function to understand the impact scope.

---

### `find_importers`

Find all files that import a specific module.

```json
{
  "repo": "repoId or path",
  "file": "src/utils/auth.ts"
}
```

**Returns:** `{ importers: [{ file, symbols }] }`

---

### `find_dead_code`

Find exported symbols with zero importers — potential dead code.

```json
{
  "repo": "repoId or path"
}
```

**Returns:** `{ deadSymbols: SymbolRecord[] }`

---

### `search_text`

Full-text search across raw file content (like grep, but from the index).

```json
{
  "repo": "repoId or path",
  "query": "validateToken(",
  "is_regex": false,
  "file_pattern": "**/*.ts",
  "context_lines": 2,
  "max_results": 50
}
```

**Returns:** `{ matches: [{ file, line, column, match, context }], truncated }`

Uses cached content — no live file reads. Supports regular expressions when `is_regex: true`.

---

### `search_semantic`

Semantic (meaning-based) search using embeddings. Finds conceptually related symbols even when no literal string matches.

```json
{
  "repo": "repoId or path",
  "query": "functions that validate user credentials",
  "mode": "hybrid",
  "semantic_weight": 0.6,
  "keyword_weight": 0.4,
  "max_results": 10,
  "kind": "function"
}
```

**Returns:** `{ results: [{ ...symbol, scores: { keyword, semantic, combined } }] }`

Requires semantic search to be enabled and an embedding provider configured. Falls back to FTS keyword search if no semantic index exists.

---

### `get_layer_violations`

Analyze architectural dependency violations based on configured layer rules.

```json
{
  "repo": "repoId or path",
  "layers": [
    { "name": "core",     "paths": ["src/core/**"] },
    { "name": "handlers", "paths": ["src/handlers/**"] }
  ]
}
```

**Returns:** `{ violations: [{ from_layer, to_layer, from_file, to_file, import_spec }], summary }`

If `layers` is omitted, reads from `config.json`. Useful for enforcing clean architecture.

---

### `get_savings_stats`

View cumulative token savings across all PureContext tool calls.

```json
{
  "reset": false
}
```

**Returns:**
```json
{
  "total_tokens_saved": 123456,
  "equivalent_context_windows": { "claude_200k": 0.62, "gpt4_128k": 0.96 },
  "total_cost_avoided": {
    "claude_opus_4": 1.85,
    "claude_sonnet_4": 0.37,
    "claude_haiku_4": 0.10,
    "gpt4o": 0.31,
    "gpt4o_mini": 0.02
  }
}
```

Set `reset: true` to clear the counter.

---

### Symbol Kinds

The `kind` parameter in search accepts any of these values:

| Kind | Description |
|------|-------------|
| `function` | Standalone function / top-level def |
| `class` | Class, struct (Go/Rust), or OOP type |
| `method` | Method inside a class/struct/impl |
| `const` | Constant, exported variable, field |
| `type` | Type alias, typedef, newtype |
| `interface` | Interface or protocol |
| `enum` | Enumeration |
| `component` | UI component (Vue, React, Angular) |
| `composable` | Vue composable (`useXxx`) |
| `hook` | React hook (`useXxx`) |
| `route` | HTTP route (any framework) |
| `middleware` | Middleware or guard |
| `decorator` | Decorator / annotation |
| `model` | ORM model (Django, Rails, Laravel, Hibernate, SQLAlchemy) |
| `view` | Request handler / controller action |
| `struct` | C/C++ struct (distinct from class) |
| `macro` | C/C++ `#define` macro |
| `signal` | Django signal receiver |
| `namespace` | C++ namespace |
| `widget` | Flutter widget |

---

## 7. Language Support

PureContext supports 19 languages via tree-sitter AST parsing.

### Full symbol extraction

| Language | Extensions | Symbol Types | Doc Comments |
|----------|-----------|--------------|--------------|
| **TypeScript** | `.ts`, `.tsx`, `.mts`, `.cts` | function, class, method, const, type, interface, enum | JSDoc `/** */` |
| **JavaScript** | `.js`, `.jsx`, `.mjs`, `.cjs` | function, class, method, const | JSDoc `/** */` |
| **Python** | `.py` | function, class, method, const | Docstrings `"""` |
| **Go** | `.go` | function, method, class (struct), interface, const, type | `//` preceding comments |
| **Rust** | `.rs` | function, method, class (struct), enum, interface (trait), const, type | `///` doc comments |
| **Java** | `.java` | class, interface, enum, method, const | Javadoc `/** */` |
| **C#** | `.cs` | class, interface, enum, struct, record, method, const, property | XML docs `/// <summary>` |
| **PHP** | `.php` | function, class, interface, trait, enum, method, const | PHPDoc `/** */` |
| **Ruby** | `.rb` | function, class, method, module, const | `#` comments |
| **Kotlin** | `.kt`, `.kts` | function, class, interface, enum, method, typealias, object | KDoc `/**` |
| **C** | `.c`, `.h` | function, struct, enum, macro, type | `//` and `/* */` |
| **C++** | `.cpp`, `.cxx`, `.cc`, `.hpp`, `.hxx`, `.hh` | All C types + namespace, template | `///` Doxygen |
| **Lua** | `.lua` | function, method, const | `--` comments |
| **Dart** | `.dart` | class, mixin, extension, enum, function, method, const, type | `///` doc comments |
| **Swift** | `.swift` | class, struct, protocol, actor, extension, method, enum, type | `///` DocC |
| **Elixir** | `.ex`, `.exs` | module (class), function, macro, struct, protocol | `@doc` attribute |
| **Haskell** | `.hs`, `.lhs` | function, data (class), typeclass (interface), instance, type, newtype | Haddock `-- \|` |
| **Scala** | `.scala`, `.sc` | class, trait, object, case class, function, method, type, enum | Scaladoc `/** */` |
| **R** | `.r`, `.R`, `.Rmd` | function, const, S3/S4/R6 class | Roxygen2 `#'` |

### What gets indexed

- **All non-private symbols** by default (exact visibility rules vary by language)
- **Byte offsets** for precise source retrieval
- **Import/dependency edges** for the dependency graph
- **Docstrings** as symbol summaries (stage 1 of the summarizer pipeline)

### What is excluded automatically

- `node_modules/`, `.git/`, `dist/`, `build/`, `.claude/`
- `*.lock` files, `.env*` files
- Binary files (detected by null-byte scanning)
- Files > 1 MB (configurable)
- Secret files: `*.pem`, `*.key`, `id_rsa`, `credentials.json`, etc.
- `private` methods in Java, C#, PHP (language-specific visibility rules)
- Unexported symbols in Go (lowercase names)
- `static` functions in C (translation-unit internal)
- Private (`_`-prefixed) symbols in Dart

---

## 8. Framework Adapters

Framework adapters run on top of language handlers and extract framework-specific metadata. They are auto-detected from project config files.

### JavaScript / TypeScript Frameworks

#### Vue 3
**Detected by:** `vue` in `package.json`, or any `.vue` files present.

Extracts from `.vue` Single File Components:
- `component` — the component itself (from filename or `defineComponent`)
- `composable` — exported `use*` functions

`frameworkMeta` includes: `vue_component`, `vue_composable`.

#### Nuxt
**Detected by:** `nuxt.config.ts` (or `.js`/`.mts`/`.mjs`) in project root.

Extracts:
- `route` from `pages/**/*.vue` (with derived route path like `/blog/:slug`)
- `route` from `server/api/**/*.ts` (with HTTP method from filename suffix)
- `middleware` from `plugins/**` and `middleware/**`
- Enriches composables in `composables/**` with `nuxt_auto_import: true`

#### React
**Detected by:** `react` in `package.json` dependencies.

Enriches TypeScript handler symbols:
- PascalCase functions returning JSX → `component`
- `use*` functions → `hook`

#### Next.js
**Detected by:** `next.config.*` or `next` in `package.json`.

Extracts:
- **Pages Router** (`pages/**`): `route` symbols with path derivation
  - `pages/blog/[slug].tsx` → `/blog/:slug`
  - Detects `getServerSideProps` (SSR), `getStaticProps` (SSG)
- **App Router** (`app/**/page.tsx`): `route` symbols
  - `app/(marketing)/about/page.tsx` → `/about` (route groups stripped)
  - Detects `'use client'` directive
- **API routes**: `pages/api/**` and `app/**/route.ts` (with HTTP method exports)
- **Middleware** (`middleware.ts`): `middleware` symbol with matcher

#### Angular
**Detected by:** `@angular/core` in `package.json`.

Extracts from decorated classes:
- `@Component` → `component` (with `selector`)
- `@Injectable` → `class` (service)
- `@NgModule` → `class` (module)
- `@Directive` → `component` (with `selector`)
- `@Pipe` → `component` (with pipe name)
- `RouterModule.forRoot/forChild` → `route` symbols

#### NestJS
**Detected by:** `@nestjs/core` in `package.json`.

Extracts from decorated controllers:
- `@Controller('prefix')` + `@Get(':id')` → `route` with combined path (`GET /prefix/:id`)
- `@Injectable` → `class` with `nestjs_provider: true`
- `@Module` → `class` with `nestjs_module: true`
- `@Guard` / `CanActivate` → `middleware`

#### Express
**Detected by:** `express` in `package.json`.

Extracts string-literal route registrations:
- `app.get('/path', ...)` → `route`
- `router.post('/path', ...)` → `route`
- `app.use('/path', ...)` → `middleware`

Dynamic paths (variables, template literals) are skipped.

#### Fastify
**Detected by:** `fastify` in `package.json`.

Same pattern as Express: `fastify.get(path, ...)` → `route`.

---

### Python Frameworks

#### Flask
**Detected by:** `Flask` in `requirements.txt` or `pyproject.toml`.

Extracts:
- `@app.route('/path')` → `route`
- `@app.get('/path')`, `@app.post(...)` → `route`
- Blueprint routes: `@bp.route(...)` → `route`
- Class-based views (inheriting `MethodView`) → `view`

Flask path parameters (`<int:user_id>`) are preserved as-is.

#### FastAPI
**Detected by:** `fastapi` in `requirements.txt` or `pyproject.toml`.

Extracts:
- `@app.get('/items/{id}')` → `route`
- `@router.post(...)` (APIRouter) → `route`

FastAPI path parameters (`{param}`) are preserved as-is.

#### Django
**Detected by:** `manage.py` at project root, or `django` in requirements.

Extracts:
- `models.Model` subclasses → `model`
- Class-based views (`APIView`, `ViewSet`, etc.) → `view`
- Function-based views (with `@login_required`, `@api_view`) → `view`
- `path(...)` / `re_path(...)` in `urls.py` → `route`
- `@receiver(post_save)` → `signal`

---

### Go Frameworks

#### Gin
**Detected by:** `github.com/gin-gonic/gin` in `go.mod`.

Extracts: `r.GET("/path", handler)`, `r.POST(...)`, etc. → `route`
Groups: `r.Group("/api")` prefix applied to child routes.

#### Echo
**Detected by:** `github.com/labstack/echo` in `go.mod`.

Same pattern as Gin: `e.GET("/path", handler)` → `route`.

#### Fiber
**Detected by:** `github.com/gofiber/fiber` in `go.mod`.

Uses title-case methods: `app.Get("/path", handler)` → `route`.

---

### PHP Frameworks

#### Laravel
**Detected by:** `laravel/framework` in `composer.json`.

Extracts:
- `Route::get('/path', ...)` → `route`
- `Route::resource('users', Controller::class)` → multiple CRUD routes
- `Route::group(['prefix' => '/api'], ...)` → prefix applied to children
- `User extends Model` → `model`
- Controller public methods → `view`
- Middleware classes → `middleware`

#### Symfony
**Detected by:** `symfony/framework-bundle` in `composer.json`.

Extracts:
- `#[Route('/path', methods: ['GET'])]` → `route` (PHP 8 attributes)
- `@Route('/path')` in docblock → `route` (annotation style)
- `#[AsController]` or `AbstractController` subclasses → controller

---

### Ruby Frameworks

#### Rails
**Detected by:** `gem 'rails'` in `Gemfile`.

Extracts:
- `ApplicationRecord` subclasses → `model` (with `has_many` associations)
- `ApplicationController` subclasses → `class` (controller)
- Controller public methods → `view` (action)
- `get '/path'`, `resources :users` in `routes.rb` → `route`

#### Sinatra
**Detected by:** `gem 'sinatra'` in `Gemfile` or `require 'sinatra'` in source.

Extracts: `get '/path' do ... end` → `route`

---

### Kotlin Frameworks

#### Ktor
**Detected by:** `io.ktor` in `build.gradle` / `pom.xml`.

Extracts from routing DSL:
- `get("/path") { ... }` → `route`
- `route("/api") { get("/users") }` → combined path `/api/users`
- `authenticate { ... }` → `frameworkMeta.authenticated: true`

#### Spring (Kotlin)
**Detected by:** `org.springframework.boot` in `build.gradle` / `pom.xml`.

Extracts:
- `@RestController` + `@GetMapping("/path")` → `route`
- `@Service`, `@Component`, `@Repository` → class with metadata

---

### Rust Frameworks

#### Axum
**Detected by:** `axum` in `Cargo.toml` dependencies.

Extracts: `.route("/path", get(handler))` chains → `route`
Layers: `.layer(...)` → `middleware`

#### Actix-web
**Detected by:** `actix-web` in `Cargo.toml`.

Extracts:
- `#[get("/path")]` attribute macro → `route`
- `web::resource("/path").route(web::get().to(handler))` → `route`
- `.wrap(...)` → `middleware`

#### Rocket
**Detected by:** `rocket` in `Cargo.toml`.

Extracts:
- `#[get("/path")]` → `route`
- `#[catch(404)]` → error catcher
- `Fairing` implementations → `middleware`

---

### Java Frameworks

#### Spring Boot
**Detected by:** `spring-boot-starter` in `pom.xml` / `build.gradle`.

Extracts:
- `@GetMapping`, `@PostMapping`, etc. (combined with `@RequestMapping` prefix) → `route`
- `@Service`, `@Component`, `@Repository` → bean classes
- `@Bean` methods → bean symbols
- `@Scheduled` methods → scheduled tasks

#### Micronaut
**Detected by:** `io.micronaut` in build files.

Extracts: `@Get("/path")`, `@Post(...)` → `route`; `@Client` interfaces → `interface`.

#### Quarkus
**Detected by:** `io.quarkus` in build files.

Extracts: JAX-RS `@GET` / `@Path` → `route`; `@ApplicationScoped` → bean.

---

### ORM Adapters

#### Hibernate (Java)
**Detected by:** `hibernate-core` or `jakarta.persistence` in dependencies.

Extracts from `@Entity` classes:
- Table name (from `@Table(name = "...")` or class name)
- Columns with types and nullability
- Relationships (`@OneToMany`, `@ManyToOne`, etc.)
- Named queries (`@NamedQuery`)

#### SQLAlchemy (Python)
**Detected by:** `sqlalchemy` in requirements.

Extracts from `Base` / `DeclarativeBase` subclasses:
- `__tablename__` attribute
- `Column(Type)` fields with types and constraints
- `relationship()` associations
- `@hybrid_property` methods

Supports both SQLAlchemy 1.x and 2.0 (`mapped_column`) styles.

#### Django ORM
**Detected by:** Django project with `manage.py`.

Extracts from `models.py` files:
- `models.Model` subclasses with table names
- Field types: `CharField`, `IntegerField`, `ForeignKey`, `ManyToManyField`, etc.
- `on_delete` constraint metadata
- Custom managers

---

### Mobile Frameworks

#### Flutter
**Detected by:** `sdk: flutter` in `pubspec.yaml`.

Extracts from `.dart` files:
- `StatelessWidget` subclasses → `widget` (with `flutter_widget_type: 'stateless'`)
- `StatefulWidget` subclasses → `widget` (with linked State class)
- `ChangeNotifier` subclasses → `class` (with `flutter_notifier: true`)

Test files (`*_test.dart`) are excluded from widget extraction.

---

## 9. Transport Modes

### stdio (default)

The standard transport for Claude Code and other MCP-native clients.

```bash
purecontext-mcp
```

No network exposure. Communication happens via stdin/stdout.

**Claude Code configuration:**
```bash
claude mcp add purecontext-mcp purecontext-mcp
```

### HTTP / Streamable HTTP

For browser-based clients, remote development, or multi-client setups.

```bash
purecontext-mcp --transport http --port 3000
```

```json
// config.json
{
  "transport": "http",
  "http": {
    "port": 3000,
    "host": "127.0.0.1",
    "corsOrigins": ["http://localhost:*"]
  }
}
```

**Endpoints:**
- `GET /health` — Server health check (always public)
- `GET /sse` — MCP SSE stream
- `POST /message` — MCP message handler
- `GET /` — Web UI (when built)

**Claude Code + HTTP:**
Add to your Claude Code MCP config:
```json
{
  "mcpServers": {
    "purecontext": {
      "transport": "http",
      "url": "http://localhost:3000/sse"
    }
  }
}
```

### Both (development mode)

Runs stdio and HTTP simultaneously:

```bash
purecontext-mcp --transport both
```

### HTTP Authentication

When deploying on a non-loopback address, enable bearer token authentication:

```json
{
  "http": {
    "host": "0.0.0.0",
    "auth": {
      "enabled": true,
      "token": "${PURECONTEXT_API_TOKEN}"
    }
  }
}
```

If `token` is empty with `enabled: true`, a random 32-byte hex token is generated at startup and printed to stderr. Save it.

All MCP requests must include: `Authorization: Bearer <token>`

---

## 10. AI Summarization

PureContext can generate natural-language summaries for symbols that have no docstring, using a multi-stage fallback:

1. **Stage 1** — Docstring (JSDoc, Python docstring, `///`, `@doc`, etc.)
2. **Stage 2** — Framework-derived: `"Vue component UserCard"`, `"GET /api/users server route"`
3. **Stage 3** — AI batch summarization (optional, requires config)
4. **Stage 4** — Signature fallback: `"function validateToken(token: string): boolean"`

### Enable AI summarization

**Using Anthropic (Claude Haiku):**

```json
{
  "ai": {
    "provider": "anthropic",
    "allowRemoteAI": true,
    "apiKey": "${ANTHROPIC_API_KEY}",
    "model": "claude-haiku-4-5-20251001",
    "batchSize": 50
  }
}
```

**Using a local Ollama model:**

```json
{
  "ai": {
    "provider": "openai-compatible",
    "allowRemoteAI": true,
    "endpoint": "http://localhost:11434",
    "model": "llama3.2",
    "batchSize": 10
  }
}
```

AI summarization is **always optional**. With `allowRemoteAI: false` (the default), no network calls are made and all tests pass.

Summaries are generated post-indexing in batches. On incremental re-index, changed symbols get their summaries refreshed.

---

## 11. Semantic Search (HNSW)

Semantic search uses embedding vectors and HNSW (Hierarchical Navigable Small Worlds) indexing to find symbols by meaning, not just keywords.

**When is it active?**
- `semantic.enabled: true` in config
- Repository has more than `semantic.threshold` symbols (default: 50,000)
- An embedding provider is configured

**Below the threshold**, all search uses SQLite FTS5 keyword search.

### Enable semantic search

**Using OpenAI embeddings:**

```json
{
  "semantic": {
    "enabled": true,
    "provider": "openai",
    "threshold": 50000
  },
  "ai": {
    "openaiApiKey": "${OPENAI_API_KEY}"
  }
}
```

**Using local Ollama embeddings:**

```json
{
  "semantic": {
    "enabled": true,
    "provider": "local",
    "localEmbeddingEndpoint": "http://localhost:11434",
    "threshold": 1000
  }
}
```

Set `threshold` low (e.g., 100) to test on small repos.

### Using semantic search

Via `search_semantic` tool:

```json
{
  "repo": "my-project",
  "query": "functions that validate user credentials",
  "mode": "hybrid",
  "semantic_weight": 0.6,
  "keyword_weight": 0.4
}
```

Via `search_symbols` tool (automatic hybrid mode when index exists):

```json
{
  "repo": "my-project",
  "query": "auth validate",
  "mode": "hybrid"
}
```

### How hybrid search works

1. Run FTS keyword search → top N results
2. Embed the query → run HNSW vector search → top N results
3. Merge using Reciprocal Rank Fusion (RRF):
   `score = keywordWeight × (1/(60+rank)) + semanticWeight × (1/(60+rank))`
4. Return top results sorted by combined score

### Performance

- HNSW search: < 10ms for k=10 in a 100k vector index
- Embedding generation: batched, ~50ms per symbol
- Indexes are persisted to `~/.purecontext/indexes/{repoId}/hnsw.idx`

---

## 12. Token Savings Tracker

Every retrieval tool call automatically tracks how many tokens were saved compared to reading full files.

### How savings are calculated

```
tokens_saved = max(0, (rawFileBytes - responseBytes) / 4)
```

The `4 bytes/token` ratio is the cl100k_base encoding approximation.

### Viewing savings

Use the `get_savings_stats` tool:

```json
{}
```

```json
{
  "total_tokens_saved": 1234567,
  "equivalent_context_windows": {
    "claude_200k": 6.17,
    "gpt4_128k": 9.64
  },
  "total_cost_avoided": {
    "claude_opus_4": 18.52,
    "claude_sonnet_4": 3.70,
    "claude_haiku_4": 0.99,
    "gpt4o": 3.09,
    "gpt4o_mini": 0.19
  }
}
```

Savings are included in the `_meta` field of every retrieval tool response:

```json
{
  "symbol": { ... },
  "source": "...",
  "_meta": {
    "timing_ms": 3,
    "tokens_saved": 1842,
    "total_tokens_saved": 45231,
    "cost_avoided": { "claude_opus_4": 0.028 },
    "powered_by": "PureContext MCP"
  }
}
```

Savings persist to `~/.purecontext/_savings.json` across sessions. Reset with `get_savings_stats(reset: true)`.

---

## 13. Multi-Tenant Hosting

PureContext supports hosting as a shared service for teams or organizations.

### Rate Limiting

Enabled automatically when using HTTP transport. Uses a token bucket algorithm:
- Each client gets a bucket with capacity `maxTokens` (default 100)
- Tokens refill at `refillRate` per second (default 10)
- Expensive operations cost more tokens (indexing costs 10 tokens by default)

When rate limited, responses return `429 Too Many Requests` with a `Retry-After` header.

Configure in `config.json`:

```json
{
  "rateLimit": {
    "enabled": true,
    "maxTokens": 100,
    "refillRate": 10,
    "perToolLimits": {
      "index_folder": 10,
      "search_symbols": 1
    }
  }
}
```

### API Key Authentication

Create and manage API keys for tenant identification:

```bash
# Create a key
purecontext-mcp keys create --tenant myorg --permissions read,write

# Output: cl_live_a1b2c3d4_<random>_<checksum>
# Save this — it's shown only once

# List keys
purecontext-mcp keys list --tenant myorg

# Revoke a key
purecontext-mcp keys revoke cl_live_a1b2c3
```

**Key format:** `cl_live_{tenantId}_{24-char-random}_{checksum}`

Keys include a checksum for fast format validation without a database hit. Raw keys are never stored — only SHA-256 hashes.

**Permissions:**
- `read` — query tools (search, retrieval)
- `write` — indexing tools (index_folder, index_repo)
- `admin` — tenant management, stats

### Tenant Data Isolation

When running multi-tenant:
- Each tenant's repositories, symbols, and embeddings are isolated
- Queries across tenants are prevented at the data layer
- Separate HNSW indexes per tenant
- Storage quotas per tenant

### Admin API

Accessible at `http://localhost:3000/admin/*` with `admin` permission:

| Endpoint | Description |
|----------|-------------|
| `GET /admin/stats` | Server-wide statistics |
| `POST /admin/tenants` | Create a tenant |
| `GET /admin/tenants` | List all tenants |
| `GET /admin/tenants/:id/stats` | Tenant-specific stats |
| `DELETE /admin/tenants/:id` | Delete tenant and all data |
| `POST /admin/tenants/:id/keys` | Create API key for tenant |

---

## 14. Web UI

A browser-based interface for visual codebase exploration. Served at `http://localhost:3000` when HTTP transport is active.

### Building the UI

```bash
npm run build:ui
```

Or include it in the full build:

```bash
npm run build
```

### Features

#### Repository Browser
- List all indexed repositories with symbol counts and languages
- Collapsible file tree with file type icons
- File outline: all symbols in a file, grouped by kind

#### Symbol Search
- Real-time search with 300ms debounce
- Filter by: kind, language, file pattern
- Keyboard navigation (arrow keys + Enter)
- Term highlighting in results

#### Symbol Source Viewer
- Syntax-highlighted source code (via Shiki — VS Code accuracy)
- Line numbers with anchors
- Light/dark theme toggle (persisted in localStorage)
- Related symbols panel: importers, dependencies, same-file symbols

#### Dependency Graph
- Interactive force-directed graph of file/symbol dependencies
- Pan, zoom, fit-to-view controls
- Layout options: force-directed, hierarchical, radial
- Depth slider (1-hop to N-hop)
- Powered by React Flow + D3

#### Blast Radius Visualization
- Radial layout: affected symbols radiate from the source
- Color gradient: red (direct impact) → yellow (indirect)
- Impact statistics: files affected, symbols affected
- Toggle between graph and list view

### Development mode

```bash
npm run dev
```

Runs TypeScript compiler in watch mode alongside Vite dev server with hot reload.

---

## 15. Security

### Path Traversal Prevention

All file paths are validated before reading:
- Resolved to absolute paths
- Verified to start within the project root
- Symlinks that escape the root are blocked (unless `allowSymlinks: true`)

### Secret File Exclusion

The following files are automatically excluded from indexing:
- `.env`, `.env.*`, `.env.local`, `.env.production`
- `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.crt`, `*.cer`
- `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`
- `credentials.json`, `credentials.yaml`, `secrets.json`
- `serviceAccountKey*.json`, `*-service-account.json`
- `*.token`, `*.secret`

### Binary File Detection

Files with null bytes in the first 8 KB are treated as binary and skipped.

### HTTP Security

- Default host: `127.0.0.1` (loopback only) — not exposed on the network
- Warning logged if `host` is not loopback and `auth.enabled` is false
- Token comparison uses `crypto.timingSafeEqual()` (timing-attack resistant)
- Request bodies limited to 1 MB
- CORS origins whitelist-controlled

### Remote Repository Cloning

- Only `https://`, `http://`, and `git@` URL schemes are accepted
- Clone tokens are never logged
- Clones are isolated under `~/.purecontext/clones/`

---

## 16. Architecture Overview

PureContext uses a strict three-layer architecture:

```
Adapters → Handlers → Core
```

- **Core** (`src/core/`) — File discovery, hashing, tree-sitter dispatch, SQLite storage, MCP transport, file watcher. Language-agnostic.
- **Handlers** (`src/handlers/`) — One handler per language. Implements `LanguageHandler`: parse with tree-sitter, extract symbols and imports.
- **Adapters** (`src/adapters/`) — One adapter per framework. Implements `FrameworkAdapter`: auto-detect from project files, extract framework-specific symbols, enrich metadata.

The dependency graph, semantic indexer, summarizer, and MCP server all build on Core without violating the layer boundary. Use `get_layer_violations` to verify your own projects follow similar rules.

### Data flow

```
index_folder(path)
  → FileDiscovery (scan, priority order, exclude patterns, secret detection)
  → HashCache (skip unchanged files)
  → LanguageHandler.parseFile(buffer) → AST
  → LanguageHandler.extractSymbols(AST) → SymbolRecord[]
  → LanguageHandler.extractImports(AST) → ImportRecord[]
  → FrameworkAdapter.extractFrameworkSymbols(AST) → SymbolRecord[]
  → FrameworkAdapter.enrichMetadata(symbol) → SymbolRecord
  → Summarizer (docstring → framework-derived → AI → signature)
  → SymbolStore.insertSymbols(batch) → SQLite
  → PathResolver.resolve(imports) → DepEdge[]
  → DepStore.insertEdges(batch) → SQLite
  → SemanticIndexer.index(symbols) → HNSW (if enabled)
```

### Storage locations

| Path | Contents |
|------|----------|
| `~/.purecontext/indexes/` | SQLite databases (one per project) |
| `~/.purecontext/indexes/{repoId}/hnsw.idx` | HNSW vector index |
| `~/.purecontext/clones/` | Remote repo clones |
| `~/.purecontext/config.json` | Configuration file |
| `~/.purecontext/_savings.json` | Cumulative token savings |

---

## 17. Troubleshooting

### "Repo not indexed" error

The repository has not been indexed yet. Call `index_folder` first.

### Incremental re-index not triggered

The file watcher has a 2-second debounce. For manual force re-index: call `index_folder` again — it skips unchanged files using content hashing.

### Missing symbols after indexing

Check if the file is excluded:
1. File may be in `node_modules/`, `dist/`, or another built-in exclusion
2. File may match a `excludePatterns` glob
3. File may exceed `maxFileSizeBytes`
4. File may be a secret file (matched by security patterns)
5. For some languages: private symbols are skipped by design (e.g., Go unexported, C static functions)

### Adapter not activating

Run `purecontext-mcp config --check` and look at the detected adapters. Adapter detection:
- Vue: requires `vue` in `package.json`
- Nuxt: requires `nuxt.config.ts`
- Django: requires `manage.py` at project root
- Gin: requires `github.com/gin-gonic/gin` in `go.mod`

Force a specific adapter by setting `adapters` in config:
```json
{ "adapters": ["vue", "nuxt"] }
```

### HTTP transport not accessible from browser

1. Check `http.host` — default is `127.0.0.1` (loopback). Set to `0.0.0.0` for network access.
2. Check `http.corsOrigins` — must include the browser's origin.
3. Check `http.auth` — if enabled, all requests need `Authorization: Bearer <token>`.

### Semantic search not working

1. Verify `semantic.enabled: true` in config
2. Verify a provider is configured (`semantic.provider`)
3. Check if the repo meets the threshold: `semantic.threshold` (default 50,000 symbols — lower it for small repos)
4. Check API key environment variables

### Config validation errors

```bash
purecontext-mcp config --check
```

This validates `~/.purecontext/config.json` and reports any schema errors.

### Performance — indexing is slow

- Increase `fileLimit` if you want more files indexed
- The first index is always slower; subsequent runs are incremental
- AI summarization (`allowRemoteAI: true`) adds network latency
- Semantic indexing also adds API call time

### "git not found" when using index_repo

Install Git and ensure it is on `PATH`. Verify with `git --version`.

---

## Quick Reference Card

```
# Install
npm install -g .

# Connect to Claude Code
claude mcp add purecontext-mcp purecontext-mcp

# Generate config
purecontext-mcp config --init

# Start HTTP server with Web UI
purecontext-mcp --transport http --port 3000

# In Claude Code — typical workflow
index_folder       → index a project
search_symbols     → find code by name or kind
get_file_outline   → see all symbols in a file
get_symbol_source  → retrieve a symbol's source
get_context_bundle → symbol + what it depends on
get_blast_radius   → symbol + what depends on it
search_text        → grep-style text search
search_semantic    → meaning-based search
find_dead_code     → unused exports
get_layer_violations → architecture rule checking
get_savings_stats  → view token savings
```
