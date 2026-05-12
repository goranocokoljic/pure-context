# Code Intelligence

Some questions about a codebase can't be answered by searching for a specific name or looking at a single file. They require the server to reason about the whole codebase at once: *where does this application start?*, *what does this library expose?*, *which functions have no tests?*, *where are all the outstanding TODO items?*

PureContext's code intelligence tools answer these whole-codebase questions without requiring you to read through files manually.

---

## Finding entry points

Every application has a starting point — and often more than one. A Node.js service has a `bootstrap()` call. A CLI tool has argument parsing. A serverless function has Lambda handlers. A test suite has test runner entry points.

**Scenario:** You've just been handed a codebase you've never seen before. Your first question: how does this thing actually start?

> "Where does this application start? Show me all the entry points."

```
get_entry_points(repoId) →

  Entry Points (8 found):

  HIGH CONFIDENCE:
    main()               src/index.ts           main_function
      reason: "function named main at module root"

    bootstrap()          src/server.ts          server_startup
      reason: "calls app.listen(), server startup pattern"

    handler()            src/lambda/api.ts       lambda_handler
      reason: "exported 'handler' in file matching /lambda/"

    handler()            src/lambda/events.ts    lambda_handler
      reason: "exported 'handler' in file matching /lambda/"

  MEDIUM CONFIDENCE:
    run()                src/cli/index.ts        cli_handler
      reason: "calls process.argv, process.exit — CLI pattern"

    workerMain()         src/workers/index.ts    server_startup
      reason: "calls queue.process() — worker startup pattern"

  LOW CONFIDENCE:
    setup()              test/setup.ts           test_suite
      reason: "matched test file pattern, exports setup function"

    seed()               scripts/seed.ts         script
      reason: "script file with no importers"
```

Eight entry points: two Lambda handlers, a main server, a CLI, a worker, and a seeding script. In 30 seconds you understand the full deployment surface of the application.

**Filtering by type:**

> "Show me only the Lambda handlers."

```
get_entry_points(repoId, kind: "lambda_handler", minConfidence: "high") →
  [only the two confirmed Lambda handlers]
```

**Use with `get_call_hierarchy`** to trace the full execution path from an entry point:

```
get_entry_points(repoId, kind: "server_startup") → bootstrap()
get_call_hierarchy(symbolId: "bootstrap-id", direction: "callees", maxDepth: 3)
  → full initialization sequence
```

---

## Auditing the public API surface

Libraries, shared packages, and microservice clients expose a public API. Over time, that API grows — and often includes symbols that were never meant to be public.

**Scenario:** You're preparing a major version release. You want to document the public API and identify exports that aren't actually used by any consumer.

> "What does this package export? Show me the full public API surface."

```
get_public_api(repoId) →

  Public API Surface — 3 files, 47 exports

  src/index.ts (31 exports):
    createClient()        function   default export  "Create a new PureContext client"
    IndexManager          class                      "Manages index lifecycle"
    SearchEngine          class                      "Symbol and semantic search"
    SymbolRecord          type                       "Core symbol type"
    SymbolKind            type                       "Union of all symbol kinds"
    ImportRecord          type                       "Import edge type"
    ...

  src/config.ts (9 exports):
    loadConfig()          function                   "Load and validate config.json"
    ConfigSchema          type                       "JSON Schema for config"
    DEFAULT_CONFIG        const                      "Default configuration values"
    ...

  src/errors.ts (7 exports):
    PureContextError      class                      "Base error class"
    IndexNotFoundError    class                      "Repo not indexed"
    ...

  Total: 47 exported symbols
```

**Finding dead exports — things you export but nobody uses:**

```
get_public_api(repoId) → 47 exports
find_dead_code(repoId)  → 12 exports have no importers

  These 12 are exported but never imported:
    LegacyParser         src/index.ts   (deprecated)
    debugMode            src/config.ts  (internal flag leaked into public API)
    InternalQueue        src/index.ts   (should have been private)
    ...
```

Twelve symbols that are publicly exported but consumed by nobody — prime candidates for removal before the major release.

**Filtering the API by kind or file:**

```
get_public_api(repoId, kind: "function") → only exported functions
get_public_api(repoId, filePath: "src/auth/") → exports from auth module only
get_public_api(repoId, includeMembers: true) → includes public methods of exported classes
```

---

## Tracking TODOs and technical debt comments

Every codebase has outstanding work buried in comments. `get_todos` surfaces all of it in one place.

**Scenario:** Before a release, you want a complete list of every `FIXME` and `TODO` in the codebase.

> "Show me all FIXMEs and TODOs in the codebase, grouped by file."

```
get_todos(repoId, tags: ["FIXME", "TODO"], groupByFile: true) →

  30 items found across 18 files

  src/auth/oauth2.ts (3):
    TODO:42   Replace JWT_SECRET with dedicated OAUTH_STATE_SECRET before merge
    FIXME:67  Race condition: concurrent refreshes can invalidate each other's tokens
    TODO:89   Add retry logic for failed OAuth state validation

  src/billing/processor.ts (4):
    FIXME:23  chargePayment doesn't handle partial auth — card could be charged twice
    TODO:45   Add idempotency key support
    TODO:67   Move tax calculation to a separate service
    TODO:134  Handle PaymentIntent.cancelled status

  src/core/database.ts (2):
    FIXME:45  Connection pool exhaustion under load — needs backpressure
    TODO:78   Add query timeout configuration

  ... (15 more files)

  Summary by tag:
    TODO:  24 items
    FIXME:  6 items
```

Two of those FIXMEs describe potential bugs — a race condition in OAuth token refresh and a double-charge risk in billing. Those belong on the release blocker list.

**Filtering by tag:**

```
get_todos(repoId, tags: ["FIXME", "BUG"])
  → only bugs and fixes — use before a release

get_todos(repoId, tags: ["HACK"])
  → all acknowledged hacks — useful for tech debt planning

get_todos(repoId, tags: ["TODO", "OPTIMIZE"])
  → performance improvement backlog
```

**Filtering by assignee:**

```
get_todos(repoId, assignee: "alice")
  → only items assigned to alice: TODO(alice): ...

get_todos(repoId, filePath: "src/auth/", tags: ["FIXME"])
  → all FIXMEs in the auth module
```

---

## Finding complexity hotspots

When you have limited refactoring time, you want to focus on the files that will give you the most improvement per hour. `get_complexity_hotspots` ranks files by their complexity concentration — not just the worst individual function, but files with many complex symbols clustered together.

**Scenario:** You're allocating sprint capacity to reduce complexity. Which files should you tackle first?

> "Which files in src/ have the highest complexity concentration? I want to prioritize my refactoring backlog."

```
get_complexity_hotspots(repoId, scope: "src/", topN: 8) →

  Complexity Hotspots:

  1. src/legacy/UserManager.ts          hotspot: 94/100
     avg complexity: 11.4    max: 23    symbols: 34
     Top offenders:
       processAuthRequest()   complexity: 23   120 lines
       handlePermissions()    complexity: 19    98 lines
       validateUserData()     complexity: 14    67 lines

  2. src/billing/processor.ts           hotspot: 78/100
     avg complexity: 8.7     max: 18    symbols: 14
     Top offenders:
       chargePayment()        complexity: 18    89 lines
       applyDiscounts()       complexity: 12    54 lines

  3. src/api/routes/legacy.ts           hotspot: 67/100
     avg complexity: 7.1     max: 15    symbols: 21
     Top offenders:
       handleLegacyRequest()  complexity: 15    78 lines

  4. src/core/parser.ts                 hotspot: 61/100
     avg complexity: 6.8     max: 12    symbols: 9
     ...
```

`UserManager.ts` has the worst hotspot score — nearly every function in it is complex. `billing/processor.ts` is second, with two high-complexity functions in a smaller file. These two files are your sprint targets.

**Scoping to a directory and filtering out simple functions:**

```
get_complexity_hotspots(repoId, scope: "src/api/", topN: 5, minComplexity: 5)
  → hotspots in the API directory, only counting functions with complexity ≥ 5
```

---

## Visualizing the type hierarchy

For TypeScript codebases with significant type hierarchies — domain models, plugin interfaces, ORM entities — `get_type_graph` shows how all the types relate to each other.

**Scenario:** You're onboarding a new developer to work on the domain model. You want to give them a visual overview of the type relationships before they start.

> "Show me a Mermaid diagram of the type hierarchy in src/domain/."

```
get_type_graph(repoId, scope: "src/domain/", format: "mermaid") →

  ```mermaid
  classDiagram
    Entity <|-- UserEntity
    Entity <|-- OrderEntity
    Entity <|-- ProductEntity
    UserEntity --> Address : uses
    UserEntity --> UserRole : uses
    OrderEntity --> OrderItem : uses
    OrderEntity --> PaymentStatus : uses
    Repository~T~ <|.. UserRepository
    Repository~T~ <|.. OrderRepository
    Repository~T~ <|.. ProductRepository
  ```
```

Paste into any Mermaid renderer and the team can see the full domain model at a glance. Generated from live code — never stale.

**Focusing on one type's connected types:**

```
get_type_graph(repoId, rootSymbol: "UserEntity", maxDepth: 2) →
  [UserEntity and everything it directly relates to, up to 2 hops]
```

**JSON output for programmatic use:**

```
get_type_graph(repoId, scope: "src/domain/", format: "json") →
  {
    "nodes": [
      { "id": "...", "name": "UserEntity", "kind": "class", "filePath": "..." },
      { "id": "...", "name": "Repository", "kind": "interface", "filePath": "..." },
      ...
    ],
    "edges": [
      { "source": "UserEntity-id", "target": "Entity-id", "relationship": "extends" },
      { "source": "UserRepository-id", "target": "Repository-id", "relationship": "implements" },
      ...
    ]
  }
```

Use this to feed into custom diagram tools, documentation generators, or architecture review scripts.

---

## Finding untested symbols

`find_untested_symbols` identifies functions, methods, and classes whose names don't appear in any test file — a heuristic for missing test coverage without needing a coverage report.

**Scenario:** Before a release, you want to know which business-critical functions have no tests at all.

> "Which functions in src/billing/ have no test coverage?"

```
find_untested_symbols(repoId, scope: "src/billing/", kinds: ["function", "method"]) →

  Untested Symbols — 12 found (sorted by priority):

  HIGH PRIORITY (complex and untested):
    chargePayment()       src/billing/processor.ts    complexity: 18   lines: 89
    applyRefund()         src/billing/refunds.ts      complexity: 12   lines: 67
    calculateProration()  src/billing/proration.ts    complexity: 9    lines: 45

  MEDIUM PRIORITY:
    formatInvoiceLine()   src/billing/invoice.ts      complexity: 4    lines: 23
    getNextBillingDate()  src/billing/schedule.ts     complexity: 3    lines: 18
    ... (5 more)

  LOW PRIORITY:
    formatCurrency()      src/billing/format.ts       complexity: 1    lines: 4
    ... (4 more)
```

The three high-priority items — `chargePayment`, `applyRefund`, `calculateProration` — are complex, untested, and handle money. These are your release blockers.

**Getting exact coverage with a coverage report:**

For more precision, use `get_test_coverage_map` instead:

> "Parse our vitest coverage report and show me which billing functions are uncovered."

```
get_test_coverage_map(repoId,
  coveragePath: "/project/coverage/coverage-final.json",
  scope: "src/billing/",
  includeUncoveredOnly: true) →

  Coverage Summary: 67% (41 of 61 symbols covered)

  Uncovered Symbols:
    chargePayment()       src/billing/processor.ts    0 calls   0% statements
    applyRefund()         src/billing/refunds.ts      0 calls   0% statements
    handlePartialAuth()   src/billing/processor.ts    0 calls   0% statements
    ...

  File Coverage:
    src/billing/processor.ts    statements: 45%   functions: 33%   branches: 38%
    src/billing/refunds.ts      statements: 52%   functions: 50%   branches: 44%
    src/billing/invoice.ts      statements: 91%   functions: 88%   branches: 84%
```

Line-accurate coverage linked to indexed symbols. Supports Istanbul/NYC (`coverage-final.json`) and V8/c8 formats.

---

## Choosing between coverage tools

| Situation | Use |
|-----------|-----|
| No coverage file available — quick estimate | `find_untested_symbols` |
| You have a coverage report — need line accuracy | `get_test_coverage_map` |
| Find the most complex untested functions | `find_untested_symbols` (sorted by complexity) |
| See statement/branch/function % per file | `get_test_coverage_map` |

---

→ Reference: [MCP Tools Reference](docs/06-tools-reference.md) — `get_entry_points`, `get_public_api`, `get_todos`, `get_complexity_hotspots`, `get_type_graph`, `find_untested_symbols`, `get_test_coverage_map`
