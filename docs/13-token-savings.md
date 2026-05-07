# Token Savings Tracker


Every retrieval tool call automatically tracks how many tokens were saved compared to reading full files. The tracker is always on — no configuration required.

---

## How savings are calculated

```
tokens_saved = max(0, (rawFileBytes - responseBytes) / 4)
```

- `rawFileBytes` — size of the full file(s) that would have been read
- `responseBytes` — size of the actual response (symbol source or summary)
- `4 bytes/token` — approximation using the cl100k_base encoding

This is a **conservative estimate** — the actual savings are often higher because agents typically need to read multiple files to locate a symbol, while PureContext returns it directly.

---

## Viewing savings

### In every response

Savings are included in the `_meta` field of every retrieval tool response:

```json
{
  "symbol": { "name": "authenticateUser", ... },
  "source": "...",
  "_meta": {
    "timing_ms": 3,
    "tokens_saved": 1842,
    "total_tokens_saved": 45231,
    "cost_avoided": {
      "claude_opus_4": 0.028,
      "claude_sonnet_4": 0.006
    },
    "powered_by": "PureContext MCP"
  }
}
```

### Cumulative stats

Use the `get_savings_stats` tool to view totals across the session:

```json
{}
```

**Response:**

```json
{
  "total_tokens_saved": 1234567,
  "equivalent_context_windows": {
    "claude_200k": 6.17,
    "gpt4_128k": 9.64
  },
  "total_cost_avoided": {
    "claude_opus_4": 18.52,
    "claude_sonnet_4": 3.70,
    "claude_haiku_4": 0.99,
    "gpt4o": 3.09,
    "gpt4o_mini": 0.19
  }
}
```

---

## Interpreting results

| Savings % | What it means |
|-----------|--------------|
| 90–98% | Typical for well-structured codebases — agents retrieving individual symbols |
| 70–89% | Normal — some larger functions or files being retrieved whole |
| < 70% | Check agent tool usage — agents may be calling `get_file_content` for full files, or using `get_repo_outline` frequently |

**`equivalent_context_windows`** shows how many full context windows worth of tokens were saved — useful for communicating the value to stakeholders.

**`total_cost_avoided`** is the dollar equivalent at published API rates for each model. This is an estimate at the time of the release — actual rates may differ.

---

## Persistence

Savings persist to `~/.purecontext/_savings.json` across sessions. They accumulate indefinitely.

To reset the counter:

```json
{
  "reset": true
}
```

---

## What does and does not count

| Counts toward savings | Does not count |
|----------------------|---------------|
| `get_symbol_source` — returns partial file | `list_repos` — no file content |
| `get_file_outline` — returns symbols, not file | `search_symbols` — no file content |
| `get_context_bundle` — returns selected symbols | `get_file_tree` — no file content |
| `get_blast_radius` — returns file list | `index_folder` — write operation |
| `get_file_content` with line range | `get_file_content` without range (full file) |
