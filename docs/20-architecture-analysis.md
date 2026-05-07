# AI-Powered Architecture Analysis


Architecture analysis tools use the symbol graph and AI to surface quality metrics, detect anti-patterns, and generate documentation automatically.

---

## `get_quality_metrics`

Per-file and per-symbol quality scores based on static analysis of the dependency graph and symbol data.

**Parameters:** `{ repoId, filePath? }`

**Response:**

```json
{
  "files": [
    {
      "filePath": "src/auth/validator.ts",
      "complexity": 6.2,
      "coupling": {
        "fanIn": 14,
        "fanOut": 8
      },
      "cohesion": 0.71,
      "docCoverage": 0.85,
      "score": 72
    }
  ],
  "summary": {
    "averageScore": 68,
    "worstFiles": ["src/legacy/processor.ts"],
    "bestFiles": ["src/utils/format.ts"]
  }
}
```

**Metrics explained:**

| Metric | Meaning | Good range |
|--------|---------|-----------|
| `complexity` | Average cyclomatic complexity per function | < 5 |
| `coupling.fanIn` | Files that import this file | depends on role |
| `coupling.fanOut` | Files this file imports | < 10 |
| `cohesion` | How related the symbols in a file are (0–1) | > 0.6 |
| `docCoverage` | % of exported symbols with non-empty summaries | > 0.8 |
| `score` | Composite quality score (0–100) | > 70 |

---

## `detect_antipatterns`

Scan a repo for common architectural anti-patterns.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `repoId` | `string` | required | Target repository |
| `patterns` | `string[]` | all | Specific patterns to check. Omit for all. |

**Available patterns:**

| Pattern | Description |
|---------|-------------|
| `god-class` | Class with > 20 methods or > 15 imports |
| `god-function` | Function with cyclomatic complexity > 15 |
| `high-coupling` | File with fan-out > 20 |
| `circular-deps` | Import cycles (A→B→C→A) |
| `dead-code` | Exported symbols with no importers |
| `missing-docs` | Exported symbols without summaries |
| `inconsistent-naming` | Mixed camelCase/snake_case in a single file |
| `deep-nesting` | Functions with nesting depth > 5 |

**Response:**

```json
{
  "issues": [
    {
      "pattern": "god-class",
      "filePath": "src/legacy/UserManager.ts",
      "symbolId": "abc123",
      "symbolName": "UserManager",
      "severity": "warning",
      "description": "UserManager has 34 methods. Consider splitting into smaller, focused classes.",
      "metrics": { "methodCount": 34 }
    },
    {
      "pattern": "circular-deps",
      "filePath": "src/core/index.ts",
      "severity": "error",
      "description": "Circular dependency: src/core/index.ts → src/utils/helpers.ts → src/core/index.ts",
      "cycle": ["src/core/index.ts", "src/utils/helpers.ts"]
    }
  ],
  "summary": {
    "total": 12,
    "errors": 2,
    "warnings": 10
  }
}
```

---

## `get_architecture_doc`

Auto-generate an architecture summary for the repo — useful for onboarding, design reviews, or keeping architecture documentation current.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `repoId` | `string` | required | Target repository |
| `format` | `string` | `"markdown"` | `"markdown"` or `"mermaid"` |

**Response (markdown):**

```json
{
  "doc": "# Architecture Overview\n\n## Entry Points\n...\n## Module Structure\n...\n## Key Dependencies\n..."
}
```

**Response (mermaid):**

```json
{
  "doc": "graph TD\n  A[src/index.ts] --> B[src/core/]\n  B --> C[src/handlers/]\n..."
}
```

The generated document includes:
- Top-level entry points
- Module/layer breakdown
- Key external dependencies
- Framework adapters detected
- High-level data flow

This uses AI (the configured `ai.provider`) to summarize the graph structure into natural language. Requires `ai.allowRemoteAI: true`.

---

## Refactoring detector

Identify candidates for refactoring based on size, coupling, and duplication.

**Parameters:** `{ repoId }`

**Response:**

```json
{
  "candidates": [
    {
      "type": "extract-function",
      "filePath": "src/auth/processor.ts",
      "symbolId": "abc123",
      "symbolName": "processAuthRequest",
      "reason": "Function has 120 lines and cyclomatic complexity of 18. Consider extracting validation and transformation logic.",
      "priority": "high"
    },
    {
      "type": "extract-module",
      "filePath": "src/utils/helpers.ts",
      "reason": "File contains 45 symbols across 8 unrelated concerns. Consider splitting by domain.",
      "priority": "medium"
    },
    {
      "type": "deduplicate",
      "symbols": [
        { "repoId": "a1b2c3d4", "symbolId": "def456", "name": "formatDate" },
        { "repoId": "a1b2c3d4", "symbolId": "ghi789", "name": "formatDateLegacy" }
      ],
      "similarity": 0.96,
      "reason": "These two functions are 96% similar. Consider merging.",
      "priority": "low"
    }
  ]
}
```

---

## Smart context bundling

An AI-powered enhancement of `get_context_bundle` that uses quality metrics and churn data to prioritize what context to include within a token budget.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `repoId` | `string` | required | Target repository |
| `symbolId` | `string` | required | Starting symbol |
| `maxTokens` | `number` | `4000` | Token budget |
| `strategy` | `string` | `"balanced"` | `"quality"`, `"churn"`, or `"balanced"` |

Strategies:
- **`quality`** — prioritize high-quality, well-documented dependencies
- **`churn`** — prioritize recently changed dependencies (likely most relevant)
- **`balanced`** — weighted combination of both

---

## Using analysis tools together

A pre-refactoring workflow:

```
1. get_quality_metrics(repoId)
   → Find the lowest-scoring files

2. detect_antipatterns(repoId, patterns: ["god-class", "circular-deps"])
   → Find structural issues in those files

3. get_blast_radius(symbolId)
   → Understand the impact scope before changing a god class

4. get_architecture_doc(repoId, format: "mermaid")
   → Generate a before-picture for the design doc

5. (make the refactoring)

6. detect_antipatterns(repoId)
   → Verify the anti-patterns were resolved
```
