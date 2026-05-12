# Health Dashboards & Debt Reporting

Technical debt accumulates the same way in every codebase: gradually, then suddenly. Individual decisions that seemed reasonable at the time compound into a system that's expensive to change and risky to touch. By the time it's a crisis, you're already deep in it.

PureContext gives you three complementary tools for measuring, tracking, and acting on code health over time.

---

## Health radar: five-axis scoring at a glance

`health_radar` scores your codebase on five dimensions, each 0–100 where 100 is perfectly healthy. It's designed for a quick read — dashboard views, CI gates, and pre-meeting overviews.

**Scenario:** Before a quarterly architecture review, you want a snapshot of where the codebase stands.

> "Give me a health overview of the entire codebase before we start our planning session."

```
health_radar(repoId) →

  Health Radar — purecontext-mcp

  complexity       72   ██████████████░░░░░░  Good
                        avg. cyclomatic: 3.4  peak: 18 (src/legacy/UserManager.ts)

  coupling         51   ██████████░░░░░░░░░░  Warning
                        23 files with fan-out > 10  (threshold: < 10)

  maintainability  78   ███████████████░░░░░  Good
                        3 god classes found  11 dead exports

  documentation    34   ██████░░░░░░░░░░░░░░  Poor
                        34% of exported symbols have meaningful summaries

  stability        63   ████████████░░░░░░░░  Fair
                        (churn data available — 8 high-churn files flagged)

  Overall Health:  60   Grade: C

  Summary: 312 files, 4,218 symbols, 7 high-risk files
```

Five numbers give you the complete picture in under 30 seconds. Complexity and maintainability are green. Coupling is borderline. Documentation is a problem. Stability is fair but has hot spots.

**Scoping to a subsystem:**

> "How healthy is just the authentication module?"

```
health_radar(repoId, scope: "src/auth/") →
  [same five axes, computed only for files under src/auth/]
```

Use this to compare health across services, or to track the health of a specific domain area you're actively working on.

**Excluding git data:**

```
health_radar(repoId, includeStability: false)
```

The stability axis requires git history. If git metadata isn't available (e.g., a freshly cloned repo without full history), set `includeStability: false` to score only the four static axes.

---

## Comparing health between two versions

`diff_health_radar` runs health radar on two repos and computes the delta. The most common use is before/after comparison, but it works for any two indexed repos.

**Scenario 1: Validating a refactoring sprint.**

Your team spent two weeks addressing coupling and documentation issues. You want proof that it worked.

> "Compare the health of the codebase now vs. the snapshot we indexed before the sprint."

```
diff_health_radar(baseRepoId: "pre-sprint-id", headRepoId: "post-sprint-id") →

  Comparison: pre-sprint → post-sprint

  complexity      72 → 74   Δ +2   stable
  coupling        51 → 67   Δ +16  ▲ improved
  maintainability 78 → 82   Δ +4   stable
  documentation   34 → 61   Δ +27  ▲ improved significantly
  stability       63 → 65   Δ +2   stable

  Overall:  60 → 70   Δ +10   trend: improved

  Improvements: coupling, documentation
  Regressions:  none
```

Coupling improved from 51 to 67 — a meaningful change. Documentation went from 34 to 61 — a dramatic improvement from the doc-writing effort. No regressions. The sprint achieved its goals.

**Scenario 2: PR health review.**

> "Does this PR improve or worsen the codebase health?"

```
# 1. Index main branch
index_folder(path: "/projects/app", ...)  → baseRepoId: "main-index"

# 2. Index the feature branch
index_folder(path: "/projects/app-pr-feature-x", ...) → headRepoId: "pr-index"

# 3. Compare
diff_health_radar(baseRepoId: "main-index", headRepoId: "pr-index") →

  coupling        65 → 61   Δ -4   ▼ degraded
  documentation   61 → 58   Δ -3   ▼ degraded slightly

  Regressions: coupling, documentation
  trend: degraded
```

The PR adds coupling and removes documentation coverage. Flag it in the review — the delta is small but the direction is wrong.

---

## Debt reports: from score to action

Health radar gives you scores. `get_debt_report` gives you the full breakdown with ranked files and prioritized action items.

**Scenario:** You have a C-grade codebase and limited sprint capacity. You want to know exactly where to invest to get the most improvement per hour of work.

> "Generate a technical debt report for the whole codebase. I want to know where to focus first."

```
get_debt_report(repoId, topN: 5) →

  Technical Debt Report

  Overall Debt Score: 43/100   Grade: C

  ┌─────────────────────┬────────┬──────────────────────────────────────────┐
  │ Category            │ Score  │ Top Issues                               │
  ├─────────────────────┼────────┼──────────────────────────────────────────┤
  │ Complexity          │   38   │ 12 functions with cyclomatic > 10        │
  │ Structural          │   61   │ 3 circular deps, 8 high-coupling files   │
  │ Maintainability     │   29   │ 2 god classes, 41 dead exports           │
  │ Volatility          │   44   │ 5 high-churn files with complexity > 8   │
  └─────────────────────┴────────┴──────────────────────────────────────────┘

  Top Debt Files:

  1. src/legacy/UserManager.ts          score: 87
     - cyclomatic complexity avg: 11.4 (34 methods, 4 > 20 complexity)
     - fan-out: 28 (imports 28 different files)
     - 0 exports have documentation
     - modified 47× in the last 6 months (highest churn)

  2. src/utils/helpers.ts               score: 74
     - 45 symbols across 8 unrelated domains (low cohesion)
     - fan-in: 41 files depend on it (high blast radius)
     - 12 dead exports

  3. src/core/billing.ts                score: 68
     - circular dependency with src/utils/currency.ts
     - 3 functions with complexity > 12
     - high churn: modified 31× in 6 months

  4. src/api/routes/legacy.ts           score: 62
     - 7 functions with complexity > 8
     - no test references found for 4 exported functions

  5. src/models/user.ts                 score: 58
     - imported by 34 files (stable hub — risky to change)
     - 6 dead exports (possibly orphaned during a migration)

  Prioritized Action Items:

  HIGH ROI:
  • Extract UserManager.ts into focused service classes
    Reason: highest debt score + highest churn = highest risk
    Estimated impact: −15 pts on complexity, −8 pts on structural debt

  • Split helpers.ts by domain into 8 focused utility modules
    Reason: eliminates 41-file blast radius + removes dead code
    Estimated impact: −12 pts on structural, −5 pts on maintainability

  • Break billing.ts ↔ currency.ts circular dependency
    Reason: blocking independent testing of both modules
    Estimated impact: −8 pts on structural debt

  MEDIUM ROI:
  • Add documentation to top 20 exported symbols in core/
    Reason: documentation score is pulling down the overall grade
    Estimated impact: +10 pts on documentation axis in health_radar

  • Delete 41 dead exports (run find_dead_code for the full list)
    Reason: reduces cognitive load + clarifies the public API surface
```

The report tells you exactly what to work on: `UserManager.ts` is the highest-priority target (highest debt, highest churn — the most dangerous file in the codebase). `helpers.ts` second. The circular dependency third.

**Narrowing to a subsystem:**

```
get_debt_report(repoId, scope: "src/core/", topN: 10)
  → debt analysis restricted to files under src/core/
```

**For CI integration:**

Run `get_debt_report` in CI and fail the pipeline if the overall debt score exceeds a threshold. Pair it with `diff_health_radar` to catch individual PRs that increase debt.

---

## Using the three tools together

The three tools answer different questions and work best together:

| Tool | When to use | Output |
|------|------------|--------|
| `health_radar` | Quick status check: "where are we?" | 5 scores + grade |
| `diff_health_radar` | Before/after comparison: "did we improve?" | Per-axis deltas |
| `get_debt_report` | Action planning: "what do we do first?" | Ranked files + action items |

**A monthly rhythm that works:**

```
1st of the month:
  health_radar(repoId)
  → log the scores to track the trend over time

Start of sprint:
  get_debt_report(repoId, topN: 10)
  → pick the highest-ROI items for this sprint

End of sprint:
  diff_health_radar(baseRepoId: "month-start", headRepoId: "current")
  → measure the sprint's impact on each axis

PR merges:
  diff_health_radar(baseRepoId: "main", headRepoId: "feature")
  → catch regressions at the PR level, not the monthly level
```

---

→ Reference: [MCP Tools Reference](docs/06-tools-reference.md) — `health_radar`, `diff_health_radar`, `get_debt_report`  
→ See also: [Code Health & Architecture Analysis](CODE-HEALTH.md) — quality metrics, anti-pattern detection
