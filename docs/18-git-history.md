# Git & History Integration


Git integration gives agents and the Web UI access to symbol-level history, diff analysis, and churn metrics — without requiring agents to run git commands themselves.

---

## How it works

During indexing, PureContext walks `git log` and maps commits to symbols using byte-range overlap:

1. For each commit, `git diff` is parsed to identify changed byte ranges per file
2. These ranges are matched against indexed symbol byte offsets
3. The mapping is stored in the `git_metadata` table in SQLite

This means you can ask "which commits touched `authenticateUser`?" and get an answer from the index — no git subprocess needed at query time.

---

## Requirements

- `git` must be on PATH
- The indexed project must be a git repository

---

## Configuration

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

| Field | Default | Description |
|-------|---------|-------------|
| `git.enabled` | `true` | Enable git metadata indexing (if repo is a git repo) |
| `git.maxCommits` | `500` | Maximum commits to walk back from HEAD |
| `git.includeMergeCommits` | `false` | Include merge commits (usually noise) |
| `git.branches` | `["main"]` | Branches to index history from |
| `git.coChangeDepth` | `300` | Commits captured at the repo root for co-change analysis (`get_co_change`, `get_symbol_risk`, bundle `historicalNeighbors`). `0` disables capture entirely. |
| `git.megaCommitThreshold` | `30` | Commits touching more files than this are excluded / down-weighted as mega-commits (reformats, lockfile sweeps) |

---

## `get_symbol_history`

Symbol-level git history: which commits touched a symbol, and how.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `repoId` | `string` | required | Target repository |
| `symbolId` | `string` | required | Symbol to query |
| `limit` | `number` | `20` | Max commits to return |

**Response:**

```json
{
  "symbol": {
    "name": "authenticateUser",
    "filePath": "src/auth/validator.ts"
  },
  "history": [
    {
      "hash": "a1b2c3d4",
      "author": "alice",
      "date": "2026-04-15T10:30:00Z",
      "message": "Add MFA support to authenticateUser",
      "diff": "@@ -12,6 +12,14 @@ ...",
      "linesAdded": 14,
      "linesRemoved": 3
    }
  ]
}
```

**Use cases:**
- "When was this function last changed?"
- "Who introduced this code?"
- "What changed in this function over the last month?"

---

## `get_churn_metrics`

File and symbol churn metrics — how often things change.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `repoId` | `string` | required | Target repository |
| `filePath` | `string` | — | Scope to one file (optional) |
| `since` | `string` | — | ISO 8601 date — look back from this date |

**Response:**

```json
{
  "files": [
    {
      "filePath": "src/auth/validator.ts",
      "commits": 47,
      "linesChanged": 820,
      "authors": ["alice", "bob", "charlie"],
      "churnScore": 8.4,
      "lastChanged": "2026-04-20T14:00:00Z"
    }
  ]
}
```

**Interpreting `churnScore`:** Normalized metric (0–10+). High churn (> 6) indicates either: active development, frequent bug fixes, or instability. Use alongside quality metrics to distinguish "active feature" from "unstable code".

---

## `get_co_change` — temporal coupling

Files that historically change together with a target file or symbol. This is the signal a static dependency graph cannot derive: a route and its test, or a feature flag and the code it gates, that move together without importing each other.

Capture is a single repo-level `git log --no-merges --name-only -n N` at index time (controlled by `git.coChangeDepth`), stored in a dedicated `commit_files` table — separate from the per-file `git_metadata` history, whose last-N-per-file window is too shallow for co-change.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `repoId` | `string` | required | Target repository |
| `filePath` | `string` | — | Target file (provide this **or** `symbolId`) |
| `symbolId` | `string` | — | Target symbol — resolved to its file (git is file-granular) |
| `minSupport` | `number` | `2` | Drop partners with fewer than N shared commits |
| `dayWindow` | `number` | — | Look back N days (default: entire captured window) |
| `topN` | `number` | `20` | Max partners to return |

**Response:** ranked `partners` with `support` (shared commits), `confidence` (directional A→B probability), `lift` (association strength), and `coChangeDate`. Mega-commits are filtered and down-weighted; `signalQuality: "low"` flags shallow/sparse histories.

**Use cases:**
- "If I touch this file, what else usually changes with it?"
- "What's the test or config that moves with this code but doesn't import it?"

---

## `get_symbol_risk` — composite change risk

A single, explainable "how risky is it to change this symbol?" verdict. Blends churn (90 d), centrality (afferent coupling + reverse blast radius), cyclomatic complexity, test-coverage gap, and co-change spread — each normalized **repo-relative** (midrank percentile) so scores compare within a repo and aren't dominated by absolute size.

**Parameters:** `{ repoId, symbolId }`

**Response:** `{ riskScore (0–100), band: "low" | "review" | "high", factors: { churn, centrality, complexity, testGap, coChange }, reasons: string[], signalQuality }`. Factor weights are tunable via `risk.weights.*` (see [Configuration](04-configuration.md)).

It always returns `factors` (raw + normalized) and human-readable `reasons[]` — never a black-box number. **Code-centered only — no author, ownership, or productivity metrics.**

**Guardrail:** before broad or automated edits to a `high` symbol, inspect its callers (`get_blast_radius`) and co-changers (`get_co_change`) first. `search_symbols` and `get_symbol_source` accept `includeRisk: true` to attach a compact `{ band, riskScore }` inline; `get_context_bundle` returns `historicalNeighbors` (co-changing files not reachable via imports) when co-change data exists.

---

## PR / diff analysis

Analyze what a branch or commit range changes at the symbol level:

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | `string` | Target repository |
| `base` | `string` | Base branch or commit hash |
| `head` | `string` | Head branch or commit hash |

**Response:** Symbols added, modified, deleted; blast radius of changed symbols.

**Use case:** Before reviewing a PR, call this to understand the symbol-level impact — not just which files changed, but which functions were modified and what else might be affected.

---

## Git history in the Web UI

When git integration is enabled:

- **Heatmap overlay** in the file tree shows churn data
- **Symbol timeline** shows per-symbol history as a visual timeline
- High-churn files appear in a "Hot files" panel in the dashboard

---

## Limitations

- History is indexed up to `git.maxCommits` — commits older than that are not tracked
- **Renames/moves:** git rename detection is best-effort. Symbols in renamed files start fresh history from the rename commit
- **Merge commits:** excluded by default to avoid noise from merge-only diffs
- **Rebased history:** rebase changes commit hashes — a re-index is needed to pick up rebased history accurately
- Git submodules are not indexed
- **Co-change rename continuity:** the repo-level capture does not follow renames, so a file renamed mid-history splits its co-change signal until re-indexed
- **Squash-merge monorepos:** squashed PRs collapse many logical changes into one commit, which can inflate co-change; `git.megaCommitThreshold` mitigates this and `signalQuality: "low"` flags weak signal
