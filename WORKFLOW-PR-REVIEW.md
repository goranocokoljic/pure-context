# Workflow: Reviewing a Pull Request

**Scenario:** It's Tuesday morning. You open GitHub and find a pull request sitting in your queue: "Migrate user authentication to OAuth2 — 40 files changed." You're the designated reviewer. The author is a colleague you trust, but this is a large, cross-cutting change affecting the core authentication flow. You have about 45 minutes before your next meeting.

Without context, you'd start reading diffs top to bottom, hoping to understand the intent as you go. With PureContext, you start by understanding the impact, then read strategically.

---

## Step 1: Understand the scope before reading anything

**You:** "I have a PR to review — 40 files changed in the authentication migration. Before I read any diffs, give me a symbol-level analysis of what actually changed."

**Claude** calls `analyze_diff(base: "main", head: "feature/oauth2-migration")`:

```
Symbols modified (signature changed — potential breaking changes):
  authenticateUser()         apps/auth/validator.py    signature changed
  require_auth               apps/auth/decorators.py   implementation changed
  UserPermissions            apps/core/types.py         fields added

Symbols modified (implementation only — no signature change):
  JWTMiddleware              apps/auth/middleware.py    replaced internally
  createSession()            apps/auth/session.py       updated token format
  ... (12 more)

Symbols added (new in this PR):
  OAuthClient                apps/auth/oauth2.py        new class
  exchangeOAuthCode()        apps/auth/oauth2.py        new
  refreshOAuthToken()        apps/auth/oauth2.py        new
  OAuthCallbackView          apps/auth/views.py          new
  ... (8 more)

Symbols deleted:
  generateLegacyToken()      apps/auth/legacy.py        removed
  OldSessionManager          apps/auth/sessions.py      removed
  validateBasicAuth()        apps/auth/basic.py         removed

Blast radius of modified symbols: 47 files

Aggregate risk: HIGH
  authenticate_user   high (78/100) — 6 dependents · churn 9/90d · signature changed
  require_auth        high (71/100) — wraps 134 views · co-changes with middleware tests

missingCoChange (historically move with the edited files, but NOT in this PR):
  apps/auth/sso_config.py     (confidence 0.62)   ← SSO config usually changes with the auth flow
  tests/auth/test_sso.py      (confidence 0.55)

coverageGaps (changed symbols with no detected test):
  OAuthCallbackView    apps/auth/views.py

recommendedTests:
  tests/auth/test_middleware.py · tests/auth/test_decorators.py

architecturalFlags:
  (none — changed files don't currently sit on a cycle or cross a layer boundary)

Review priority: CRITICAL (signature breaks + high aggregate risk)
```

In 30 seconds you know — without reading a diff:
- The signature of `authenticateUser` changed and it scores **high** composite risk — everything that calls it must be checked
- `require_auth` was modified — it wraps 134 view functions, so behavior changes here affect the entire application
- Three symbols were deleted — are they truly dead, or are there call sites the PR missed?
- The real blast radius is 47 files, not 40 (some impact is indirect)
- **`missingCoChange` is the senior-reviewer instinct made explicit:** `sso_config.py` and `test_sso.py` historically move with the auth flow but aren't in this PR — likely an omission to ask the author about
- `OAuthCallbackView` ships with no test

`analyze_diff` returns all of this in one call (the risk / co-change / test / flag sections default on; switch any off for cheap runs). This frames your entire review before you've read a diff.

---

## Step 2: Verify the deleted symbols were actually unused

The deleted symbols are the first concern. Deleting code that's still called causes a runtime error.

**You:** "Three symbols were deleted. Verify that they had no importers in main — confirm they were actually dead code before this PR."

**Claude** calls `get_blast_radius` on each deleted symbol against the main branch index:

```
generateLegacyToken()  — 0 importers in main (confirmed dead)
OldSessionManager      — 0 importers in main (confirmed dead)
validateBasicAuth()    — 0 importers in main (confirmed dead)
```

All three confirmed dead. The author cleaned up dead code correctly. This concern is closed.

---

## Step 3: Check the signature change for `authenticateUser`

A signature change to a function is the highest-risk change in any PR. It means every call site needs to handle the new interface.

**You:** "authenticateUser changed its signature. Show me the old signature, the new one, and all the places that call it."

**Claude** retrieves the symbol history for `authenticateUser` and the current source:

```
Old signature (main):
  def authenticate_user(username: str, password: str) -> Optional[User]

New signature (this PR):
  def authenticate_user(credentials: OAuthCredentials | PasswordCredentials) -> AuthResult
```

The parameter type changed from two positional strings to a union type, and the return type changed from `Optional[User]` to `AuthResult`. This is a significant interface change.

**Claude** calls `find_references(symbolId: "authenticateUser")` on the current branch:

```
authenticate_user() is called in 6 places:

  apps/auth/views.py:45      LoginView.post()         ← using new signature ✓
  apps/users/tests/test_auth.py:23   test_login()    ← updated ✓
  apps/users/tests/test_auth.py:67   test_lockout()  ← updated ✓
  apps/api/auth.py:89        api_login()              ← using new signature ✓
  apps/admin/views.py:134    admin_login()            ← still using old signature ✗
  apps/integrations/sso.py:67  sso_authenticate()    ← still using old signature ✗
```

Two call sites weren't updated. `admin_login` and `sso_authenticate` are still passing two positional string arguments. This is a bug in the PR — it would pass type checking if the types weren't enforced strictly, but would fail at runtime.

You've found the blocking issue in the PR. Two minutes into the review.

---

## Step 4: Verify the critical path

`require_auth` is the decorator used by 134 views. It was modified. You need to know the modification is backward compatible.

**You:** "require_auth was modified. Show me what changed and verify that all 134 views that use it still work with the new implementation."

**Claude** retrieves the new source for `require_auth`:

```python
def require_auth(view_func):
    @wraps(view_func)
    def wrapper(request, *args, **kwargs):
        # NEW: Accept both JWT (legacy) and OAuth2 Bearer tokens
        auth_header = request.META.get('HTTP_AUTHORIZATION', '')
        if auth_header.startswith('Bearer '):
            user = authenticate_oauth_token(auth_header[7:])
        else:
            user = authenticate_jwt_token(request)  # legacy path preserved
        if user is None:
            return HttpResponse(status=401)
        request.user = user
        return view_func(request, *args, **kwargs)
    return wrapper
```

The implementation accepts both token formats — OAuth2 Bearer tokens and the legacy JWT. The 134 decorated views don't need to be updated because the decorator handles the transition transparently. This is a good implementation decision, and it's verifiable from the code.

**You:** "This looks correct — it's a compatible shim. But check: is there any test that specifically covers the JWT fallback path in the new implementation?"

**Claude** calls `search_symbols(query: "authenticate_jwt_token", filePath: "tests/**")`:

```
authenticate_jwt_token referenced in tests:
  tests/auth/test_middleware.py    test_jwt_fallback()   ← exists ✓
  tests/auth/test_decorators.py    test_require_auth()   ← exists ✓
```

The fallback path is tested. The implementation is sound.

---

## Step 5: Check for any missed text-level dependencies

Symbol analysis catches structured dependencies. But JWT-specific string patterns — cache keys, token format strings, configuration keys — might be missed.

**You:** "Search for any remaining references to the old JWT configuration key or the old session format that might have been missed."

**Claude** calls `search_text(query: "JWT_SECRET", filePath: "**/*.py")`:

```
Remaining JWT_SECRET references:
  apps/auth/oauth2.py:156    settings.JWT_SECRET   ← why does the new OAuth module reference this?
```

Unexpected. The new OAuth2 module references `JWT_SECRET`. You open the source:

```python
# Temporary: use JWT_SECRET as the OAuth state parameter signing key
# TODO: Replace with dedicated OAUTH_STATE_SECRET before merge
state_sig = hmac.new(settings.JWT_SECRET.encode(), ...)
```

The author left a TODO comment but didn't create a separate configuration key. This is a code smell — the OAuth implementation is reusing the JWT secret for a different purpose, which violates key isolation. Flag it in the review.

---

## Step 6: Did the migration make the architecture worse?

A 40-file migration is exactly the kind of change that quietly introduces a new import cycle or layer violation. If a baseline architecture snapshot was taken on `main` (e.g. in CI before the branch diverged), `compare_change_impact` reports only what *this* change introduced.

**You:** "Did this PR introduce any new import cycles or layer violations versus main?"

```
compare_change_impact(repoId, baselineSnapshotId: "main-baseline") →

  verdict: "regressed"
  newCycles: [ [ "apps/auth/oauth2.py", "apps/auth/views.py", "apps/auth/oauth2.py" ] ]
  newLayerViolations: [ ]
  resolvedCycles: [ ]
```

A new cycle between `oauth2.py` and `views.py` that did not exist on `main` — introduced by this PR. Unlike `analyze_diff`'s `architecturalFlags` (which flag *pre-existing* structure), this is a genuine regression to raise. (The PR author can run the same check locally before pushing — and `verify_change` to confirm they covered the `missingCoChange` files surfaced in Step 1.)

---

## The review summary

45 minutes, structured review. Findings:

| Finding | Severity | Location |
|---------|----------|----------|
| `authenticate_user` called with old signature | **Blocking** | `admin/views.py:134`, `integrations/sso.py:67` |
| New import cycle introduced (oauth2 ⇄ views) | **Blocking** | `auth/oauth2.py` ⇄ `auth/views.py` |
| JWT secret reused as OAuth state signing key | **Major** — flag before merge | `auth/oauth2.py:156` |
| SSO config historically co-changes but absent from PR | **Question for author** | `auth/sso_config.py` |
| `OAuthCallbackView` ships with no test | **Minor** | `auth/views.py` |
| Deleted symbols confirmed dead | **Pass** | legacy.py, sessions.py, basic.py |
| `require_auth` shim correctly backward compatible | **Pass** | auth/decorators.py |
| Legacy fallback path covered by tests | **Pass** | tests/auth/ |

You found two real issues — one blocking, one major — before reading most of the diff. The blocking issue (two call sites using the wrong signature) would have been a runtime error in production. The major issue (key reuse) is a security design problem.

---

## What made this review effective

**Start with impact, not diffs.** `analyze_diff` gave you the symbol-level map before you read anything. You knew where to focus.

**Verify deletions first.** Deleted code that's still called is the most dangerous class of PR error. Checking blast radius for deleted symbols takes 30 seconds and catches the worst case.

**Find all call sites for signature changes.** `find_references` across the branch revealed the two missed call sites that static analysis alone might have missed in a dynamically typed codebase.

**Use text search for string-level dependencies.** Symbol analysis doesn't catch JWT_SECRET usage in string context. Text search does.

**Know when to stop.** With the two blocking issues identified and the critical path verified, you have what you need to write a meaningful review. You don't need to read all 40 diffs to give a quality review — you need to read the right ones.

---

→ Reference: [MCP Tools Reference](docs/06-tools-reference.md) — `analyze_diff`, `compare_change_impact`, `verify_change`, `prepare_change`, `find_references`, `get_blast_radius`, `get_symbol_history`, `search_text`
