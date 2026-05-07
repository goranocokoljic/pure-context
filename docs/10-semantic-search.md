# Semantic Search


Semantic search finds symbols by **meaning** rather than exact name. It uses an HNSW (Hierarchical Navigable Small World) vector index built from symbol summaries and signatures.

---

## How it works

1. During indexing, each symbol's summary + signature is sent to an embedding model (e.g., OpenAI `text-embedding-3-small`)
2. The resulting vector is stored in an HNSW index persisted at `~/.purecontext/indexes/{repoId}/hnsw.idx`
3. At search time, the query is embedded using the same model
4. HNSW performs an approximate nearest-neighbor search by cosine similarity
5. Results are ranked by similarity score and returned

---

## When the HNSW index is built

The HNSW index is only built when **all three** conditions are met:

1. `semantic.enabled: true` in config
2. An embedding provider is configured (`semantic.provider`)
3. The repo has more symbols than `semantic.threshold` (default: 50,000)

**For small or medium repos**, set `threshold` low to enable HNSW early:

```json
{
  "semantic": {
    "enabled": true,
    "provider": "openai",
    "threshold": 100
  }
}
```

Below the threshold, all search falls back to FTS5 keyword search — which is fast and accurate for name-based queries.

---

## Enabling semantic search

### Using OpenAI embeddings

```json
{
  "semantic": {
    "enabled": true,
    "provider": "openai",
    "threshold": 50000
  },
  "ai": {
    "openaiApiKey": "${OPENAI_API_KEY}"
  }
}
```

### Using local Ollama embeddings

```json
{
  "semantic": {
    "enabled": true,
    "provider": "local",
    "localEmbeddingEndpoint": "http://localhost:11434",
    "threshold": 1000
  }
}
```

Set the model by passing it in the endpoint config or using Ollama's default embedding model.

---

## Using `search_semantic`

```json
{
  "repo": "my-project",
  "query": "function that validates user credentials",
  "mode": "hybrid",
  "semantic_weight": 0.6,
  "keyword_weight": 0.4,
  "max_results": 10
}
```

**Response:**

```json
{
  "results": [
    {
      "id": "8f3a...",
      "name": "authenticateUser",
      "kind": "function",
      "filePath": "src/auth/validator.ts",
      "signature": "function authenticateUser(creds: Credentials): Promise<User>",
      "summary": "Validates credentials against the database and returns a session token.",
      "scores": {
        "keyword": 0.72,
        "semantic": 0.89,
        "combined": 0.82
      }
    }
  ]
}
```

---

## Keyword vs semantic — when to use which

| Situation | Best tool |
|-----------|-----------|
| You know the name or a fragment of it | `search_symbols` (keyword) |
| You know what it does, not what it's called | `search_semantic` |
| You want maximum recall | `search_semantic` with `mode: "hybrid"` |
| Semantic index not available (small repo) | `search_symbols` always works |

The `search_symbols` tool also supports `mode: "hybrid"` — it will use HNSW automatically if the index exists.

---

## How hybrid search works

Hybrid mode runs both searches and merges results using **Reciprocal Rank Fusion (RRF)**:

```
score = keyword_weight × (1 / (60 + keyword_rank))
      + semantic_weight × (1 / (60 + semantic_rank))
```

This combines the precision of exact-name matching with the recall of semantic matching. Adjust weights to bias toward one or the other.

---

## Performance

- HNSW search: < 10ms for k=10 in a 100k vector index
- Embedding generation: batched at index time, ~50ms per symbol (API latency)
- Indexes are persisted — no rebuild on each startup

## Rebuilding the vector index

The HNSW index is rebuilt automatically on full re-index. To force a rebuild without re-parsing all files:

```
Use invalidate_cache with force: true, then index_folder again.
```

Or call `index_folder` with `force: true` — this re-embeds all symbols even if their source hasn't changed.
