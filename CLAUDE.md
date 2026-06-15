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

## Current Phase

**Latest: Phase 79 — COMPLETE** (Refactoring Superiority — closed pre/post loop + architecture regression)

The competitive wedge after the token-savings/jCodeMunch review (2026-06-14): stop competing on token savings (a parity feature jCodeMunch games harder) and stop chasing its larger refactoring *tool count* (`apply_rename`/`preview_refactoring`/runtime traces). Win on **judgment, not actuation** — the agent already has a file-write tool, so PureContext is the brain that says what's safe and what you forgot, not a second editor. Three new tools, all thin consumers of the Phase 77A `synthesizeChange` engine: (1) **`prepare_change`** (`src/server/tools/prepare-change.ts`) — pre-edit verdict for a stated intent (target resolution via symbolId or query + predicted change set → risk/`missingCoChange`/tests/coverageGaps/arch flags + `reasons[]` + `predictionId`); `ambiguous_target` verdict + `candidates[]` when a query has no clear winner, `no_target` when nothing matches — never synthesizes on a guess. Predicted files: rename/delete add `find_references` sites, extract adds importers, modify = target file. (2) **`verify_change`** (`src/server/tools/verify-change.ts` — the feature jCodeMunch lacks) — reuses `analyze_diff` verbatim for the actual-side synthesis, then reconciles against the prediction (`unaddressedCoChange`/`addressedCoChange`/`unplannedChanges`/`coverageGapsRemaining`; verdict `complete`/`incomplete`/`scope_expanded`); **stateless** — the agent passes `predictedFilePaths`+`predictedCoChange` back inline; co-change reconciliation suppressed when `signalQuality:'low'`. (3) **`compare_change_impact`** (`src/server/tools/compare-change-impact.ts`) — before/after architecture *regression delta* (`newCycles`/`newLayerViolations` + `resolvedCycles`/`resolvedLayerViolations`; verdict `regressed`/`improved`/`unchanged`/`no_baseline`), distinct from 77A's current-state flags. Baseline = `get_architecture_snapshot` (extended to store cycle membership + layer violations in its metrics JSON — additive, old snapshots → `no_baseline` graceful degrade). Cross-cutting: explainable `reasons[]` on every verdict (vs jCodeMunch's bare confidence number); config `refactoring.maxCandidates` (default 5); `WHY-PURECONTEXT.md` closed-loop + judgment-not-actuation positioning. 14 new tests (prepare 7, verify 4, compare 3); full suite 6012 green, 0 regressions. Tasks 467–478. Version **1.11.0**. **Boundaries (deliberately NOT built):** edit actuation, runtime traces, author/ownership metrics. See `dev-docs/PHASE79_TASKS.md`.

**Phase 78 — COMPLETE** (Node-version independence — WASM SQLite fallback + startup guard + global-Node install pinning). Tier chain `better-sqlite3` → `@sqlite.org/sqlite-wasm` (both have FTS5; `node:sqlite` does not); `node-guard.ts`/`bin.ts` fail clearly below Node 18; install pins the server to the user's global Node (Volta-aware). Version **1.10.0**. See `dev-docs/PHASE78_TASKS.md`.

**Latest: Phase 77 (Phase A) — COMPLETE** (Change-Impact Synthesis — `analyze_diff` upgrade + shared synthesis core)

Tasks 460–466 complete. Turns `analyze_diff` from "changed symbols + blast radius + a 4-line priority heuristic" into an **impact-aware change report**, built on a reusable **change-synthesis core** that Phase B's `prepare_change` will consume verbatim. Product line: *PureContext reviews changes by impact, not by diff size.* All server/tools + config + docs — no handler/adapter/core-schema changes, no new git capture (reuses Phase 76's `commit_files`). (1) **`RiskContext` perf refactor** (`src/server/tools/symbol-risk.ts`): `buildRiskContext(db,repoId)` computes the repo-wide distributions (90d churn map, afferent-coupling lookup, complexity distribution, test-file content set, co-change window) **once**; `computeSymbolRiskWithContext` scores N symbols against it; `computeSymbolRisk` is now a thin wrapper (output **byte-identical** — regression-guarded). Eliminates the O(symbols × repo) blowup on big diffs. (2) **`change-synthesis.ts`** — pure, MCP-free `synthesizeChange(db,repoId,input)` returning `aggregateRisk` (max band + top offenders), **`missingCoChange`** (the headline new signal: files historically coupled to the edited ones but ABSENT from the diff — the "you forgot to touch X" instinct; suppressed entirely on `signalQuality:'low'`), `recommendedTests`, `coverageGaps`, and `architecturalFlags` (cycles / layer crossings the change *currently* sits on — **flags, not regressions introduced**). One shared `RiskContext`; every section capped; ranks symbols-to-score by afferent coupling when over `maxSymbolsScored`. (3) **`analyze_diff` enriched** — additive `risk`/`missingCoChange`/`recommendedTests`/`coverageGaps`/`architecturalFlags`/`signalQuality` fields; `reviewPriority` now folds in risk band + coverage gaps (same `low|medium|high|critical` enum); four flags (`includeRisk`/`includeCoChangeGaps`/`includeTests`/`includeArchitectureFlags`) default **on**, switchable off (all off ⇒ today's exact shape). (4) **Config** `changeSynthesis.{coChangeConfidenceThreshold=0.4, maxSymbolsScored=25, maxCoChangeGaps=10, maxRecommendedTests=15}`. **Explicitly deferred:** `prepare_change` (Phase B), true before/after architecture regression (`compare_change_impact`), intent parsing, author/ownership metrics (permanent boundary). 34 new tests (symbol-risk context path, change-synthesis, analyze-diff fixture, config). Version **1.9.0**. See `dev-docs/PHASE77_TASKS.md`.

**Phase 76 — COMPLETE** (Temporal Risk Intelligence — co-change + composite symbol risk)

Tasks 451–459 complete. Adds the one capability the static graph cannot derive — **temporal coupling** (files that historically change together) — and fuses PureContext's existing risk primitives into a single explainable **symbol risk** verdict surfaced before edits. (1) **Co-change capture** (`src/core/git-log-reader.ts` `readRepoCommitFiles` + `src/core/db/co-change-store.ts` `commit_files` table): a SINGLE repo-level `git log --no-merges --name-only -n N` at index time, stored separately from `git_metadata` (whose per-file last-10 window is too shallow/recency-skewed for co-change). Gated on `git.coChangeDepth > 0` (default 300; `0` = byte-identical pre-phase behavior), additive + failure-tolerant. Schema **v7→v8** (additive `commit_files` table; old indexes load without re-index). (2) **`get_co_change`** tool + `src/server/tools/co-change.ts` query module: explainable `support`/`confidence`/`lift`; mega-commit filter (`git.megaCommitThreshold` default 30) + `1/(k−1)` down-weighting; `minSupport` floor; `signalQuality:"low"` on sparse history. File-granular (symbolId → file). (3) **`get_symbol_risk`** tool + `src/server/tools/symbol-risk.ts`: blends churn / centrality (afferent coupling + reverse blast radius) / complexity / test-gap / co-change spread, each **repo-relative midrank-percentile** normalized; config-weighted (`risk.weights`) sum → 0–100, banded low/review/high; always returns `factors` (raw+normalized) + `reasons[]`. Shared `src/server/tools/symbol-lines.ts` (byteOffsetToLine) extracted from get-churn-metrics. (4) **Guardrails:** opt-in `includeRisk` flag on `search_symbols`/`get_symbol_source` (compact `{band,riskScore}`, default off); `get_context_bundle` now returns `historicalNeighbors` (co-changing files not reachable via imports) when co-change data exists, else byte-identical. **No author/ownership/productivity metrics — deliberate product boundary.** 30+ new tests (co-change-store, co-change query, symbol-risk, tool e2e, parse). Version **1.8.0**. See `dev-docs/PHASE76_TASKS.md`.

**Phase 75 — COMPLETE** (Adapter-extension wiring fixes + Svelte/Astro support). Tasks 440–450 complete. **Root cause from the `.vue not indexed` investigation:** `indexFolder()` never called `discoverAdapters()` (fixed in 1.6.0 — adapters now auto-discovered when `options.adapters` is absent). Phase 75 closes the remaining instances of the same bug class and adds two new SFC adapters. (1) File watcher (`file-watcher.ts`) and GitHub remote-index path (`index-repo.ts`) now union `getAdapterExtensions(getRegisteredAdapters())` into their handler-extension sets, so `.vue`/`.svelte`/`.astro` edits trigger re-index and remote SFC blobs aren't dropped. New exported `watchedExtensions()` helper for testability. (2) Benchmark harness (`run_benchmark.ts` + `run_purecontext.ts`) now imports all framework adapters for self-registration — previously it registered 40 handlers but 0 adapters, so it had **never** indexed `.vue` (historical Vue/Nuxt benchmark numbers measured only `.ts`/`.scss`). Expect Vue/Nuxt benchmark deltas on next run — measurement-scope correction, not a regression. (3) New **Svelte** adapter (`.svelte`): `splitSvelteSFC` extracts `<script>`/`<script context="module">` blocks; component symbol per file; `useXxx`→composable. (4) New **Astro** adapter (`.astro`): `splitAstroSFC` extracts leading `---` frontmatter as a TS block; component symbol per file. Both use a shared `detect-utils.ts` (bounded recursive monorepo detection mirroring Vue/Nuxt; Vue/Nuxt keep their own inline copies). Registered in all three registries (`src/index.ts`, `indexing-worker.ts`, both harness files). 39 new tests (svelte/astro preprocessor + adapter + watcher). Version bumped to **1.7.0** (from actual 1.6.0). See `dev-docs/PHASE75_TASKS.md`.

Phases 51–75 summaries and all earlier history live in `dev-docs/PHASE*_TASKS.md` (one file per phase) and the auto-memory index. Current real version: **1.9.0**.

---

## Decision Log

Recent significant decisions:

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-14 | Phase 79: compete on *judgment, not actuation* — do NOT build `apply_rename`/`preview_refactoring`/runtime traces | jCodeMunch leads on refactoring *tool count* and the savings/jCodeMunch review showed token-savings is a parity feature it games harder ($360 "cost avoided" off the same inflated naive-read baseline PureContext's own counter uses). Chasing either is a losing, low-credibility game. In an agentic world the agent already has a file-write tool, so an MCP that *applies* edits is redundant — the value is telling the editing agent what's safe and what it forgot. The three Phase 79 tools are all read-only; edit actuation is a permanent product boundary, not a backlog item. |
| 2026-06-14 | Phase 79: `prepare_change`/`verify_change`/`compare_change_impact` are thin consumers — no synthesis logic in the tool layer | Carried from 77A's "build the engine where the input is objective, then wrap it." `prepare_change` feeds *predicted* symbols/files to `synthesizeChange`; `verify_change` reuses `analyze_diff` *verbatim* (calls its handler, parses the result) for the actual-side synthesis then only does set-difference reconciliation; neither re-implements diff parsing or synthesis. Enforced in review. Keeps the closed loop consistent and means a fix to the engine fixes all consumers. |
| 2026-06-14 | Phase 79: `verify_change` is the differentiator (plan-vs-actual reconciliation) and is **stateless** | jCodeMunch has stateful sessions but no reconciliation of the real diff against a prior prediction. `verify_change` computes `unaddressedCoChange` (predicted partner still untouched — the headline), `addressedCoChange`, `unplannedChanges` (scope creep), `coverageGapsRemaining`. Prediction is passed back **inline** (`predictedFilePaths`+`predictedCoChange` from `prepare_change`), NOT stored in a `change_predictions` table — protects the stateless-server value (Task 470 decision); add the table only on demonstrated need. Co-change reconciliation suppressed entirely when `signalQuality:'low'` (never invent "you forgot X" on thin history). |
| 2026-06-14 | Phase 79: architecture *regression* delta needs a stored before-graph → extend `get_architecture_snapshot`, don't checkout+reindex | `compare_change_impact` reports only what the change *introduced* (`newCycles`/`newLayerViolations` = set-difference of before vs current), distinct from 77A's current-state `architecturalFlags`. The snapshot's `metrics` JSON previously stored only `cycleCount` (a number) — useless for membership diffing. Extended `StoredMetrics` with `cycles` (membership) + `layerViolations` (additive to the JSON blob, no schema migration; old snapshots lack them → `no_baseline` graceful degrade). Compute helpers (`computeCurrentCycles`/`computeCurrentLayerViolations`) live in `compare-change-impact.ts` and are imported by the snapshot creator so before/after use the **identical** representation (Task 473: reuse snapshot, never checkout+reindex). |
| 2026-06-07 | Phase 77: extract `RiskContext` before composing risk over a diff (perf prerequisite) | `computeSymbolRisk` per call ran `getCommitsInWindow` (90d), `getCouplingMap` (whole repo), the full complexity-distribution query, AND scanned every file's `raw_content` for test refs — calling it once per changed symbol in a 30-symbol diff = O(symbols × repo). `buildRiskContext(db,repoId)` computes all repo-wide distributions + the afferent-coupling lookup + the test-file content set ONCE; `computeSymbolRiskWithContext` is pure scoring against it (plus a per-symbol reverse blast radius). `computeSymbolRisk` kept as a thin wrapper with **byte-identical output** (regression-guarded by a test asserting single-call ≡ context path, and a query-count spy proving distributions build once for N symbols). Also memoizes `getCoChange` by file path on the context (many changed symbols share a file). |
| 2026-06-07 | Phase 77: synthesis logic lives in `change-synthesis.ts`, NOT inside `analyze_diff` | The genuinely new value is orchestration + one reviewer instinct (absence-of-co-change). Phase B's pre-edit `prepare_change` must reuse the EXACT same engine, so the fusion (`synthesizeChange`) is a pure, MCP-free module; `analyze_diff` (post-edit) and later `prepare_change` (pre-edit) are both thin consumers. Build the engine where the input is objective and testable (a real diff is ground truth), then wrap it in the fuzzier pre-edit surface — order matters. Enforced in review: no synthesis logic duplicated in the tool layer. |
| 2026-06-07 | Phase 77: `missingCoChange` is the headline signal — and is suppressed on low signal | The static import graph cannot see temporal coupling. "You touched refundService but ledgerService historically moves with it — and it's not in this diff" = co-change partners with `confidence ≥ threshold` (default 0.4) minus files already in the diff, minus test files (those route to `recommendedTests`). To avoid manufacturing warnings on shallow/squashed histories, the whole section is **empty + suppressed when `signalQuality==='low'`** (co-change window < 20 commits) — verified by a thin-history test and the live smoke (dropping `commit_files` ≡ `coChangeDepth=0` → low + empty, no crash). |
| 2026-06-07 | Phase 77: architectural **flags**, not **regressions introduced** | True before/after architecture regression (a NEW cycle / NEW cross-layer edge introduced *by* the diff) needs a before/after graph delta — that's `compare_change_impact`, deliberately deferred. Phase A ships the honest, testable subset: `architecturalFlags` = "do the changed files *currently* sit on an import cycle (`findCycles` over the live adjacency, filtered to cycles containing a changed file) / cross a layer boundary (`assignLayer`/`isAllowed` over edges touching a changed file)." Labeled as flags throughout; never claims the diff caused them. |
| 2026-06-07 | Phase 77: enriched `analyze_diff` is fully backward-compatible | All new output fields are additive; `reviewPriority` keeps the same `low|medium|high|critical` enum (smarter derivation: folds in aggregate risk band + coverage-gap count alongside the original signature-break/blast signal). Four section toggles (`includeRisk`/`includeCoChangeGaps`/`includeTests`/`includeArchitectureFlags`) default ON (the point of the tool) but switch off for cheap runs; with all off the output reduces to the pre-Phase-77 shape exactly (verified by test). Existing CI/JSON consumers unaffected. |
| 2026-06-04 | Phase 76: dedicated `commit_files` table (not `git_metadata`) for co-change | `git_metadata` stores commits per-file but capture is `readFileHistory(limit=10)` — only the last 10 commits/file via N per-file `git log --follow` calls, so a shared commit is recorded only if it falls in BOTH files' last-10 window → systematic undercount, recency-skewed. New `commit_files(repo_id, commit_sha, file_path, commit_date)` populated by ONE repo-level `git log --no-merges --name-only -n N` (commit→files natively, far deeper + cheaper). Co-change of two files = self-join on `commit_sha`. Schema v7→v8 additive (CO_CHANGE_DDL, IF NOT EXISTS); symbol-history capture untouched. Gated on `git.coChangeDepth > 0` (default 300; 0 = no extra git call, byte-identical). |
| 2026-06-04 | Phase 76: explainable association metrics + mega-commit handling | Generic "churn dashboards" present raw counts. `getCoChange` returns support (shared commits), confidence (support/commits(target) — directional A→B), lift (support×N/(commits(A)×commits(B))). Noise control: exclude commits touching > `megaCommitThreshold` (default 30) files (reformat/lockfile/codemod sweeps); down-weight each retained shared commit by `1/(k−1)` so a 25-file commit contributes far less than a focused 2-file one (ranks by `weightedSupport`); `minSupport` floor (default 2) drops coincidences; `signalQuality:"low"` when commits(target)<5 or window<20 rather than overstating weak ratios. |
| 2026-06-04 | Phase 76: composite `get_symbol_risk` — repo-relative midrank percentile | Fuses churn (90d) / centrality (afferent coupling + reverse blast radius) / complexity / test-gap / co-change spread into one 0–100 banded verdict. Each factor normalized **repo-relative** so scores compare within a repo and aren't dominated by absolute LOC. Used **midrank** percentile `(less + 0.5·equal)/N` not fraction-`<=`: the latter inflated ties at the repo minimum (a simple symbol jumped to ~0.9 complexity because most symbols also had cc=1). Weights from `risk.weights` (tunable, not magic constants). Always returns `factors`+`reasons[]` — never a black-box number. NO author/productivity metrics (product boundary). |
| 2026-06-04 | Phase 76: guardrail surfaces are bundle + opt-in flag, NOT plan_turn | PureContext has no `plan_turn` (that's a jCodeMunch tool). Risk reaches agents via `get_context_bundle.historicalNeighbors` (co-changing files the import graph can't see; empty + byte-identical when no co-change data) and an opt-in `includeRisk` flag on `search_symbols`/`get_symbol_source` (compact `{band,riskScore}`, default off so no token/perf cost). Full breakdown stays in `get_symbol_risk`. |
| 2026-06-01 | Phase 75: Svelte + Astro adapters (new SFC support) | No `.svelte`/`.astro` support existed. Added `svelteAdapter` (`.svelte`: `splitSvelteSFC` extracts `<script>`/`<script context="module">`, component symbol, `useXxx`→composable) and `astroAdapter` (`.astro`: `splitAstroSFC` extracts leading `---` frontmatter as a TS block, component symbol). Modeled on the Vue adapter. Shared `src/adapters/detect-utils.ts` provides bounded recursive monorepo detection (`scanForFramework`, `pkgDepMatches`, `toPascalCase`); Vue/Nuxt predate it and keep inline copies (left untouched to avoid risk). Astro frontmatter fence must be leading non-whitespace content — a `---` later in markup is not treated as frontmatter; unterminated fence throws ParseError. |
| 2026-06-01 | Phase 75: watcher + remote-index union adapter extensions; harness registers adapters | Same bug class as the `indexFolder`/`discoverAdapters` root cause: `file-watcher.ts` and `index-repo.ts` gated on `getSupportedExtensions()` (handlers only), so `.vue`/`.svelte`/`.astro` were filtered out (watcher ignored SFC edits; remote indexing dropped SFC blobs). Fix: union `getAdapterExtensions(getRegisteredAdapters())` (static union of all registered adapters — not detect()-filtered, since these paths lack a reliable local FS to detect against; over-inclusion is harmless because `processFile` gates on `fileFilter` and `indexFolder` re-detects). Benchmark harness (`run_benchmark.ts` + `run_purecontext.ts`) imported 40 handlers but 0 adapters → never indexed `.vue`; now imports all adapters for self-registration so the harness matches production. Vue/Nuxt benchmark numbers will shift on next run (measurement-scope correction). |
| 2026-06-01 | indexFolder now auto-discovers adapters when none supplied (ROOT CAUSE of ".vue not indexed") | `index_folder` MCP tool + benchmark harness call `indexFolder()` without `options.adapters`, and `indexFolder` defaulted to `[]` — it never called `discoverAdapters()`. Result: adapter-only extensions (`.vue`) were never added to the discovery allowlist, so `.vue` files were silently skipped and Vue SFC `<script>`/component extraction never ran (language handlers still covered `.ts`/`.tsx`, which is why NestJS/React still scored). Fix: `const adapters = options.adapters ?? await discoverAdapters(absRoot, { adapters: getConfig().adapters })`. Adapters self-register in the main process (src/index.ts) and workers (indexing-worker.ts). Backward-compatible: explicit `options.adapters` and processes that don't import adapter modules behave as before. Verified end-to-end on a real Vue 2 repo: 0 → 255 `.vue` files / 255 `component` symbols indexed. The earlier monorepo `detect()` fix was necessary but not sufficient — the pipeline never invoked detection at all. |
| 2026-06-01 | Vue/Nuxt adapter monorepo detection — bounded recursive scan | Both adapters' `detect()` only checked the indexed root (Vue: root `package.json` + `./`, `./src`, `./components`; Nuxt: `nuxt.config.*` at root). In multi-technology repos the framework app lives in a subdirectory (`frontend/`, `apps/web/`), so detection failed → Vue's `.vue` extension was never added to the discovery allowlist → zero Vue symbols. Added a bounded recursive scan (depth ≤ 6, ≤ 2000 dirs, skips `node_modules`/`.git`/`dist`/`.nuxt`/etc., does not follow symlinks): Vue scans for a `.vue` file or nested `package.json` declaring vue/@vue/*; Nuxt scans for a nested `nuxt.config.{ts,mts,js,mjs}`. Root fast-path preserved. Version 1.5.2→1.6.0. |
| 2026-06-01 | Nuxt nested app-root path resolution — stateless `toNuxtRelative()` | After Nuxt detection fix, route/plugin/middleware extraction + page/composable enrichment still failed for nested apps: `getCategory`/`deriveServerRoute`/`derivePageRoutePath`/`enrichMetadata` keyed off paths relative to the Nuxt app root (`server/api/...`), but monorepo paths arrive repo-relative (`apps/web/server/api/...`). Added `toNuxtRelative()` that returns the path from the first recognized app-root boundary segment (`server`/`plugins`/`middleware`/`composables`/`pages`); `getCategory` split into `categoryOf(rel)` + wrapper. Must be stateless (cannot cache app root in `detect()`) because the parallel worker pool resolves adapters from its own registry — main-thread state never reaches workers. `server` is a boundary segment so `server/plugins/foo.ts` resolves within the `server/` tree (correctly *not* an app-root plugin). Stored symbol `filePath` stays repo-relative so files can still be opened. Caveat: heuristic — a non-Nuxt dir literally named `server`/`pages`/etc. could match, low-risk since the adapter only runs after `detect()` confirms Nuxt. |
| 2026-05-22 | Phase 73: Perl/R package context boost — PACKAGE_SEGMENT_STOPWORDS + reduced multiplier | catalyst-runtime regression: package context boost added `+8*overlap` for Catalyst:: namespace symbols when query contains 'catalyst', causing TestApp:: and Catalyst:: wrapper classes to outscore bare functions like `uri_for`. Fix: (1) PACKAGE_SEGMENT_STOPWORDS filters generic MVC words (controller, action, model, view, app, core, etc.) from package name token overlap; (2) multiplier reduced to `overlap >= 2 ? (overlap-1)*8+4 : 4` (single match = 4, was 8). catalyst P@3+4pp, R@5+8pp; P@1 still regressed 20%→12% because `uri_for` is not retrieved by FTS at all ('for' is a stop word). |
| 2026-05-22 | Phase 73: Perl t/lib/ fixture penalty −25 | TestApp::Controller::Action symbols in `t/lib/` are test fixtures, not library API. They outscore Catalyst core classes because their names contain query words ('action', 'controller') multiple times. Added −25 library penalty for `.pm`/`.pl` symbols whose `filePath` starts with `t/lib/` or contains `/t/lib/`. Path normalized to forward slash + lowercase before check; covers both Windows backslash and relative paths. |
| 2026-05-22 | Phase 73: Interceptor boost +15→+30 | NestJS interceptor middleware symbols were being outranked by *Service kindBoost (+30) symbols on queries about interceptors. Doubling the interceptor boost to +30 puts them on equal footing with services when the query explicitly mentions interceptor behavior. |
| 2026-05-22 | Phase 73: Rendering REPO_PATTERN + 'draw' | excalidraw uses `draw*` function names (drawElement, drawScene) that benefit from rendering-domain compound synonyms. Added 'draw' to RENDERING_REPO_PATTERN regex so excalidraw repos get rendering-specific synonym expansion. |
| 2026-05-22 | Phase 73: Compound underscore boost +30 | Underscore-named functions (e.g., `dispatch_action`, `build_request`) have all their parts in query words but don't get identityExact because the full string doesn't match. Added +30 boost when ALL `_`-split name parts (excluding STOP_WORDS) are present in the query word set. Does not fire for 'for' (stop word) — limitation for `uri_for`. |
| 2026-05-22 | Phase 73: Single-token exact boost (+50/+40) | Single-word queries that exactly match a symbol's full name or bare (last `::` segment) name were not reliably scoring highest. Added +50 for exact full-name match and +40 for exact bare-name match in single-token query mode; guards against over-firing by requiring single-token context. |
| 2026-05-22 | Phase 72: Erlang bare names — store `start_link` not `start_link/3` | rabbitmq/emqx ground truth uses `name/arity` format but FTS5 tokenizes `start_link/3` as a unit; bare name greatly improves recall. Arity uniqueness preserved via `frameworkMeta.arity`; ID still uses arity-qualified key to avoid collisions between `greet/0` and `greet/1`. Module name injected as FTS token (raw + underscore-split) for `rabbit_channel:start_link` queries. Harness extended with arity-suffix stripping for backward compat. rabbitmq 0%→36%, emqx 0%→28%. |
| 2026-05-22 | Phase 72: Proto serviceName FTS token — inject service name into method BM25 weight | googleapis proto methods named `Spanner.Read` — queries for "Spanner streaming read" need to match both the service and the method name. Added `frameworkMeta.serviceName` to RPC symbols; `buildFtsContent` injects it as an extra token. Slight P@1 regression in googleapis (service class vs method ranking conflict for bare service-name queries) — acceptable trade-off vs recall improvement. |
| 2026-05-22 | Phase 72: Neovim C-API Lua alias — `vim.api.nvim_*` FTS token on C functions | Neovim Lua users call `vim.api.nvim_open_win()` but C implementation is `nvim_open_win` — queries never matched. Added `maybeNvimLuaAlias()` to C handler; fires for `nvim_[a-z_]*` functions in `/nvim/` paths. FTS alias resolves the language barrier. neovim 24%→36% P@1 (PC beats JC). |
| 2026-05-22 | Phase 72: Groovy source boost +10 for mixed Java+Groovy repos | gradle/groovy expected symbols are all in Groovy files but compete with Java classes; +10 preferentially surfaces .groovy results in `detectJavaGroovyMixed` repos. gradle unchanged (FTS retrieval gap is the bottleneck, not ranking); groovy minor R@5 regression (1 query) likely from re-index delta not the boost. |
| 2026-05-22 | Phase 71: Library path extensions (engine, erts, contrib) | flutter C++ engine/ (40k symbols) pollutes Dart widget queries; otp erts/ pollutes Erlang stdlib queries; contrib/ inflates scientific computing symbol counts. Added as directory-segment penalties (-35). Also added /lib/wx/, /blas/, /lapack/ as multi-segment substring penalties. `unstable-core-do-not-import/` was added then removed — tRPC's canonical core API lives in that path; penalizing it blocks ProcedureBuilder.* expected symbols (task spec was incorrect). |
| 2026-05-22 | Phase 71: Java/Groovy core-path boost and plugin-path penalty | jenkins 4%/8%/16% — generic method names (getDuration, isBuilding) appear in hundreds of plugin classes. Added +15 boost for `/core/src/main/java/` paths and -35 for `/plugins/`/`/plugin/` paths, domain-gated to java/groovy repos. Result: jenkins 4%/8%/12% (slight R@5 regression — plugin penalty demoted a false-positive bare-name match that the harness had been counting as a hit). Core gap: PC indexes 11k jenkins symbols vs JC 23k — a coverage gap, not purely a ranking gap. |
| 2026-05-22 | Phase 71: Frontend path boost + use*/hook OR-fallback | novu 0%/0%/0% — 28k NestJS backend symbols drown React hooks in apps/dashboard/. Added mixed-monorepo detection (checks both frontend and backend app dirs), +20 path boost for dashboard/web/frontend app paths when query has hook/component vocabulary, and OR-fallback when AND pool lacks use[A-Z] symbols. Result: novu unchanged — hook symbols not entering the 200-candidate FTS pool at all; path boosting can't help before retrieval. |
| 2026-05-22 | Phase 71: Path proximity boost for same-name symbols | godot/home-manager — `spawn_count` in multiple demo files, `programs` in thousands of Nix modules: identical names return arbitrary result. Added +5/token path-proximity boost when ≥3 pool symbols share a name and the file path tokens overlap with query words. Common path segments (src/lib/app/core/main) excluded. Not measurable for godot (empty index); home-manager unchanged (query tokens don't overlap with Nix module file names). |
| 2026-05-22 | Phase 70: ObjC handler full extraction | Existing handler registered but missing `.h` extension, category naming, full selector building, `property` kind. Added ObjC detection guard (check first 16KB for `@interface`/`@protocol` before processing `.h` files), `ClassName+CategoryName` for named categories, `classExtension: true` for anonymous categories, full selector construction (`setObject:forKey:`), property kind changed from `const` to `property`. libs-base 0%→4%, vlc-ios 0%→12%, SparkleShare-iOS 0%→12% (JC had 16%). |
| 2026-05-22 | Phase 70: HCL handler (new, regex-only) | terraform-aws-eks and terraform-aws-components score 0%. Implemented regex-based HCL handler extracting `variable`→const, `output`→const, `resource`→class (`type.name`), `data`→const, `module`→class, `provider`→const, `locals` items→const. Naming uses `var.name`/`output.name`/`module.name`/`local.name` prefixes matching Terraform reference syntax (ground truth expectations). Registered in both `src/index.ts` and `indexing-worker.ts`. Must also register in `benchmarks/harness/run_benchmark.ts` (three separate handler registries). terraform-aws-eks 0%→84%, terraform-aws-components 0%→68%. |
| 2026-05-22 | Phase 70: Angular HTML handler (new, regex-only) | Angular `.html` templates invisible to search. Added detection guard (sibling `.component.ts` OR Angular markers/event binding pattern in first 4KB). Extracts component selectors (kebab-case multi-segment), structural directives (`*ngIf`, `*ngFor`), control flow (`@if`, `@for`), event bindings (`(click)="handler"`), template refs (`#userInput`), routerLink. |
| 2026-05-22 | Phase 70: Extensionless file discovery (opt-in → automatic) | dokku plugin functions live in extensionless `plugins/*/functions` files. Initial Phase 70 implementation required `extensionlessFilenames?: string[]` opt-in. During benchmark, harness called `indexFolder` without the parameter so dokku stayed at 0%. Changed to automatic: all extensionless files included when no allowlist provided; shebang detection in file-processor routes to bash handler or returns 0 symbols for non-bash files. dokku 0%→4%/40%/60%. |
| 2026-05-22 | Phase 70: XML root-element disambiguation | Maven 30+ modules each have `pom.xml` with `<project>` root — FTS returns arbitrary one at rank 1, blocking 21/25 queries. `disambiguateXmlName()` appends `@module` when (a) element depth ≤ 2, (b) file is in a subdirectory (parts.length ≥ 2), (c) disambiguator differs from tag. Generic stems (pom, index, config, settings, default) use parent dir name; others use file stem. Bare tag name stored in `bodySnippet` for FTS fallback. |
| 2026-05-22 | Phase 70: XML `@` disambiguation — ranker + harness end-to-end fix | After `project@maven-core` names were stored, three further fixes needed: (1) `splitNameParts` split regex updated from `[\\:.]+` to `[\\:.@]+` so `project@maven-core` tokenizes to `["project","maven","core"]` for word-overlap scoring; (2) `identityExact` boost: added `bareTagName` for the `@`-prefixed part so query word `project` triggers identityExact on `project@maven-core`; (3) `buildFtsContent`: standalone tag name token added for BM25 weight; (4) harness: `@` prefix match so `project@maven-core` matches ground truth `project`. Without these, maven went from 12% to 8% after XML rename, then back to 48% after all four fixes. |
| 2026-05-22 | Batch 5: 7 new benchmark projects (Phases 63/67) | OpenAPI/XML (maven, stripe-openapi, kubernetes-openapi, rest-api-description) + SQL (postgrest-sql, jaffle-shop, timescaledb). PC wins 4/7 P@1. P0 gaps: (1) OpenAPI `\w+` regex misses hyphenated names — rest-api-description 0% (fix: `[\w-]+`); (2) SQL handler captures schema prefix as function name — timescaledb 0% sql-kind (fix: optional schema prefix regex); (3) XML root element name collision across Maven modules (fix: file-path in symbol name). Cumulative: PC 42/67 P@1. Total benchmarked: 79 projects. |
| 2026-05-22 | Batch 4: 15 new benchmark projects (Phases 60/61/62) | Terraform/Nix, Lua/GDScript, Protobuf/GraphQL groups complete. PC wins 11/15 P@1 (JC wins terraform-aws-eks 12%, terraform-aws-components 4%, neovim 32%, godot-demo-projects 40%). Envoy 56%/64%/72% vs JC 0%. P0 gap: no HCL handler — 0 Terraform symbols. Cumulative: PC 38/60 P@1. Total benchmarked: 72 projects. Version bumped to 1.5.0. |
| 2026-05-22 | Batch 4: HCL handler identified as P0 gap | terraform-aws-eks and terraform-aws-components both score 0%/0%/0%. PC indexes 0 files because .tf/.tfvars files have no handler. JC uses heuristic text extraction for HCL. Fix: implement HCL handler with tree-sitter-hcl WASM grammar, extracting variable/output/resource/data/module/locals blocks. |
| 2026-05-21 | Batch 3: Groovy/Java core-path boost identified as P0 gap | jenkins benchmark shows JC wins 32%/48%/56% vs PC 4%/8%/16%. Root cause: Java bare method names (`isBuilding`, `getDuration`) appear in hundreds of plugin classes; PC returns plugin implementations before `core/src/main/java/` methods. Fix: apply negative library-path penalty to `plugin/`, `vendor/`, `ext/` paths in Java repos, mirroring existing `vendor/node_modules/` penalty. |
| 2026-05-21 | Batch 3: R/Perl/Groovy ground truth — 9 new projects | Phase 58 (R+Perl) and Phase 64 (Groovy) complete. 9 new benchmark projects. PC wins 5/9 P@1; JC wins 1 (jenkins); 3 ties. Cumulative: PC 27/45 P@1 head-to-head. Total benchmarked: 56 projects. |
| 2026-05-21 | Batch 2: Harness dot-qualified name matching | Fortran/Elixir handlers store module-qualified names (`radiation_cloud.allocate_cloud_arrays`). Ground truth uses bare names. Harness now accepts a match when `name.split('.').pop() === expected` — mirrors the existing `::` C++ suffix match. Only fires for bare (non-qualified) expected symbols. |
| 2026-05-21 | Batch 2: case-insensitive extension in `file-discovery.ts` | `.F90` files not discovered because `entry.name.slice(dot)` returns `.F90` (original case) but `extensions` list has `.f90` (lowercase). Fixed: `if (!extensions.includes(ext.toLowerCase())) continue`. |
| 2026-05-21 | Batch 2: case-insensitive step-3b filter in `index-manager.ts` | After file-discovery finds `.F90` files, step 3b re-filters with `supportedExts.has(ext)` where `ext` was still uppercase. Fixed: `df.path.slice(dot).toLowerCase()` before set lookup. Without this, `.F90` files were discovered but silently dropped before reaching workers. |
| 2026-05-21 | Batch 2: 5 missing handlers in `indexing-worker.ts` | Workers have their own module registry (no shared state). fortranHandler, scssHandler, lessHandler, cssHandler, objectiveCHandler were not registered in `indexing-worker.ts` — files with those extensions reached workers but got 0 symbols. Added all 5 missing `registerHandler` calls. |
| 2026-05-21 | Batch 2: directory trailing-slash in `file-discovery.ts` | `ignore` npm package: `ig.ignores('deps/rabbit')` returns `true` even when `!/deps/rabbit/` negation is present, because the no-slash check matches `/deps/*` pattern. Fix: `const checkPath = entry.isDirectory() ? relPath + '/' : relPath` — appending `/` activates the directory-level negation logic in `ignore`. Fixed RabbitMQ `deps/` traversal. |
| 2026-05-20 | Phase 52: RUST_ONLY_SYNONYMS domain restriction | `future→poll`, `spawn→tokio/task`, `concurrent→parallel`, and serde synonyms now only fire when domain='rust'. Without scoping, `future→poll` caused `FutureBase::poll` to outscore `folly::Future` in C++ repos, blocking folly P@1. Matches the existing `RENDERING_ONLY_SYNONYMS` pattern. |
| 2026-05-20 | Phase 52: C++ bare local name in FTS content | `buildFtsContent` now appends the bare local name (`Future`) for `::` qualified symbols (`folly::Future`). Gives the local name a dedicated FTS5 token with boosted BM25 weight via repetition, improving single-word C++ queries. |
| 2026-05-20 | Phase 52: Harness qualified-name matching | Benchmark harness now accepts `folly::Future` as a match when ground truth expects bare `Future`. Uses `name.split('::').pop()` suffix comparison; only fires for bare (non-qualified) expected symbols to avoid false positives. |
| 2026-05-20 | Phase 52: Windows path-case fix in harness | `computeRepoId` is SHA-256 based and case-sensitive. Harness used `computeRepoId(repoPath)` (lowercase `d:/`) while `indexFolder` used `computeRepoId(resolve(rootPath))` (uppercase `D:/`), producing different hashes. Fix: use `indexResult.repoId` from the indexer rather than recomputing. |
| 2026-05-20 | Phase 52: test-mapper local try-catch | `buildTestMappings` now catches `writeAll()` failures locally and returns 0 rather than propagating. Prevents FK constraint errors in the test-mapper transaction from blocking subsequent FTS index population. |
| 2026-05-20 | Phase 52: C# interface member extraction | `extractMembers` adds `isInterface = typeNode.type === 'interface_declaration'` guard to skip visibility check for interface members (implicitly public in C#). Also fixes method name extraction: `methodName()` helper uses `findLast` before `parameter_list` to avoid returning the return type (first identifier) instead of the method name. Event field declarations (`event_field_declaration`) added as `property` kind. |
| 2026-05-20 | Phase 51: hasCppStyleMethods guard on class injection | Class-type secondary FTS injection (to fix C++ 0% P@1) was scoped to repos where method symbols contain `::` in their name. Prevents regression in Ruby/Rails repos (brew, mastodon, rails, discourse) where single-word class names would be outranked by compound injected symbols. |
| 2026-05-20 | Phase 51: Ruby DSL extraction (associations + callbacks) | Ruby handler now extracts `has_many`, `belongs_to`, `has_one`, `has_and_belongs_to_many`, `before_action`, `after_action`, `validates`, `scope` class macros as `property` symbols with DSL kind metadata. Improves brew/rails/mastodon symbol counts and search relevance for ActiveRecord model queries. |
| 2026-05-20 | Phase 51: Rust cfg frameworkMeta + cfgFilter param | Rust symbols annotated with `#[cfg(...)]` attributes now carry `frameworkMeta.cfgAttributes` array. `search_symbols` accepts a new `cfgFilter` string that restricts results to symbols whose cfg attributes match the filter string. |
| 2026-05-20 | Phase 51: get_lexical_scope_matches + trace_invocation_chain | Two new MCP tools: `get_lexical_scope_matches` returns all symbols accessible from a given file+line (local scope, imports, module exports); `trace_invocation_chain` follows call edges from a symbol N hops deep and returns the linearised call path. |
| 2026-05-20 | Phase 50: identityExact scaled for data kinds | Const/type/interface/enum/property symbols now get identityExact=40/N (min 10) in multi-word queries. Prevents STRIPE const or Subscribers struct from dominating when mentioned as context in a longer query. BM25 cap (30% when topBase≥80) kept. Fixes nestjs 76%→84% without breaking listmonk (28%). |
| 2026-05-20 | Phase 50: Multi-IDE install command | `npx purecontext-mcp install <tool|all>` injects PureContext workflow into Cursor (.cursor/rules/purecontext.mdc), Windsurf (.windsurfrules), Continue (.continue/config.json systemMessage), Cline (.clinerules), Roo Code (.roo/rules-code.md), VS Code (.github/copilot-instructions.md), Claude Desktop (platform config). All writers are idempotent via HTML markers. |
| 2026-05-19 | Phase 48: Rendering synonyms scoped via RENDERING_ONLY_SYNONYMS | Added set of rendering-only synonym tokens; expandVerbSynonyms/preprocessQuery/toOrFallbackQuery/rankSymbols accept optional `domain` param; search-symbols.ts detects rendering repos by name pattern (mitsuba, render, shader, etc.). Fixes nuxt/airodump/origamicms-frontend regressions. |
| 2026-05-19 | Phase 48: Claude Code hooks in Node.js | Cross-platform (Windows/Linux/macOS) without bash/PS1 split — Node is already a hard dependency. Three hooks: PostToolUse index hook, PreCompact snapshot, Edit Guard (soft, never blocks). |
| 2026-05-19 | Phase 48: Negative evidence in `search_symbols` | When 0 results after all fallbacks, return `verdict: "no_match"` to stop agents from re-searching with variant queries. |
| 2026-05-19 | `AGENT_REFERENCE.md` in project root | Full tool reference, navigation patterns, known limitations moved out of global CLAUDE.md. Always-on instructions trimmed to ~80 lines; reference loaded on demand. |
| 2026-05-18 | Phase 47: Java bare method names + C++ template class extraction | fleetdirect-android 0%: Java methods used qualified names. mitsuba3 0%: tree-sitter-cpp misparsed `class MI_EXPORT_LIB ClassName` as `function_definition`. Fix: detect misparse pattern, emit class symbol, walk body. |
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
npx purecontext-mcp hooks --install               # Install Claude Code hooks
npx purecontext-mcp install all                   # Auto-detect IDEs, prompts for scope
npx purecontext-mcp install all --scope=global    # Install globally without prompt
npx purecontext-mcp install cursor --scope=local  # Install for a specific IDE

# Claude Code integration
claude mcp add purecontext-mcp npx purecontext-mcp
```

<!-- purecontext-mcp-start -->
## PureContext MCP — Code Navigation

Always use PureContext MCP tools for code navigation. Never read entire files to find code.

### Mandatory workflow

1. **Start every session**: `list_repos()` → get `repoId` (required for all tools)
2. **Find code by name**: `search_symbols` → read `summary` and `signature` → only call `get_symbol_source` for symbols you will actually edit
3. **Find code by behaviour**: `search_semantic` for conceptual queries; `search_text` for literals/comments

### Key tools

| Goal | Tool |
|------|------|
| Find function/class by name | `search_symbols` |
| Find by what it does | `search_semantic` |
| Find literal string or comment | `search_text` |
| All symbols in a file | `get_file_outline` |
| What breaks if I change this | `get_blast_radius` |
| All callers of a function | `find_references` |
| Callers/callees tree | `get_call_hierarchy` |

### Anti-patterns — never do these

- Do not read whole files to find a function — use `search_symbols` + `get_symbol_source`
- Do not call `get_symbol_source` for every result — read `summary` first
- Do not skip `list_repos` — every tool needs a `repoId`
- Do not re-search after `verdict: "no_match"` — the symbol does not exist
<!-- purecontext-mcp-end -->
