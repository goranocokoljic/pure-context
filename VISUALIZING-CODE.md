# Visualizing Code Structure

Reading code is one way to understand structure. Seeing it is faster.

PureContext can generate diagrams of your codebase — import graphs, call graphs, class hierarchies, and dependency matrices — directly from the indexed symbol data. The output is Mermaid or DOT format: Mermaid renders natively in GitHub, VS Code, Claude, and most documentation tools; DOT feeds Graphviz.

---

## Import graphs: understanding module structure at a glance

The most common architectural question is also the simplest: *what imports what?*

**Scenario:** You're about to refactor the authentication module. Before you touch anything, you want to see how the auth files relate to each other and what the rest of the codebase is connected to.

> "Generate a diagram of the import relationships in src/auth/."

```
render_import_graph(repoId, filePath: "src/auth/", maxNodes: 20) →

  ```mermaid
  graph TD
    subgraph auth
      A[auth.ts] --> B[validator.ts]
      A --> C[session.ts]
      B --> D[crypto.ts]
      C --> E[db/session-store.ts]
    end
    F[api/routes/login.ts] --> A
    G[api/middleware/auth-guard.ts] --> A
    H[workers/session-cleanup.ts] --> C
  ```
```

Paste this into any Mermaid renderer and you see the auth module's external surface immediately: two API files import the main `auth.ts`, one worker imports `session.ts` directly. The validator and session modules are internal to auth.

**Whole-repo import graph (scoped to top-level directories):**

```
render_diagram(repoId, type: "module", maxNodes: 15, maxDepth: 2) →
  [diagram showing how src/api, src/core, src/db, src/workers relate]
```

Use `maxNodes` to keep the diagram readable. A 300-file codebase doesn't need 300 nodes — 15–30 representative files gives you the architectural skeleton.

---

## Call graphs: tracing execution paths visually

A call graph shows the actual runtime flow: when function A runs, what does it call, and what do those call?

**Scenario:** You're debugging an intermittent timeout. Requests to `/api/orders` are slow. You want to see the full execution path visually.

> "Draw the call graph for the processOrder function, 3 levels deep."

```
render_call_graph(repoId, symbolId: "processOrder-id", direction: "callees", maxDepth: 3) →

  ```mermaid
  flowchart TD
    ROOT["processOrder()"]:::root
    ROOT --> A["validateCart()"]
    ROOT --> B["calculateTax()"]
    ROOT --> C["chargePayment()"]
    A --> D["checkInventory()"]
    A --> E["applyDiscounts()"]
    B --> F["fetchTaxRates()"]
    C --> G["callPaymentGateway()"]
    C -.->|cyclic| C
    classDef root fill:#f0a500
  ```
```

The orange root node is `processOrder`. The dashed self-arrow on `chargePayment` — marked `cyclic` — indicates a retry loop. `callPaymentGateway` is the leaf that makes the external call. That's your timeout candidate.

**Bidirectional view — callers and callees:**

```
render_call_graph(repoId, symbolId: "sendEmail-id", direction: "both") →
  [callers above the root, callees below]
```

---

## Class hierarchy diagrams: visualizing inheritance

For codebases with significant inheritance — frameworks, plugin systems, ORM models — seeing the hierarchy visually is far faster than tracing it through source files.

**Scenario:** You're onboarding a new developer to the project. They need to understand the controller hierarchy before they can write a new endpoint.

> "Generate a class diagram of the controller hierarchy."

```
render_class_hierarchy(repoId, symbolId: "BaseController-id", direction: "descendants") →

  ```mermaid
  classDiagram
    BaseController <|-- AuthenticatedController
    BaseController <|-- PublicController
    AuthenticatedController <|-- UserController
    AuthenticatedController <|-- AdminController
    AuthenticatedController <|-- ApiController
    ApiController <|-- RestApiController
    ApiController <|-- GraphQLController
    PublicController <|-- LandingController
  ```
```

This goes straight into the architecture documentation. The diagram is generated from the live code — not hand-drawn — so it's always accurate.

---

## Dependency matrices: finding coupling hotspots

A dependency matrix shows the same information as an import graph but in table form. It's better for spotting dense coupling between specific files.

**Scenario:** You have a suspicion that certain modules in `src/core/` are too tightly coupled to each other. You want to see the exact coupling pattern.

> "Show me the dependency matrix for the 8 most coupled files in src/core/."

```
render_dep_matrix(repoId, filePath: "src/core/", topN: 8) →

               auth  billing  events  models  session  utils  crypto  db
  auth            —       1       0       1        1      1       1    1
  billing         0       —       1       1        0      1       0    1
  events          1       1       —       0        1      1       0    0
  models          0       0       0       —        0      0       0    1
  session         1       0       1       1        —      1       0    1
  utils           0       0       0       0        0      —       0    0
  crypto          0       0       0       0        0      1       —    0
  db              0       0       0       0        0      0       0    —
```

Cell `[row][col] = 1` means the row file imports the column file. You can immediately see that `auth`, `events`, and `session` form a triangle of mutual imports — a strong signal of circular dependency. `utils` imports nothing (it's a pure leaf), confirming it's safe to change. `models` only imports `db` — appropriately isolated.

---

## Architecture snapshots: tracking structural change over time

The tools above show you the current state. Architecture snapshots let you compare state across time — before and after a refactoring, between a feature branch and main.

**Scenario:** Your team spent three weeks breaking circular dependencies and reducing coupling. You want to prove the improvement with data.

> "Create a snapshot of the architecture before we start the refactoring sprint."

```
get_architecture_snapshot(repoId, action: "create", label: "before-dec-sprint") →
  { snapshotId: "snap_a1b2c3", label: "before-dec-sprint", createdAt: "..." }
```

[Three weeks and a re-index later]

> "Create another snapshot and compare it to the one from before the sprint."

```
get_architecture_snapshot(repoId, action: "create", label: "after-dec-sprint") →
  { snapshotId: "snap_d4e5f6" }

get_architecture_snapshot(repoId, action: "diff",
  snapshotId: "snap_a1b2c3", compareId: "snap_d4e5f6") →

  Structural change (after vs before):

  fileCount:      +12         (12 new files created during extraction)
  symbolCount:    +34         (more focused, smaller functions)
  edgeCount:      -41         (fewer total imports — less coupling)
  cycleCount:     -7          (7 circular deps eliminated)
  avgCoupling:    3.4 → 2.1  (modules are less interconnected)
  avgComplexity:  4.8 → 3.9  (simpler on average)
```

Fewer edges, fewer cycles, lower coupling, lower complexity. This is the before-and-after you show in the sprint retrospective.

**Use snapshots for PR review too:**

```
1. Index main → get_architecture_snapshot(action: "create", label: "main")
2. Index feature branch → get_architecture_snapshot(action: "create", label: "pr-42")
3. diff the two snapshots to see the structural impact of the PR
```

---

## Choosing the right diagram

| Question | Tool |
|----------|------|
| How are the files in this directory connected? | `render_import_graph` |
| What does this function call at runtime? | `render_call_graph` |
| What extends/implements this class? | `render_class_hierarchy` |
| Which files are most tightly coupled? | `render_dep_matrix` |
| I want a single diagram — call, class, or module | `render_diagram` (general-purpose) |
| Did this PR improve or worsen the architecture? | `get_architecture_snapshot` + diff |

All tools support `format: "dot"` if you prefer Graphviz output for more powerful layout options.

---

→ Reference: [MCP Tools Reference](docs/06-tools-reference.md) — `render_diagram`, `render_call_graph`, `render_import_graph`, `render_class_hierarchy`, `render_dep_matrix`, `get_architecture_snapshot`
