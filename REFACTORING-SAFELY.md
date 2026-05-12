# Refactoring Safely

Refactoring is risky not because the changes are hard, but because the side effects are invisible. You rename a function and forget about the string-literal reference in a config file. You delete a helper and miss the one call site that imported it from a different path. You move a file and half the codebase's import paths silently break.

PureContext's refactoring safety tools give you a complete impact analysis before you make any change — so you know exactly what you're dealing with before you start.

---

## Before renaming a symbol

Renaming a function, class, or constant affects every file that references it. The question is always: *exactly how many places, which ones, and are there any that a text-replace can't fix automatically?*

**Scenario:** You're renaming `validateToken` to `verifyAuthToken` to align with the new naming convention. Before you do it in your editor, get the full picture.

> "I want to rename validateToken to verifyAuthToken. Is that safe? Show me everywhere it's used."

```
check_rename_safe(repoId, symbolId: "validateToken-id", newName: "verifyAuthToken") →

  safe: true
  verdict: "Rename is safe. All references are in import statements and call sites
            that can be updated automatically. No string-literal references detected."

  Affected files (12):
    src/auth/index.ts:3        import  — import { validateToken } from './validator'
    src/auth/index.ts:47       call    — const result = validateToken(req.headers.auth)
    src/api/middleware/auth.ts:12  import  — import { validateToken } ...
    src/api/middleware/auth.ts:67  call    — validateToken(bearer)
    src/api/routes/login.ts:23     call    — if (!validateToken(session)) ...
    test/auth/validator.test.ts:15  call   — expect(validateToken('expired')).toBe(false)
    test/auth/validator.test.ts:31  call   — validateToken(validToken)
    ... (5 more)

  No conflicts: "verifyAuthToken" does not exist in any of these files.
  No string-literal references that require manual updates.
```

Safe to proceed. All 12 references are structured code — imports and call sites — that any rename tool can update mechanically. No surprises.

**When it's not safe:**

```
check_rename_safe(repoId, symbolId: "processPayment-id", newName: "handlePayment") →

  safe: false
  blockers:
    1. String-literal reference found:
       src/config/routes.json:34  "handler": "processPayment"
       ← This is a string, not a code reference. A rename tool won't catch it.

    2. Name conflict:
       src/billing/processor.ts already contains a symbol named "handlePayment"
       ← Two functions with the same name in the same import scope will conflict.
```

Two blockers. The string-literal reference in `routes.json` needs a manual update — it's used as a string key to look up the handler dynamically. The name conflict needs to be resolved before the rename can proceed.

---

## Before deleting a symbol

Deleting code that's still called causes runtime errors. `check_delete_safe` finds every live reference before you delete anything.

**Scenario:** You think `formatDateLegacy` is dead code. You want to confirm before deleting it.

> "Is formatDateLegacy safe to delete?"

```
check_delete_safe(repoId, symbolId: "formatDateLegacy-id") →

  safe: true
  verdict: "No live references found. Symbol is unexported. Safe to delete."

  Risks found:
    test-subject  test/utils/date.test.ts:45  — test file references this symbol
                  (informational — deleting will require updating the test)
```

No production code references it. The only reference is in a test file — which is expected and will need to be cleaned up alongside the deletion. Safe to proceed.

**When there are live references:**

```
check_delete_safe(repoId, symbolId: "getUserById-id") →

  safe: false
  verdict: "3 live references found. Deletion would cause runtime errors."

  Risks:
    live-reference  src/api/routes/users.ts:67
      const user = getUserById(req.params.id);

    live-reference  src/workers/sync.ts:34
      const admin = getUserById(config.adminId);

    exported-symbol  (symbol is exported — may be consumed by external packages)
```

Not safe. Two active call sites would break immediately. The exported flag also indicates external consumers may exist outside the indexed codebase.

**Checking an entire file for deletion:**

> "I want to delete src/legacy/auth-v1.ts entirely. What would break?"

```
check_delete_safe(repoId, filePath: "src/legacy/auth-v1.ts") →

  safe: false  (aggregate verdict across 8 symbols in this file)

  Breakdown:
    generateLegacyToken()   → safe: true   (0 references)
    validateBasicAuth()     → safe: true   (0 references)
    LegacySession           → safe: false  (2 live references)
      live-reference  src/api/middleware/legacy-compat.ts:23
      live-reference  src/workers/migrate-sessions.ts:67
    ... (5 more symbols, all safe)

  Summary: 2 of 8 symbols have live references. Remove references first.
```

You can delete most of the file immediately. Two symbols — `LegacySession` — need their callers updated first. The tool tells you exactly which two files.

---

## Before moving a file

Moving a file changes all the import paths that reference it. `check_move_safe` shows you every import that will need updating, and flags any that require manual intervention.

**Scenario:** You're reorganizing the project structure and want to move `src/utils/auth-helpers.ts` into `src/auth/helpers.ts`.

> "If I move auth-helpers.ts to src/auth/helpers.ts, what import paths will break?"

```
check_move_safe(repoId,
  filePath: "src/utils/auth-helpers.ts",
  newFilePath: "src/auth/helpers.ts") →

  safe: true
  verdict: "All 9 import references use relative paths and can be updated automatically."

  Import updates needed (9 files):
    src/api/middleware/auth.ts:2
      current:  import { hashToken } from '../../utils/auth-helpers'
      updated:  import { hashToken } from '../auth/helpers'

    src/auth/validator.ts:1
      current:  import { compareHash } from '../utils/auth-helpers'
      updated:  import { compareHash } from './helpers'

    src/core/session.ts:3
      current:  import { generateSecret } from '../utils/auth-helpers'
      updated:  import { generateSecret } from '../auth/helpers'

    ... (6 more, all relative paths)

  manualUpdatesRequired: false
```

All relative paths — a find-and-replace-style operation can handle this automatically.

**When manual updates are required:**

```
check_move_safe(repoId,
  filePath: "src/core/database.ts",
  newFilePath: "src/db/database.ts") →

  safe: false
  manualUpdatesRequired: true

  Problems:
    src/config/jest.config.ts:14
      moduleNameMapper: { '@core/database': './src/core/database' }
      ← Path alias in Jest config — not a TypeScript import. Requires manual update.

    src/build/webpack.config.js:56
      resolve: { alias: { 'core/database': path.resolve('./src/core/database') } }
      ← Webpack alias. Requires manual update.
```

The TypeScript imports can be updated automatically. The Jest and Webpack configs use the old path as a string — those need manual updates before the move.

---

## Getting a complete refactoring plan

When the scope is larger — breaking a circular dependency, extracting a module, reducing coupling — `plan_refactoring` synthesizes all the individual safety checks into a sequenced, risk-annotated action plan.

**Scenario:** You want to rename a widely-used symbol, and you want a step-by-step plan rather than a raw impact list.

> "Give me a complete refactoring plan for renaming validateToken to verifyAuthToken."

```
plan_refactoring(repoId, goal: "rename-symbol",
  symbolId: "validateToken-id", newName: "verifyAuthToken") →

  Goal: rename-symbol
  Estimated files: 12
  Estimated risk: low

  Steps (execute in order):

  1. [LOW RISK] Update test references (2 files)
     test/auth/validator.test.ts — update 2 call sites
     test/integration/auth.test.ts — update 1 import + 3 calls
     Reason: Start with tests — they validate the rename worked correctly.

  2. [LOW RISK] Update leaf callers (4 files)
     src/api/routes/login.ts — update 1 call site
     src/api/routes/refresh.ts — update 1 call site
     src/workers/session-cleanup.ts — update 1 call site
     src/api/middleware/auth.ts — update 1 import + 2 calls
     Reason: These files import validateToken but nothing else imports them in this context.

  3. [MEDIUM RISK] Update hub callers (2 files)
     src/auth/index.ts — update export re-export
     src/core/auth.ts — update 1 import + 4 calls
     Reason: These are imported by 8+ other files. Change here last.

  4. [FINAL] Rename the declaration
     src/auth/validator.ts — rename the function
     Reason: Always rename the declaration last, after all references are updated.

  Warnings:
    - After step 4, run index_folder to update the symbol index.
    - Run tests after each step to catch regressions early.
```

The plan is sequenced bottom-up: leaf files first, hub files last, the declaration itself final. This minimizes the window between "declaration renamed" and "all references updated," reducing the chance of a broken build.

**Other refactoring goals:**

```
plan_refactoring(repoId, goal: "delete-symbol", symbolId: "...")
  → sequenced steps for removing all references then deleting

plan_refactoring(repoId, goal: "break-cycle", filePath: "src/core/auth.ts")
  → identifies the specific import causing the cycle and how to break it

plan_refactoring(repoId, goal: "extract-module",
  filePath: "src/utils/helpers.ts", newFilePath: "src/format/currency.ts")
  → step-by-step extraction with all affected import updates

plan_refactoring(repoId, goal: "reduce-coupling", filePath: "src/core/auth.ts")
  → identifies the highest-coupling imports and suggests what to decouple

plan_refactoring(repoId, goal: "general", filePath: "src/utils/helpers.ts")
  → open-ended: surfaces the top structural issues in this file
```

---

## The pre-change pattern

For any significant structural change, this is the workflow:

```
1. Run the relevant safety check
   check_rename_safe / check_delete_safe / check_move_safe
   → get the verdict and full impact list

2. If safe: get the sequenced plan
   plan_refactoring(goal: "...")
   → step-by-step with risk annotations

3. Execute from leaf to hub, test after each step

4. Re-index after all changes
   index_folder(path, force: false)
   → incremental, picks up only what changed

5. Verify no dead code was created
   find_dead_code(repoId)
   → check nothing is now unreferenced
```

---

→ Reference: [MCP Tools Reference](docs/06-tools-reference.md) — `check_rename_safe`, `check_delete_safe`, `check_move_safe`, `plan_refactoring`
