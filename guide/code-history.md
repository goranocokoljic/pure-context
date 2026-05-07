# Understanding Code History

Git tells you what changed. PureContext tells you which *symbol* changed, when, by whom, and how often — without running a single git command yourself.

This matters because most of the important questions about a codebase aren't file-level questions. "When was the authentication flow changed?" is a much more useful question than "which commits touched auth.ts?" The first question has a precise answer. The second requires you to dig through dozens of commits to find the relevant ones.

---

## Why symbol-level history changes everything

Traditional git history gives you commits per file. A file with 800 lines might have 150 commits, most of which touched completely unrelated functions. Finding the history of `validateToken` in that file means manually reading through diffs to find the lines that changed.

PureContext maps every commit to the symbols it touched, using byte-range overlap. When you ask for the history of `validateToken`, you get only the commits that actually modified that function — not every commit that touched the file.

---

## Tracing a function's history

**Scenario:** A bug was introduced in the payment calculation logic sometime in the last three months. You need to find when `calculateTax` was last changed and what the change was.

> "Show me the commit history for the calculateTax function."

```
get_symbol_history(symbolId: "calculateTax-id") →

  calculateTax() — 4 commits in the last 90 days:

  2026-04-15  alice    "Add VAT handling for EU customers"
              +18 lines  -3 lines
              diff: @@ -34,6 +34,22 @@ function calculateTax...

  2026-03-08  bob      "Fix rounding error on fractional amounts"
              +2 lines   -2 lines

  2026-02-20  alice    "Refactor tax calculation to use new rate table"
              +45 lines  -28 lines

  2026-01-12  charlie  "Initial tax calculation implementation"
              +37 lines  -0 lines
```

Four commits. You can see immediately that the April change added EU VAT handling — a likely source of a bug if the EU customer path wasn't fully tested. You have the author, the date, and the diff, all scoped to this single function.

---

## Understanding churn: the risk heatmap

Churn tells you which parts of the codebase change most frequently. High churn in a module means either active development (fine) or instability (a problem). Combined with quality metrics, it tells you where to focus attention.

> "Which files in the authentication service have changed the most in the last 30 days?"

```
get_churn_metrics(repoId, since: "2026-04-07") →

  src/auth/validator.ts        47 commits   820 lines changed   authors: alice, bob, charlie
  src/auth/session-store.ts    31 commits   540 lines changed   authors: alice, david
  src/auth/middleware.ts       12 commits   180 lines changed   authors: bob
  src/auth/crypto.ts            2 commits    18 lines changed   authors: alice
```

`validator.ts` with 47 commits in 30 days is a warning sign. Either it's in active feature development or it's unstable. `crypto.ts` with 2 commits is stable — touch it carefully, it's probably well-settled code that nobody wants to disturb.

**Using churn before a refactor:** High-churn files are high-risk refactoring targets. They're being actively changed, which means merge conflicts are likely and any behavioral change will land in a fast-moving area. Low-churn files are safer to refactor because the blast radius of getting it wrong is contained.

---

## Answering "who owns this?" without politics

In enterprise environments, code ownership is often informal — there are people who know parts of the codebase deeply, but that knowledge isn't documented anywhere. Churn data makes it explicit.

> "Who are the primary contributors to the billing service?"

```
get_churn_metrics(filePath: "src/billing/**") →

  alice:   34% of changes across 12 files — primary owner of billing/invoice.ts
  bob:     28% of changes across 8 files  — primary owner of billing/tax.ts
  charlie: 22% of changes across 6 files  — primary owner of billing/payments.ts
  others:  16%
```

When you need to review a change in the billing service, now you know who to ask. When a bug appears in invoice generation, you know who understands the context. This isn't blame — it's knowledge mapping.

---

## Before reviewing a pull request

Before reading a single line of a PR, use PureContext to understand the scope at the symbol level:

> "Analyze the diff between main and this branch. What symbols were changed?"

```
analyze_diff(base: "main", head: "feature/oauth2-migration") →

  Symbols modified:
    authenticateUser()     src/auth/validator.ts     signature changed
    createSession()        src/auth/session.ts        modified (no signature change)
    UserPermissions        src/core/types.ts           type definition changed

  Symbols added:
    exchangeOAuthCode()    src/auth/oauth.ts           new
    refreshOAuthToken()    src/auth/oauth.ts           new

  Symbols deleted:
    validateJWT()          src/auth/jwt.ts             removed (was imported by 3 files)

  Blast radius of changed symbols: 14 files
  Review priority: HIGH (signature changes detected)
```

Before you've read any diff, you know: the PR changes the signature of `authenticateUser` (a breaking change for anything that calls it), deletes `validateJWT` (which was still used by 3 files — possible breaking change), and the total impact is 14 files. That's the review strategy decided before the first line of code.

---

## In the Web UI: the symbol timeline

When running PureContext's HTTP server and Web UI, git history becomes visual. The **symbol timeline** shows a function's life as a horizontal line with commit markers.

Click any commit marker to see the diff for that function at that point in time. See when the function was created, when it grew significantly, and when it was last touched. This view is particularly useful during architecture reviews when you want to tell the story of how a module evolved over time.

See [Web UI](web-ui.md) for the visual exploration features.

---

## Requirements

Git history integration requires:
- `git` installed and available on PATH
- The indexed project must be a git repository
- Git integration enabled in config (enabled by default when git is detected)

Configure the depth of history indexed:

```json
{
  "git": {
    "enabled": true,
    "maxCommits": 500,
    "includeMergeCommits": false,
    "branches": ["main", "develop"]
  }
}
```

The default of 500 commits covers about a year on a moderately active project.

---

→ Reference: [MCP Tools Reference](../docs/06-tools-reference.md) — `get_symbol_history`, `get_churn_metrics`, `analyze_diff`
