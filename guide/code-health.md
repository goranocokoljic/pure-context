# Code Health & Architecture Analysis

Code health problems are usually invisible until they're crises. A function that's grown to 200 lines, a module with 30 imports, a circular dependency that makes testing impossible — these accumulate silently until the day someone needs to change them.

PureContext makes code health visible and measurable, so you can address problems proactively rather than reactively.

---

## Quality metrics

The `get_quality_metrics` tool scores files and symbols on four dimensions:

| Metric | What it measures | Target |
|--------|-----------------|--------|
| **Complexity** | Average cyclomatic complexity per function | < 5 |
| **Coupling** | Fan-in (who imports this) and fan-out (what this imports) | Fan-out < 10 |
| **Cohesion** | How related the symbols in a file are to each other | > 0.6 |
| **Doc coverage** | % of exported symbols with non-empty summaries | > 0.8 |

**Scenario:** Before a quarterly technical debt sprint, get an overview of which files need the most attention.

> "Give me quality metrics for the entire codebase. Which files are in the worst shape?"

```
get_quality_metrics(repoId) →

  Worst files by composite score:

  src/legacy/UserManager.ts       score: 34/100
    complexity: 9.4 (high)
    coupling.fanOut: 28 (very high)
    cohesion: 0.31 (low — 47 symbols, many unrelated)
    docCoverage: 0.08 (almost undocumented)

  src/utils/helpers.ts            score: 41/100
    complexity: 3.2 (fine)
    coupling.fanIn: 42 (everything imports this)
    cohesion: 0.28 (45 symbols, 8 different domains)
    docCoverage: 0.15

  src/api/routes/legacy.ts        score: 48/100
    complexity: 7.1 (high)
    coupling.fanOut: 18 (too many imports)
    ...
```

`UserManager.ts` and `helpers.ts` are the priority. One is a god class; the other is a catch-all utilities file that's accumulated unrelated concerns over years.

---

## Anti-pattern detection

`detect_antipatterns` scans the codebase for specific structural problems. Run it on demand, focus it on specific patterns, or run all checks at once.

**Detected patterns:**

| Pattern | What it means |
|---------|--------------|
| `god-class` | Class with > 20 methods or > 15 imports — should be split |
| `god-function` | Function with cyclomatic complexity > 15 — should be broken up |
| `high-coupling` | File importing > 20 other files — knows too much |
| `circular-deps` | A → B → C → A — modules that can't be changed independently |
| `dead-code` | Exported symbols with no importers — candidates for deletion |
| `missing-docs` | Exported symbols with no summary — invisible to search |
| `deep-nesting` | Functions with nesting depth > 5 — hard to read and test |

**Scenario:** Before merging a large feature branch to main:

> "Check for any architectural problems introduced by this branch."

```
detect_antipatterns(repoId) →

  2 errors, 8 warnings:

  ERROR  circular-deps    src/core/index.ts → src/utils/helpers.ts → src/core/index.ts
         "Circular dependency detected. These modules cannot be changed independently."

  ERROR  god-class        src/features/UserManager.ts (UserManager class)
         "34 methods detected. Consider splitting by responsibility."

  WARNING dead-code        src/auth/legacy-jwt.ts (validateJWT function)
         "Exported but no importers found. Possibly orphaned by this branch."

  WARNING missing-docs     8 exported symbols have no summaries.
  ...
```

Two errors tell you what must be fixed before this goes to production. The dead-code warning flags a likely bug — `validateJWT` was removed from its callers but not deleted.

---

## CI integration: fail on critical issues

For enterprise teams, anti-pattern detection can be part of the CI pipeline. Use the GitHub Actions integration to fail the build when error-severity issues are detected:

```yaml
- uses: purecontext/purecontext-mcp@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    detect-antipatterns: 'true'   # fails CI on error-severity issues
    analyze-diff: 'true'          # posts blast radius as a PR comment
```

This enforces architecture rules at the point of change — a PR can't introduce a circular dependency and pass CI. The enforcement is automatic and doesn't require a reviewer to catch it.

See [Distribution & Platform](../docs/22-distribution.md) for the full GitHub Actions reference.

---

## Auto-generated architecture documentation

`get_architecture_doc` generates a written description of the codebase's structure from the symbol graph and dependency data. It doesn't require AI summarization to be enabled — the structure itself contains enough information to describe the architecture.

> "Generate an architecture overview for this service."

```
get_architecture_doc(repoId, format: "markdown") →

  # Architecture Overview

  ## Entry Points
  The application starts at src/index.ts (bootstrap function), which initializes
  the HTTP server and registers 3 background workers.

  ## Module Structure
  - **api/** — HTTP routing layer. 12 routes across 4 controllers. Express adapter active.
  - **core/** — Business logic. 8 service classes. No framework dependencies.
  - **db/** — Data access. Prisma adapter detected. 6 models, 14 query functions.
  - **workers/** — Background jobs. 3 workers registered via Bull queue.

  ## Key Dependencies
  External: express, prisma, bull, jsonwebtoken, bcrypt
  All core services are framework-agnostic (testable without HTTP layer).

  ## Detected Adapters
  Express (routing), Prisma (ORM)
```

Generate the Mermaid format for visual architecture diagrams:

```
get_architecture_doc(repoId, format: "mermaid") →
  graph TD
    A[src/index.ts] --> B[src/api/]
    A --> C[src/workers/]
    B --> D[src/core/]
    D --> E[src/db/]
```

**Where this is useful:** Architecture review meetings where the documentation is out of date, onboarding new team members, writing the architecture section of a design doc, or verifying that the actual code structure matches the documented design.

---

## Finding refactoring opportunities

The refactoring detector combines quality metrics, duplication analysis, and coupling data to surface the highest-value refactoring candidates:

> "What should we refactor first in this codebase?"

```
find_refactoring_opportunities(repoId) →

  HIGH PRIORITY:
  extract-function  src/auth/processor.ts / processAuthRequest()
    "120 lines, complexity 18. Extract validation and transformation logic."

  extract-module    src/utils/helpers.ts
    "45 symbols across 8 unrelated domains. Split by domain into focused modules."

  MEDIUM PRIORITY:
  deduplicate       src/utils/format.ts / formatDate()
                    src/legacy/date-utils.ts / formatDateLegacy()
    "96% similar. These can be merged — one has the edge case handling the other is missing."
```

The deduplication finding is particularly valuable in long-lived codebases — functions that were written twice because nobody knew the other existed. PureContext finds them by semantic similarity across the entire codebase.

---

## Using quality metrics over time

Run `get_quality_metrics` before and after a refactoring sprint to measure the improvement. Before: `averageScore: 52`. After: `averageScore: 68`. That's a concrete, measurable outcome from the work.

For teams, consider making code health a regular agenda item — not for blame, but for visibility. A monthly look at the heatmap and the worst-scoring files keeps technical debt from becoming invisible until it's a crisis.

---

→ Reference: [MCP Tools Reference](../docs/06-tools-reference.md) — `get_quality_metrics`, `detect_antipatterns`, `get_architecture_doc`  
→ Reference: [AI-Powered Architecture Analysis](../docs/20-architecture-analysis.md) — full parameter reference
