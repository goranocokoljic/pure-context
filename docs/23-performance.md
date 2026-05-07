# Performance & Scalability


PureContext is designed to handle enterprise-scale repos (10k–50k files) using a worker thread pool for parallel tree-sitter parsing.

---

## Indexing speed

Typical performance on a 4-core machine:

| Repo size | First index | Incremental re-index |
|-----------|-------------|----------------------|
| 500 files | ~2 seconds | < 100ms |
| 5,000 files | ~15 seconds | < 1 second |
| 20,000 files | ~60 seconds | 1–3 seconds |
| 50,000 files | ~3 minutes | 2–10 seconds |

These numbers assume no AI summarization or semantic indexing. Both add API round-trip time.

---

## Worker thread pool

The bottleneck in sequential indexing is tree-sitter WASM parsing — each WASM instance is single-threaded. The worker thread pool parallelizes parsing across CPU cores.

```
                Main thread
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   Worker 1      Worker 2     Worker 3
   (TypeScript)  (Python)     (Go)
   parse + extract  parse + extract  parse + extract
        │            │            │
        └────────────┴────────────┘
                     │
                Main thread
             (SQLite writes)
```

Each worker loads its own WASM grammar instances. File batches are distributed across workers by the main thread. SQLite writes are serialized on the main thread (better-sqlite3 is synchronous).

### Configuring worker threads

```json
{
  "workerThreads": 4   // default: os.cpus().length - 1, minimum 1
}
```

Increase for CPU-bound workloads on machines with many cores. Do not exceed `os.cpus().length - 1` — you want to leave one core for the main thread and OS.

---

## Memory usage

| Component | Memory |
|-----------|--------|
| WASM grammars (per worker) | ~20–30 MB per grammar loaded |
| In-memory symbol cache (during indexing) | ~100 MB for 10k symbols |
| SQLite WAL mode (at rest) | ~50 MB |
| HNSW vector index (if enabled) | ~100 bytes per embedding dimension per symbol |

**Typical peak during indexing:** 200–500 MB for a 10k-file repo. Returns to ~50 MB at rest.

Workers are spawned once and reused for the lifetime of the server — no spawn/teardown overhead per index run.

---

## Incremental re-indexing

The content hash cache makes re-indexing very fast:

1. Each file's SHA-256 hash is stored in the `files` table after indexing
2. On re-index, the hash is recomputed and compared
3. Only files with a changed hash are re-parsed
4. Symbols for unchanged files are retained as-is

A typical `git pull` touches 10–50 files — re-index completes in milliseconds.

To force a full re-index (bypass the hash cache):

```
Use invalidate_cache tool, then index_folder again.
```

Or call `index_folder` with `force: true`.

---

## Large repo tuning

For repos with > 10,000 files:

| Setting | Recommendation |
|---------|---------------|
| `workerThreads` | Set to `os.cpus().length - 1` |
| `watchDebounceMs` | Increase to `5000` if many files change at once (e.g., code generation) |
| `excludePatterns` | Add patterns for generated files, test fixtures with large data files |
| `maxFileSizeBytes` | Keep at 1 MB or lower — parsing multi-MB files is slow and rarely useful |
| `fileLimit` | Set to `0` (unlimited) if you need the full repo indexed |

---

## SQLite performance

SQLite in **WAL (Write-Ahead Logging) mode** provides:
- Concurrent reads without blocking writes
- Fast writes (no fsync on every write in WAL mode)
- Crash safety (WAL journal ensures atomicity)

Query performance:
- `search_symbols` with FTS5: < 5ms for 100k symbols
- `get_symbol_source`: < 1ms (single row lookup by primary key)
- `get_blast_radius` (depth 5): 5–20ms depending on graph density
- `get_context_bundle` (depth 3): 3–15ms

No tuning is needed for the SQLite layer up to ~500k symbols. At very large scale, consider periodic `VACUUM` to reclaim space from deleted symbols.


