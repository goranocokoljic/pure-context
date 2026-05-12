# Workflow: Running a Tech Debt Review Sprint

**Scenario:** It's the start of a new quarter. Your team has been shipping features for six months and the codebase has drifted. You have two weeks set aside for a technical debt sprint. You need to figure out what to work on, prioritize it, execute it safely, and prove the improvement.

This workflow shows how PureContext turns a vague "debt sprint" into a structured, measurable campaign.

---

## Phase 1: Assess — what are we dealing with?

Before writing any code, get a complete picture of the codebase's health.

**You:** "Before we start the sprint, give me a full health assessment of the codebase."

**Claude** runs `health_radar`:

```
Health Radar — before Q2 sprint

complexity       58   ██████████░░░░░░░░░░  Warning
coupling         44   ████████░░░░░░░░░░░░  Poor
maintainability  71   ██████████████░░░░░░  Fair
documentation    31   ██████░░░░░░░░░░░░░░  Poor
stability        62   ████████████░░░░░░░░  Fair

Overall Health:  53   Grade: D
```

Not good. Coupling and documentation are the weakest axes. Complexity is borderline. Now get the details.

**You:** "Generate a full debt report. I want to know which files to focus on."

**Claude** runs `get_debt_report(topN: 10)`:

```
Technical Debt Report

Overall Debt Score: 49/100   Grade: C-

Structural Debt:  68  ← worst category
  3 circular dependencies
  14 files with fan-out > 10
  2 god classes (UserManager.ts, helpers.ts)

Complexity Debt:  55
  18 functions with cyclomatic > 8
  4 functions > 20 complexity

Maintainability:  41
  2 god classes
  29 dead exports
  81 undocumented exported symbols

Volatility:  44
  6 high-churn files with complexity > 8 (highest risk)

Top Debt Files:

  1. src/legacy/UserManager.ts       score: 91
  2. src/utils/helpers.ts            score: 79
  3. src/core/auth.ts                score: 68  ← highest churn + cycles
  4. src/api/routes/legacy.ts        score: 61
  5. src/billing/processor.ts        score: 58
```

**Snapshot the state before you start:**

```
get_architecture_snapshot(repoId, action: "create", label: "before-Q2-sprint")
→ snapshotId: "snap_before"
```

You'll diff against this at the end to prove the improvement.

---

## Phase 2: Understand — cycles, coupling, relationships

Before breaking cycles and reducing coupling, understand the exact structure.

**You:** "Find all circular dependencies. Show me the cycles involving our core modules."

```
find_cycles(repoId, filePath: "src/core/") →

  Cycle 1 (ERROR — tight 2-node):
    src/core/auth.ts ↔ src/core/session.ts

  Cycle 2 (ERROR — tight 3-node):
    src/core/billing.ts → src/utils/currency.ts → src/core/billing.ts

  Cycle 3 (WARNING):
    src/core/events.ts → src/handlers/payment.ts → src/core/billing.ts
    → src/core/events.ts
```

Three cycles. Two errors — these are the structural problems that make the core modules hard to test independently.

**You:** "Show me the coupling map for the most coupled files."

```
get_coupling_map(repoId, topN: 8) →

  src/utils/helpers.ts         instability: 0.06   (42 files depend on it)
  src/core/auth.ts             instability: 0.24   (28 files depend on it)
  src/models/user.ts           instability: 0.19   (31 files depend on it)
  ...
```

`helpers.ts` is the most dangerous file to change — 42 files depend on it. It's also identified as a god class in the debt report. It's the highest-priority structural target.

**You:** "Before I split helpers.ts, show me its class hierarchy and who implements its exported interfaces."

```
get_class_hierarchy(symbolId: "BaseHelper-id", direction: "descendants") →
  [hierarchy showing no subclasses — it's not a class hierarchy issue, it's a module cohesion issue]

get_coupling_map(repoId, filePath: "src/utils/helpers.ts", direction: "efferent") →
  [shows helpers.ts imports from: lodash, moment, crypto, db/queries ← 4 completely unrelated domains]
```

The helper file mixes formatting, crypto, date handling, and database utilities in one place. The plan: split it into `src/format/`, `src/crypto/`, `src/date/`, `src/db/utils/`.

---

## Phase 3: Plan — sequence the work safely

Before executing, get a sequenced plan for each major change.

**You:** "Give me a refactoring plan for splitting helpers.ts into focused modules."

```
plan_refactoring(repoId, goal: "extract-module", filePath: "src/utils/helpers.ts") →

  Goal: extract-module
  Estimated files affected: 42
  Risk: HIGH (42 files import this — proceed carefully)

  Recommended steps:

  1. [LOW RISK] Create new module files
     src/format/currency.ts  — move formatCurrency, formatPrice, formatPercent
     src/date/utils.ts       — move formatDate, parseDate, addDays
     src/crypto/utils.ts     — move hashToken, compareHash, generateSecret
     src/db/helpers.ts       — move buildQuery, sanitizeSql

  2. [MEDIUM RISK] Update leaf importers (files with few other importers)
     12 test files — update imports one by one, run tests after each
     8 utility consumers — update in batches of 2-3

  3. [HIGH RISK] Update hub importers (files imported by many others)
     src/core/auth.ts (imported by 28 files) — update last
     src/api/middleware/auth.ts (imported by 14 files) — update last

  4. [FINAL] Deprecate src/utils/helpers.ts
     Add re-exports for backward compatibility
     Schedule removal in next major release

  Warnings:
    - Do not remove helpers.ts immediately — it takes 42 files off the air simultaneously
    - Use re-exports during a transition period to avoid breaking the team's in-progress work
```

---

## Phase 4: Execute — safely, one step at a time

For each specific change, check safety before you start.

**Breaking the billing ↔ currency cycle:**

**You:** "Before I break the circular dependency between billing.ts and currency.ts, show me the exact imports causing the cycle."

```
find_cycles(repoId, filePath: "src/core/billing.ts") →

  Cycle:
    src/core/billing.ts:3   import { formatCurrency } from '../utils/currency'
    src/utils/currency.ts:7  import { DEFAULT_CURRENCY } from '../core/billing'
```

`billing.ts` imports `formatCurrency` from currency. `currency.ts` imports `DEFAULT_CURRENCY` from billing. The fix: move `DEFAULT_CURRENCY` to a `constants.ts` file that both can import without creating a cycle.

**Renaming a function as part of the cleanup:**

**You:** "I'm renaming formatCurrency to formatMoney as part of the extraction. Is that safe?"

```
check_rename_safe(repoId, symbolId: "formatCurrency-id", newName: "formatMoney") →

  safe: true  — 23 files affected, all call sites and imports
  No string-literal references. No name conflicts.
```

Safe. Proceed.

**Deleting dead exports found by the debt report:**

**You:** "The debt report listed 29 dead exports. Confirm that the top 5 are safe to delete."

```
check_delete_safe(repoId, symbolId: "LegacyTokenParser-id") → safe: true
check_delete_safe(repoId, symbolId: "OldSessionFormat-id")   → safe: true
check_delete_safe(repoId, symbolId: "validateBasicAuth-id")  → safe: true
check_delete_safe(repoId, symbolId: "generateJWT-id")        →
  safe: false — 1 live reference in src/integrations/legacy-sso.ts:45
check_delete_safe(repoId, symbolId: "parseQueryString-id")   → safe: true
```

Four of five are clean deletes. `generateJWT` has one live reference in the legacy SSO integration — update that first, then delete.

---

## Phase 5: Verify — did it work?

After two weeks of work, measure the improvement.

**You:** "Re-index and generate a new health radar. How did we do?"

```
health_radar(repoId) →

  Health Radar — after Q2 sprint

  complexity       65   ████████████░░░░░░░░  Fair    (was: 58 ▲ +7)
  coupling         61   ████████████░░░░░░░░  Fair    (was: 44 ▲ +17)
  maintainability  79   ███████████████░░░░░  Good    (was: 71 ▲ +8)
  documentation    52   ██████████░░░░░░░░░░  Warning (was: 31 ▲ +21)
  stability        67   █████████████░░░░░░░  Fair    (was: 62 ▲ +5)

  Overall Health:  65   Grade: C+   (was: D)
```

Every axis improved. Documentation saw the biggest gain — from a nearly failing 31 to 52. Coupling improved by 17 points. Overall grade went from D to C+.

**Compare the architecture snapshots:**

```
get_architecture_snapshot(repoId, action: "diff",
  snapshotId: "snap_before", compareId: "snap_after") →

  fileCount:     +8     (helpers.ts split into 4 focused modules + 4 new test files)
  symbolCount:   -12    (29 dead exports removed, net negative after new code)
  edgeCount:     -34    (fewer total imports — better modularization)
  cycleCount:    -3     (3 circular deps eliminated)
  avgCoupling:   4.2 → 2.8  (-1.4 — significantly less coupled)
  avgComplexity: 5.1 → 4.3  (-0.8 — lower average complexity)
```

Concrete structural improvement. Three cycles eliminated. Coupling down 33%.

**Run the debt report to verify the top files improved:**

```
get_debt_report(repoId, topN: 5) →

  Overall Debt Score: 31/100   Grade: B-   (was: 49/100)

  src/legacy/UserManager.ts  score: 67  (was: 91 ▼ -24)
  src/utils/format/currency.ts  score: 12  (was: 79 as helpers.ts ▼ -67 — split completed)
  src/core/auth.ts  score: 44  (was: 68 ▼ -24)
  src/api/routes/legacy.ts  score: 58  (was: 61 ▼ -3)
  src/billing/processor.ts  score: 55  (was: 58 ▼ -3)
```

The dramatic improvement in `helpers.ts` (79 → 12 average across the split modules) shows the extraction was the right call. `UserManager.ts` dropped 24 points from the class extraction. The sprint achieved its goals.

---

## What made this sprint effective

**Measured before and after.** Snapshots gave concrete proof of improvement — not just "we refactored things" but "+17 coupling score, 3 cycles eliminated."

**Prioritized by impact, not feeling.** The debt report ranked files objectively. `UserManager.ts` and `helpers.ts` were the right targets because the data said so — not intuition.

**Checked safety before every change.** `check_rename_safe`, `check_delete_safe`, and `check_move_safe` prevented breaking changes. The one "not safe" flag on `generateJWT` caught a real dependency that would have caused a production regression.

**Understood structure before touching code.** `find_cycles` showed the exact imports causing each cycle. `get_coupling_map` showed why `helpers.ts` was so dangerous to change. The actual edits were straightforward once the structure was understood.

---

→ See also:  
→ [Code Health & Architecture Analysis](CODE-HEALTH.md) — quality metrics and anti-pattern detection  
→ [Health Dashboards & Debt Reporting](HEALTH-DASHBOARDS.md) — health_radar, diff_health_radar, get_debt_report  
→ [Refactoring Safely](REFACTORING-SAFELY.md) — pre-flight checks before any structural change  
→ [Understanding Relationships](UNDERSTANDING-RELATIONSHIPS.md) — cycles, coupling, and call hierarchies
