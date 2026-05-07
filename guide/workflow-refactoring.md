# Workflow: Refactoring Legacy Code

**Scenario:** Your team inherited a legacy Python web application — a Django monolith that's been running for six years. The authentication system uses a custom JWT implementation that predates the team's tenure. You've been asked to replace it with a standard OAuth2 flow. The problem: nobody on the current team fully understands how the old authentication system is wired together. It grew organically, it's partially documented, and there are integration tests that haven't run in eight months.

This is not a rare scenario. It is the normal state of software that has lived long enough.

---

## Phase 1: Understand what exists

**You:** "I need to replace the legacy JWT authentication with OAuth2. Before touching anything, help me understand how the current authentication system works — what it's made of, where it's used, and what depends on it."

**Claude** calls `search_symbols(query: "authenticate", filePath: "apps/auth/**")`:

```
apps/auth/jwt.py             authenticate_token()    function
apps/auth/jwt.py             generate_token()        function
apps/auth/jwt.py             validate_claims()       function
apps/auth/middleware.py      JWTMiddleware            class
apps/auth/decorators.py      require_auth             function (decorator)
apps/auth/views.py           LoginView                class (view)
apps/auth/views.py           LogoutView               class (view)
apps/auth/views.py           RefreshTokenView         class (view)
```

Eight symbols in the auth module. Claude retrieves the outline for each file and builds a mental model. Then you ask the critical question:

**You:** "How widely is `require_auth` used across the application? This is the decorator — everything using it will need to work differently after the migration."

**Claude** calls `get_blast_radius(symbolId: "require_auth")`:

```
require_auth is used in 47 files across 12 Django apps:

  apps/users/views.py           18 decorated views
  apps/billing/views.py         12 decorated views
  apps/orders/views.py          9 decorated views
  apps/admin_panel/views.py     6 decorated views
  apps/api/views.py             31 decorated views
  ... (7 more apps)

  Total decorated views: 134
  Also used in: 3 custom middleware files
```

134 views. The scope is clear before you've planned a single line of migration. You're not doing a small change — you're touching the entire application's access control layer.

---

## Phase 2: Understand the current implementation

**You:** "Let me see the full context bundle for authenticate_token — I need to understand exactly how it works before designing the replacement."

`get_context_bundle(symbolId: "authenticate_token", maxDepth: 3)` returns:

```
authenticate_token()       apps/auth/jwt.py          — main function, 45 lines
validate_claims()          apps/auth/jwt.py          — claim validation, 28 lines
AuthUser                   apps/users/models.py      — the user model it returns
UserPermissions            apps/auth/permissions.py  — permission model
get_user_from_cache()      apps/core/cache.py        — Redis user caching, 22 lines
settings.JWT_SECRET        apps/core/settings.py     — the signing key location

Token estimate: 1,840 tokens
```

With the context bundle loaded, Claude explains how the current implementation works: JWT is decoded, the `sub` claim is extracted, the user is looked up from Redis cache first, then the database, and a combined `AuthUser` object is returned with permissions. The cache key format is `auth:user:{user_id}`.

This is knowledge that should be in documentation but isn't. Now it is — extracted directly from the code.

---

## Phase 3: Find the hidden dependencies

**You:** "Are there any places outside the auth module that interact directly with the JWT format, tokens, or the user cache? I don't want to miss something that breaks silently."

**Claude** calls `search_text(query: "JWT_SECRET")` and `search_text(query: "auth:user:", is_regex: false)`:

```
JWT_SECRET references:
  apps/auth/jwt.py:34          settings.JWT_SECRET  (expected)
  apps/integrations/webhooks.py:89  settings.JWT_SECRET  (unexpected!)
  scripts/generate_test_tokens.py:12  settings.JWT_SECRET

auth:user: cache key references:
  apps/auth/jwt.py:67          (expected)
  apps/core/cache.py:45        (expected)
  apps/analytics/sessions.py:128   (unexpected!)
```

Two surprises: `webhooks.py` is generating JWTs independently (a parallel implementation you didn't know existed), and `analytics/sessions.py` is reading directly from the user cache using the key format. Both would silently break after the migration if you hadn't found them.

This is the difference between a migration that works and a migration that works until three months later when a webhook or analytics edge case surfaces.

---

## Phase 4: Check for dead code before migrating

**You:** "Are there any auth-related functions that are already dead — unused exports we shouldn't bother migrating?"

**Claude** calls `find_dead_code(repoId)` filtered to auth-related files:

```
Dead code in auth module:

  generate_legacy_token()    apps/auth/legacy.py    — not imported anywhere
  OldSessionManager          apps/auth/sessions.py  — class with no instantiations
  validate_basic_auth()      apps/auth/basic.py     — imported nowhere
```

Three functions that can be deleted immediately without migration. The legacy session manager dates from before the JWT implementation. Migrating it would be wasted effort.

---

## Phase 5: Plan the migration path

With a complete picture of the system, you can now plan the migration confidently:

```
Migration plan (informed by PureContext analysis):

1. Create OAuth2 implementation alongside existing JWT:
   - New: apps/auth/oauth2.py
   - Preserve: existing JWT system during transition

2. Create a compatibility shim in require_auth:
   - Accept both JWT (existing) and OAuth2 Bearer tokens
   - No changes to 134 view files — they use the decorator, not the auth logic

3. Fix the hidden dependencies first:
   - apps/integrations/webhooks.py — replace with OAuth2 client credentials
   - apps/analytics/sessions.py — update cache key reading logic

4. Migrate clients gradually:
   - Internal services first, external API clients last

5. Delete dead code before merging:
   - apps/auth/legacy.py, sessions.py, basic.py

6. Remove JWT system when all clients confirmed migrated
```

The plan addresses all the blast radius, the hidden dependencies, and the dead code — in the right order. A migration plan shaped by actual analysis rather than assumptions.

---

## Phase 6: After the migration

Once the migration is complete, re-index and verify:

**You:** "The migration is done. Check for any dead code that the old JWT implementation left behind, and verify there are no remaining JWT references."

```
search_text(query: "JWT_SECRET") → 0 results
search_text(query: "jwt.decode") → 0 results
find_dead_code() →
  apps/auth/jwt.py (authenticate_token, generate_token, validate_claims) — now dead
```

The old JWT module is now entirely dead code. Safe to delete.

---

## What this workflow demonstrates

**Discovery before commitment.** Understanding the full scope — 134 decorated views, 2 hidden dependencies, 3 dead functions — happened before a single line of migration code was written. The plan emerged from evidence, not guesswork.

**Hidden dependencies surfaced.** `search_text` for string literals and cache key patterns found things that symbol search alone wouldn't catch. Text search and symbol search complement each other.

**Migration sequencing informed by data.** The decision to use a compatibility shim in `require_auth` (avoiding changes to 134 files) came directly from the blast radius analysis. Without that number, you might have tried to update each view individually.

**Verification at the end.** Re-indexing after the migration and checking for remaining references gives you a definitive answer: the migration is complete, not "probably complete."
