# AST-Level Search

The three standard search modes — by name, by meaning, by text — cover most navigation tasks. But some questions can only be answered by looking at the *structure* of the code, not its surface.

- How many arrow functions are in this codebase?
- Find every function that returns `Promise<void>`.
- Which classes use the `@Injectable` decorator?
- Show me every function with more than 6 parameters.

These are structural questions. PureContext's AST-level search tools answer them by searching the indexed symbol data and — where needed — re-parsing stored file content through tree-sitter grammars.

---

## Searching by AST node type

`search_ast` finds every occurrence of a specific tree-sitter node type across all indexed files. If you've ever wanted to run a structural grep across a codebase, this is it.

**Scenario:** Your team is trying to eliminate all `try/catch` blocks in favor of `Result` types. Before you start, you want to know how many there are and where.

> "Find every try/catch block in the TypeScript source files."

```
search_ast(repoId, nodeType: "try_statement", language: "typescript") →

  47 matches across 23 files:

  src/api/routes/auth.ts:34         try { await validateToken(req) } catch (e) { ... }
  src/api/routes/payments.ts:67     try { await chargeCard(amount) } catch (err) { ... }
  src/core/database.ts:123          try { return await db.query(sql) } catch (e) { ... }
  src/workers/sync.ts:45            try { await syncUser(id) } catch (e) {
  ...
  (43 more)
```

47 places. The migration scope is now concrete.

**Finding all await expressions (checking for missing error handling):**

> "Find every await expression so I can check which ones lack try/catch."

```
search_ast(repoId, nodeType: "await_expression", filePath: "src/api/") →
  [all awaited calls in the API directory]
```

**Common node types by language:**

| Language | Node types to try |
|----------|------------------|
| TypeScript / JS | `arrow_function`, `function_declaration`, `class_declaration`, `interface_declaration`, `try_statement`, `await_expression`, `call_expression`, `import_statement`, `jsx_element`, `template_string`, `throw_statement`, `type_alias_declaration` |
| Python | `function_definition`, `class_definition`, `for_statement`, `with_statement`, `decorated_definition`, `lambda` |
| Go | `function_declaration`, `method_declaration`, `go_statement`, `defer_statement`, `type_declaration`, `interface_type` |
| Rust | `function_item`, `struct_item`, `impl_item`, `match_expression`, `closure_expression`, `trait_item` |
| Java / Kotlin | `method_declaration`, `class_declaration`, `try_statement`, `lambda_expression`, `annotation` |

Node type names are tree-sitter's internal names and are exact, case-sensitive matches.

---

## Searching by type signature

`search_by_signature` finds symbols by the pattern of their type signature. It operates on the one-line signature stored for every indexed symbol — no re-parsing needed.

**Scenario:** You're auditing all functions that accept a `Request` object to make sure they all validate the request before using it.

> "Find all functions that accept a Request parameter."

```
search_by_signature(repoId, pattern: "(req: Request", kind: "function") →

  handleLogin()           src/api/routes/auth.ts          function
  handleLogout()          src/api/routes/auth.ts          function
  validateRequestBody()   src/api/middleware/validate.ts  function
  processWebhook()        src/api/routes/webhooks.ts      function
  ... (14 more)
```

All 17 functions that accept a `Request`. Spot-check each one for input validation.

**Finding all async functions in a specific directory:**

```
search_by_signature(repoId, pattern: "async", mode: "startsWith", filePath: "src/core/") →
  [all symbols in src/core/ whose signature starts with "async"]
```

**Finding all exported symbols (to audit the public API surface):**

```
search_by_signature(repoId, pattern: "export", mode: "startsWith") →
  [every symbol with a signature beginning with "export"]
```

**Finding functions that return a specific type:**

```
search_by_signature(repoId, pattern: "Promise<void>") →
  [all functions returning Promise<void>]

search_by_signature(repoId, pattern: ": string[]") →
  [all functions returning string[]]

search_by_signature(repoId, pattern: "AuthResult") →
  [any signature mentioning AuthResult — return types, parameters, or type aliases]
```

**Using regex mode for complex patterns:**

```
search_by_signature(repoId, pattern: "\\(.*password.*\\)", mode: "regex") →
  [all functions that have "password" somewhere in their parameter list]
```

---

## Searching by decorator

`search_by_decorator` finds all symbols annotated with a specific decorator. It re-parses file content to locate decorator nodes — catching decorators that may not appear in the stored signature.

**Scenario:** You're auditing all NestJS route handlers decorated with `@Get` to verify they all have proper authentication guards.

> "Find all @Get route handlers."

```
search_by_decorator(repoId, decoratorName: "Get") →

  getUsers()           src/users/users.controller.ts:14    method
  getUserById()        src/users/users.controller.ts:28    method
  getOrderHistory()    src/orders/orders.controller.ts:8   method
  getPaymentMethods()  src/billing/billing.controller.ts:19 method
  ... (11 more)
```

15 GET handlers. Now cross-reference with those that have an `@UseGuards` decorator:

```
search_by_decorator(repoId, decoratorName: "UseGuards") →
  [12 matches]
```

Three handlers don't have a guard. Those are your security gaps.

**Prefix match for families of decorators:**

```
search_by_decorator(repoId, decoratorName: "Get", matchMode: "prefix") →
  → finds @Get, @GetMapping, etc.

search_by_decorator(repoId, decoratorName: "Column", matchMode: "prefix") →
  → finds @Column, @ColumnType, @ColumnDefault, etc.
```

**Finding all ORM entities:**

```
search_by_decorator(repoId, decoratorName: "Entity") →
  [all classes marked as TypeORM entities]

search_by_decorator(repoId, decoratorName: "injectable", matchMode: "contains") →
  [all injection-related decorators across frameworks — @Injectable, @Inject, etc.]
```

---

## Searching by complexity thresholds

`search_by_complexity` finds symbols that match specific numeric criteria across six complexity dimensions. This is different from `get_complexity_hotspots` (which ranks files) — here you set specific thresholds and get back the matching symbols.

**Scenario:** A code review checklist says any function with cyclomatic complexity above 8 requires two reviewers. Before the release, find all such functions.

> "Find all functions with cyclomatic complexity above 8."

```
search_by_complexity(repoId, minCyclomaticComplexity: 8, kind: "function") →

  processAuthRequest()    src/auth/processor.ts      complexity: 18  lines: 120
  generateReport()        src/reporting/engine.ts    complexity: 14  lines: 89
  validatePaymentForm()   src/billing/validator.ts   complexity: 11  lines: 67
  migrateUserData()       src/workers/migration.ts   complexity: 9   lines: 43
  ... (7 more)
```

11 functions require dual review.

**Finding functions with too many parameters:**

> "Find all functions with 5 or more parameters — we're moving to options objects."

```
search_by_complexity(repoId, minParamCount: 5) →

  createUser(name, email, role, tenantId, options, ...rest)  — 6 params
  sendEmail(to, from, subject, body, attachments, headers)    — 6 params
  processOrder(items, userId, discount, tax, shipping, note) — 6 params
  ... (9 more)
```

**Finding long functions to split:**

```
search_by_complexity(repoId, minLineCount: 100, kind: "function") →
  [all functions longer than 100 lines]
```

**Combining multiple criteria:**

> "Find the most dangerous code — high complexity AND deeply nested AND long."

```
search_by_complexity(repoId,
  minCyclomaticComplexity: 8,
  minNestingDepth: 4,
  minLineCount: 50) →
  [intersection of all three filters]
```

**Finding simple utility functions (to understand what's safe to inline):**

```
search_by_complexity(repoId,
  maxCyclomaticComplexity: 2,
  maxLineCount: 10,
  maxParamCount: 2,
  kind: "function") →
  [simple, pure helper functions — candidates for inlining]
```

The six complexity dimensions available:

| Dimension | What it measures |
|-----------|-----------------|
| `cyclomaticComplexity` | Number of independent code paths (branching) |
| `cognitiveComplexity` | Mental effort to understand (nested structures) |
| `lineCount` | Function body size |
| `nestingDepth` | Maximum level of nested blocks |
| `paramCount` | Number of parameters |
| `returnCount` | Number of return statements (exit points) |

---

## Combining AST search with other tools

AST search tools work best as the starting point for further navigation:

```
1. search_ast(nodeType: "try_statement")
   → get all try/catch blocks in the codebase

2. [review the list, pick the ones you care about]

3. get_symbol_source(symbolId)
   → read the source for specific matches

4. find_references(symbolId)
   → see who calls functions that contain the pattern

5. get_context_bundle(symbolId)
   → understand the full context around a complex function
```

```
1. search_by_complexity(minCyclomaticComplexity: 10)
   → find the most complex functions

2. get_symbol_history(symbolId)
   → check how long they've been this complex and who wrote them

3. plan_refactoring(goal: "general", filePath)
   → get a structured plan for the worst files
```

---

→ Reference: [MCP Tools Reference](docs/06-tools-reference.md) — `search_ast`, `search_by_signature`, `search_by_decorator`, `search_by_complexity`
