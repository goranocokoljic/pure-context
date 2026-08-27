# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [1.27.0] - 2026-08-27 — Phase 94: Angular Integrity

From the Angular deep-dive audit (A-1…A-13): duplicate class rows, zero
class-field extraction, a doubly-dead HTML-template guard, route extraction
that never fired on real apps, and unverified Phase-70/73 fixes.

> **Re-index note:** Angular repos should be re-indexed once on this version
> to heal duplicate class rows (every `@Component`/`@Directive`/`@Pipe`/guard
> was stored twice under two ids) and to gain field, route, and template
> symbols. TypeScript repos in general gain class-field (`property`) symbols.
> No schema change.

### Fixed (correctness)

- **Duplicate Angular class rows killed** (A-1): the adapter re-emitted every
  decorated class under a second id (kind is inside the id hash). It now
  collects per-file facts and upgrades the TS handler's own row in place
  (android/react pattern) — kind + metadata + recomputed id, real spans,
  signatures, and docstrings preserved. One row per class. Functional
  `canX` guard consts stop duplicating their handler row too. Measured:
  872 duplicate rows removed across the three Angular benchmark repos;
  angular-realworld P@3 +8pp from de-duplication alone.
- **Abstract classes recognized** (A-9): `export abstract class` +
  `@Component`/`@Injectable`/guards now get Angular metadata (bitwarden has
  140 abstract classes in `.service.ts` alone).
- **Angular HTML sibling guard repaired** (A-3): the colocation check built
  `foo.component.component.ts` (a name that never exists) and resolved it
  against `process.cwd()` — dead code. It now checks `<stem>.ts` against the
  repo root, threaded to handlers via the new optional `HandlerContext`
  (worker parity included). Marker-less templates like angular-realworld's
  `app.component.html` are indexed again.
- **Angular HTML false positives killed** (A-5): claiming a `.html` file now
  requires TWO distinct Angular markers; event-binding and template-ref
  regexes are anchored to attribute position — plain HTML with `(e) =>`
  arrows, `href="#top"`, entities, or hex colors yields zero symbols.
- **Angular HTML spans** (A-6): every template symbol spanned the whole file;
  spans are now match-local true byte offsets, one symbol per distinct name.
- **Route extraction fires on real apps** (A-4): `forRoot(routesVar)` resolves
  the same-file `Routes` declaration (the dominant pattern — 11 sites in
  bitwarden matched none before); arrays are bracket-matched so nested
  `children`/`canActivate` no longer truncate; standalone
  `provideRouter(...)` and bare `const routes: Routes = [...]` are extracted;
  route symbols get real spans plus `component`/`guards`/`lazy` metadata.
  Cross-file route variables remain a documented limitation.
- **Guard detection heritage-only** (A-7): a service *mentioning* CanActivate
  in a comment/body is no longer reclassified to `middleware`; all guard
  interfaces (`CanActivateChild`/`CanDeactivate`/`CanMatch`/`CanLoad`) are
  recognized; guards keep `angular_injectable` alongside. Typed functional
  providers (`CanActivateFn`/`ResolveFn`/`HttpInterceptorFn` consts) become
  `middleware` with guard/resolver/interceptor metadata — the real-world
  `authGuard`/`errorInterceptor`/`bankAccountResolve` names the old
  `/^can[A-Z]/` rule missed.
- **NestJS never mislabeled** (A-12): angular wins the shared
  `.service/.module/.guard/...` suffixes by registration order (now
  documented at the registration site); files importing from `@nestjs/` are
  left completely untouched by the angular adapter — extraction AND
  enrichment. Multi-adapter integration test added (angular + nestjs in one
  repo, real bootstrap order).
- **`standalone` inversion fixed** (A-11): tri-state — explicit
  `standalone: true`/`false` recorded as written, absent = unknown (standalone
  is the Angular ≥19 default; the old code recorded absent as not-standalone).
  Standalone `imports: [...]` component deps captured as names.

### Added

- **TypeScript class-field extraction** (A-2, framework-neutral): the TS
  handler emits `property` symbols for class fields — decorated
  (`@Input`/`@Output`/`@ViewChild`), typed, and initialized fields
  (`signal(0)`, `fb.group({...})`, `users$` observables) — with qualified
  `Class.field` names, real spans, decorator names and explicit
  `private`/`protected` visibility in frameworkMeta, and the initializer head
  as FTS content. ECMAScript `#private` fields stay skipped (the method
  policy). Angular stamps `angular_signal` / `angular_injection` (inject
  token name) on top.
- **Angular detection beyond the root package.json** (A-8): `angular.json` /
  `workspace.json` at the root, or a bounded monorepo scan — Nx workspaces
  start working. fileFilter now also routes `*.routes.ts`, `app.config.ts`,
  `main.ts`, and the NgRx family (`.effects/.reducer/.facade/.store/.state.ts`).
- **`isAngularRepo` from repo evidence** (A-10): derived once per repo from
  the files table (angular.json anywhere, or ≥3 `.component.ts` files) instead
  of from the current search's candidate pool (chicken-and-egg; `.module.ts`
  also matched NestJS). Memoized; harness imports the same helper.

### Ranking (benchmark-gated)

- **Interceptor/guard boost extended to kind `middleware`**: the Phase-73
  boost (+30 on guard/interceptor-named symbols for guard/interceptor
  queries) only fired for kinds `function`/`class` — so the 586
  reclassification of functional guards to `middleware` silently cost them
  the boost (bitwarden gt-15 rank 1→5, jhipster gt-16 out of top-5,
  measured). NestJS adapter guards were ALWAYS middleware and were excluded
  from this boost since Phase 73. Fixed; bitwarden recovered to 16/20/24 and
  jhipster reached 36/44/60 — its best result.
- **Qualifier-word damp extended to TS fields**: new `Parent.field` symbols
  carry every parent name word and displaced sibling methods on
  angular-realworld (P@3/R@5 −8pp on first measurement). Query words matched
  only via the qualifier segment now count half for kind `property` in
  `.ts/.tsx` (the Phase-93 Vue member mechanism; damp only — the parent +15
  shadow transfer was deliberately NOT extended). Recovered realworld R@5 to
  72; guards all byte-identical; cal-com P@3 +4pp.

### Benchmarks

Fresh pre-94 baselines (v1.26.0) vs post-94 final: angular-realworld 36/60/72
→ 36/60/72 (flat scores, +44% searchable symbols; the 583 de-dup P@3 gain of
+8pp was traded back by field-symbol near-ties — recorded as Phase-95
evidence), jhipster 32/44/56 → 36/44/60 (P@1 +4, R@5 +4 — its best result),
bitwarden 16/20/24 → 16/20/24 flat with symbols 27,623 → 40,094 (+45%
searchable surface: fields, templates, routes).
Free wins on guards: excalidraw 4/36/36 → 8/44/52 (React class fields),
cal-com 36/48/64 → 36/52/68. All other guards byte-identical (nestjs-ecom
80/100/100, novu, infisical, trpc, nuxt, kurirfe, vismedic). This phase also
closes A-13: the Phase-70/73 Angular fixes are now benchmark-verified.

---

## [1.26.0] - 2026-08-27 — Phase 93: Vue/Nuxt Integrity

From the Vue/Nuxt deep-dive audit (V-1…V-13): phantom Nuxt symbols, dead
route metadata, splitter file loss, zero Options-API/Pinia extraction.

> **Re-index note:** Vue/Nuxt repos should be re-indexed once on this version
> to heal names/kinds (phantom `middleware`/`route` rows removed, `index.vue`
> components renamed, mode suffixes stripped) and to gain the new Options-API,
> Pinia, and `defineProps`/`defineEmits` symbols. FTS content changed
> (route paths + Pinia store ids indexed) — retrieval improvements need the
> re-index too. No schema change.

### Fixed (correctness)

- **Phantom Nuxt symbols killed** (V-1): `toNuxtRelative` treated ANY
  `plugins/`/`middleware/`/`server/`/`pages/`/`composables/` directory
  anywhere in a repo as a Nuxt app root — the nuxt benchmark repo carried 111
  fabricated `middleware` + 24 fabricated `route` symbols (~5% of its index).
  Convention dirs now count only near the repo root (≤ 2 leading segments, or
  3 under Nuxt 4's `app/`), and never under `src/`, `dist/`, `test/`,
  `tests/`, `__tests__/`, `fixtures/`, `runtime/`, `templates/`,
  `node_modules/`. Re-index verified: 135 phantoms → 1 real playground route.
- **SFC splitter never drops a whole file** (V-6): a `generic="T extends
  Record<string, any>"` attribute no longer breaks the script-tag regex
  (quote-aware attribute matching); `lang="tsx"` blocks now parse with the
  JSX-capable tsx grammar (previously the plain TS grammar failed on literal
  JSX → zero symbols); an unmatched `</script>` inside `<template>` (JSON-LD
  scripts) degrades to extracting the matching blocks with a warning instead
  of throwing the whole file away. A truly unterminated column-0 `<script>`
  still throws.
- **Vue detection is fixture-blind** (V-7): `test/`, `tests/`, `fixtures/`,
  `__fixtures__/`, `examples/`, `e2e/` are ignored by the vue/nuxt detection
  scans — PureContext's own repo no longer activates Vue and self-indexes its
  Zustand stores as `composable` (self-index guard test).

### Added

- **Options API / defineComponent / Pinia extraction** (V-4/V-5, the recall
  win): `.vue` script blocks with `export default { … }`,
  `defineComponent({ … })`, `defineNuxtComponent({ … })`, or Vue 2's
  `Vue.extend({ … })` now emit `method` symbols for `methods:`/`computed:`/
  `watch:`/lifecycle entries (`UserCard.fetchItems`) and `property` symbols
  for `props:` keys and `data()` return keys — with real spans and signatures.
  Pinia `defineStore('id', { actions, getters })` emits `method` symbols per
  action/getter (`useAuthStore.logout`) in ANY JS/TS file, and the store id
  becomes an FTS token. `defineProps`/`defineEmits` (script setup) emit
  `property` symbols per prop/emit name. Plain `.ts`/`.js` files without
  `defineStore` are byte-identical (regression-guarded).
- **Route paths are searchable** (V-2): `buildFtsContent` indexes
  `frameworkMeta.route_path` (raw + segment-split) for `route`/`component`
  kinds — framework-agnostic (Nuxt pages, Next.js, Flask, Django, Laravel,
  Rails-style adapters all store `route_path`). Nuxt page summaries are
  rewritten to `Page route /blog/:slug`.
- **JS Nuxt apps finally index** (V-8): `server/`/`plugins/`/`middleware/`/
  `composables/` accept all JS/TS extensions (`.js`, `.mjs`, `.mts`, `.cjs`),
  not just `.ts`.
- **Nuxt naming conventions** (V-9): mode suffixes (`auth.client.ts` → `auth`
  + `frameworkMeta.nuxt_mode: 'client'`); `index.vue` named after its parent
  directory (`components/user/index.vue` → `User`); optional params
  `[[id]]` → `:id?`; catch-all `[...slug]` → `**:slug` (as Nuxt renders it).
- **Test-fixture ranking penalty** (V-3): symbols under `test/`, `tests/`,
  `__tests__/`, `fixtures/`, `__fixtures__/`, `playground/` directory segments
  take −25 at rank time — unless the query itself asks for tests
  ("test"/"spec"/"fixture"). Stacks with the library-path penalty.

### Changed

- `.nuxt/` and `.output/` are built-in discovery excludes.
- Vue/Nuxt detection ported to the shared `detect-utils.ts` scanner
  (behavior-preserving; ~110 duplicated lines deleted); `toPascalCase` has a
  single implementation shared by adapters and the Options-API extractor.
- `resolveComponentName` also honours `defineComponent({name})` and
  Options-API `export default {name}` — as the docs already claimed.

---

## [1.25.0] - 2026-08-27 — Phase 92: React Adapter Integrity

From the React framework-support audit: the React adapter was a bare name
heuristic with three correctness bugs and zero ranking payoff.

> **Re-index note:** React and mixed (React + Vue/Svelte) repos should be
> re-indexed once on this version to heal stored symbol kinds (hooks stored as
> `composable`, PascalCase symbols wrongly stored as `component`). No schema
> change — this is adapter behavior, not stored-value corruption.

### Fixed (correctness)

- **Vue/Svelte no longer steal React hooks.** The `use*` → `composable`
  upgrade in the Vue and Svelte adapters is now gated to a positive extension
  allowlist (`.vue`/`.svelte` plus plain `.ts`/`.js`) — never `.tsx`/`.jsx`,
  never other languages (a Kotlin `useCase` no longer becomes a `composable`
  when Vue detection fires). This was the novu 0/0/0 root cause; Phase 88 had
  fixed retrieval only, the stored kind stayed wrong.
- **React enrichment is no longer repo-wide.** The component upgrade fires
  only in `.tsx`/`.jsx` files and requires true PascalCase (`API_URL`, `HTTP`
  stay `const`; PascalCase Go/Java/Kotlin symbols are never touched). The hook
  upgrade fires in `.tsx`/`.jsx`, or in plain `.ts`/`.js` files under a
  `hooks/` path segment — where it also re-claims a `composable` a Vue/Svelte
  adapter produced first (deterministic result regardless of adapter order).
- **Next.js adapter un-shadowed.** `nextjs` now registers BEFORE `react`
  (first matching adapter wins the file), so App Router pages finally produce
  `route` symbols, special files (layout/loading/error/not-found/template)
  produce `component` symbols, and the page's own symbols are still extracted.
- **`'use client'` / `'use server'` detection fixed.** The directive is found
  behind license headers (first-statement rule, 2KB scan) and both directives
  are recorded (`client_component` / `server_action`; App Router default
  `server_component: true`), on pages and special files.

### Added

- React `detect()` monorepo scan: nested `package.json` declaring react, or
  any `.tsx`/`.jsx` file (shared bounded `scanForFramework`).
- Ranker kind hints for `hook`/`composable` query words (+35 for the matching
  kind; pool-gated −20 for method/class so backend repos where "hook" means
  webhook are untouched). `composable` and `hook` are rank-time aliases,
  protecting Vue queries symmetrically. A `component` kind hint was measured
  and REVERTED in-phase: on Vue repos "component" appears in queries whose
  target is a factory function (kurirfe P@3 −8pp with the hint).
- `hasReactHookQuery` now also fires on "composable"/"composables" (Vue-audit
  V-11) — composable-phrased queries get the same OR-fallback and hook bonus.
- Pages Router pages record `frameworkMeta.ssr: true` (`getServerSideProps`)
  / `ssg: true` (`getStaticProps`) — the docs claimed this for years; now it
  is true.
- `template.tsx` recognized as an App Router special file.

### Changed

- `component` added to the Phase-50 data-kind identityExact scaling set
  (40/N instead of the full +60 on multi-word queries). Needed BY the kind
  reclassification: PascalCase consts in `.tsx` were already scaled as
  `const`; storing them as `component` un-scaled them and four `Organization`
  components displaced the asked-for fetch function (infisical gt-22).
- `hasFrontendVocab` false positives fixed: `user`, `usage`, `useful` no
  longer count as frontend vocabulary (use-prefixed tokens must match the
  `use[A-Z]` hook convention; computed once per query in `rankSymbols`).
- Mixed-monorepo detection broadened: a frontend (`frontend/`, `client/`,
  `web/`, `dashboard/`) or backend (`api/`, `server/`, `backend/`, `trpc/`)
  directory as first or second path segment now counts — covers infisical
  (`frontend/src`) and cal.com (`packages/trpc`), not just novu's `apps/*`.
- Docs brought down to what the code does (JSX-return detection and the
  middleware `matcher` extraction are NOT implemented; stated plainly).

---

## [1.24.0] - 2026-08-26 — Phase 91: Index Durability at Scale + Install UX

From the reporter's installation runbook on a ~90k-file polyrepo: an index of
that tree ran 110 minutes and committed ZERO rows (one unbounded transaction),
and the installer was called "a trap". Both fixed.

### ⚠ Installer behavior change (user-visible)

- **`install claude` / `install all` no longer install hooks by default.**
  Default = MCP registration + instruction block only. Opt in with
  `--with-hooks`. `hooks --install` remains the explicit path.
- **The PreToolUse per-edit stderr reminder is now opt-in**
  (`--with-reminders`); re-running the installer without the flag removes a
  previously installed reminder. All other hook events were verified against
  current Claude Code documentation (WorktreeCreate, WorktreeRemove,
  TaskCompleted, SubagentStart all exist) and are kept.
- The installer prints exactly what it will write, where, BEFORE writing.
- The injected instruction block was rewritten as defaults-with-exceptions
  (roughly half the size, no absolutist rules that fight other instructions).

### Fixed (critical)

- **Chunked index commits.** `index_folder` commits every N files
  (`indexing.commitBatchSize`, default 500; 0 = old single-transaction
  behavior) with a passive WAL checkpoint per batch. A killed run keeps every
  committed batch and resumes via the content-hash cache. Response gains
  `batchesCommitted`. Peak memory also drops: parse results are held one
  batch at a time.
- **User excludePatterns now override the repo .gitignore.** Precedence is
  built-ins → .gitignore → user patterns, so `!protected/` in config can
  rescue a nested repo the root .gitignore hides. Discovery also reports
  top-level directories dropped entirely by ignore rules (`excludedDirs` with
  rule source).

### Changed

- **`better-sqlite3` moved to optionalDependencies** — `npm install` succeeds
  on any Node ≥ 18 without a C++ toolchain; the Phase-78 WASM tier takes over
  at runtime. `config --check` now reports the active SQLite tier. Prebuild
  targets extended toward current Node lines.
- New docs: `docs/28-operations.md` (scoped indexes, verification recipe,
  branch discipline, privacy defaults, PCTX_DATA_DIR) — the runbook's
  operational knowledge, official.

---

## [1.23.0] - 2026-08-26 — Phase 90: Offset Integrity (char-vs-byte fix)

The `start_byte`/`end_byte` columns now hold TRUE byte offsets on every
encoding. Previously, tree-sitter node indices (UTF-16 code-unit indices into
the decoded string) were stored as byte offsets, so every consumer that sliced
raw bytes returned shifted source on any file containing non-ASCII text
(em-dashes, box-drawing dividers, CJK, emoji, or a UTF-8 BOM). On
PureContext's own repo, 95% of files were affected; `get_symbol_source` could
start ~8 lines early and end mid-statement.

### Fixed (critical)

- **Stored symbol spans are true byte offsets.** New `src/core/offsets.ts`
  converter (ASCII identity fast path — zero cost on ASCII files); conversion
  happens once per file in `file-processor.ts` at the storage boundary, for
  tree-sitter handlers AND framework adapters. Regex-only handlers already
  computed true bytes and are unchanged.
- **SFC block spans no longer mix char and byte math.** Adapter preProcess
  blocks convert block-local char indices to bytes BEFORE adding the byte
  offset of the block within the file.
- **`analyze_diff` hunk attribution** is exact on non-ASCII files (was: hunks
  could be attributed to the wrong symbol entirely).
- **Query-time re-parse tools** (`search_ast`, `search_by_decorator`,
  `get_lexical_scope_matches`) now operate purely in char space on the decoded
  string — exact snippets and line numbers; `search_ast` response
  `startByte`/`endByte` are converted to true bytes.
- **Handler-internal signature slicing** in the Go/JavaScript/Python/Ruby
  handlers no longer garbles text after multi-byte characters
  (`Buffer.toString('utf8', charIdx, charIdx)` misuse).

### Changed

- **Schema version 10 → 11** (values-correctness bump, no DDL change). Pre-v11
  indexes hold corrupted spans; `index_folder` force-re-parses them once to
  heal, and `check_index_staleness` reports a `schemaWarning` until then.
- Five duplicate byte→line implementations consolidated onto
  `symbol-lines.ts` / `core/offsets.ts` (one implementation, one test suite).

---

## [1.22.0] - 2026-08-26 — Phase 89: Graph Integrity + Edge Hygiene

Driven by the 1.18.0 verification report on a production Android automotive
tree (and its follow-ups). Headline: the graph is now correct when built AND
stays correct as it is used.

### Fixed (critical)

- **Incremental re-index no longer destroys the dependency graph.** Re-parsing
  a file used to delete its INCOMING edges too (they only regenerated when each
  importer was itself re-indexed), so the prescribed `index_file`-after-write
  loop rotted the graph monotonically. Reprocessing now clears outgoing edges
  only; both-direction deletion is reserved for files actually removed from
  disk.
- **Newly added files now receive incoming edges.** Raw import statements are
  persisted per file (schema v9 → v10, `import_records` table), so when a new
  file arrives the graph re-resolves from stored records — no re-parsing.
  Pre-v10 indexes re-parse once, automatically, to backfill.
- **`index_folder` prunes files that vanished from disk** (`filesPruned` in the
  response). An in-place branch switch previously accreted the union of every
  branch ever indexed; only deleting the database recovered. Worktree-per-branch
  guidance is now documented as the intended pattern.

### Added

- **`graph.reservedNamespaces` config** (default: `android`, `androidx`,
  `java`, `javax`, `kotlin`, `kotlinx`, `dalvik`, `com.android.internal`,
  `sun`, `jdk`): imports of platform namespaces never resolve to local files —
  vendored AOSP shims and unit-test stubs declaring `package android.util` no
  longer capture `import android.util.Log` (31% of edges on the report's
  corpus). `[]` disables (AOSP-fork opt-out). Applies to DI-edge type matching
  BEFORE package stripping.
- **Production → test-source-set edges eliminated** (28.6% of edges on the
  report's corpus): a shared test-path predicate (`src/core/test-paths.ts`,
  replacing five private copies) now covers Gradle (`src/test/`,
  `src/androidTest/`, `src/testFixtures/`) and .NET (`*.Tests/`) layouts;
  resolvers and DI edges drop test-set candidates for non-test importers.
- **Blast-radius honesty:** `get_blast_radius` now returns
  `granularity: "file"`, the effective `depth`, and `truncated: true` when the
  walk hit its depth cap with unexplored dependents (previously a silent
  cutoff); descriptions corrected (edges are file-level).
- **Library entry point:** `import { bootstrapLibrary, indexFolder } from
  'purecontext-mcp/lib'` drives the indexer programmatically with no MCP
  server side effect.

### Changed

- **ONE registration list** (`src/core/bootstrap-registry.ts`) replaces four
  hand-kept handler/adapter lists that had drifted (the benchmark harness's
  secondary runner had 21 of 41 handlers; adapter ORDER differed between main
  process and workers).
- The test suite writes to a temp directory via `PCTX_DATA_DIR`
  (`test/setup.ts`) — `npm test` no longer touches `~/.purecontext`.
- `src/graph/di-edges.ts` and `src/server/tools/compare-change-impact.ts` no
  longer contain raw NUL bytes (git diff/blame/grep work again; PureContext can
  index its own source). A hygiene guard test keeps the whole `src/` tree
  NUL-free and asserts `src/version.ts` matches `package.json`.

---

## [1.21.0] - 2026-08-26

### Fixed

**Phase 88 — Search-Quality Repair Sweep.** Benchmark-driven repair of the known hard zeros and the two biggest retrieval/ranking defects. Each fix was diagnosed retrieval-vs-ranking first; ranking changes are per-language gated (no global formula change).

- **SQL (`sql.ts`): `@extschema@.` placeholder support.** TimescaleDB-style PGXS extension scripts declare their entire public API as `CREATE FUNCTION @extschema@.name(...)` — the placeholder made the CREATE regex fail and none of those functions were indexed. `CREATE TABLE/VIEW/FUNCTION/PROCEDURE` now accept an optional `@schema@.` prefix (stripped from the stored name). timescaledb benchmark: 0/4/8 → 60/76/84 (P@1/P@3/R@5).
- **OpenAPI (`openapi.ts`): one-pass key-offset index.** `findKeyOffset` re-scanned the whole buffer per path/schema — O(keys × bytes), 6.2 s for one 10 MB GitHub spec, hours for large spec repos (the real cause of the old "rest-api-description: 3+ hours, 0 files" report; the previously blamed `\w+` regex never existed). `buildKeyOffsetIndex` builds byte offsets in two O(bytes) passes (line-anchored YAML/pretty-JSON keys + quoted keys anywhere for minified JSON; non-ASCII-safe); the old scan remains as fallback on map miss. 11× faster per file.
- **FTS (`symbol-store.ts`): UI-kind alias tokens.** Symbols of kind `hook`/`composable` now index the tokens "hook composable" (cross-framework synonyms) and `component` indexes "component". Hook names never contain the word "hook", so vocabulary queries ("hook to create a workflow") could not retrieve them into the FTS candidate pool at all on large mixed monorepos. novu: 0/0/0 → 28/28/40.
- **Search (`search-symbols.ts` + harness): OR-fallback on near-empty AND pools.** The OR merge now fires when the AND pool has fewer than 5 candidates (was: only 0) — a near-empty AND pool means low recall, not precision; AND hits still rank first.
- **Ranker (`relevance-ranker.ts`), Java/Groovy-gated (auto-active for Java-dominant pools):** (1) single-token generic-verb names (`run`, `execute`, `get`, …) have identityExact scaled to ⅓ on multi-word queries — they hit +60 via one query word or its verb synonym and outranked the real target on nearly every jenkins query; (2) new `camelCompoundBoost` +30 when ALL camelCase name parts appear in the query (analog of the underscore compound boost). jenkins: 4/8/12 → 36/60/72 (now ahead of the competitor's 32/48/56); gradle 8/12/20 → 16/32/44; groovy 12/24/36 → 32/44/44; maven 52/52/56.
- **Ranker, Haskell-gated (`.hs`/`.lhs`):** queries announce the kind ("function that…", "record…", "sum type…") — honour it both ways (+35 matching kind, −20 contradicting kind), and penalize spaced typeclass-instance/constructor names (−15) that outrank the real type by word overlap. postgrest-hs: 0/28/36 → 16/40/52; pandoc 0/4/8 → 8/20/20.
- **Swift (`swift.ts`): extension ID collision.** `extension Foo` in the same file as `class Foo` produced the same symbol ID and `INSERT OR REPLACE` let the last extension overwrite the primary declaration — destroying its doc comment (swift-nio: every `ChannelPipeline` row was a bare "Swift extension:" stub). Extension IDs are now keyed by byte position. swift-nio: 0/4/4 → 4/8/12.
- **Objective-C (`objective-c.ts`): GNUstep `GS_GENERIC_CLASS` macro.** `@interface GS_GENERIC_CLASS(NSArray, __covariant ElementT)` captured the macro as the class name, so NSArray/NSString/NSDictionary/… were entirely absent from the libs-base index. The macro call is normalized to its first argument before interface matching.
- **Benchmark harness parity (`run_benchmark.ts`):** the harness's dim2 search path had silently drifted from production — it lacked the Phase-71 hook OR-fallback clause AND passed no `RankOptions` to `rankSymbols` (mixed-monorepo/frontend/Java-Groovy/Angular boosts were never measured). It now imports the production helpers (`hasReactHookQuery`, `detectMixedMonorepo`, `detectJavaGroovyMixed` — newly exported) instead of duplicating them.

### Benchmark notes

18 repos re-run; full per-repo movement table with coverage-vs-ranking attribution in `dev-docs/benchmarks/BENCHMARK-RESULTS.md` ("Phase 88 re-run notes"). nuxt's drop from the Phase-49-era table value is a stale-baseline correction (isolation-verified pre-88; Phase 75 predicted the shift when `.vue` indexing was fixed); nestjs-ecommerce 84→80 is run-to-run FTS-pool-boundary variance on a 2-point margin, not a Phase-88 effect.

---

## [1.20.0] - 2026-08-26

### Added

**Rust: mod-tree import resolution + crate-visibility indexing.** Rust repos previously indexed to zero dependency edges (every `use crate::…` was an unresolvable bare specifier) and skipped every non-`pub` item — both Phase 82 bug classes. After one re-index, `get_blast_radius`, `find_importers`, `find_cycles`, the architecture tools, and the centrality axis of `get_symbol_risk` work on Rust repos.

- **`src/graph/rust-resolver.ts`** — the only family that needs a real module TREE, not a flat map. Crate boundaries come from the nearest ancestor `Cargo.toml` (crate names dash→underscore normalized; a Cargo-less repo falls back to the repo root); the module map is derived from the file layout under `src/` (`src/a/b.rs` and `src/a/b/mod.rs` both answer to `a::b`; 2015 + 2018 layouts). `crate::`/`self::`/`super::` (chains included) resolve against the source file's own module position; a bare leading segment resolves as a top-level module of the own crate (2018 uniform paths) or as a same-workspace crate by name; `std`/crates.io imports produce no edge. Leaf items check the symbol table scoped to the resolved module's files, falling back to the module file itself (inline `mod` blocks, macro-generated items — over-approximation is the safe direction). Globs expand to the module subtree, capped by `graph.maxWildcardFanout`.
- **Rust handler `use` extraction extended** — grouped uses are flattened to one record per leaf (`use a::{b, c::{d}}` → `a::b` + `a::c::d`), leading `crate`/`self`/`super` keywords are preserved (previously `use crate::{a, b}` lost the `crate`), globs are marked with `importedNames: ['*']`, and renames carry the ORIGINAL path (`use a::b as c` → `a::b`).
- **Everything is indexed now** (the Kotlin-`internal` rule): `pub` items carry no metadata; `pub(crate)`/`pub(super)`/`pub(in …)` record `frameworkMeta.visibility: 'crate'`; no-modifier items (module-private, but visible to child modules and the same file — Rust has no true `private`) record `'module'`. Kills the false `no_match` → confident-wrong-answer chain for the most-searched symbols.
- **Ranker**: the mild `-20` unexported-visibility penalty (Go, v1.17.0) now also applies to `visibility: 'module'`, so module-private helpers stay findable without outranking the public API on natural-language queries; `'crate'` is not penalized. Exact-name searches still surface penalized symbols first (identityExact +40).

### Known limitations (documented)

- `#[path]` overrides, `build.rs`-generated modules, and `macro_rules!` expansion are not followed; `#[cfg]`-conditional mod trees index all branches (over-approximation; cfg metadata exists since Phase 51). Cross-crate edges via Cargo path-dependencies resolve only for crates indexed in the same repo.

---

## [1.19.0] - 2026-08-26

### Added

**Declared-Module Wave 2 — dependency edges for PHP, Haskell, Elixir, Erlang, and Fortran.** Five more languages that previously indexed to zero dependency edges now build graphs, riding the Phase 82/84 family-resolver seam. `get_blast_radius`, `find_importers`, `find_cycles`, the architecture tools, and the centrality axis of `get_symbol_risk` work on these repos after one re-index.

- **PHP** (`src/graph/php-resolver.ts`): `use X\Y\Class` resolves via the file's declared `namespace` (new `extractPackage` on the PHP handler → `files.declared_package`) plus the fully-qualified symbol table, with composer.json PSR-4 maps (`autoload` + `autoload-dev`, root and nested, memoized) as the fallback for files without a namespace row. Whole-namespace uses (`use App\Models;`) expand to all namespace files, capped by `graph.maxWildcardFanout`. Cross-package ambiguity prefers the importing file's own composer.json root, else edges to all candidates. Multi-namespace files store only the first namespace (v1 limitation).
- **Haskell** (`src/graph/haskell-resolver.ts`): `import A.B.C` resolves by exact declared module header (`module A.B.C where`, new `extractPackage` on the Haskell handler) — one module per file, no member lookup. Headerless files fall back to a dotted path-suffix match (`src/App/Core/Run.hs` answers to `App.Core.Run`).
- **Elixir** (`src/graph/elixir-resolver.ts`): `alias`/`import`/`use`/`require` resolve against the `defmodule`/`defprotocol` SYMBOL map (multiple modules per file are legal), with a longest-known-prefix fallback for nested module names.
- **Erlang** (`src/graph/erlang-resolver.ts`): module == file basename, so `-import(mod, …)` (and `mod:fun` specifiers) resolve to `mod.erl`; basename collisions edge to all candidates. The handler now also emits `-include` / `-include_lib` directives, resolved by `.hrl` basename — the previous "always external" hardcoding is gone.
- **Fortran** (`src/graph/fortran-resolver.ts`): `USE module_name` resolves to the files declaring `MODULE module_name` (case-insensitive, as Fortran is).

### Changed

- `buildGraph` now dispatches family resolvers through one extension → resolver map instead of a growing per-family if-chain; `buildFamilyResolvers` is table-driven. TypeScript/JavaScript output is byte-identical (regression-guarded), and the Phase 82 bare-`JvmResolver` back-compat still holds.
- The empty-graph honesty note (`graphCoverage: 'empty'`) now names the remaining unresolved languages (Rust, Ruby, long tail) and the re-index version per resolver family.

---

## [1.18.0] - 2026-08-26

### Added

**Android framework adapter** (`android`) — Compose, Hilt/Dagger, manifest entry points, and Gradle module structure become first-class on Android repos. Detected by an `AndroidManifest.xml` anywhere in the tree or `com.android.application`/`com.android.library` in a `build.gradle(.kts)` (bounded recursive scan — multi-module is the Android default). Handles `.kt`, `.java`, and `AndroidManifest.xml`; registered ahead of the other JVM adapters so it wins Android sources (a Ktor/Spring server repo is unaffected — detection keys on Android markers).

- **Compose:** `@Composable` functions upgrade to kind `composable` (handler spans/signatures preserved); `@Preview` composables carry `frameworkMeta.preview: true` so they can be filtered from API surfaces.
- **Hilt/Dagger DI metadata:** `@Module`, `@Provides`/`@Binds` (+ `providedType`), `@Inject` constructors/fields (+ `consumedTypes`), `@HiltViewModel`, `@AndroidEntryPoint`, and scope annotations are recorded in `frameworkMeta.di` — Kotlin and Java.
- **DI dependency edges** (`src/graph/di-edges.ts`): at graph-build time, DI metadata becomes `di` edges (consumer file → provider file, specifier `di:<TypeName>`) — the coupling import analysis misses, because Hilt consumers never import their providers. Classes with `@Inject` constructors count as providers of their own type. Name-based matching; ambiguous names edge to **all** providers (over-approximation, safe for blast radius). Graph tools pick the edges up automatically; `find_cycles` excludes `di` edges (the `@Binds` module ↔ impl pair is by design, not a cycle).
- **Manifest entry points:** `<activity>`, `<service>`, `<receiver>`, `<provider>` → `route` symbols with `component`, `exported`, `intentFilters`, and a `launcher` flag; leading-dot names resolve against the manifest `package`. `get_entry_points` gains the `android_component` kind — the LAUNCHER activity ranks first.
- **Gradle modules:** every `.kt`/`.java`/manifest symbol carries `frameworkMeta.gradleModule` (`:app`, `:feature:login`, `:` = root) derived from the path before the first `src/` segment, plus a documented recipe for turning the module list into a `get_layer_violations` layer config.

### Fixed

**Adapter-routed files with regex-only handlers were dropped.** `processWithAdapter` always ran the tree-sitter parse; a file routed to an adapter but owned by a grammar-less handler (e.g. `AndroidManifest.xml` → XML handler) threw and lost all its symbols. The adapter path now mirrors the normal handler path: regex handlers extract without a parse, and handler `detect()` gates are honoured.

---

## [1.17.0] - 2026-08-26

### Fixed

**Go unexported symbols are now indexed.** Names with a lowercase first letter were skipped entirely, so `search_symbols` returned a false `no_match` for package-private helpers, structs, consts, and interface methods — the same bug class fixed for Kotlin `internal` (1.15.0) and C# `internal` (1.16.0). Unexported names are package-visible and the package sits inside the indexed unit, so they must stay findable. Visibility is recorded in `frameworkMeta.visibility: 'unexported'`; exported names carry no metadata. The relevance ranker applies a mild −20 penalty to unexported symbols so the exported API still wins natural-language queries, while an exact-name search surfaces the unexported symbol first. `get_public_api` is unaffected.

### Added

**Python dependency edges.** Python imports now resolve to in-repo files, so `get_blast_radius`, `find_importers`, `find_cycles`, and the other graph tools work on Python repos (previously: zero edges — every import looked external). Module identity is the file path (`a/b.py` ↔ `a.b`, `a/b/__init__.py` ↔ `a.b`); `src/` layouts and other non-package first-level source dirs are stripped, so `mypkg.core` finds `src/mypkg/core.py`. Relative imports (`from . import x`, `from ..pkg import y`) resolve by exact directory walk; `from a.b import c` prefers the submodule `a/b/c.py`, else the module file itself (symbol-table tiebreak on ambiguity). Unknown modules (numpy, django) produce no edge. Not yet supported: `sys.path` manipulation, editable installs, `pyproject` package-dir remapping. Repos indexed before 1.17.0 need one re-index to build the edges.

**Go dependency edges.** Go imports now resolve via `go.mod`: every `go.mod` above an indexed `.go` file contributes its `module` directive (nested modules / workspaces supported, longest prefix wins, `/v2` suffixes handled). An import path resolves to **every** indexed `.go` file of the target package directory — the true Go package semantic. `_test.go` files are included; stdlib and third-party imports produce no edge; edges are never emitted into `vendor/`. Build tags and cgo are ignored. Repos indexed before 1.17.0 need one re-index to build the edges.

**Per-family resolver dispatch.** `buildGraph` now accepts a family-resolver map (`{jvm?, python?, go?}`); each family's resolver is built only when the index batch contains that family's files, so TypeScript-only repos pay nothing (output byte-identical, regression-guarded).

---

## [1.16.0] - 2026-08-26

### Fixed

**C# visibility: `internal` and modifier-less types are now indexed.** Previously only explicit `public`/`protected` symbols were extracted, so `internal` types AND types with no modifier (implicitly internal — very common) were missing from the index entirely. C#'s asymmetric defaults are now respected: a type with no modifier is internal (indexed, with `frameworkMeta.visibility` recorded), while a member with no modifier is private (still skipped). Explicit `private` / `private protected` stay excluded. On the C# benchmark repos this grew the index 1.6–2.5× and lifted Recall@5 by 16–36 points.

### Added

**C# dependency edges.** `using` directives now resolve to in-repo files via each file's declared `namespace` (file-scoped or outermost block), on the same declared-module resolver that serves the JVM family since 1.15.0. A plain `using X.Y` imports the whole namespace and produces edges to every file declaring it; `using static` and alias usings resolve to the type's file; cross-project ambiguity prefers the importing file's own `*.csproj`/`*.sln` project. `get_blast_radius`, `find_importers`, `find_cycles`, and the other graph tools now work on C# repos. Repos indexed before 1.16.0 need one re-index to populate the namespace data.

**New config `graph.maxWildcardFanout`** (default 100, `0` = uncapped): caps how many files a single wildcard/namespace import may expand to (deterministic order, one warning per index build). Applies to C# namespace usings and JVM wildcard imports alike.

---

## [1.15.0] - 2026-08-26

### Fixed

**JVM repos no longer index to zero dependency edges.** Bare JVM import specifiers (`import com.example.Bar`) were treated as external packages, so every Kotlin/Java/Scala/Groovy repo produced an empty dependency graph — silently disabling ~17 graph tools (`get_blast_radius`, `find_importers`, `find_cycles`, the architecture tools, the centrality axis of `get_symbol_risk`, …). Imports are now resolved via each file's declared `package` header, captured at index time into a new `files.declared_package` column (schema v8→v9, additive — old indexes load without re-index, but need one re-index to populate the package data).

**Kotlin `internal` symbols are now indexed.** Only `private` declarations are skipped. `internal` is module-visible, and the module is exactly the unit being indexed — dropping it made `search_symbols` return false `no_match` for the most-searched symbols (impl classes, DI modules). Visibility is recorded in `frameworkMeta.visibility`.

### Added

**JVM import resolver** (`src/graph/jvm-resolver.ts`): longest-package-prefix resolution → basename match → symbol-table fallback (Kotlin top-level member imports); wildcard imports per handler shape (Kotlin/Java bare package names, Groovy `.*`, Scala `._` and `{A, B => C}` selectors). Cross-module ambiguity prefers the importing file's own Gradle/Maven module (`build.gradle` / `build.gradle.kts` / `pom.xml`), otherwise edges go to **all** candidates — over-approximating is the safe direction for blast radius. TypeScript/JavaScript resolution is byte-identical (regression-guarded).

**Honesty signals.** `index_folder` now returns `limitReached` + `totalBeforeLimit` instead of silently truncating at the file limit. Graph tools (`get_blast_radius`, `find_importers`, `get_context_bundle`, `find_cycles`, coupling) attach `graphCoverage: 'empty'` + a note when a ≥20-file repo has zero edges — an empty result means "no graph", not "safe to change".

**Excludes:** `.gradle/` and `.idea/` added to the built-in exclude list.

### Documentation

- LANGUAGE-SUPPORT.md gained a per-language dependency-edge matrix (replacing the incorrect "every language" claim); AGENT_REFERENCE.md limitation row, README, and docs/09 updated with the external-vs-unresolvable distinction.

---

## [1.14.0] - 2026-06-29

### Changed

**Agent instructions now teach the change-safety workflow.** The always-on rules that `install` writes into every IDE (Cursor, Windsurf, Cline, Copilot, Continue, Claude) previously covered only navigation. They now teach the full close-the-loop workflow introduced in 1.8.0–1.13.0:

- **Orient** with `get_task_context`, then **before editing** run `prepare_change` (existing code) or `check_consistency` (new code), **edit**, **refresh** with `index_file`, **verify** with `verify_change`, and gate a merge with `merge_readiness`.
- The gate-envelope contract (`{ gate: "pass" | "warn" | "block" }`) and the `index_file`-not-`index_folder` mid-task freshness rule are now explicit.

This makes the tools shipped in 1.8.0–1.13.0 discoverable to agents — previously they existed but the installed guidance never mentioned them.

**Agent rules are now single-sourced** from `assets/agent-rules.md` (shipped in the package). The `install` command reads it at runtime, so the rules can no longer drift from a hardcoded copy.

### Documentation

- Documented the full tool surface for 1.10.0–1.13.0 that was missing from the public docs: `index_file`, `check_index_staleness`, `check_consistency`, `merge_readiness`, the gate envelope, `get_task_context` associative mode, the `index-file` CLI subcommand, and the `consistency.*` / `taskContext.*` config blocks.
- Noted `get_task_context`'s no-embeddings behavior: seed discovery falls back to FTS token matching, so a pure natural-language task that shares no tokens with indexed symbols returns no seeds (reported in `suggestedProbes`) — configure embeddings, phrase with real terms, or fall back to `search_symbols`.

---

## [1.13.0] - 2026-06-28

### Added

**Active context reconstruction — `get_task_context` associative mode**

`get_task_context` no longer does a single-shot "top-N similarity → one AI selection" pass. In the new default `associative` mode it discovers seed symbols, then **walks the real dependency and temporal graph** around them — imports (forward deps), callers (reverse deps via blast radius), and historically co-changing files — so a structurally essential but lexically dissimilar symbol (a dependency, a caller, a co-change partner) can now be selected.

- Each returned item carries a `role` **derived from the graph edge that surfaced it** (`dependency` / `caller` / `historical` / `primary`), plus a `provenance` object (`{ via, seedId?, confidence? }`). The AI keeps only the prose `relevanceReason`.
- New top-level `evidenceGaps` (`lowConfidenceSeeds`, `droppedByBudget`, `unselectedCoChange`) and `suggestedProbes[]` tell the agent what it still hasn't seen — the agent is the router and decides whether to probe further (no server-side reflective loop).
- Works **with zero embeddings**: when no AI/embedding provider is configured, results rank by graph provenance instead of keyword similarity — the floor rises from "top-N keyword guess" to "seeds + real graph neighborhood" (pure SQL).
- `_meta` gains `mode`, `seedsExpanded`, and `poolSize`.
- Pass `mode:"flat"` for the legacy single-pass similarity selection — **byte-identical to pre-1.13.0 output** (regression-guarded).

These are thin consumers of existing engines (`get_context_bundle`, `get_blast_radius`, `get_co_change`) — no new analysis engine.

### Configuration

- `taskContext.seedCount` (default 8) — top-N discovery hits expanded via the graph.
- `taskContext.expansionDepth` (default 1) — dep-graph hops walked per seed (forward + reverse).
- `taskContext.maxPool` (default 60) — candidate pool cap before ranking.
- `taskContext.maxCoChangePartners` (default 5) — co-change partner files pulled per seed.
- `taskContext.maxSymbolsPerPartner` (default 5) — symbols pulled per co-change partner file.

---

## [1.12.0] - 2026-06-28

### Added

**Harness Loop Fit — making PureContext usable inside automated codegen harnesses**

PureContext is the persistent cross-process brain a harness lacks: it tells the generating agent what already exists, what it's drifting from, and what it forgot — without re-reading the codebase from scratch every run. New tools across index freshness, greenfield consistency, and brownfield merge-gating:

- **`index_file`** — targeted re-index of one or a few files **without** the full-tree discovery pass `index_folder` performs (O(one file), independent of repo size). This is the mid-run freshness path: call it after writing a file so subsequent searches reflect current state. Firing `index_folder` after every edit is discovery-bound and stalls; `index_file` does not.
- **`check_index_staleness`** — cheaply check whether the index is current with no discovery pass. Pass `filePaths` for a per-file `fresh`/`stale` verdict (stored content hash vs disk); omit them for a repo-level summary. Use at task start to choose a cold `index_folder` vs targeted `index_file`.
- **`check_consistency`** — the greenfield pre-write front door: given an intended new symbol (name/kind/signature/target dir) it returns `duplicates` ("you already wrote this"), `patternFit` (sibling exemplars), `placement`, and `existingApiPointer`. Runs on **structural search alone — no embedding provider required** (`mode:"structural"`); `signalQuality:"low"` suppresses dedup on a sparse index.
- **`merge_readiness`** — one pre-merge go/no-go that folds `verify_change` (completeness vs the prediction) and `compare_change_impact` (architecture regression vs a baseline snapshot) into a single `{ gate, reasons[], unresolved[] }`. Thin consumer — no new analysis.

**Normalized gate envelope.** `prepare_change`, `verify_change`, `compare_change_impact`, `check_consistency`, and `merge_readiness` each return a stable `{ gate: "pass"|"warn"|"block", gateReasons[], nextAction }` a harness can branch on with a single field — additive to their detailed verdicts.

**`index-file` CLI subcommand + PostToolUse hook.** The Claude Code PostToolUse hook now calls the cheap targeted re-index (`purecontext-mcp index-file --repo <dir> <file...>`) instead of a full `index-folder`, bootstrapping a full index automatically the first time a repo is seen.

**`docs/HARNESS-CONTRACT.md`** — greenfield + brownfield loop recipes, freshness rules (`index_file` mid-run, never `index_folder`), and the stable gate-envelope contract.

### Fixed

- **No-op re-index churn.** `index_folder` used to skip persisting the content hash for files that yield 0 symbols and 0 imports, so those files were re-read and re-parsed on every run. The hash is now always persisted (delete-then-upsert even when empty), so a true no-op reports `filesIndexed: 0`. `reindexFiles` also now clears stale rows when an edit empties a file's last symbol (parity with a full index).

### Configuration

- `consistency.maxDuplicates` (default 5) — max duplicate candidates returned by `check_consistency`.
- `consistency.maxPatternFit` (default 5) — max sibling/pattern-fit exemplars returned.
- `consistency.maxApiPointer` (default 20) — max existing-symbol names listed for the target directory.

---

## [1.11.0] - 2026-06-14

### Added

**Refactoring loop — `prepare_change` → `verify_change` → `compare_change_impact`**

Three new read-only tools that turn PureContext from "flags risk" into "confirms the change was safe and complete." They are **judgment, not actuation** — none of them edit code; your agent applies the change, and these tell it what's safe and what's still missing, each with a plain-English `reasons[]` (not a bare confidence score). All three are thin consumers of the existing change-synthesis engine.

- **`prepare_change`** — pre-edit verdict for a stated `intent` (`rename` / `delete` / `modify` / `extract`) and a target (`targetSymbolId` or free-text `query`). Resolves the concrete change set and returns the predicted files, composite risk, historically co-changing files MISSING from the change (the "you forgot to touch X" signal), recommended tests, coverage gaps, architectural flags, and a `predictionId`. Returns `ambiguous_target` with candidates when a query has no clear match — it never guesses.
- **`verify_change`** — post-edit reconciliation of the real diff against the prediction: `unaddressedCoChange` (planned partners still untouched), `addressedCoChange`, `unplannedChanges` (scope creep), and `coverageGapsRemaining`. Verdict `complete` / `incomplete` / `scope_expanded`. Stateless — pass `predictedFilePaths` and `predictedCoChange` back from the prepare_change output. Co-change reconciliation is suppressed when the git signal is low.
- **`compare_change_impact`** — before/after architecture *regression* delta against a baseline snapshot: `newCycles` and `newLayerViolations` introduced by the change (plus `resolvedCycles` / `resolvedLayerViolations`). Distinct from `analyze_diff`'s `architecturalFlags`, which flag pre-existing issues — this reports only the delta and never blames the change for problems it didn't create. Verdict `regressed` / `improved` / `unchanged` / `no_baseline`.

**`get_architecture_snapshot` stores diffable cycle/layer data.** Snapshots now persist import-cycle membership and layer violations in their metrics (additive — snapshots created before 1.11.0 are treated as "no usable baseline" by `compare_change_impact`).

### Configuration

- `refactoring.maxCandidates` (default 5) — how many candidate symbols `prepare_change` returns when disambiguating a free-text query.

---

## [1.10.0] - 2026-06-14

### Added

**Node-version independence — WASM SQLite fallback (`@sqlite.org/sqlite-wasm`)**

PureContext now runs on **any Node.js ≥ 18**. The native `better-sqlite3` engine remains the fast path on Node 18/20/22; on any other Node — or whenever the native binary fails to load (e.g. an ABI mismatch under a Volta-pinned project) — PureContext automatically falls back to a pure-WASM SQLite engine that is ABI-independent.

- The WASM engine is FTS5-capable, so full-text search (`search_symbols`, `search_text`) works identically on the fallback. (`node:sqlite` and stock `sql.js` were evaluated and rejected — neither ships FTS5.)
- The fallback is **full-featured, not degraded**: FTS5, transactions, BLOBs, and the entire schema work. The only difference from native is throughput (WASM is somewhat slower on large indexes).
- Index database files use the standard SQLite format and are portable across the native and WASM engines.
- Backend selection is automatic and logged (`SQLite backend: WASM (@sqlite.org/sqlite-wasm)`). The override `PCTX_SQLITE_BACKEND=wasm` forces the fallback.

This eliminates the `MCP error -32000: Connection closed` failures caused by native ABI mismatches on Node versions without a matching prebuild (19/21/23/24+) or under per-project Node managers like Volta.

**Startup Node-version guard**

Running on Node < 18 now prints a clear, actionable message and exits — instead of crashing with an opaque `-32000 Connection closed`. A dependency-free launcher (`dist/bin.js`, now the package `bin`) checks the Node version *before* the heavy module graph (including any native addon) is loaded.

**Install pins the server to a globally-available Node**

`install` now configures the MCP server to run under the user's **global/default** Node (Volta's default via `platform.json`, else the system Node), independent of any project's Node pin:

- Claude Desktop config is written with the resolved absolute Node path.
- Claude Code **hooks** (`~/.claude/settings.json`) are pinned to the same global Node, instead of whatever Node ran `install` (previously they inherited a project-pinned version under Volta).
- `install claude` prints the exact `claude mcp add purecontext-mcp --scope user -- <node> <launcher>` command to register Claude Code at user scope.
- Machine-specific absolute paths are only ever placed in **user-scope** config — never a project-committed `.mcp.json`, which stays portable (and now works on any project Node ≥ 18 thanks to the WASM fallback).

**Claude Code hook system overhaul**

Hooks now use CLI-style commands (`npx purecontext-mcp hook-*`) registered directly in `~/.claude/settings.json`. No scripts are copied to `~/.claude/hooks/` — the commands invoke the installed package directly, so hook logic updates automatically when the package updates.

Seven hook events are now supported (up from three):

| Hook event | Command | What it does |
|------------|---------|--------------|
| `PostToolUse` | `hook-posttooluse` | Re-indexes modified files after Edit/Write/MultiEdit |
| `PreCompact` | `hook-precompact` | Injects indexed repo list into context before compaction |
| `PreToolUse` | `hook-pretooluse` | Soft edit guard — suggests read tools before editing |
| `WorktreeCreate` | `hook-worktree-create` | Auto-indexes a newly created agent worktree |
| `WorktreeRemove` | `hook-worktree-remove` | Fires when an agent worktree is removed |
| `TaskCompleted` | `hook-taskcompleted` | Post-task diagnostics: complexity stats, TODO count, tool suggestions |
| `SubagentStart` | `hook-subagentstart` | Injects condensed repo orientation for newly spawned subagents |

*TaskCompleted* — after the agent finishes a task, queries each indexed repo for high-complexity symbols (cyclomatic complexity > 5) and TODO/FIXME annotations, then injects a diagnostic summary plus a reminder of relevant tools: `find_dead_code`, `find_untested_symbols`, `get_todos`, `get_complexity_hotspots`, `health_radar`.

*SubagentStart* — when a subagent spawns it has no session context. This hook injects the indexed repo list (repoId, path, file and symbol counts, last-indexed timestamp) plus the mandatory workflow table so the subagent is oriented without needing an extra tool call.

*WorktreeCreate* — Claude Code's Agent tool can create isolated git worktrees for sub-tasks. This hook calls `index-folder` on the new worktree automatically so PureContext tools work immediately inside it.

Re-running `npx purecontext-mcp hooks --install` upgrades existing installations: old `node ~/.claude/hooks/purecontext-*.mjs` entries are replaced with the new CLI form, and the four new hook events are added.

### Fixed

- Native backend detection now probes the `better-sqlite3` binding (a throwaway in-memory open) during selection. Previously the loader committed to native after only `require()`-ing the JS wrapper and then threw at first `open()` under a mismatched ABI (e.g. Node 21), bypassing the WASM fallback.

---

## [1.9.0] - 2026-06-07

### Added

**Change-impact synthesis — `analyze_diff` reviews by impact, not by diff size (Phase 77, Phase A)**

`analyze_diff` is upgraded from "changed symbols + blast radius + a simple priority heuristic" into an impact-aware change report. Paste a unified `git diff` and, on top of the changed-symbol list, it now returns:

- **`missingCoChange`** — the headline new signal: files that *historically* change together with the edited files but are **absent from this diff** (the senior-reviewer "you touched `refundService` but `ledgerService` usually moves with it — and it's not here" instinct). Suppressed entirely on thin/squashed history (`signalQuality: "low"`) — it never invents warnings.
- **`risk`** — aggregate risk band (`low` / `review` / `high`) plus the top composite-risk symbols touched (reusing the Phase 76 `get_symbol_risk` engine).
- **`recommendedTests`** — tests that exercise the changed symbols, plus co-changing test files.
- **`coverageGaps`** — changed symbols with no detected test coverage.
- **`architecturalFlags`** — import cycles / layer-boundary crossings the changed files **currently sit on** (current-state *flags*, not "regressions introduced by the diff" — a before/after graph delta is deferred to a future `compare_change_impact`).
- **`reviewPriority`** — same `low` / `medium` / `high` / `critical` enum, now folding in the aggregate risk band and coverage-gap count alongside the original signature-break / blast signal.

All impact sections default **on** and are individually switchable off (`includeRisk`, `includeCoChangeGaps`, `includeTests`, `includeArchitectureFlags`) for cheap runs — with all four off, the output reduces to the pre-1.9 shape exactly. All new fields are additive, so existing CI/JSON consumers are unaffected.

Internally this ships a reusable, MCP-free **change-synthesis core** (`synthesizeChange`) that a future pre-edit `prepare_change` orchestrator will consume verbatim, and a `RiskContext` performance refactor so scoring many symbols in one diff builds the repo-wide distributions once instead of per symbol (composite-risk output is byte-identical).

New config: `changeSynthesis.coChangeConfidenceThreshold` (0.4), `changeSynthesis.maxSymbolsScored` (25), `changeSynthesis.maxCoChangeGaps` (10), `changeSynthesis.maxRecommendedTests` (15). Risk weights reuse `risk.weights`; mega-commit handling reuses `git.megaCommitThreshold`. **Still deliberately code-centered: no author, ownership, or productivity metrics.**

---

## [1.8.0] - 2026-06-04

### Added

**Temporal risk intelligence (Phase 76)**

PureContext now models the one signal a static dependency graph can't derive — which files *historically change together* — and fuses it with the risk primitives it already computes into a single, explainable verdict surfaced *before* you edit.

- **`get_co_change`** — temporal coupling. Reports the files that change together with a target file or symbol, derived from git commit history. Surfaces coupling the import graph cannot see (a route and its test; a feature flag and the code it gates). Returns explainable association metrics — `support` (shared commits), `confidence` (directional A→B probability), and `lift` (association strength) — with mega-commits (reformats, lockfile sweeps, codemods) filtered out and down-weighted by `1/(k−1)`. Granularity is file-level (a `symbolId` resolves to its file). Shallow/sparse histories return `signalQuality: "low"` instead of overstating weak ratios.
- **`get_symbol_risk`** — composite, explainable "how risky is it to change this symbol?" score (0–100, banded `low` / `review` / `high`). Blends churn (90 d), centrality (afferent coupling + reverse blast radius), cyclomatic complexity, test-coverage gap, and co-change spread — each normalized **repo-relative** (midrank percentile) so the score is comparable within a repo and not dominated by absolute size. Always returns `factors` (raw + normalized) and human-readable `reasons[]` — never a black-box number. Weights are configurable via `risk.weights`.
- **`get_context_bundle` → `historicalNeighbors`** — the bundle now appends files that historically change with the target but are *not* reachable through imports, each with a small outline. Empty (and bundle output byte-identical to before) when no co-change data exists, so token estimates are unchanged unless the signal is present.
- **`includeRisk` flag** on `search_symbols` and `get_symbol_source` — opt-in (default `false`, no added cost). When set, each result carries a compact `{ band, riskScore }`; the full breakdown stays in `get_symbol_risk`.

Capture is a single repo-level `git log --name-only -n N` stored in a dedicated `commit_files` table (separate from `git_metadata`, whose per-file last-10 window is too shallow and recency-skewed for co-change). New config: `git.coChangeDepth` (default 300; `0` disables capture entirely with zero behavioral change) and `git.megaCommitThreshold` (default 30). Capture is additive and failure-tolerant; skipped for non-git directories. **Deliberately code-centered: no author, ownership, or productivity metrics.**

Known limitations (documented, not bugs): repo-level capture does not `--follow`, so a mid-history rename splits a file's co-change signal; squash-merge monorepos can inflate coupling (mitigated by `megaCommitThreshold` + `signalQuality`).

**TypeScript HOC arrow detection + `delete-index` CLI (Phase 74)**

- HOC-wrapped arrow/function exports — `export const X = React.memo(fn)`, `forwardRef<T,P>(fn)`, `withRouter(fn)` — are now stored as `kind=function` instead of `kind=const`, so rendering-domain ranking (`computeRenderingCompoundBoost`, `kindBoost`) can see them.
- New `npx purecontext-mcp delete-index <path>` command cleanly removes a project's stored index.

### Database

- Schema version bumped to **8**: additive `commit_files` table (`repo_id`, `commit_sha`, `file_path`, `commit_date`) with a `commit_sha` index. Migration is backward-safe — existing indexes load without re-indexing; co-change/risk simply report low signal until the next re-index captures history.

---

## [1.7.0] - 2026-06-01

### Added

**Svelte and Astro single-file-component support (Phase 75)**

- **Svelte** (`.svelte`) — a `splitSvelteSFC` preprocessor extracts `<script>` and `<script context="module">` blocks; one `component` symbol per file; `useXxx` helpers are classified as composables.
- **Astro** (`.astro`) — a `splitAstroSFC` preprocessor extracts the leading `---` frontmatter as a TypeScript block; one `component` symbol per file. A `---` later in markup is not treated as frontmatter; an unterminated fence raises a parse error.
- Both adapters use a shared `detect-utils.ts` providing bounded recursive monorepo detection (mirrors the Vue/Nuxt approach).

### Fixed

**Adapter-extension wiring (the `.vue`-not-indexed bug class, Phase 75)**

- The **file watcher** and the **GitHub remote-index path** now union adapter extensions (`getAdapterExtensions(getRegisteredAdapters())`) into their handler-extension sets, so `.vue`/`.svelte`/`.astro` edits trigger re-index and remote SFC blobs are no longer dropped. (Previously both gated on handler extensions only.) New `watchedExtensions()` helper for testability.
- The **benchmark harness** now imports all framework adapters for self-registration — it previously registered 40 handlers but 0 adapters, so it had never indexed `.vue`. Vue/Nuxt benchmark numbers shift on the next run as a measurement-scope correction, not a regression.

---

## [1.5.0] - 2026-05-22

### Added

**New language handlers**

- **HCL / Terraform** (`.tf`, `.tfvars`, `.hcl`) — extracts `variable`, `output`, `resource`, `data`, `module`, `provider`, and `locals` blocks; names follow Terraform reference syntax (`var.name`, `module.name`, `local.name`, `output.name`) so queries match the way you write them in code
- **Angular HTML templates** (`.html`) — extracts component selectors, structural directives (`*ngIf`, `*ngFor`, `@if`, `@for`), event bindings (`(click)="handler"`), template references (`#userInput`), and `routerLink` directives; auto-detected via a sibling `.component.ts` file or Angular marker patterns
- **Extensionless scripts** — extensionless files (e.g. `plugins/*/functions` in Bash-heavy projects) are now discovered and indexed automatically; shebang detection routes each file to the correct handler

**Objective-C handler overhaul**

- `@interface`, `@protocol`, and `@implementation` declarations now fully extracted from both `.m` and `.h` files
- Named categories stored as `ClassName+CategoryName`; anonymous categories flagged with `classExtension: true`
- Full Objective-C selector building (`setObject:forKey:`) instead of plain method names
- Properties extracted with `property` kind (was `const`)
- `.h` files guarded by an ObjC detection pass — C headers that happen to use `.h` are not misidentified

**XML symbol disambiguation**

- Root-element symbols in multi-module XML repositories (e.g. `pom.xml` across 30+ Maven modules) are now stored as `tag@module` names, eliminating collisions where every module shared the same top-level element name
- Bare tag name retained as an FTS token so single-word queries still find the right file

**Search relevance improvements**

- *Monorepo path heuristics* — frontend app directories (`apps/dashboard/`, `apps/web/`) get a score boost when the query contains hook or component vocabulary; avoids backend symbols drowning React/Angular results in mixed monorepos
- *Java/Groovy core-path boost* — symbols in `/core/src/main/java/` paths boosted; symbols in plugin directories penalised; reduces noise from plugin implementations when querying for core API methods
- *Library path penalties* extended to cover `engine/`, `erts/`, and `contrib/` directory segments (common in projects that embed a runtime)
- *Compound underscore boost* — fires when all underscore-separated parts of a symbol name are present in the query, without requiring an exact full-name match
- *Single-token exact match boost* — single-word queries reliably surface the best exact match at rank 1
- *Cross-language FTS aliases* — Neovim `nvim_*` C functions get a `vim.api.nvim_*` alias so Lua-style queries (`vim.api.nvim_open_win`) find the C implementation; Proto RPC method symbols include their service name as an FTS token
- *Erlang bare function names* — Erlang symbols stored without arity suffix (`start_link` instead of `start_link/3`); arity preserved in `frameworkMeta`; module name injected as an FTS token so `module:function` queries work
- *TypeScript HOC detection* — `export const X = React.memo(() => ...)`, `forwardRef(...)`, and similar HOC-wrapped arrow functions emitted as `kind=function` instead of `kind=const`, ensuring rendering-domain boosts fire correctly

### Fixed

- Case-insensitive file extension matching in file discovery (`.F90` Fortran files were silently skipped)
- Directory trailing-slash handling in `ignore` negation patterns — fixes traversal of directories with explicit `!negation` rules
- Index workers were missing registrations for the Fortran, SCSS, LESS, CSS, and Objective-C handlers; files with those extensions were silently dropped before parsing
- C++ qualified name FTS — bare local name (`Future`) now stored as a separate FTS token alongside the fully-qualified name (`folly::Future`), improving single-word C++ queries
- Rust synonym scoping — `future→poll`, `spawn→tokio/task`, and serde-specific synonyms now fire only in Rust repositories, preventing them from polluting C++ search results

---

## [1.4.0] - 2026-05-20

### Added

**New MCP tools**

- `get_lexical_scope_matches` — returns all symbols accessible from a given file and line (local scope, module imports, and exported API), letting agents reason about what identifiers are in scope without reading whole files
- `trace_invocation_chain` — follows call edges from a symbol N hops deep and returns the linearised invocation path; useful for tracing a request from an entry point through to storage

**Language handler depth**

- *Ruby* — DSL macro extraction: `has_many`, `belongs_to`, `has_one`, `has_and_belongs_to_many`, `before_action`, `after_action`, `validates`, and `scope` class macros extracted as `property` symbols; metaprogramming patterns (`define_method`, `method_missing`) flagged in `frameworkMeta`
- *Rust* — `#[cfg(...)]` attributes now captured in `frameworkMeta.cfgAttributes`; new `cfgFilter` parameter on `search_symbols` restricts results to symbols matching a specific cfg condition (e.g. `target_os = "linux"`)
- *C++* — export-macro class extraction: `class MY_EXPORT ClassName` and similar patterns now correctly identified as class declarations rather than function definitions
- *TypeScript* — `export const X = forwardRef(...)` / `React.memo(...)` and similar HOC patterns emitted as `kind=function`; decorator extraction inside `export_statement` wrapper fixed (was silently dropping `@Injectable` and similar decorators on exported classes)
- *C#* — interface member extraction fixed (interface members are implicitly public; visibility guard removed); method name extraction uses `findLast` before `parameter_list` to avoid returning the return type; event field declarations (`event_field_declaration`) extracted as `property` kind
- *Kotlin* — extension function extraction; primary constructor property parameters extracted as `property` symbols
- *PHP* — PHP 8 `#[Attribute]` syntax parsed correctly; Symfony route and controller patterns added to quality-gate trigger; property declarations, `define()` constants, closures, abstract methods, enum cases, and interface constants all extracted

**Search quality**

- FTS BM25 raw rank exposed to the relevance ranker — high keyword-match scores contribute a 0–50 point bonus on top of structural scoring; prevents purely-structural boosts from overriding strong keyword matches
- Docstring extraction extended — Python and C++ full-paragraph docstrings (not just the first line) fed to the FTS index; improves matches for queries that use documentation vocabulary rather than identifier names
- Nuxt/Vue-specific vocabulary synonyms added (`composable`, `setup`, `defineComponent`, `useNuxt`, etc.)
- `search_symbols` returns `verdict: "no_match"` with `negative_evidence` details when all retrieval strategies are exhausted, allowing agents to stop retrying instead of looping through variant queries

**Multi-IDE installer**

`npx purecontext-mcp install <tool|all>` now supports:

| IDE / Tool | Config location |
|------------|----------------|
| Cursor | `.cursor/rules/purecontext.mdc` |
| Windsurf | `.windsurfrules` |
| Continue | `.continue/config.json` system message |
| Cline | `.clinerules` |
| Roo Code | `.roo/rules-code.md` |
| VS Code Copilot | `.github/copilot-instructions.md` |
| Claude Desktop | Platform config (`claude_desktop_config.json`) |

All writers are idempotent — running `install` a second time updates the existing block rather than appending a duplicate.

**Claude Code hooks**

- *PostToolUse index hook* — re-indexes modified files automatically after any Edit/Write tool call, keeping the symbol index in sync with in-session edits
- *PreCompact snapshot hook* — captures an architecture snapshot before context is compacted
- *Edit guard hook* (soft) — warns when an edit target has dependents with high blast radius; never blocks

Install via `npx purecontext-mcp hooks --install`.

### Fixed

- `expandVerbSynonyms`: prototype-chain collision on the `constructor` key — calling `expandVerbSynonyms("constructor")` previously returned the built-in `Function.prototype.constructor`; fixed by using `Object.create(null)` for the synonym map
- Test-mapper transaction: FK constraint errors no longer propagate and block FTS index population
- Windows path-case mismatch: repo ID computation now uses the canonical absolute path from the indexer output rather than recomputing from a potentially different-cased input string

---

## [1.3.0] - 2026-05-16

### Added

**Search quality**

- *OR-fallback retrieval* — when the FTS5 AND query returns too few results, the engine automatically retries with an OR query and re-ranks the combined pool; improves recall for longer, natural-language queries
- *Abbreviation expansion* — common abbreviations in queries expanded before FTS: `db→database`, `auth→authentication`, `cfg→configuration`, `mgr→manager`, `ctrl→controller`, and 40+ more; C/C++ abbreviations included
- *camelCase boundary tokenisation* — FTS5 index now correctly splits `getUserById` into `get`, `user`, `by`, `id` at index time, not just at query time; improves recall when query uses word-boundary terms that appear inside camelCase identifiers
- *Verb synonym expansion* — common verb synonyms expanded at query time: `fetch↔get↔retrieve`, `create↔insert↔add`, `delete↔remove↔drop`, `update↔modify↔edit`, `authenticate→login`, `list↔find`, and more
- *Stop-word expansion* — 30 additional stop words filtered from multi-word queries: `with`, `without`, `using`, `via`, `existing`, `before`, `after`, `during`, and others
- *Service/repository kind boost* — `*Service` method symbols +30, `*Repository`/`*Manager`/`*Store` method symbols +15; surfaces application-layer API methods before utility helpers with similar names
- *Method verb bonus* — fires when the first camelCase part of a method name (the action verb) matches a query word, differentiating `ProductsService.create` from `buildProductListCacheKey`
- *Quality-gate OR-fallback* — if the AND pool contains no `*Service`/`*Repository` methods even after the first OR-fallback, a second OR pass retrieves the broader candidate pool
- *Stem matching* — pluralised name parts (`products→product`) now match singular query words
- *Library path penalty* — symbols from `vendor/`, `node_modules/`, `bower_components/`, `third_party/`, and similar paths penalised to prevent dependency code from ranking above project code

**New stylesheet handlers**

- *SCSS / SASS* (`.scss`, `.sass`) — `@mixin` → function, `@function` → function, top-level `$variable` → const, `%placeholder` → class, `@keyframes` → type
- *LESS* (`.less`) — `.mixin(@params){}` → function, top-level `@variable` → const, `@keyframes` → type
- *CSS* (`.css`) — CSS custom properties (`--token-name`) indexed as const (opt-in via `indexing.cssVariables: true` in config)

**Handler depth improvements**

- *Go* — interface `method_spec` extraction; top-level `var` declarations; `*Handler`/`*DB`/`*Client` receiver types added to kind-boost patterns
- *Java* — inner-class extraction no longer gated on `isStatic`; package-private methods included; Android `Activity`/`Fragment`/`ViewModel` pattern boosts
- *Rust* — `impl` methods filtered to `pub` visibility by default; `trait` implementations boosted; Rust-specific synonyms scoped to Rust repos only
- *PHP* — UTF-8 multibyte character offset bug fixed (was producing broken symbol names for methods after accented characters in source); property declarations, closures, `define()` global constants, abstract methods, PHP 8.1 enum cases, and interface constants all extracted
- *TypeScript* — decorator extraction inside `export_statement` wrapper fixed

### Fixed

- FTS5 syntax error in synonym OR-groups: tokens joined as `(a OR b)` were concatenated without an explicit `AND` connector when followed by another group, producing invalid FTS5 queries; fixed by inserting explicit ` AND ` between groups and checking for top-level OR context before switching to OR-fallback mode
- `namePrefix` word-boundary guard: stem matching no longer fires when a name only contains the query word as an interior substring (e.g. query `user` no longer matches `superuser` via stem)
- Short-token filter in multi-word query branch: tokens shorter than 2 characters no longer enter the AND query, preventing FTS5 from returning zero results on trivially-true constraints

---

## [1.2.0] - 2026-05-13

### Added

**Advanced relationship analysis**
- `find_implementations` — find all concrete implementations of a TypeScript interface or abstract class; returns implementing classes with `implementedMethods` and `missingMethods` arrays compared against the interface contract
- `get_call_hierarchy` — callers and callees of a function N levels deep as a hierarchical tree; supports `callers`, `callees`, and `both` directions; recursive calls marked `cyclic: true`
- `get_class_hierarchy` — full inheritance tree rooted at a class, showing both ancestors and descendants; use before refactoring a base class to understand the full polymorphism surface
- `find_cycles` — detect circular import dependencies across the repo or a subtree; returns strongly-connected components with severity rating
- `get_coupling_map` — afferent/efferent coupling metrics and instability scores (`I = efferent / (afferent + efferent)`) for every file; highlights highest-risk refactoring candidates

**Architectural visualization**
- `render_diagram` — general-purpose Mermaid or DOT dependency diagram (module, call graph, class hierarchy); output renders natively in GitHub, VS Code, and Claude
- `render_call_graph` — specialized call graph diagram rooted at a symbol with call-graph-specific layout options
- `render_import_graph` — file-level import graph for a directory or whole repo; nodes clustered by directory
- `render_class_hierarchy` — class inheritance diagram in Mermaid `classDiagram` format; shows fields, methods, and inheritance/implementation relationships
- `render_dep_matrix` — dependency matrix diagram showing coupling between modules as a grid; surfaces structural hotspots at a glance
- `get_architecture_snapshot` — captures architectural state (file count, symbol count, module breakdown, coupling summary, health scores); take two snapshots to prove structural improvement objectively

**Refactoring safety checks**
- `check_rename_safe` — pre-flight check before renaming a symbol; returns `safe` verdict and all `affectedSites` (call, import, type-reference, string-literal, comment) with file, line, column, and context snippet
- `check_delete_safe` — pre-flight check before deleting a symbol; returns `safe: false` if anything in the repo still imports or references the symbol
- `check_move_safe` — pre-flight check before moving a symbol to a different file; validates no import conflicts and lists all import statements that need updating
- `plan_refactoring` — generate a sequenced, dependency-ordered plan for a structural change from a natural-language description; steps ordered so lower-risk changes happen first

**Health dashboards & debt reporting**
- `health_radar` — five-axis health score (complexity, coupling, maintainability, documentation, stability), each 0–100; returns `overallHealth` score and letter grade (A–F); designed for CI health gates
- `diff_health_radar` — compare two health radar snapshots (before/after a refactoring) with axis-by-axis deltas and regression/improvement verdicts
- `get_debt_report` — detailed technical debt report with per-file rankings, priority tiers, worst files by each metric, specific symbols to address, and estimated effort indicators

**AST-level search**
- `search_ast` — find every occurrence of a specific tree-sitter node type across all indexed files (e.g. `try_statement`, `arrow_function`, `await_expression`); returns file, line, column, and snippet
- `search_by_signature` — search symbols by type signature pattern (regex or substring); find all functions returning `Promise<void>` or methods accepting a `Request` parameter
- `search_by_decorator` — find all symbols annotated with a specific decorator; works for TypeScript (`@Injectable`, `@Controller`) and Python (`@app.route`, `@property`) decorators
- `search_by_complexity` — find symbols above or below a complexity threshold; returns symbols ranked by complexity score; use before refactoring sprints or to enforce complexity budgets

**Code intelligence helpers**
- `get_entry_points` — identify all runnable entry points: main functions, CLI handlers, HTTP server startups, Lambda handlers, test suites, and scripts; each result includes `kind`, `confidence`, and reason
- `get_public_api` — all exported symbols grouped by file; use to document a library, audit what is exposed, or check for accidental exports
- `get_todos` — find all TODO, FIXME, HACK, NOTE, and XXX comments across the repo with file, line, tag type, and comment text
- `get_complexity_hotspots` — symbols ranked by complexity score, highest first; use to identify the worst functions before a refactoring sprint
- `get_type_graph` — type dependency graph showing which types reference which other types, rooted at a specific type or across the whole repo; supports `uses`, `usedBy`, and `both` directions
- `find_untested_symbols` — exported symbols with no corresponding test coverage, ranked by complexity (highest priority first); uses import-based heuristics
- `get_test_coverage_map` — per-file coverage map showing which symbols are referenced by test files and which are not; produces `coverageRatio` per file and aggregated totals

**Documentation guides**
- `AST-SEARCH.md` — guide to AST-level search tools and tree-sitter node types
- `CODE-INTELLIGENCE.md` — guide to code intelligence helper tools
- `HEALTH-DASHBOARDS.md` — guide to health radar, debt reporting, and architecture snapshots
- `REFACTORING-SAFELY.md` — guide to refactoring safety check tools and pre-flight workflows
- `UNDERSTANDING-RELATIONSHIPS.md` — guide to relationship analysis tools (call hierarchy, class hierarchy, coupling)
- `VISUALIZING-CODE.md` — guide to diagram rendering tools and Mermaid output
- `WORKFLOW-TECH-DEBT.md` — end-to-end tech debt sprint workflow

### Fixed

- Token savings tracker: corrected cumulative savings calculation and fixed display in web UI
- Web UI: dependency graph and repo detail pages now render correctly after token tracker refactor
- Docker: UI workspace panel and repo list routing fixes

---

## [1.1.0] - 2026-05-07

### Added

**New MCP tools**
- `find_references` — find all usage/call sites for a symbol across the repo (identifier-level, not import-level)
- `get_file_content` — retrieve raw cached file content with optional line-range slicing (`startLine`/`endLine`)
- `get_symbols` — batch-fetch multiple symbols by ID, returning source in a single round-trip
- `invalidate_cache` — force a full or per-file re-index by clearing content hashes; accepts optional `filePath` to scope invalidation

**Tool capability enhancements**
- `search_symbols`: new `debug` parameter — includes per-result relevance scoring breakdown (FTS5 rank, kind boost, exact-match bonus)
- `get_symbol_source`: new `context_lines` parameter (extra lines above/below) and `verify` flag (re-reads from disk to confirm source is current)
- `index_repo`: clone and index a remote Git repository by URL; supports private repos via `token`; clones stored at `~/.purecontext/clones/`
- AI summarization via Gemini Flash — configurable as an embedding/summarization provider alongside Anthropic and OpenAI

**Ecosystem & data tools**
- Context provider framework — plugin interface (`ContextProvider`) for domain-specific symbol enrichment; providers auto-detected from project config
- dbt integration — indexes models, sources, seeds, macros, and exposures; dbt Jinja pre-processor expands `{{ ref() }}` / `{{ source() }}` before SQL parsing; column definitions from `schema.yml` stored in `frameworkMeta.columns`
- OpenAPI/Swagger handler — parses `.yaml`/`.yml` files detected as OpenAPI specs; indexes endpoints and schemas as symbols
- SQL handler — indexes tables, views, functions, and stored procedures; works standalone and with dbt Jinja expansion
- `search_columns` tool — search dbt/SQL column definitions by name or description, with upstream/downstream lineage

**Language coverage expansion to 34 languages**

16 new language handlers added (previously 18):

| Language | Extensions | Key symbol types |
|----------|-----------|-----------------|
| Bash | `.sh`, `.bash` | function |
| Perl | `.pl`, `.pm` | function, package |
| Terraform / HCL | `.tf`, `.hcl` | resource, module, variable, output |
| Nix | `.nix` | function, attribute |
| Protobuf | `.proto` | message, service, enum, rpc |
| GraphQL | `.graphql`, `.gql` | type, query, mutation, subscription, fragment |
| Groovy | `.groovy` | function, class, method |
| Erlang | `.erl`, `.hrl` | function, module |
| Gleam | `.gleam` | function, type |
| GDScript | `.gd` | function, class, signal |
| XML | `.xml` | element (pattern-configurable) |
| Objective-C | `.m`, `.h` | function, class, method |
| Fortran | `.f90`, `.f95`, `.for`, `.f` | function, subroutine, module |
| SQL | `.sql` | table, view, function, procedure |
| OpenAPI / YAML | `.yaml`, `.yml` | endpoint, schema |
| PHP (doc coverage) | existing | PHPDoc `/** */` extraction improved |

**Cross-repo intelligence**
- `search_cross_repo` tool — unified symbol search across all repos in a workspace; supports keyword, semantic, and hybrid modes; results include `repoId` and `repoPath`
- `find_similar` tool — find semantically similar code across repos using HNSW cosine similarity; configurable `minSimilarity` threshold (requires semantic search enabled)
- Cross-repo dependency tracking — `dep_edges` extended with `sourceRepoId`/`targetRepoId` columns; `get_blast_radius` and `find_importers` can now follow edges across repo boundaries
- MCP Resources — indexed symbol outlines exposed as MCP Resources (`purecontext://repo/<repoId>/outline`) for clients that support resource subscriptions

**Git & history integration**
- Git metadata indexing — during `index_folder`, PureContext walks `git log` and maps commits to symbols via byte-range overlap; stored in new `git_metadata` SQLite table; configurable via `git.enabled`, `git.maxCommits`, `git.branches`
- `get_symbol_history` tool — symbol-level commit history (hash, author, date, message, diff) without agents needing to run git commands
- `get_churn_metrics` tool — file or symbol churn scores (commits, lines changed, authors, churn score) with optional `since` date filter; surfaces high-risk files

**AI-powered architecture analysis**
- `get_quality_metrics` tool — per-file quality scores: cyclomatic complexity, coupling (fan-in/fan-out), cohesion, doc coverage, and a composite 0–100 score
- `detect_antipatterns` tool — detects god classes, circular dependencies, deep inheritance, feature envy, and other common anti-patterns; results include severity and symbol ID
- `get_architecture_doc` tool — auto-generates a Markdown or Mermaid architecture summary from the dependency graph and quality metrics
- `get_layer_violations` tool — detects import boundary violations given a layer definition (e.g., controllers must not import repositories directly)

**Enhanced Web UI**
- Architecture heatmap — colour-coded file tree where heat indicates churn score or quality score; helps identify hot spots at a glance
- Symbol timeline — visual history of commits touching a symbol, linked to `get_symbol_history` data
- Test coverage overlay — when a coverage JSON report is present, file tree nodes show line coverage percentages
- Multi-repo workspace view — repository picker with cross-repo search tab; switch between repos without reloading
- Advanced dependency graph — zoom/pan, node grouping by directory, edge filtering by kind, and path highlighting between two selected nodes

**Distribution & platform**
- Index export (`npx purecontext-mcp export`) — archives the SQLite database and HNSW index into a portable `.pctx.tar.gz` file
- Index import (`npx purecontext-mcp import`) — restores an exported archive; repo is immediately searchable, no re-indexing required
- Public registry — pre-built indexes for popular open-source projects hosted on CDN; pull with `npx purecontext-mcp pull <package>@<version>`; browse with `npx purecontext-mcp registry list`
- Webhook auto-reindex — HTTP endpoint (`POST /webhook/reindex`) accepts GitHub/GitLab push payloads and triggers incremental re-indexing automatically
- GitHub Actions composite action — `.github/actions/purecontext-cache/action.yml`; caches the index between CI runs using `actions/cache`, exports after indexing, imports on cache hit
- VS Code extension — `vscode-purecontext` extension wraps the MCP server with a sidebar panel for symbol search, file outline, and dependency graph directly in the editor

### Changed

- `search_symbols` response now includes `repoId` in every result (was implicit from the request parameter) — enables direct use in cross-repo result lists
- `list_repos` now includes `gitEnabled` and `lastGitIndexed` fields when git metadata indexing is active
- Default `fileLimit` raised from 1000 to 5000 (language expansion makes larger repos viable)
- `_meta` envelope included in all tool responses (previously only retrieval tools); fields: `timing_ms`, `tokens_saved`, `total_tokens_saved`, `cost_avoided`

---

## [1.0.0] - 2026-04-26

This is the first stable release of PureContext MCP. The public tool API is now under
semver: breaking changes require a major version bump, new tools and fields increment
the minor version, and bug fixes increment the patch version.

### Added

**Core symbol indexing (TypeScript and JavaScript)**
- Tree-sitter AST parsing via WASM bindings (`web-tree-sitter`) — no native compilation required for the parser itself
- Extracts functions, classes, methods, constants, types, interfaces, and enums with one-line signatures
- Deterministic symbol IDs (SHA-256 of `filePath:name:kind`) for stable cross-session references
- SQLite storage (`better-sqlite3`) with four tables: `symbols`, `files`, `dep_edges`, `repos`
- Incremental re-indexing via chokidar file watcher with debounce

**Language support (16 languages)**
- TypeScript and JavaScript (full symbol + import extraction)
- Python, Go, Rust, Java, C, C++, C#, Swift, Kotlin, Dart
- Elixir, Haskell, Scala, R
- PHP, Lua, Ruby

**Framework adapters (20+ frameworks)**
- Vue 3 (SFC `<script setup>`, composables, components)
- Nuxt 3 (pages, layouts, composables, server routes, plugins)
- React and Next.js (components, hooks, server/client components, API routes)
- Angular (components, services, pipes, guards, modules, directives)
- Express and Fastify (routes, middleware, plugins)
- Django, FastAPI, Flask (views, serializers, models, routers, dependencies)
- SQLAlchemy and Prisma (models, schemas, migrations)
- Axum and Actix-web (handlers, middleware, extractors)
- Echo, Fiber, Gin (handlers, middleware, groups)
- Spring and Hibernate (controllers, services, repositories, entities)

**MCP tool surface (12 tools)**
- `index_folder` — index a project directory
- `resolve_repo` — resolve a path to its repo ID
- `list_repos` — list all indexed repositories
- `search_symbols` — search by name fragment with kind and path filters
- `get_symbol_source` — retrieve raw source by byte offsets
- `get_file_outline` — all symbols in a file with signatures
- `get_repo_outline` — all files with top-level symbols
- `get_file_tree` — directory tree with file counts
- `get_context_bundle` — transitive forward-walk from a symbol
- `get_blast_radius` — reverse-walk to find all dependents
- `find_importers` — direct importers of a file
- `find_dead_code` — exported symbols that nothing imports

**Dependency graph**
- Import resolution with tsconfig path alias support
- Forward (context bundle) and reverse (blast radius) BFS traversal
- Dead code detection across the entire project graph

**FTS5 keyword search with relevance ranking**
- Full-text search over symbol names and signatures
- camelCase query preprocessor (`getUserById` → `get user by id`)
- Hyphen-aware tokenization
- Relevance ranker: exact name match → prefix match → content match

**Semantic search — HNSW vector index**
- Optional embedding-based symbol search via `hnswlib-wasm`
- Configurable embedding provider (Anthropic, OpenAI, or none)
- Index persists alongside the SQLite database

**Token savings tracker**
- Each tool response includes `_tokenEstimate` so agents can gauge context size
- Cumulative session savings reported by `list_repos`

**Multi-tenant rate limiting**
- Per-client request quotas configurable in `config.json`
- Token bucket algorithm with burst allowance

**Web UI**
- Vite + Vue 3 dashboard served from the MCP process
- Symbol search, file outline, dependency graph visualisation
- 28 Playwright end-to-end tests

**Worker thread pool for enterprise repos**
- Parallel tree-sitter parsing across a configurable thread pool
- Designed for 10k–50k file codebases
- Graceful degradation to single-threaded mode when the pool is unavailable

**npm release infrastructure**
- `prebuildify` prebuilt binaries for Node 18/20/22 × Windows/macOS/Linux
- GitHub Actions CI: 9-job matrix (3 OS × 3 Node versions) on every push and PR
- Release workflow: prebuild + publish triggered by `v*` tags
- `files` allowlist in `package.json` — published package < 20 MB
- `scripts/check-sqlite.js` postinstall canary with actionable error message
- `scripts/verify-package.sh` pre-release verification helper

**Public launch polish**
- `--health` flag — checks prerequisites (grammars, SQLite, index directory) and exits with JSON output; non-zero exit code on any failure
- Actionable error messages throughout: missing grammar files, SQLite open failures, and config validation all produce human-readable guidance instead of raw stack traces
- Opt-in telemetry — reports anonymised usage counts (tool invocations, file counts); disabled by default, enabled via `telemetry.enabled: true` in config

**Team and cloud features**
- HTTP/SSE transport — start the server with `--transport http` (or `--transport both` for stdio + HTTP simultaneously); port and bind address configurable via `--port`/`--host` or `config.json`
- API key management — `purecontext-mcp keys create/list/revoke` CLI; keys stored as bcrypt hashes, shown once on creation; format `pctx_<workspaceId>_<24-char-random>_<checksum>`
- Workspace support — logical namespaces that group repos and API keys; managed via the admin key (`PCTX_ADMIN_KEY` env var)
- Docker deployment — official `purecontext/purecontext-mcp` image; `docker-compose.yml` included in the repo; `/health` HTTP endpoint for container health checks

### Changed

- Minimum Node.js version: **18.0.0** (uses native `fetch`, `worker_threads`, `structuredClone`)
- Default `fileLimit` raised from 500 to 1000

### Fixed

- `web-tree-sitter` character-vs-byte offset bug in handler text extraction (all language handlers now use byte offsets throughout)
- Forward-slash normalisation for file paths stored in SQLite (Windows compatibility)
- FTS5 hyphen tokenization — hyphens in symbol names are now indexed correctly

---

## [0.1.0] - 2026-04-10

Initial internal release. Core TypeScript/JavaScript indexing, SQLite storage, and MCP stdio transport.
