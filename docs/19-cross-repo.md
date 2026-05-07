# Cross-Repo Intelligence


Cross-repo tools let agents search across multiple indexed repositories simultaneously and find semantically similar code regardless of which repo it lives in.

---

## Overview

When multiple repos are indexed (e.g., a microservices ecosystem or a monorepo with sub-projects), cross-repo tools provide a unified view. No special configuration is needed — all repos indexed in the same workspace are automatically eligible for cross-repo search.

---

## `search_cross_repo`

Search symbols across multiple repos with a single query.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | `string` | required | Name fragment or natural language |
| `repoIds` | `string[]` | — | Repos to search. Omit to search all repos in workspace. |
| `kind` | `string` | — | Symbol kind filter |
| `limit` | `number` | `20` | Max results |
| `mode` | `string` | `"keyword"` | `"keyword"`, `"semantic"`, or `"hybrid"` |

**Response:**

```json
{
  "symbols": [
    {
      "id": "abc123",
      "name": "authenticate",
      "kind": "function",
      "filePath": "src/auth/user.ts",
      "repoId": "a1b2c3d4",
      "repoPath": "/projects/user-service",
      "signature": "function authenticate(token: string): Promise<User>",
      "summary": "Validates JWT token and returns authenticated user."
    },
    {
      "id": "def456",
      "name": "authenticate",
      "kind": "method",
      "filePath": "app/services/auth_service.rb",
      "repoId": "e5f6a7b8",
      "repoPath": "/projects/api-gateway",
      "signature": "def authenticate(credentials)",
      "summary": "Rails service method for credential validation."
    }
  ]
}
```

**Use cases:**
- "Find all `authenticate` functions across my microservices"
- "Which services have a `sendEmail` function?"
- "Where is the `UserProfile` type defined across all repos?"

---

## `find_similar`

Find semantically similar code across repos — detect duplication, discover existing implementations, find patterns.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `symbolId` | `string` | required | Reference symbol |
| `repoId` | `string` | required | Repo of the reference symbol |
| `searchRepoIds` | `string[]` | — | Repos to search (default: all) |
| `minSimilarity` | `number` | `0.8` | Minimum cosine similarity (0–1) |
| `limit` | `number` | `10` | Max results |

**Response:**

```json
{
  "reference": {
    "name": "formatCurrency",
    "repoId": "a1b2c3d4",
    "filePath": "src/utils/format.ts"
  },
  "similar": [
    {
      "id": "xyz789",
      "name": "formatMoney",
      "repoId": "e5f6a7b8",
      "repoPath": "/projects/billing-service",
      "filePath": "lib/helpers/currency.rb",
      "similarity": 0.94,
      "summary": "Formats a decimal value as a localized currency string."
    }
  ]
}
```

**Requires:** Semantic search enabled in config (`semantic.enabled: true` with a provider configured).

**Use cases:**
- "Is there already a `formatCurrency` function somewhere in our codebase before I write a new one?"
- "Find all copy-pasted validation logic across repos"
- "Discover shared utilities that should be extracted into a common library"

---

## Cross-repo dependency tracking

Track import relationships that cross repo boundaries. For example, in a monorepo or workspace where packages import each other.

Configure cross-repo dependencies in each project's `.purecontext.json`:

```json
{
  "crossRepoDeps": ["@myorg/shared-utils", "@myorg/api-client"]
}
```

When these packages are also indexed repos, `get_blast_radius` with `crossRepo: true` will follow the dependency chain across repo boundaries.

---

## MCP Resources

In addition to MCP Tools, PureContext exposes **MCP Resources** — a push-based subscription model where agents can subscribe to symbol content and receive updates when it changes.

### Resource URI format

```
purecontext://repo/{repoId}/symbol/{symbolId}
```

### Using MCP Resources

List available resources:

```
GET purecontext://repo/{repoId}/symbols
```

Subscribe to a resource (supported by MCP clients that implement `resources/subscribe`):

```json
{
  "method": "resources/subscribe",
  "params": {
    "uri": "purecontext://repo/a1b2c3d4/symbol/8f3a2c1d"
  }
}
```

The server sends a `resources/updated` notification whenever the symbol's source changes (detected by the file watcher).

### Use cases for MCP Resources

- Agents that monitor a critical function and react when it changes
- Live documentation tools that stay in sync with the code
- CI integrations that trigger when specific symbols are modified

---

## Setting up cross-repo search

No special setup is required. Index each repo independently:

```
index_folder("/projects/user-service")
index_folder("/projects/billing-service")
index_folder("/projects/api-gateway")
```

Then use `search_cross_repo` or `find_similar` — they automatically search all indexed repos in the workspace.

To restrict search to specific repos, pass their `repoIds` explicitly.
