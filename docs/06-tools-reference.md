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

> To search symbol *names* across repositories, use `search_symbols` with `repoIds: [...]`, or omit `repoId`/`repoIds` entirely to search every indexed repo in one call.

### `find_cross_repo_usages`

Find where source files in *other* indexed repos reference an identifier defined in a given repo — i.e. which downstream packages/services consume a symbol from a shared library. Word-boundary text search; heuristic, not type-resolved.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sourceRepoId` | `string` | yes | Repo that defines the symbol |
| `symbolName` | `string` | yes | Symbol name to search for in other repos |
| `symbolKind` | `string` | no | Filter the source-repo lookup by kind (reduces false positives for generic names) |
| `targetRepoIds` | `string[]` | no | Repos to search (default: all indexed repos except the source) |
| `limit` | `number` | no | Max usages (default: 50) |

**Returns:** `{ usages: [{ repoId, filePath, line, context }] }`

---

### `search_similar`

Find semantically similar code across repos (HNSW vector similarity). Before implementing new functionality, call this to check whether equivalent code already exists. Requires semantic search enabled.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Repo of the reference symbol |
| `symbolId` | `string` | yes | Reference symbol |
| `searchRepoIds` | `string[]` | no | Repos to search (default: all) |
| `minSimilarity` | `number` | no | Minimum cosine similarity 0–1 (default: 0.8) |
| `limit` | `number` | no | Max results (default: 10) |

**Returns:** `{ similar: [{ ...symbolSummary, repoId, similarity }] }`

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

### `generate_docs`

Auto-generate an architecture / module summary in Markdown or Mermaid. Requires `ai.allowRemoteAI: true` for AI-written prose.

**Parameters:** `{ repoId, scope?, format?: 'markdown' | 'mermaid' }` (default format: `'markdown'`)

**Returns:** `{ doc: string }`

---

### `get_coupling_map`

Per-file afferent/efferent coupling and instability (`I = efferent / (afferent + efferent)`).

**Parameters:** `{ repoId, filePath?, scope?, limit? }` (limit default 50)

**Returns:** `{ files: [{ filePath, efferentCoupling, afferentCoupling, instability, efferentDeps, afferentDeps }] }`

---

### `find_refactoring_opportunities`

Surface extract/split/decouple candidates ranked by estimated impact.

**Parameters:** `{ repoId, scope?, limit? }`

**Returns:** `{ opportunities: [{ filePath, symbolId?, kind, impact, rationale }] }`

---

## Relationship Analysis Tools

### `find_implementations`

All concrete implementations of an interface or abstract class. Returns `implementedMethods` / `missingMethods` per class — call before modifying an interface to know every class that must change.

**Parameters:** `{ repoId, symbolId, includeAbstract?, limit? }` (limit default 50)

---

### `get_call_hierarchy`

Callers and callees of a function, N levels deep, as a tree. Recursive calls are marked `cyclic: true`. Uses the import-edge graph — dynamic dispatch / `eval` / reflection are invisible.

**Parameters:** `{ repoId, symbolId, direction?: 'callers' | 'callees' | 'both', maxDepth?, maxNodes? }`

---

### `get_class_hierarchy`

Inheritance tree rooted at a class — ancestors (what it extends) and descendants (what extends it).

**Parameters:** `{ repoId, symbolId, direction?: 'ancestors' | 'descendants' | 'both', maxDepth? }` (default `both`, depth 5)

---

### `find_cycles`

Detect circular import dependencies (strongly-connected components with severity ratings).

**Parameters:** `{ repoId, scope?, minCycleLength? }` (default min length 2)

**Returns:** `{ cycles: [{ files, length, severity }], totalFound }`

---

### `trace_invocation_chain`

Follow call edges from a symbol N hops deep and return the linearised call path(s).

**Parameters:** `{ repoId, symbolId, maxDepth? }`

---

### `get_lexical_scope_matches`

All symbols accessible from a given file + line: local scope, imports, and module exports.

**Parameters:** `{ repoId, filePath, line }`

---

## Visualization Tools

### `render_diagram`

Generate a Mermaid or DOT diagram from the dependency graph.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Target repository |
| `type` | `string` | no | `"module"` / `"import"` (file-level), `"call"` (needs `rootSymbolId`), `"class"` (needs `rootSymbolId`) |
| `format` | `string` | no | `"mermaid"` (default) or `"dot"` |
| `maxNodes` | `number` | no | Cap nodes (diagrams >50 nodes become unreadable) |
| `maxDepth` | `number` | no | Max graph depth |

**Returns:** `{ diagram: string, format, nodeCount }`

`render_call_graph`, `render_import_graph`, `render_class_hierarchy`, and `render_dep_matrix` are specialized variants of `render_diagram` for a single diagram type.

---

### `get_architecture_snapshot`

Freeze the architecture state (file/symbol/edge counts, cycle membership, layer violations, coupling/complexity averages) into a named snapshot, then `diff` two snapshots for before/after evidence. The stored cycle/layer data is what `compare_change_impact` diffs against.

**Parameters:** `{ repoId, action: 'create' | 'list' | 'diff' | 'delete', snapshotId?, compareId?, label? }`

---

## Refactoring Safety Tools

Run the matching `check_*` before any structural change — they give a binary `safe` verdict with the full impact list. (For the impact-aware pre/post loop, see [Change & Refactoring Tools](#change--refactoring-tools).)

### `check_rename_safe`

**Parameters:** `{ repoId, symbolId, newName }`

**Returns:** `{ safe, verdict, conflicts, affectedSites: [{ filePath, line, column, context, changeType }], affectedFileCount }` — `safe: false` on name conflicts or string-literal references that need human judgment.

---

### `check_delete_safe`

**Parameters:** `{ repoId, symbolId }` (or `filePath` for a whole-file aggregate)

**Returns:** `{ safe, risks: [{ kind, filePath, line, detail }], liveReferenceCount, isExported, isEntryPoint }`

---

### `check_move_safe`

**Parameters:** `{ repoId, filePath, newFilePath }`

**Returns:** `{ safe, importUpdates: [{ importerFilePath, currentImportPath, newImportPath, line }], newCycles, wouldIntroduceCycles }`

---

### `plan_refactoring`

Sequenced, risk-annotated plan synthesizing the safety checks. Read-only — produces a plan, writes nothing.

**Parameters:** `{ repoId, goal: 'rename-symbol' | 'delete-symbol' | 'break-cycle' | 'extract-module' | 'reduce-coupling' | 'general', symbolId?, filePath?, newName?, newFilePath?, contextHint? }`

**Returns:** `{ goal, summary, steps: [{ order, action, filePath, line?, detail, automated, risk }], totalSteps, estimatedRisk, warnings }`

---

## Health & Debt Tools

### `health_radar`

Five-axis health radar (each axis 0–100, 100 = healthy): complexity, coupling, maintainability, documentation, stability.

**Parameters:** `{ repoId, scope?, includeStability? }` (set `includeStability: false` for repos with no git history)

---

### `diff_health_radar`

Compare two health snapshots axis-by-axis for before/after evidence.

**Parameters:** `{ repoId, scope?, includeStability? }` (compares against the prior snapshot / two commits)

---

### `get_debt_report`

Per-file technical-debt report with priority tiers and recommendations.

**Parameters:** `{ repoId, scope?, maxFiles?, includeDead? }` (maxFiles default 10)

---

## AST-Level Search Tools

These re-parse stored file content with tree-sitter — only files backed by a WASM grammar are searched (regex-only handlers are skipped; use `search_text` there).

### `search_ast`

Find every occurrence of a tree-sitter node type (e.g. `try_statement`, `arrow_function`, `impl_item`).

**Parameters:** `{ repoId, nodeType, filePath?, limit? }`

---

### `search_by_signature`

Search symbols by type-signature pattern (regex or substring).

**Parameters:** `{ repoId, pattern, kind? }`

---

### `search_by_decorator`

Find all symbols annotated with a given decorator (e.g. `Injectable`, `route`). Combine with set-difference to find symbols *lacking* a decorator.

**Parameters:** `{ repoId, decorator, kind? }`

---

### `search_by_complexity`

Find symbols above a cyclomatic-complexity threshold.

**Parameters:** `{ repoId, minComplexity, kind?, limit? }`

---

## Code Intelligence Tools

### `get_entry_points`

Identify runnable entry points (main, CLI, server startup, Lambda, test suites, scripts), each with a `confidence` and reason.

**Parameters:** `{ repoId, kind?, minConfidence? }`

---

### `get_public_api`

Exported symbols grouped by file — the public API surface of the repo or a module.

**Parameters:** `{ repoId, filePath?, kind?, includeMembers?, groupByFile? }` (groupByFile default true)

---

### `get_todos`

All TODO / FIXME / HACK / NOTE / XXX comments with file, line, tag, and text.

**Parameters:** `{ repoId, tags?, filePath?, limit? }` (limit default 200)

---

### `get_complexity_hotspots`

Symbols ranked by complexity, highest first.

**Parameters:** `{ repoId, kind?, filePath?, limit?, minComplexity? }` (limit default 20)

---

### `get_type_graph`

Type dependency graph — which types reference which.

**Parameters:** `{ repoId, symbolId?, maxDepth?, direction?: 'uses' | 'usedBy' | 'both' }` (maxDepth default 3)

---

### `find_untested_symbols`

Exported symbols with no corresponding test coverage (import-based heuristic, not runtime coverage).

**Parameters:** `{ repoId, filePath?, kind?, limit? }` (limit default 50)

---

### `get_test_coverage_map`

Per-file coverage map with `coverageRatio` and aggregated totals.

**Parameters:** `{ repoId, filePath?, includeSymbols? }`

---

### `get_task_context`

Assemble a focused context bundle for a natural-language task description (the symbols and files most relevant to the work). In the default `associative` mode it discovers seed symbols, then walks the real dependency + co-change graph around them (imports, callers, historically co-changing files), derives each symbol's `role` from the edge that surfaced it (`dependency`/`caller`/`historical`/`primary`), and returns `provenance` per item plus `evidenceGaps` (`lowConfidenceSeeds`/`droppedByBudget`/`unselectedCoChange`) and `suggestedProbes` so the agent can decide whether to probe further. AI ranking is used when configured; otherwise results are ranked by graph provenance (works with zero embeddings). Pass `mode:"flat"` for the legacy single-pass similarity selection.

**Parameters:** `{ repoId, task, maxSymbols?, includeSource?, model?, mode? }`

Fanout is governed by config `taskContext.{seedCount, expansionDepth, maxPool, maxCoChangePartners, maxSymbolsPerPartner}`.

---

## Distribution Tools

### `export_index`

Serialize a repo's index to a portable archive.

**Parameters:** `{ repoId, outputPath? }`

---

### `import_index`

Import a previously exported index archive.

**Parameters:** `{ archivePath }`

---

### `fetch_public_index`

Download a pre-built index from the public registry.

**Parameters:** `{ name | url }`

---

## Ecosystem & Data Tools

### `search_columns`

Search dbt/SQL column definitions with full upstream/downstream lineage. dbt-only — run `dbt compile` before `index_folder`.

**Parameters:** `{ repoId, query, modelName? }`

**Returns:** `{ columns: [{ name, model, dataType, description, lineage }] }`

---

## Change & Refactoring Tools

PureContext closes a loop around an edit: assess before, reconcile after, and check for architectural regression. These tools are **judgment, not actuation** — they never write files. Each verdict ships with a plain-English `reasons[]`.

### `analyze_diff`

Parse a unified git diff and produce an impact-aware change report (CI / PR review). Built on the same synthesis engine as `prepare_change`.

**Parameters:** `{ repoId, diff, includeBlastRadius?, blastRadiusDepth?, includeRisk?, includeCoChangeGaps?, includeTests?, includeArchitectureFlags? }` (impact sections default on; switch off for cheap runs).

**Returns:** `{ summary, changedSymbols, blastRadius?, risk?, missingCoChange?, recommendedTests?, coverageGaps?, architecturalFlags?, signalQuality?, reviewPriority }`

---

### `prepare_change`

Pre-edit verdict for an intended change. Resolves a target and returns the predicted impact **before** you edit.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Target repository |
| `intent` | `"rename" \| "delete" \| "modify" \| "extract"` | yes | What you intend to do |
| `targetSymbolId` | `string` | one of | Resolve directly by symbol id |
| `query` | `string` | one of | Resolve by free-text name/description |
| `includeRisk` / `includeCoChangeGaps` / `includeTests` / `includeArchitectureFlags` | `boolean` | no | Section toggles (default on) |

**Returns:** `{ verdict: "ready" | "ambiguous_target" | "no_target", target?, candidates?, predictedChange?: { changedSymbolIds, changedFilePaths }, predictionId?, risk?, missingCoChange?, recommendedTests?, coverageGaps?, architecturalFlags?, signalQuality?, reasons }`

> On `ambiguous_target` it returns `candidates[]` and refuses to synthesize — re-call with the chosen `targetSymbolId`. It never guesses.

---

### `verify_change`

Post-edit reconciliation of the real diff against a `prepare_change` prediction. Stateless — pass the prediction back inline.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | yes | Target repository |
| `diff` | `string` | yes | Unified diff of what you actually changed |
| `predictedFilePaths` | `string[]` | yes | `predictedChange.changedFilePaths` from prepare_change |
| `predictedCoChange` | `string[]` | no | `missingCoChange[].filePath` from prepare_change |
| `predictionId` | `string` | no | Optional echo (label only; not stored) |

**Returns:** `{ verdict: "complete" | "incomplete" | "scope_expanded", actualFilePaths, addressedCoChange, unaddressedCoChange, unplannedChanges, coverageGapsRemaining, signalQuality, reasons }`

> Co-change reconciliation is suppressed when `signalQuality` is `low` (shallow/squashed history) — it never invents "you forgot X."

---

### `compare_change_impact`

Before/after architecture *regression* delta. Distinct from `analyze_diff`'s `architecturalFlags` (which flag pre-existing issues); this reports only what the change introduced or resolved.

**Parameters:** `{ repoId, baselineSnapshotId? }` — baseline from `get_architecture_snapshot` (action `create`); omit to use the most recent snapshot.

**Returns:** `{ verdict: "regressed" | "improved" | "unchanged" | "no_baseline", baselineSnapshotId?, newCycles, resolvedCycles, newLayerViolations, resolvedLayerViolations, currentCycleCount, currentLayerViolationCount, reasons }`

**Workflow:** `get_architecture_snapshot` (create) → edit → reindex → `compare_change_impact`. Snapshots created before v1.11.0 lack the stored cycle/layer data and return `no_baseline`.

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
