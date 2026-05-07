# AI Summaries

Every symbol PureContext indexes gets a one-line description called a summary. Summaries appear in search results and symbol outlines. They're what makes the difference between search results that tell you something and search results that just list names.

Most of the time, summaries cost nothing to generate. When they require AI, the cost is small and the improvement is significant.

---

## Why summaries matter

When you search for symbols and get results back, you're looking at something like this:

```
authenticateUser()     src/auth/validator.ts    function
validateToken()        src/auth/jwt.ts           function
checkPermissions()     src/auth/guards.ts        function
verifySession()        src/api/middleware.ts     function
```

Four functions. They all sound authentication-related. Which one is the one that validates a JWT against the user database? You'd have to open each one to find out — or call `get_symbol_source` on all four.

With summaries:

```
authenticateUser()   Validates credentials against the user database and returns a session token.
validateToken()      Parses and verifies a JWT signature, returns the decoded payload.
checkPermissions()   Checks whether a user has the required role for a resource.
verifySession()      Middleware that reads the session cookie and attaches the user to the request.
```

Now you know. One retrieval, not four. This is what summaries do — they answer the question "is this the one I'm looking for?" without requiring you to read the source.

---

## How summaries are generated

PureContext fills in summaries through a priority chain, from cheapest to most expensive:

**1. Extracted docstrings (free):** If the function has a JSDoc comment, Python docstring, `///` doc comment, `@doc` attribute, or any other recognized documentation format, PureContext extracts it. Well-documented codebases get rich summaries at zero cost.

```typescript
/**
 * Validates user credentials and issues a session token.
 * Throws AuthError if credentials are invalid or account is locked.
 */
function authenticateUser(credentials: Credentials): Promise<SessionToken>
```

Summary: `"Validates user credentials and issues a session token. Throws AuthError if credentials are invalid or account is locked."`

**2. Framework inference (free):** Recognized patterns generate summaries without AI. A function in a Nuxt server route at `server/api/users/[id].get.ts` becomes `"GET /api/users/:id Nuxt server route"`. A Vue component named `UserCard.vue` becomes `"Vue component UserCard"`. No AI call, no cost.

**3. AI generation (small cost):** For symbols with no docstring and no recognizable framework pattern — which is the majority of code in most real-world projects — PureContext can call an AI API to generate a summary from the function signature and body.

**4. Signature fallback (free):** If AI is disabled or the call fails, the signature itself becomes the summary. Less informative but always available.

---

## When to enable AI summarization

**Enable it if** your codebase has minimal documentation and you want search to actually work by meaning. A codebase full of functions like `processX`, `handleY`, and `doZ` with no docstrings is nearly unsearchable without summaries. With them, semantic search finds the right `processX` from a natural language description.

**Leave it off if** your codebase is well-documented, you're indexing only for symbol navigation (not meaning-based search), or you want to control costs strictly. The signature fallback is always available and still gives you accurate name-based search.

**The real-world cost:** A 1,000-symbol project with no docstrings, using Claude Haiku, processes 50 symbols per API call. That's 20 calls, roughly $0.01–0.05 total for the whole codebase. Summaries are cached — re-indexing unchanged files does not re-summarize. The cost is paid once when a symbol is first indexed, then zero on every subsequent run.

---

## Enabling AI summarization

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

The `allowRemoteAI: true` flag is required as an explicit opt-in — summaries are never generated through external APIs without you turning this on.

Available providers: Anthropic (Claude Haiku recommended for cost), OpenAI (GPT-4o mini), Google Gemini Flash (lowest cost per token), or any OpenAI-compatible endpoint including local Ollama models.

---

## Using a local model for summaries

If your codebase is sensitive and you don't want code leaving your infrastructure, use a local Ollama model:

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

Summary quality from local models is lower than cloud models for ambiguous code, but for well-structured code with clear naming, it's often good enough. Use a smaller `batchSize` for local models — they handle fewer tokens per call.

---

## How summaries improve semantic search

Semantic search works by comparing your query to the embeddings of symbol summaries. A symbol with no summary has only its name and signature to embed — limited signal for matching against a natural language query.

A symbol with a rich summary — even a short one like "Formats a decimal amount as a localized currency string with the correct symbol" — gives the embedding model much more to work with. The result is that semantic search becomes genuinely useful on undocumented codebases once summaries are enabled.

**The pattern:** Enable AI summaries, index once, then use hybrid search mode. The combination of keyword precision and semantic recall makes `search_symbols` effective even in codebases where naming is inconsistent.

---

## Summaries for the AI agent itself

Summaries don't just help you navigate — they help the AI agent reason about your code. When Claude calls `get_file_outline` and gets back a list of symbols with summaries, it can decide which ones to retrieve based on what they do, not just what they're named.

Without summaries, Claude sees `processX`, `handleY`, `doZ` and has to guess. With summaries, it sees what each one does and retrieves only the relevant ones. Fewer retrievals, more accurate answers, less back-and-forth.

---

→ Reference: [AI Summarization](../docs/12-ai-summarization.md) — provider configuration, batch mode, cost management, Gemini Flash setup
