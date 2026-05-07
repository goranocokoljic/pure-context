# Making Changes Safely

The hardest part of changing code in a large codebase is not writing the new code — it's understanding what the old code touches. Every change that breaks something unexpected does so because the developer didn't know about a dependency they couldn't see.

PureContext gives you two tools that together form a complete pre-change analysis workflow: **blast radius** (what does this touch?) and **context bundle** (what does this need?).

---

## The blast radius: knowing your impact before you start

Before you change anything, find out what depends on it.

**Scenario:** You're refactoring a utility function `formatCurrency` that's been in the codebase for three years. It's used everywhere, but you don't know exactly where.

> "Before I refactor formatCurrency, show me everything that uses it."

Claude calls `get_blast_radius` and returns:

```
formatCurrency() is imported by 23 files:
  Direct importers (depth 1):
    src/billing/invoice.ts
    src/reporting/pdf-generator.ts
    src/api/responses/pricing.ts
    src/ui/components/PriceDisplay.tsx
    ... (8 more)

  Transitive importers (depth 2–3):
    src/api/routes/orders.ts  (via billing/invoice.ts)
    src/workers/monthly-report.ts  (via reporting/pdf-generator.ts)
    ... (9 more)

  Total files affected: 23
```

You now know the scope before you've written a line. If the blast radius is 23 files, you know this change needs careful testing. If it's 2, you can move quickly.

**What the blast radius tells you:**
- Files you need to update if the function's signature changes
- Test files that will break if behavior changes
- Services that will fail if the function is removed
- The difference between "safe to refactor locally" and "needs a deprecation cycle"

**Using blast radius for deletion decisions:**

> "I think this helper is unused — can you confirm?"

```
get_blast_radius(symbolId: "legacyFormatDate-id") →
  importers: []
  count: 0
```

Zero importers. Safe to delete. `find_dead_code` will surface all such symbols at once across the whole codebase.

---

## The context bundle: understanding what you're changing

Once you know the impact scope, understand the code itself before you touch it.

**Scenario:** You need to modify the `processOrder` function but you've never worked in this part of the codebase. You need to understand what it calls, what data it expects, and what it produces.

> "Give me everything I need to understand processOrder before I change it."

Claude calls `get_context_bundle` starting from `processOrder` with a depth of 2:

```
Context bundle for processOrder():

  processOrder()          src/orders/processor.ts    (the function itself, 67 lines)
  validateCart()          src/cart/validator.ts      (called by processOrder, 34 lines)
  calculateTax()          src/billing/tax.ts          (called by processOrder, 28 lines)
  formatPrice()           src/utils/format.ts         (called by validateCart, 12 lines)
  OrderRecord             src/db/models/order.ts      (the data shape, 22 lines)

  Token estimate: 1,240 tokens
  Files covered: 5
```

1,240 tokens for a complete picture of the order processing flow. Reading those 5 files directly would be ~8,000 tokens and would include unrelated functions, imports, and comments.

**Setting depth:** `maxDepth: 1` gives you just the direct dependencies. `maxDepth: 3` follows the dependency chain further but returns more. Start at 2 and go deeper only if you need it.

**Setting a token budget:** If you're working within a context window budget, set `maxTokens` and the bundle will stop collecting symbols once the estimate exceeds it — always returning the most directly connected ones first.

---

## The complete pre-change workflow

This is the pattern to use before any significant change:

```
1. Identify the symbol you're changing
   search_symbols(query: "processOrder") → find the right one

2. Check the blast radius
   get_blast_radius(symbolId) → how many files are affected?

3. Understand the symbol in context
   get_context_bundle(symbolId, maxDepth: 2) → what does it depend on?

4. Make the change

5. Verify nothing became orphaned
   find_dead_code(repoId) → any exports that are now unused?

6. Re-index (if you changed signatures)
   index_folder → incremental, fast, picks up your changes
```

---

## Detecting architectural violations before they ship

PureContext can also check whether your change violates the project's intended layer structure. If your codebase has defined architectural layers — for example, "core services must not import from API controllers" — the `get_layer_violations` tool checks for violations across the whole codebase.

> "Check if my changes introduced any architectural boundary violations."

```
get_layer_violations(repoId) →

  VIOLATION: src/core/billing.ts imports from src/api/middleware/auth.ts
  Layer: core → api  (not allowed per layer rules)
  Import: AuthMiddleware
```

Catch these before code review, not during.

---

## For teams: sharing impact analysis

In a team environment, blast radius analysis is especially valuable during planning. Before a developer starts on a change, ask PureContext to assess the scope:

> "We're planning to move the authentication service from JWT to session-based auth. What's the blast radius of changing the validateToken function?"

The answer tells the team how many files need to be updated, which services are affected, and whether this is a one-person job or a coordinated migration. That's a planning conversation that used to require a senior engineer's memory of the codebase.

---

## For legacy codebases

Legacy codebases are where blast radius analysis pays off most. Nobody knows all the call sites for a function that's been there for five years. PureContext does.

Before refactoring anything in a legacy system:

1. Run `find_dead_code` first — it often reveals that 20% of what you thought you needed to understand is actually unused
2. Use blast radius on the symbols you do need to change — the dependency graph doesn't lie
3. Use context bundle to understand the chain before proposing a change to your team

This transforms "I think this change is safe but I'm not sure" into "I know exactly which 7 files this change affects and here they are."

---

→ Reference: [MCP Tools Reference](../docs/06-tools-reference.md) — `get_blast_radius`, `get_context_bundle`, `find_importers`, `find_dead_code`, `get_layer_violations`
