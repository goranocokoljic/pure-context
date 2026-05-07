# Dependency Graph Tools


The dependency graph tracks import relationships between files. Four tools let agents query it at different granularities — from a single hop to a full transitive walk.

---

## Concepts

During indexing, each `import` / `require` / `use` statement is resolved to a dependency edge:

```
dep_edge: sourceFile → resolvedTargetFile (via import specifier)
```

Edges are stored in the `dep_edges` SQLite table. External packages (e.g., `from 'react'`) produce edges with `resolvedPath: null` and are excluded from graph traversal.

Two directions of traversal:
- **Forward walk** — "what does X depend on?" (imports, transitively)
- **Reverse walk** — "what depends on X?" (importers, transitively)

---

## `get_context_bundle`

**Purpose:** Forward-walk from a symbol — returns everything an agent needs to understand it (the symbol itself plus its transitive imports).

**When to use:** Before modifying a function — understand its full context without reading whole files.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `repoId` | `string` | required | Target repository |
| `symbolId` | `string` | required | Starting symbol |
| `maxDepth` | `number` | `3` | Traversal depth |
| `maxTokens` | `number` | — | Stop collecting when estimate exceeds this |

**Example:**

```
"Give me everything needed to understand the processOrder function."

→ get_context_bundle({ symbolId: "processOrder-id", maxDepth: 2 })
→ Returns: processOrder + validateCart + calculateTax + formatPrice
  _tokenEstimate: 820
```

**Response:**

```json
{
  "symbols": [
    { "id": "...", "name": "processOrder", "signature": "...", "source": "..." },
    { "id": "...", "name": "validateCart", "signature": "...", "source": "..." }
  ],
  "files": ["src/orders/processor.ts", "src/cart/validator.ts"],
  "_tokenEstimate": 820
}
```

---

## `get_blast_radius`

**Purpose:** Reverse-walk — all files that (transitively) import a given symbol. Tells you what would break if you change or delete it.

**When to use:** Before modifying or deleting a symbol.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `repoId` | `string` | required | Target repository |
| `symbolId` | `string` | required | Symbol to analyze |
| `maxDepth` | `number` | `5` | Traversal depth |

**Example:**

```
"What breaks if I change UserService.authenticate?"

→ get_blast_radius({ symbolId: "UserService.authenticate-id" })
→ Returns: 14 files at depth 1–3
  (AuthController, LoginPage, SessionMiddleware, tests/...)
```

**Response:**

```json
{
  "importers": [
    "src/controllers/auth.ts",
    "src/middleware/session.ts",
    "src/pages/Login.tsx",
    "test/auth.test.ts"
  ],
  "count": 14,
  "_tokenEstimate": 120
}
```

---

## `find_importers`

**Purpose:** Direct (one-hop) importers of a file — faster and narrower than `get_blast_radius`.

**When to use:** Quick check — "who imports this module directly?"

**Parameters:** `{ repoId, filePath }` — `filePath` is relative to repo root.

**Response:**

```json
{
  "importers": [
    {
      "filePath": "src/controllers/auth.ts",
      "importedNames": ["UserService", "AuthToken"]
    }
  ],
  "_tokenEstimate": 80
}
```

---

## `find_dead_code`

**Purpose:** Exported symbols in files that nothing else imports — potential dead code.

**When to use:** Cleanup sprints, pre-refactor audits.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `repoId` | `string` | required | Target repository |
| `limit` | `number` | `50` | Max results |

**Response:**

```json
{
  "symbols": [
    {
      "id": "...",
      "name": "legacyFormatDate",
      "kind": "function",
      "filePath": "src/utils/date-old.ts",
      "signature": "function legacyFormatDate(d: Date): string"
    }
  ],
  "_tokenEstimate": 240
}
```

**False positive sources:**
- **Dynamic imports** — `import('./module')` are not tracked by the static graph
- **Side-effect imports** — `import './setup'` (no names imported) create edges but no `importedNames`
- **External consumers** — if this repo is itself an npm package, external consumers won't appear in the index
- **Test files** — test imports are included in the graph; symbols only used by tests are not dead

---

## Combining graph tools

A typical refactoring workflow:

```
1. get_blast_radius(symbolId)
   → See the full impact scope before touching anything

2. get_context_bundle(symbolId, maxDepth: 2)
   → Understand the symbol and its immediate dependencies

3. Make the change

4. find_dead_code(repoId)
   → Verify no orphaned exports were left behind
```
