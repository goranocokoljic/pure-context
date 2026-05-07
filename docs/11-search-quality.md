# Search Quality & Ranking


Keyword search is backed by SQLite FTS5 with a custom relevance ranker and a camelCase/snake_case query preprocessor.

---

## How keyword search works

`search_symbols` and `search_text` use SQLite's **FTS5** (Full-Text Search) virtual table, which provides:

- BM25 ranking — frequency-adjusted term weighting
- Fast full-text matching without table scans
- Unicode tokenization

Before FTS5, keyword search used SQL `LIKE` — which had 0% precision for camelCase names. FTS5 with the preprocessor below fixed this.

---

## Query preprocessor

Before a query hits FTS5, it goes through a preprocessor that splits identifiers into component words:

| Input query | Preprocessed to |
|-------------|----------------|
| `processOrder` | `process order` |
| `process_order` | `process order` |
| `HTTPClient` | `http client` |
| `getUserById` | `get user by id` |
| `validate-token` | `validate token` |
| `auth validate` | `auth validate` (already split) |

This means `processOrder` and `process_order` are equivalent queries — no need to guess the naming convention.

**Phrase search** bypasses splitting. Use quotes for exact matching:
```
"processOrder"   → matches only "processOrder" literally
```

---

## Relevance ranker

Results are scored by a multi-factor ranker that adjusts raw BM25 scores:

| Factor | Boost | Example |
|--------|-------|---------|
| Exact name match | +3.0 | query `"authenticate"` matches symbol named `authenticate` |
| Name starts-with | +1.5 | query `"auth"` matches `authenticateUser` |
| Symbol kind filter match | +0.5 | `kind: "function"` filters and boosts |
| File path proximity | +0.3 | query restricted to `src/auth/**` |
| BM25 base | 1.0 | FTS5 BM25 score |

The ranker ensures that an exact name hit always ranks above a summary-only hit, even if the summary appears more times in the index.

---

## `search_symbols` vs `search_text`

| Tool | Searches | Returns |
|------|---------|---------|
| `search_symbols` | Symbol names and summaries | Symbol metadata (no source) |
| `search_text` | Raw file content (grep-style) | File + line + context snippet |

Use `search_symbols` for navigating by identifier. Use `search_text` when you need to find a string that isn't a symbol name — error messages, config values, comments, string literals.

---

## Debug mode

Pass `debug: true` to either search tool to get the scoring breakdown in the response:

```json
{
  "query": "authenticateUser",
  "debug": true
}
```

Response includes:
```json
{
  "symbols": [...],
  "_debug": {
    "preprocessedQuery": "authenticate user",
    "ftsMatches": 12,
    "rankedResults": [
      {
        "name": "authenticateUser",
        "bm25": 4.21,
        "nameBoost": 3.0,
        "finalScore": 7.21
      }
    ]
  }
}
```

This is useful for diagnosing why a result ranks unexpectedly high or low.

---

## Search tips

- **camelCase and snake_case are equivalent** — `processOrder`, `process_order`, and `process order` all return the same results.
- **Short queries rank better** — `auth` finds more than `authentication function` because shorter terms match more precisely.
- **Use `kind` filter to narrow** — `kind: "function"` eliminates class/method noise.
- **Combine with semantic search** — use `mode: "hybrid"` for the best recall when you're not sure of the exact name.
- **Scope with `filePath`** — `filePath: "src/auth/**"` restricts to a directory.
- **For exact strings** — use `search_text` with `is_regex: false` when you need to find a literal string in source.
