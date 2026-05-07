# Ecosystem & Data Tools


Ecosystem tools extend PureContext to data-centric codebases: dbt projects, SQL schemas, OpenAPI specifications, and a context provider framework for domain-specific integrations.

---

## Context provider framework

A context provider is a plugin that adds domain-specific enrichment to symbol metadata and search results. Providers are loaded automatically when their target framework is detected.

**Built-in providers:**
- **dbt provider** — enriches dbt model symbols with column lineage and upstream/downstream dependencies
- **OpenAPI provider** — enriches endpoint symbols with request/response schema details
- **SQL provider** — enriches table symbols with column definitions and foreign key relationships

**Writing a custom provider:**

```typescript
interface ContextProvider {
  name: string;
  detect(projectRoot: string): Promise<boolean>;
  enrich(symbol: SymbolRecord): Promise<EnrichedSymbol>;
}
```

Register in `config.json`:

```json
{
  "contextProviders": ["my-custom-provider"]
}
```

---

## dbt integration

**Auto-detected by:** `dbt_project.yml` in project root.

### What is indexed

| dbt artifact | Symbol kind | Notes |
|-------------|-------------|-------|
| Model (`.sql`) | `function` | SQL logic as source, dbt Jinja expanded |
| Source | `const` | External data source reference |
| Seed (`.csv`) | `const` | Static data table |
| Macro | `function` | Jinja macro definition |
| Exposure | `const` | Dashboard/downstream consumer |

Column definitions from `schema.yml` are stored in `frameworkMeta.columns`.

### dbt Jinja expansion

Before parsing, dbt SQL files are pre-processed to expand Jinja templating:
- `{{ ref('orders') }}` → resolved model name
- `{{ source('raw', 'events') }}` → source reference
- `{{ config(...) }}` → stripped

This allows the SQL handler to parse the underlying SQL accurately.

### Configuration

```json
{
  "dbt": {
    "manifestPath": "target/manifest.json",
    "profilesPath": "~/.dbt/profiles.yml"
  }
}
```

Run `dbt compile` or `dbt run` before indexing to ensure `target/manifest.json` is current.

---

## `search_columns`

Search column definitions across dbt models and SQL tables.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `repoId` | `string` | required | Target repository |
| `query` | `string` | required | Column name fragment |
| `modelName` | `string` | — | Restrict to a specific model |

**Response:**

```json
{
  "columns": [
    {
      "name": "user_id",
      "model": "fct_orders",
      "dataType": "bigint",
      "description": "Foreign key to dim_users",
      "nullable": false,
      "lineage": {
        "upstream": ["stg_orders.user_id"],
        "downstream": ["rpt_user_activity.user_id", "fct_revenue.user_id"]
      }
    }
  ]
}
```

**Use cases:**
- "Find all columns named `user_id` across my dbt project"
- "What models produce the `revenue` column?"
- "What is the lineage of `order_status`?"

---

## OpenAPI / Swagger handler

**Auto-detected by:** `openapi.yaml`, `openapi.json`, `swagger.yaml`, or `swagger.json` in the project root, or files with `openapi: 3.x.x` content.

### What is indexed

| OpenAPI artifact | Symbol kind | Notes |
|-----------------|-------------|-------|
| Endpoint (`GET /users`) | `route` | Path + method as name |
| Schema object | `type` | Request/response schema |
| Parameter | `const` | Query/path/header parameter |

### Using OpenAPI symbols

```
search_symbols(query: "users", kind: "route")
→ "GET /users", "POST /users", "GET /users/{id}"

get_symbol_source(symbolId: "GET /users/{id}")
→ Full endpoint definition including parameters, request body, response schemas
```

---

## SQL handler

**Extensions:** `.sql` files.

**Detected separately from dbt** — the SQL handler processes raw SQL files without dbt Jinja.

### What is indexed

| SQL statement | Symbol kind |
|--------------|-------------|
| `CREATE TABLE` | `class` |
| `CREATE VIEW` | `function` |
| `CREATE FUNCTION` | `function` |
| `CREATE PROCEDURE` | `function` |
| `CREATE INDEX` | `const` |

For dbt projects, the SQL handler works alongside the dbt provider — the provider handles Jinja expansion and column lineage, the handler handles AST parsing.

### Example

```
search_symbols(query: "orders", kind: "class")
→ "orders" table (CREATE TABLE orders ...)

get_symbol_source(symbolId: "orders-table-id")
→ Full CREATE TABLE statement with all column definitions
```

---

## Combining data tools

A typical data platform exploration workflow:

```
1. search_columns(query: "revenue")
   → Find all columns named 'revenue' and their models

2. get_symbol_source(symbolId: "fct_revenue-model-id")
   → See the SQL logic that produces the revenue column

3. get_context_bundle(symbolId: "fct_revenue-model-id")
   → Traverse upstream to understand the full lineage

4. search_symbols(query: "revenue", kind: "route")
   → Find the API endpoints that expose revenue data

5. get_blast_radius(symbolId: "fct_revenue-model-id")
   → See which dashboards and downstream models depend on this
```
