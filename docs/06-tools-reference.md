# MCP Tools Reference


All tools return JSON. Most responses include a `_tokenEstimate` field so agents can gauge context size before loading full source. Every retrieval tool also includes a `_meta` envelope with timing and token savings.

```json
"_meta": {
  "timing_ms": 3,
  "tokens_saved": 1842,
  "total_tokens_saved": 45231,
  "cost_avoided": { "claude_opus_4": 0.028 },
  "powered_by": "PureContext MCP"
}
```

---

## Indexing

### `index_folder`

Index a local project directory.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | yes | Absolute path to the project root |
| `fileLimit` | `number` | no | Override config `fileLimit` for this run |
| `force` | `boolean` | no | Re-index even unchanged files (default: `false`) |

**Returns:** `{ repoId, filesIndexed, symbolsExtracted, durationMs, languages, adapters }`

Subsequent calls are incremental — only changed files (by content hash) are re-parsed. The file watcher also triggers incremental re-indexing automatically on file changes.

---

### `index_repo`

Clone and index a remote Git repository.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | `string` | yes | Repository URL (`https://`, `http://`, or `git@`) |
| `branch` | `string` | no | Branch to clone (default: default branch) |
| `token` | `string` | no | Personal access token for private repos |
| `fileLimit` | `number` | no | Max files to index |

**Returns:** Same as `index_folder`. Clones are stored at `~/.purecontext/clones/`.

---

### `resolve_repo`

Resolve a local path to its `repoId` and check if it is indexed.

**Parameters:** `{ path: string }`

**Returns:** `{ repoId, indexed, lastIndexed, filesIndexed, symbolCount }`

---

### `list_repos`

List all indexed repositories.

**Parameters:** `{}`

**Returns:** `{ repos: [{ repoId, path, filesIndexed, lastIndexed, languages }] }`

---

### `invalidate_cache`

Force a full re-index of a repo or a single file, clearing all content hashes.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Repository to invalidate |
| `filePath` | `string` | no | If given, invalidate only this file (relative path) |

**Returns:** `{ invalidated: number }` — number of files whose cache was cleared.

---

## Symbol Search & Retrieval

### `search_symbols`

Search symbols by name fragment. The primary navigation tool.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Target repository |
| `query` | `string` | yes | Name fragment or FTS5 query |
| `kind` | `string` | no | Filter by symbol kind (see [Symbol Kinds](#symbol-kinds)) |
| `filePath` | `string` | no | Filter to a specific file |
| `limit` | `number` | no | Max results (default: 20) |
| `mode` | `string` | no | `"keyword"` (default), `"semantic"`, or `"hybrid"` |
| `debug` | `boolean` | no | Include relevance scoring breakdown in response |
| `includeRisk` | `boolean` | no | Attach a compact `{ band, riskScore }` to each result (default `false`; see [`get_symbol_risk`](#get_symbol_risk)) |

**Returns:** `{ symbols: SymbolSummary[], _tokenEstimate }`

Does **not** return source code — use `get_symbol_source` for that.

---

### `search_text`

Full-text search across cached file content (grep-like).

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Target repository |
| `query` | `string` | yes | Search term or regex |
| `is_regex` | `boolean` | no | Treat query as a regular expression (default: `false`) |
| `file_pattern` | `string` | no | Glob pattern to restrict to specific files |
| `context_lines` | `number` | no | Lines of context around each match (default: 2) |
| `max_results` | `number` | no | Max matches (default: 50) |
| `debug` | `boolean` | no | Include relevance scoring breakdown |

**Returns:** `{ matches: [{ file, line, column, match, context }], truncated }`

---

### `search_semantic`

Semantic (meaning-based) search using HNSW vector index.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Target repository |
| `query` | `string` | yes | Natural language description |
| `mode` | `string` | no | `"semantic"` (default) or `"hybrid"` |
| `semantic_weight` | `number` | no | Weight for semantic score in hybrid mode (default: 0.6) |
| `keyword_weight` | `number` | no | Weight for keyword score in hybrid mode (default: 0.4) |
| `max_results` | `number` | no | Max results (default: 10) |
| `kind` | `string` | no | Filter by symbol kind |

**Returns:** `{ results: [{ ...symbol, scores: { keyword, semantic, combined } }] }`

Requires semantic search enabled and an embedding provider configured. Falls back to FTS5 when no HNSW index exists.

---

### `get_symbol_source`

Retrieve the raw source code of a symbol.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Target repository |
| `symbolId` | `string` | yes | Symbol ID from `search_symbols` |
| `context_lines` | `number` | no | Extra lines of context above/below (default: 0) |
| `verify` | `boolean` | no | Re-read file from disk to verify source hasn't changed |
| `includeRisk` | `boolean` | no | Attach a compact `{ band, riskScore }` to the symbol (default `false`; see [`get_symbol_risk`](#get_symbol_risk)) |

**Returns:** `{ source, filePath, startByte, endByte, startLine, endLine, _tokenEstimate }`

---

### `get_symbols`

Batch-fetch multiple symbols by ID.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Target repository |
| `symbolIds` | `string[]` | yes | Array of symbol IDs |

**Returns:** `{ symbols: [{ ...symbolSummary, source }] }`

---

### `get_file_content`

Retrieve raw cached file content, with optional line range.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Target repository |
| `filePath` | `string` | yes | Relative file path |
| `startLine` | `number` | no | Start line (1-based, default: 1) |
| `endLine` | `number` | no | End line (inclusive, default: end of file) |

**Returns:** `{ content, filePath, startLine, endLine, totalLines, _tokenEstimate }`

---

### `get_file_outline`

All symbols in a file with signatures and summaries.

**Parameters:** `{ repoId, filePath }`

**Returns:** `{ filePath, symbols: SymbolSummary[], _tokenEstimate }`

---

### `get_repo_outline`

All files with their top-level symbols — a project map.

**Parameters:** `{ repoId, limit? }` (default limit: 100 files)

**Returns:** `{ files: [{ filePath, symbols: SymbolSummary[] }], _tokenEstimate }`

---

### `get_file_tree`

Directory tree with file counts per directory.

**Parameters:** `{ repoId, maxDepth? }` (default maxDepth: 5)

**Returns:** Nested `{ name, type: 'dir'|'file', children?, symbolCount? }`

---

### `find_references`

Find all usage sites (call sites, references) for a symbol across the repo.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Target repository |
| `symbolId` | `string` | yes | Symbol to find references for |
| `limit` | `number` | no | Max results (default: 50) |

**Returns:** `{ references: [{ filePath, line, column, snippet }], count }`

---

## Dependency Graph

### `get_context_bundle`

Forward-walk from a symbol — returns everything needed to understand it (transitive imports).

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Target repository |
| `symbolId` | `string` | yes | Starting symbol |
| `maxDepth` | `number` | no | Max traversal depth (default: 3) |
| `maxTokens` | `number` | no | Stop collecting when estimate exceeds this |

**Returns:** `{ symbols: SymbolSummary[], files: string[], _tokenEstimate }`

When git co-change data exists (`git.coChangeDepth > 0`), the response also includes `historicalNeighbors` — files that historically change together with the target but are not reachable through imports, each with a small outline. Absent (and output byte-identical to before) when there is no co-change data.

---

### `get_blast_radius`

Reverse-walk — all files that (transitively) import a symbol. Use before modifying or deleting a symbol.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Target repository |
| `symbolId` | `string` | yes | Starting symbol |
| `maxDepth` | `number` | no | Max traversal depth (default: 5) |

**Returns:** `{ importers: string[], count, _tokenEstimate }`

---

### `find_importers`

Direct (one-hop) importers of a file.

**Parameters:** `{ repoId, filePath }`

**Returns:** `{ importers: [{ filePath, importedNames: string[] }], _tokenEstimate }`

---

### `find_dead_code`

Exported symbols in files that nothing else imports.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Target repository |
| `limit` | `number` | no | Max results (default: 50) |

**Returns:** `{ symbols: SymbolSummary[], _tokenEstimate }`

**Note:** May produce false positives for: dynamic imports, side-effect imports, symbols used by external packages (npm consumers).

---

### `get_layer_violations`

Detect architectural import boundary violations.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Target repository |
| `layers` | `LayerDef[]` | no | Layer definitions (reads from config if omitted) |

**Returns:** `{ violations: [{ from_layer, to_layer, from_file, to_file, import_spec }], summary }`

---

## Token Savings

### `get_savings_stats`

View cumulative token savings across all PureContext tool calls.

**Parameters:** `{ reset?: boolean }` — set `reset: true` to clear counters.

**Returns:**

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

---

## Cross-Repo Tools

### `search_cross_repo`

Search symbols across multiple indexed repositories simultaneously.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | yes | Name fragment |
| `repoIds` | `string[]` | no | Repos to search (default: all in workspace) |
| `kind` | `string` | no | Symbol kind filter |
| `limit` | `number` | no | Max results (default: 20) |

**Returns:** `{ symbols: [{ ...symbolSummary, repoId }] }`

---

### `find_similar`

Find semantically similar code across repos.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbolId` | `string` | yes | Reference symbol |
| `repoId` | `string` | yes | Repo of the reference symbol |
| `searchRepoIds` | `string[]` | no | Repos to search (default: all) |
| `minSimilarity` | `number` | no | Minimum cosine similarity 0–1 (default: 0.8) |
| `limit` | `number` | no | Max results (default: 10) |

**Returns:** `{ similar: [{ ...symbolSummary, repoId, similarity }] }`

Requires semantic search enabled.

---

## Git & History Tools

### `get_symbol_history`

Symbol-level git commit history.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Target repository |
| `symbolId` | `string` | yes | Symbol to get history for |
| `limit` | `number` | no | Max commits (default: 20) |

**Returns:** `{ history: [{ hash, author, date, message, diff }] }`

---

### `get_churn_metrics`

File or symbol churn metrics.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Target repository |
| `filePath` | `string` | no | Scope to a single file |
| `since` | `string` | no | ISO 8601 date — look back from this date |

**Returns:** `{ files: [{ filePath, commits, linesChanged, authors, churnScore }] }`

---

### `get_co_change`

Temporal coupling — files that historically change together with a target file or symbol, derived from the repo-level commit capture. Reveals coupling the import graph cannot (a route and its test; a feature flag and the code it gates). Requires `git.coChangeDepth > 0` at index time.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Target repository |
| `filePath` | `string` | no | Target file path (provide this **or** `symbolId`) |
| `symbolId` | `string` | no | Target symbol — resolved to its containing file (git is file-granular) |
| `minSupport` | `number` | no | Drop partners with fewer than N shared commits (default 2) |
| `dayWindow` | `number` | no | Look back N days (default: entire captured window) |
| `topN` | `number` | no | Max partners to return (default 20) |

**Returns:** `{ targetFilePath, targetCommits, windowCommits, signalQuality, partners: [{ filePath, support, weightedSupport, confidence, lift, coChangeDate }] }`

Mega-commits (reformats, lockfile sweeps) are filtered out and down-weighted; `signalQuality: "low"` flags shallow/sparse histories.

---

### `get_symbol_risk`

Composite, explainable "how risky is it to change this symbol?" verdict. Blends churn (90 d), centrality (afferent coupling + reverse blast radius), cyclomatic complexity, test-coverage gap, and co-change spread — each normalized repo-relative. Returns a 0–100 score, a band, the per-factor breakdown, and human-readable reasons. Code-centered only — no author/ownership metrics.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Target repository |
| `symbolId` | `string` | yes | Symbol to score |

**Returns:** `{ riskScore, band: "low" | "review" | "high", factors: { churn, centrality, complexity, testGap, coChange }, reasons: string[], signalQuality }`

> `search_symbols` and `get_symbol_source` accept `includeRisk: true` to attach a compact `{ band, riskScore }` to results (opt-in, default off). `get_context_bundle` returns `historicalNeighbors` — co-changing files not reachable via imports — when co-change data exists. Risk weights are configurable via `risk.weights.*` (see [Configuration](04-configuration.md)).

---

## Architecture Analysis Tools

### `get_quality_metrics`

Per-file and per-symbol quality scores.

**Parameters:** `{ repoId, filePath? }`

**Returns:** `{ files: [{ filePath, complexity, coupling, cohesion, docCoverage, score }] }`

---

### `detect_antipatterns`

Detect common architectural anti-patterns.

**Parameters:** `{ repoId, patterns?: string[] }` — omit `patterns` for all checks.

**Returns:** `{ issues: [{ pattern, filePath, symbolId, severity, description }] }`

---

### `get_architecture_doc`

Auto-generate an architecture summary.

**Parameters:** `{ repoId, format?: 'markdown' | 'mermaid' }` (default: `'markdown'`)

**Returns:** `{ doc: string }`

---

## Ecosystem & Data Tools

### `search_columns`

Search dbt/SQL column definitions.

**Parameters:** `{ repoId, query, modelName? }`

**Returns:** `{ columns: [{ name, model, dataType, description, lineage }] }`

---

## Symbol Kinds

The `kind` parameter accepts any of:

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
| `model` | ORM model |
| `view` | Request handler / controller action |
| `struct` | C/C++ struct |
| `macro` | C/C++ `#define` macro |
| `signal` | Django signal receiver |
| `namespace` | C++ namespace |
| `widget` | Flutter widget |
