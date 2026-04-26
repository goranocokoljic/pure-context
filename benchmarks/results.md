# PureContext — Token Efficiency Benchmark

**Tokenizer:** `cl100k_base` approximation (bytes / 4)
**Workflow:** `search-symbols` (top 5) + `get-symbol-source` x 3
**Baseline:** all source files concatenated (minimum for "open every file" agent)

## basic-ts-project

| Metric | Value |
|--------|-------|
| Files indexed | **9** |
| Symbols extracted | **19** |
| Baseline tokens (all files) | **798** |

| Query | Baseline&nbsp;tokens | PureContext&nbsp;tokens | Reduction | Ratio |
|-------|---------------------:|------------------------:|----------:|------:|
| `router route handler` | 798 |                       1 | **99.9%** | 798.0x |
| `middleware` | 798 |                       1 | **99.9%** | 798.0x |
| `error exception` | 798 |                       1 | **99.9%** | 798.0x |
| `request response` | 798 |                       1 | **99.9%** | 798.0x |
| `context bind` | 798 |                       1 | **99.9%** | 798.0x |
| **Average** | — |                       — | **99.9%** | **798.0x** |

<details><summary>Query detail (search + fetch tokens, latency)</summary>

| Query | Search&nbsp;tokens | Fetch&nbsp;tokens | Hits&nbsp;fetched | Search&nbsp;ms |
|-------|-----------------:|------------------:|------------------:|---------------:|
| `router route handler` | 1 | 0 | 0 | 0.1 |
| `middleware` | 1 | 0 | 0 | 0.1 |
| `error exception` | 1 | 0 | 0 | 0.1 |
| `request response` | 1 | 0 | 0 | 0.0 |
| `context bind` | 1 | 0 | 0 | 0.1 |

</details>

## swift-project

| Metric | Value |
|--------|-------|
| Files indexed | **6** |
| Symbols extracted | **27** |
| Baseline tokens (all files) | **858** |

| Query | Baseline&nbsp;tokens | PureContext&nbsp;tokens | Reduction | Ratio |
|-------|---------------------:|---------------------:|----------:|------:|
| `router route handler` | 858 | 1 | **99.9%** | 858.0x |
| `middleware` | 858 | 1 | **99.9%** | 858.0x |
| `error exception` | 858 | 1 | **99.9%** | 858.0x |
| `request response` | 858 | 1 | **99.9%** | 858.0x |
| `context bind` | 858 | 1 | **99.9%** | 858.0x |
| **Average** | — | — | **99.9%** | **858.0x** |

<details><summary>Query detail (search + fetch tokens, latency)</summary>

| Query | Search&nbsp;tokens | Fetch&nbsp;tokens | Hits&nbsp;fetched | Search&nbsp;ms |
|-------|-----------------:|------------------:|------------------:|---------------:|
| `router route handler` | 1 | 0 | 0 | 0.1 |
| `middleware` | 1 | 0 | 0 | 0.1 |
| `error exception` | 1 | 0 | 0 | 0.1 |
| `request response` | 1 | 0 | 0 | 0.0 |
| `context bind` | 1 | 0 | 0 | 0.1 |

</details>

## vapor-project

| Metric | Value |
|--------|-------|
| Files indexed | **4** |
| Symbols extracted | **12** |
| Baseline tokens (all files) | **859** |

| Query | Baseline&nbsp;tokens | PureContext&nbsp;tokens | Reduction | Ratio |
|-------|---------------------:|---------------------:|----------:|------:|
| `router route handler` | 859 | 1 | **99.9%** | 859.0x |
| `middleware` | 859 | 1 | **99.9%** | 859.0x |
| `error exception` | 859 | 1 | **99.9%** | 859.0x |
| `request response` | 859 | 1 | **99.9%** | 859.0x |
| `context bind` | 859 | 1 | **99.9%** | 859.0x |
| **Average** | — | — | **99.9%** | **859.0x** |

<details><summary>Query detail (search + fetch tokens, latency)</summary>

| Query | Search&nbsp;tokens | Fetch&nbsp;tokens | Hits&nbsp;fetched | Search&nbsp;ms |
|-------|-----------------:|------------------:|------------------:|---------------:|
| `router route handler` | 1 | 0 | 0 | 0.1 |
| `middleware` | 1 | 0 | 0 | 0.1 |
| `error exception` | 1 | 0 | 0 | 0.0 |
| `request response` | 1 | 0 | 0 | 0.0 |
| `context bind` | 1 | 0 | 0 | 0.0 |

</details>

---

## Grand Summary

| | Tokens |
|--|-------:|
| Baseline total (15 task-runs) | 12,575 |
| PureContext total | 15 |
| **Reduction** | **99.9%** |
| **Ratio** | **838.3x** |

> Measured with cl100k_base approximation (bytes / 4). Baseline = all indexed source files. PureContext = search_symbols (top 5) + get_symbol_source x 3 per query.
