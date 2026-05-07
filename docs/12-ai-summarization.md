# AI Summarization


AI summarization generates one-line descriptions for symbols that have no docstring. Summaries appear in search results and reduce the need to fetch full source.

---

## Summary priority chain

For every symbol, PureContext uses the first successful source in this order:

1. **Extracted docstring** — JSDoc `/** */`, Python `"""`, `///`, `@doc`, Haddock, etc. No AI cost.
2. **Framework-derived** — for recognized patterns: `"Vue component UserCard"`, `"GET /api/users Nuxt server route"`. No AI cost.
3. **AI-generated** (optional) — requires config. Batched API call to the configured provider.
4. **Signature fallback** — if AI is disabled or fails: reformatted one-liner from the symbol signature. No AI cost.

The result is that well-documented codebases spend almost nothing on AI summarization.

---

## Enabling AI summarization

AI summarization is **always disabled by default** and requires two explicit opt-ins:

```json
{
  "ai": {
    "provider": "anthropic",
    "allowRemoteAI": true,
    "apiKey": "${ANTHROPIC_API_KEY}",
    "model": "claude-haiku-4-5-20251001",
    "batchSize": 50
  }
}
```

`allowRemoteAI: true` is a safety gate — without it, no outbound AI API calls are made even if `provider` is set. This prevents accidental API costs during development.

---

## Supported providers

| Provider | `ai.provider` value | Recommended model | Notes |
|----------|---------------------|-------------------|-------|
| Anthropic | `"anthropic"` | `claude-haiku-4-5-20251001` | Best quality, fast |
| OpenAI | `"openai"` | `gpt-4o-mini` | Good quality, cost-effective |
| Google Gemini | `"google"` | `gemini-flash` | Lowest cost per token |
| OpenAI-compatible | `"openai-compatible"` | any | Ollama, LM Studio, etc. |
| Disabled | `"none"` | — | Default — no AI calls |

### Using a local Ollama model

```json
{
  "ai": {
    "provider": "openai-compatible",
    "allowRemoteAI": true,
    "endpoint": "http://localhost:11434",
    "model": "llama3.2",
    "batchSize": 10
  }
}
```

---

## Batch mode

Symbols are summarized in batches to minimize API round trips. `ai.batchSize` controls how many symbols are sent per request (default: 50).

The batch prompt includes all symbol signatures and asks for one-line summaries for each. Responses are parsed and cached in SQLite — no re-generation on repeated `index_folder` calls for unchanged files.

**Cost estimate:** A 1,000-symbol project with no docstrings, using Claude Haiku at ~50 symbols/batch:
- 20 API calls
- ~10,000 input tokens + ~2,000 output tokens per call
- Total: ~$0.01–0.05 depending on provider

---

## Google Gemini Flash

Google Gemini Flash offers the lowest cost per token for summarization. Enable it with:

```json
{
  "ai": {
    "provider": "google",
    "allowRemoteAI": true,
    "apiKey": "${GEMINI_API_KEY}",
    "model": "gemini-flash",
    "batchSize": 100
  }
}
```

Gemini Flash supports larger batches than Claude or GPT-4o-mini, reducing the number of API calls.

---

## Cost management tips

- **Use the cheapest model** — summaries are short, quality difference between Haiku/Flash/mini and Opus/GPT-4o is negligible.
- **Only undocumented symbols trigger AI** — a codebase with JSDoc on every function costs almost nothing.
- **Summaries are cached** — re-indexing unchanged files does not re-summarize.
- **Set `allowRemoteAI: false` during development** (the default) to avoid accidental charges.
- **Lower `batchSize` for local models** — local models can handle fewer tokens per call.
