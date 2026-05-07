# Finding Code

There are three fundamentally different situations when you need to find code, and each calls for a different approach. PureContext supports all three, and knowing which to use is the difference between a fast answer and a long frustrating search.

---

## When you know the name (or part of it)

Use `search_symbols` — the primary search tool for navigating by identifier.

**Scenario:** You're debugging an authentication error. You know the function is called something like `validateToken` but you're not sure of the exact name.

> "Find all functions related to token validation."

```
search_symbols(query: "validateToken") →

  validateToken()         src/auth/validator.ts      function
  validateRefreshToken()  src/auth/refresh.ts         function
  isTokenExpired()        src/utils/jwt.ts             function
  TokenValidator          src/auth/validator.ts        class
```

The query preprocessor splits `validateToken` into `validate token` automatically, so `validateToken`, `validate_token`, and `validate token` all return the same results. You don't need to guess naming conventions.

**Narrow it down with kind filters:**

> "Find only the functions, not the class."

```
search_symbols(query: "validateToken", kind: "function")
```

**Scope to a directory:**

> "Find authentication-related functions only in the auth directory."

```
search_symbols(query: "auth", kind: "function", filePath: "src/auth/**")
```

**What you get back:** Names, signatures, summaries, and file locations — but not source code. This is intentional. You scan 10 results at ~5 tokens each, pick the one you need, then retrieve the source for just that symbol. The alternative — returning source for all 10 results — would be 10× more tokens for the same navigation task.

---

## When you don't know the name

Use `search_semantic` — natural language search over what symbols *do*, not what they're *called*.

**Scenario:** You're new to the codebase and need to find the code that sends transactional emails. You don't know if it's called `sendEmail`, `dispatchNotification`, `MailService`, or something else entirely.

> "Find the code responsible for sending transactional emails to users."

```
search_semantic(query: "send transactional email to user") →

  sendTransactionEmail()    src/notifications/mailer.ts    similarity: 0.94
  EmailDispatcher           src/core/email-service.ts      similarity: 0.91
  notifyUserOfPayment()     src/billing/notify.ts          similarity: 0.87
  triggerWelcomeSequence()  src/onboarding/email.ts        similarity: 0.84
```

The first result is the primary send function. The second is the service class. The third and fourth are specialized callers. All found without knowing any of their names.

**Hybrid mode** gives you the best of both worlds — semantic similarity combined with keyword matching:

> "Search for payment validation using hybrid mode."

```
search_symbols(query: "validate payment", mode: "hybrid")
```

This is the recommended default when you're not sure: it ranks exact name matches highly while still catching semantically similar symbols even if they use different vocabulary.

**When semantic search requires configuration:** Semantic search needs an embedding provider (OpenAI or a local Ollama model). If it's not configured, `search_symbols` falls back to keyword search automatically. See [AI Summarization](ai-summaries.md) for setup.

---

## When you need to find a string in source

Use `search_text` — a structured grep over indexed file content.

**Scenario:** You're tracking down where a specific error message is generated. You know the exact string from a log: `"insufficient permissions for resource"`.

> "Find where the string 'insufficient permissions' appears in the codebase."

```
search_text(query: "insufficient permissions") →

  src/auth/authorization.ts:87   throw new AuthError("insufficient permissions for resource");
  src/api/middleware/guards.ts:34  message: "insufficient permissions for resource",
  test/auth/authorization.test.ts:156  expect(error.message).toBe("insufficient permissions...")
```

You get file, line number, and surrounding context — not symbol metadata, raw source. This is the tool for strings, configuration values, comments, error messages, and anything that isn't a named symbol.

**Regex for patterns:**

> "Find all places where we're catching and swallowing errors silently."

```
search_text(query: "catch.*\\{\\s*\\}", is_regex: true)
```

**Scoped to specific files:**

> "Find all TODO comments in the authentication module."

```
search_text(query: "TODO", file_pattern: "src/auth/**")
```

---

## Choosing the right search

| Situation | Use |
|-----------|-----|
| You know part of the function or class name | `search_symbols` (keyword) |
| You know what it does, not what it's called | `search_semantic` |
| You want maximum recall on a name search | `search_symbols` with `mode: "hybrid"` |
| You're looking for a literal string, error message, or comment | `search_text` |
| You want to find code across multiple repositories | `search_cross_repo` |

---

## From search to source: the two-step pattern

Almost every search workflow follows the same pattern:

**Step 1 — Search returns a list of candidates** (small, fast, token-efficient)

```
search_symbols(query: "payment") → 8 results with names, signatures, file locations
```

**Step 2 — Retrieve source for the one you need** (targeted, only what matters)

```
get_symbol_source(symbolId: "processPayment-id") → 45 lines of source
```

The separation is intentional. If you retrieved source for all 8 results at step 1, you'd get 400 lines of code to find the 45 you needed. The two-step pattern keeps every search conversation fast and focused.

---

## When results aren't what you expect

**Too many irrelevant results:** Add a `kind` filter or scope with `filePath`. `search_symbols(query: "model")` returns everything with "model" in its name — `search_symbols(query: "model", kind: "class")` narrows to class definitions.

**Missing a result you know should be there:** Try the semantic equivalent. A function named `checkTokenValidity` may not score highly for the query `validateToken`, but `search_semantic` will find it by what it does.

**Result is there but buried:** Use `debug: true` to see the relevance scoring. This shows you exactly why each result ranked where it did — useful for understanding whether a different query would surface it earlier.

---

→ Reference: [MCP Tools Reference](../docs/06-tools-reference.md) — `search_symbols`, `search_semantic`, `search_text`, `search_cross_repo`, `get_symbol_source`
