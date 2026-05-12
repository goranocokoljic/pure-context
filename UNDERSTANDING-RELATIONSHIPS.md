# Understanding Code Relationships

The dependency graph gives you the broad picture — what imports what. But most real questions about a codebase go deeper: *who implements this interface?*, *what does this function call at runtime?*, *why is this module so hard to change?*, *where are the circular imports that are blocking our refactoring?*

PureContext has a dedicated set of tools for answering these structural questions without reading source files.

---

## Finding all implementations of an interface

When you're working with a codebase that uses interfaces heavily — whether for dependency injection, plugin systems, or polymorphism — you regularly need to know: *what concrete classes actually implement this?*

**Scenario:** You're changing the `UserRepository` interface to add a new method. Before you change the interface, you need to know which classes implement it so you can update them all.

> "Which classes implement the UserRepository interface?"

```
find_implementations(symbolId: "UserRepository-id") →

  Interface: UserRepository  (src/core/repositories/user.ts)

  Implementations:
    PostgresUserRepository   src/db/postgres/user-repo.ts    implements all 7 methods ✓
    InMemoryUserRepository   src/test/mocks/user-repo.ts     implements all 7 methods ✓
    CachedUserRepository     src/cache/user-repo.ts          missing: batchGet, streamAll ✗

  Total: 3 implementations
```

You can see immediately that `CachedUserRepository` is incomplete — it's missing two methods. Adding a third method to the interface will require updating all three classes. You know the scope before you change a single line.

**Including abstract subclasses:**

```
find_implementations(symbolId: "UserRepository-id", includeAbstract: true)
```

This surfaces abstract classes that extend the interface — useful in Java or Kotlin codebases where abstract base classes form an intermediate layer.

---

## Understanding the call hierarchy

`get_blast_radius` tells you which *files* import a symbol. `get_call_hierarchy` tells you how a function is actually *called at runtime* — the actual call stack, structured as a tree.

**Scenario:** You're investigating a performance issue. The `generateReport` function is slow, but you're not sure if the problem is in the function itself or in something it calls deep down.

> "Show me what generateReport calls, three levels deep."

```
get_call_hierarchy(symbolId: "generateReport-id", direction: "callees", maxDepth: 3) →

  generateReport()                  [root]
    ├── fetchReportData()            depth 1 — called 1×
    │     ├── queryUserEvents()      depth 2 — called 1×
    │     │     └── buildSQLQuery()  depth 3 — called 3×
    │     └── queryMetrics()         depth 2 — called 1×
    │           └── buildSQLQuery()  depth 3 — called 1×  [cyclic: seen above]
    ├── formatReportRows()           depth 1 — called 1×
    │     └── formatCurrency()       depth 2 — called N×
    └── generatePDF()               depth 1 — called 1×
          └── compressOutput()       depth 2 — called 1×

  Total nodes: 10
```

`buildSQLQuery` is called four times from two different paths. `formatCurrency` is called in a loop. The tree structure lets you see exactly where the CPU time is going without running a profiler.

**Checking who calls a function:**

> "Who calls sendEmail? I need to know all the places it's triggered."

```
get_call_hierarchy(symbolId: "sendEmail-id", direction: "callers", maxDepth: 2) →

  sendEmail()                  [root]
    ├── triggerWelcomeEmail()   depth 1 — src/onboarding/welcome.ts
    ├── sendPasswordReset()     depth 1 — src/auth/password.ts
    │     └── resetPassword()   depth 2 — src/api/routes/auth.ts
    ├── notifyPaymentFailed()   depth 1 — src/billing/notify.ts
    └── weeklyDigest()          depth 1 — src/workers/digest.ts
```

Four callers, one with a caller of its own. This is the full list of places that trigger email sending — a complete picture for changing the email system.

---

## Tracing inheritance chains

When working with class hierarchies — especially in enterprise codebases with deep inheritance — you need to understand both directions: what does a class inherit from, and what inherits from it?

**Scenario:** You're refactoring `BaseController`. Before you change it, you want to know the full inheritance chain.

> "Show me the full class hierarchy for BaseController."

```
get_class_hierarchy(symbolId: "BaseController-id", direction: "both") →

  Ancestors (BaseController extends):
    BaseController → Object  (external, not indexed)

  Descendants (classes that extend BaseController):
    BaseController
      ├── AuthenticatedController
      │     ├── UserController
      │     ├── AdminController
      │     └── ApiController
      │           ├── RestApiController
      │           └── GraphQLController
      └── PublicController
            └── LandingController

  Total: 9 nodes
```

Seven classes will be affected by changes to `BaseController`. The deepest chains (`RestApiController`, `GraphQLController`) are four levels of inheritance — a sign that these might benefit from composition instead.

**Checking ancestors only:**

```
get_class_hierarchy(symbolId: "UserController-id", direction: "ancestors")
→ UserController → AuthenticatedController → BaseController → Object
```

---

## Finding circular dependencies

Circular imports are one of the most common causes of "this module is impossible to change independently." They also cause subtle initialization bugs and make testing harder.

**Scenario:** You've noticed that changes to `src/core/` always seem to require changes in `src/utils/`, and vice versa. You suspect a circular dependency.

> "Find all circular imports in the codebase. Start with cycles involving the core directory."

```
find_cycles(filePath: "src/core/") →

  Cycle 1 (severity: error — tight 2-node cycle):
    src/core/billing.ts → src/utils/currency.ts → src/core/billing.ts

  Cycle 2 (severity: error — tight 3-node cycle):
    src/core/auth.ts → src/models/user.ts → src/core/session.ts → src/core/auth.ts

  Cycle 3 (severity: warning — longer chain):
    src/core/events.ts → src/handlers/payment.ts → src/core/billing.ts
    → src/core/events.ts

  Total: 3 cycles found
```

The first cycle is the one you suspected — `billing.ts` and `currency.ts` are mutually dependent. Breaking this cycle (typically by extracting the shared types into a third module that both can import) is the fix.

**Checking cycles in the whole repo:**

```
find_cycles(maxCycles: 50) → finds all cycles up to the limit
find_cycles(minLength: 3)  → skips direct mutual imports, shows only longer chains
```

---

## Measuring coupling

Coupling tells you which files are the most dangerous to change — not because they're complex, but because everything else depends on them.

**Scenario:** You're planning a major refactoring sprint. Before you start, you want to know which files have the highest coupling — both in terms of what they import and what imports them.

> "Which files in src/ have the highest coupling? I want to know where the structural risk is."

```
get_coupling_map(repoId, topN: 10) →

  src/utils/helpers.ts
    efferentCoupling (imports): 3      ← imports only 3 files
    afferentCoupling (imported by): 41 ← but 41 files depend on it
    instability: 0.07                  ← near 0 = maximally stable = risky to change

  src/core/auth.ts
    efferentCoupling: 12
    afferentCoupling: 28
    instability: 0.30                  ← stable hub

  src/api/middleware/logging.ts
    efferentCoupling: 18
    afferentCoupling: 2
    instability: 0.90                  ← near 1 = leaf node = safe to change

  ...
```

`helpers.ts` is the hidden risk: 41 files depend on it, but it only imports 3 things. Its instability score of 0.07 means it's a stable hub — every change to it ripples out to 41 files. That's the file to touch last, if at all.

**Inspecting a single file's dependency list:**

> "Who depends on src/core/auth.ts, and what does auth.ts itself depend on?"

```
get_coupling_map(repoId, filePath: "src/core/auth.ts", direction: "both") →

  Imports (efferent — what auth.ts depends on):
    src/models/user.ts
    src/db/queries/auth.ts
    src/utils/crypto.ts
    ... (9 more)

  Imported by (afferent — what depends on auth.ts):
    src/api/middleware/auth-guard.ts
    src/api/routes/login.ts
    src/workers/session-cleanup.ts
    ... (25 more)
```

---

## Putting it together: pre-refactoring analysis

Before a significant structural refactoring, combine these tools:

```
1. find_cycles(repoId)
   → identify which circular deps are blocking modularization

2. get_coupling_map(repoId, topN: 20)
   → rank files by coupling to find the stable hubs

3. get_class_hierarchy(symbolId)
   → understand inheritance depth in affected areas

4. find_implementations(symbolId)
   → know how many classes implement interfaces you plan to change

5. get_call_hierarchy(symbolId, direction: "callers")
   → verify you've found all callers before changing a function signature
```

This analysis takes minutes and replaces hours of manual code reading.

---

→ Reference: [MCP Tools Reference](docs/06-tools-reference.md) — `find_implementations`, `get_call_hierarchy`, `get_class_hierarchy`, `find_cycles`, `get_coupling_map`
