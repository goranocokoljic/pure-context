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
