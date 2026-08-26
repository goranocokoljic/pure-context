# PureContext Harness Contract

> Stable integration contract for automated code-generation harnesses (agents that
> run *read task → explore → write → review → fix → test → merge* with no human in
> the seat). Phase 80. Output shapes documented here are **stability-guaranteed**:
> additive changes only within a major version.

PureContext is the **persistent cross-process brain** a harness lacks. A harness
that spawns a fresh agent per issue/PR has zero cross-run memory; PureContext's
index survives process death and answers "what already exists, what am I drifting
from, what did I forget?" without re-reading the codebase from scratch.

**Boundary:** PureContext is *judgment, not actuation*. It never edits, builds,
tests, or merges — the harness owns all actuation. PureContext gates the
transitions. Semantic invariants (business rules) stay with your review lenses;
PureContext owns the **structural + retrieval** layer only.

---

## 1. The gate envelope (switch on one field)

Every loop tool returns a normalized envelope alongside its detailed output:

```jsonc
{
  "gate": "pass" | "warn" | "block",   // the one field to branch on
  "gateReasons": ["…"],                // why (a block always carries ≥1 reason)
  "nextAction": "proceed" | "…"        // stable machine-readable next step
}
```

- **pass** — proceed; nothing structural stands in the way.
- **warn** — proceed only with judgment; something needs an agent/human decision.
- **block** — do not proceed as-is; there is unfinished or regressed work.

Carried by `prepare_change`, `verify_change`, `compare_change_impact`,
`check_consistency`, and the composite `merge_readiness` (which exposes `gate` +
`reasons` + `unresolved`).

Derivation (so you can predict it):

| Tool | block when | warn when | pass when |
|------|-----------|-----------|-----------|
| `verify_change` | `verdict: incomplete` | `scope_expanded` | `complete` |
| `compare_change_impact` | `verdict: regressed` | `no_baseline` | `improved` / `unchanged` |
| `prepare_change` | (never — advisory) | `no_target` / `ambiguous_target` / high risk | `ready` + low/moderate risk |
| `check_consistency` | (never) | exact duplicate or bad placement | clean (or sparse index) |

---

## 2. Index freshness (the prerequisite)

The index must reflect current state for retrieval to be trustworthy mid-run.

- **At task start:** `index_folder` once (cold). Acceptable amortized over a
  multi-minute run. Use `check_index_staleness` first to skip if already fresh.
- **Mid-run, after every write:** **never** call `index_folder` — it is
  discovery-bound (stats every file, ~seconds even on a no-op). Call
  **`index_file`** with just the edited path(s) — O(one file). The PostToolUse
  hook does this automatically if installed.
- `check_index_staleness({ repoId, filePaths })` → per-file `fresh`/`stale`
  without a discovery pass; omit `filePaths` for a repo-level summary.

### Branches

The index is keyed on the **absolute path** (`repoId = sha256(path)`) — not on
branch or commit. Every branch checked out at that path shares one index.

- **After an in-place branch switch: run `index_folder` before trusting any
  result.** It re-parses what changed and prunes files the new branch does not
  have (`filesPruned` in the response), so the index converges to the checked-
  out state. Before v1.22.0 it did NOT prune — a branch switch produced a
  hybrid union of both branches; if you see symbols from an abandoned branch,
  you are on an old version.
- **One git worktree per branch is the cleanest pattern** — each worktree has
  its own path, therefore its own fully independent index. This is by design.
- After a **rebase**, git metadata (churn, co-change) is stale wholesale:
  `invalidate_cache` then `index_folder`.

---

## 3. Greenfield loop (project built from scratch, issue by issue)

The codebase grows over the run; at issue #1 it is empty. There is no git
history, so co-change/risk/blast-radius are null early — the value is
**consistency over the growing codebase**, on structural search alone (no
embedding provider required).

```
1. orient    get_task_context({ repoId, task })      → relevant existing symbols + plan
                                                        (FTS5 fallback when no embeddings)
2. pre-write check_consistency({ repoId, name, kind,  → duplicates / patternFit /
             intendedFilePath, signature })             placement / existingApiPointer
             → gate:warn means "you may be re-implementing / drifting" — reconsider
3. write     (harness edits the file)
4. refresh   index_file({ repoId, filePaths:[edited] })  ← keep the brain current
5. (repeat 2–4 per new symbol/file)
6. review    find_untested_symbols, get_context_bundle feed your review lenses
```

`check_consistency` returns `signalQuality:"low"` on a near-empty index and
suppresses duplicate claims — it will not invent "you already wrote this" when
there is nothing to compare against.

---

## 4. Brownfield loop (existing codebase)

Reuses the Phase 76–79 closed loop. Predictions are passed back **inline** (the
server is stateless — no prediction store).

```
1. orient    get_task_context({ repoId, task })
2. pre-edit  prepare_change({ repoId, intent, query|targetSymbolId })
             → predictedChange.changedFilePaths, missingCoChange, risk, gate
             snapshot: get_architecture_snapshot({ action:"create" })   ← baseline
3. edit      (harness edits)
4. refresh   index_file({ repoId, filePaths:[edited] })
5. verify    verify_change({ repoId, diff, predictedFilePaths,          → complete?
             predictedCoChange })                                          gate
6. merge?    merge_readiness({ repoId, diff, predictedFilePaths,         → one go/no-go
             predictedCoChange, baselineSnapshotId })
             gate:block → fix unresolved[] and re-run; gate:pass → merge
```

`merge_readiness` folds `verify_change` (completeness) + `compare_change_impact`
(architecture regression vs the baseline snapshot) into one
`{ gate, reasons[], unresolved[] }`. It is a thin consumer — it runs no new
analysis.

---

## 5. Tool reference (Phase 80 additions)

| Tool | Purpose | Needs git history? | Needs embeddings? |
|------|---------|--------------------|-------------------|
| `index_file` | Targeted single-file re-index (mid-run freshness) | no | no |
| `check_index_staleness` | Cheap per-file fresh/stale check | no | no |
| `check_consistency` | Pre-write dedup / drift / pattern-fit (greenfield front door) | no | no (structural) |
| `merge_readiness` | Composite pre-merge go/no-go | optional | no |

All other loop tools (`get_task_context`, `prepare_change`, `verify_change`,
`compare_change_impact`, `get_architecture_snapshot`, `find_untested_symbols`,
`get_context_bundle`) predate Phase 80; see `AGENT_REFERENCE.md`.
