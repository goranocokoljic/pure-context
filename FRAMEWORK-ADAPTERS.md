# Framework Adapters

A language handler knows what a function or class looks like. A framework adapter knows that `app.get('/users/:id', ...)` is actually a **route**, that a Vue Single File Component is a **component**, and that a Django `models.Model` subclass is a **model** with a table behind it.

PureContext ships with adapters for the frameworks most production codebases are written against. They run automatically — drop the index on a NestJS project and `/users` routes show up as first-class symbols you can search for by path, not just by handler-function name.

This page is the user-facing tour. For parameter-level details (exact regex patterns, full `frameworkMeta` shapes), see the [reference manual](docs/08-framework-adapters.md).

---

## How adapters change what you see

Without an adapter, searching for "user routes" in an Express app returns *function names* — `handleGetUser`, `createUserHandler`, `usersRouter` — and you have to read each one to confirm it's actually a route.

With the Express adapter active, the same search returns:

```
search_symbols(query: "users") →

  GET    /users         src/routes/users.ts    route
  POST   /users         src/routes/users.ts    route
  GET    /users/:id     src/routes/users.ts    route
  DELETE /users/:id     src/routes/users.ts    route
```

That's the difference. Adapters extract the *intent* of code (a route, a component, an ORM entity) rather than just its syntactic shape.

---

## Auto-detection

Adapters are detected from project config — `package.json`, `composer.json`, `Gemfile`, `pubspec.yaml`, `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle`. If you have `react` in dependencies, the React adapter runs. If `manage.py` sits at the project root, the Django adapter runs.

You don't usually need to configure anything. If you do:

```json
{
  "adapters": "auto"           // default
  "adapters": "none"           // disable all adapters
  "adapters": ["vue", "nuxt"]  // explicit allow-list
}
```

Multiple adapters run side by side. A Vue + Nuxt project activates both. A Nest app that also uses TypeORM gets routes from Nest *and* entities from TypeORM.

---

## JavaScript and TypeScript

### Vue 3

Detected by `vue` in `package.json` or any `.vue` file present.

Extracts from Single File Components:
- The component itself (named from `defineComponent` or filename) → `component`
- Exported `useFoo` functions → `composable`

Useful for: jumping to a `<MyButton>` mentioned in a template, or finding every composable that touches the auth store.

### Svelte

Detected by `svelte` / `@sveltejs/*` in `package.json`, a `svelte.config.*` file, or any `.svelte` file present (including monorepo sub-apps).

Extracts from Svelte components:
- The component itself (named from filename) → `component`
- Symbols inside `<script>` / `<script context="module">` blocks (parsed by the TS/JS handler)
- Exported `useFoo` functions → `composable`

### Astro

Detected by `astro` / `@astrojs/*` in `package.json`, an `astro.config.*` file, or any `.astro` file present (including monorepo sub-apps).

Extracts from Astro components:
- The component itself (named from filename) → `component`
- Symbols declared in the leading `---` frontmatter (parsed as TypeScript)

### Nuxt

Detected by `nuxt.config.ts` / `.js` / `.mts` / `.mjs`.

Layers Nuxt's conventional routing on top of the Vue adapter:
- `pages/blog/[slug].vue` → `route /blog/:slug`
- `server/api/users.get.ts` → `route GET /api/users`
- `middleware/auth.ts` and `plugins/*` → `middleware`
- Composables in `composables/` are flagged with `nuxt_auto_import: true`

### React

Detected by `react` in `package.json`. This adapter doesn't extract new symbols — it *enriches* what the TypeScript handler already found:
- PascalCase functions that return JSX → `component`
- `useFoo` functions → `hook`

So `MyButton` shows up as a `component` rather than a generic `function`, and `useAuth` shows up as a `hook` rather than a generic `function`.

### Next.js

Detected by `next.config.*` or `next` in dependencies. Supports both routers:

**Pages Router** (`pages/`):
- `pages/blog/[slug].tsx` → `route /blog/:slug`
- Detects `getServerSideProps` (SSR) and `getStaticProps` (SSG)
- API routes from `pages/api/`

**App Router** (`app/`):
- `app/(marketing)/about/page.tsx` → `route /about` (route groups stripped)
- `'use client'` directive flagged on metadata
- API routes from `app/**/route.ts` with HTTP method exports

**Middleware** (`middleware.ts`) → `middleware` symbol with the matcher config.

### Angular

Detected by `@angular/core`. Decorated classes become first-class:
- `@Component` → `component` (with `selector`)
- `@Injectable` → `class` (service)
- `@NgModule` → `class` (module)
- `@Directive` → `component`
- `@Pipe` → `component` (with the pipe name)
- `RouterModule.forRoot` / `forChild` configs → `route` symbols

### NestJS

Detected by `@nestjs/core`. Combines the controller prefix with each method's path:

```typescript
@Controller('users')
class UsersController {
  @Get(':id') findOne() { ... }   // → route GET /users/:id
}
```

- `@Injectable` → `class` (with `nestjs_provider: true`)
- `@Module` → `class` (with `nestjs_module: true`)
- Guards and `CanActivate` implementations → `middleware`

### Express

Detected by `express`. Extracts string-literal route registrations:

```javascript
app.get('/path', handler)         // → route GET /path
router.post('/path', handler)     // → route POST /path
app.use('/path', middleware)      // → middleware /path
```

Dynamic paths built from variables or template literals are skipped — there's no reliable way to recover the runtime value from static analysis.

### Fastify

Detected by `fastify`. Same pattern as Express: `fastify.get(path, handler)` → `route`.

---

## Python

### Django

Detected by `manage.py` at the project root, or `django` in requirements.

- `models.Model` subclasses → `model` (with field types: `CharField`, `ForeignKey`, etc.)
- Class-based views (`APIView`, `ViewSet`, etc.) → `view`
- Function-based views with `@login_required` / `@api_view` → `view`
- `path(...)` / `re_path(...)` in `urls.py` → `route`
- `@receiver(post_save)` → `signal`

### FastAPI

Detected by `fastapi`. Extracts decorated handlers:

```python
@app.get('/items/{id}')           # → route GET /items/{id}
@router.post('/items')            # → route POST /items
```

FastAPI's `{param}` path syntax is preserved as-is in the route metadata.

### Flask

Detected by `Flask`. Extracts:
- `@app.route('/path')` → `route`
- `@app.get`, `@app.post`, etc. → `route`
- Blueprint routes (`@bp.route(...)`) → `route`
- Class-based views inheriting `MethodView` → `view`

Flask's `<int:user_id>` path syntax is preserved.

---

## Go

### Gin, Echo, Fiber

Detected by their respective `go.mod` entries. All three follow the same pattern — `r.GET("/path", handler)` becomes a `route`. Route groups apply their prefix to children.

The Fiber adapter handles title-cased methods (`app.Get`, `app.Post`); Gin and Echo use lowercase methods.

---

## PHP

### Laravel

Detected by `laravel/framework` in `composer.json`.

- `Route::get('/path', ...)` → `route`
- `Route::resource('users', Controller::class)` → expands into the seven CRUD routes (index/show/create/store/edit/update/destroy)
- `Route::group(['prefix' => '/api'], ...)` → prefix applied to children
- `class User extends Model` → `model`
- Controller public methods → `view` (action)
- Middleware classes → `middleware`

### Symfony

Detected by `symfony/framework-bundle`. Supports both routing styles:

```php
#[Route('/path', methods: ['GET'])]   // PHP 8 attributes
@Route('/path')                       // docblock annotations
```

Both produce `route` symbols.

---

## Ruby

### Rails

Detected by `gem 'rails'` in `Gemfile`.

- `ApplicationRecord` subclasses → `model` (with `has_many` associations captured)
- Controller public methods → `view` (action)
- `get '/path'`, `resources :users` in `routes.rb` → `route` (resources expand to the seven REST actions)

### Sinatra

Detected by `gem 'sinatra'` or `require 'sinatra'`. `get '/path' do ... end` → `route`.

---

## Kotlin

### Ktor

Detected by `io.ktor`. Extracts from the routing DSL:

```kotlin
route("/api") {
  get("/users") { ... }    // → route /api/users
}
authenticate { ... }       // → frameworkMeta.authenticated: true
```

### Spring (Kotlin)

Detected by `org.springframework.boot`. Same extraction as Spring Boot below — adapter handles both Java and Kotlin sources.

### Android (Compose + Hilt + Manifest + Gradle modules)

Detected by an `AndroidManifest.xml` anywhere in the tree, or a `build.gradle(.kts)` applying `com.android.application` / `com.android.library` (bounded recursive scan — multi-module is the Android default). Handles `.kt`, `.java`, and `AndroidManifest.xml`.

**Compose:** `@Composable` functions → kind `composable` (`frameworkMeta.android: 'compose'`). `@Preview` composables carry `preview: true` so they can be filtered from API surfaces.

**Hilt/Dagger DI:** annotations become `frameworkMeta.di` on the symbol — `@Module` (role `module`), `@Provides`/`@Binds` (role `provider` + `providedType`), `@Inject` constructors/fields (role `consumer` + `consumedTypes`), `@HiltViewModel`, `@AndroidEntryPoint`, and scope annotations (`@Singleton`, `@ViewModelScoped`, …) as `scope`. At graph-build time these become **`di` dependency edges** (consumer file → provider file, specifier `di:<TypeName>`) — the coupling import analysis cannot see, because Hilt consumers never import their providers. Graph tools (`get_blast_radius`, `find_importers`, …) pick them up automatically; `find_cycles` excludes `di` edges (the `@Binds` pattern makes module ↔ impl pairs by design). v1 bound: name-based matching only — an ambiguous type name edges to *all* providers (over-approximation, the safe direction for blast radius); no `@Named` qualifier disambiguation.

**Manifest entry points:** `<activity>`, `<service>`, `<receiver>`, `<provider>` → `route` symbols (`frameworkMeta.android: 'manifest'`) with `component`, `exported`, `intentFilters`, and a `launcher` flag. `get_entry_points` ranks them as `android_component` entries — the LAUNCHER activity first. Leading-dot names resolve against the manifest `package` attribute; manifests that keep the namespace only in Gradle fall back to the bare class name (v1 limitation).

**Gradle modules:** every `.kt`/`.java`/manifest symbol carries `frameworkMeta.gradleModule` (`:app`, `:feature:login`, `:` for the root module), derived from the path segments before the first `src/` directory.

**Recipe — Gradle modules as architecture layers:** `get_layer_violations` needs a layer config; generate one from your module list. Read the `include(...)` lines in `settings.gradle(.kts)`, map each module to its directory, and declare the allowed direction (apps depend on features, features on core — never the reverse):

```json
{
  "layers": [
    { "name": "app",     "paths": ["app/**"] },
    { "name": "feature", "paths": ["feature/**"] },
    { "name": "core",    "paths": ["core/**"] }
  ],
  "rules": [
    { "from": "app",     "allow": ["feature", "core"] },
    { "from": "feature", "allow": ["core"] }
  ]
}
```

Out of scope (deliberate): `res/**` XML resources, Gradle version catalogs, KSP output, runtime navigation graphs.

---

## Rust

### Axum

Detected by `axum` in `Cargo.toml`. Extracts router chains:

```rust
.route("/users", get(list_users))
.route("/users/:id", get(get_user))
.layer(auth_middleware)   // → middleware
```

### Actix-web

Detected by `actix-web`. Extracts attribute macros: `#[get("/path")]` → `route`. `.wrap(...)` calls become `middleware`.

### Rocket

Detected by `rocket`. Extracts `#[get("/path")]` → `route`. `#[catch(404)]` becomes an error catcher, and `Fairing` implementations become middleware.

---

## Java

### Spring Boot

Detected by `spring-boot-starter` in build files.

- `@GetMapping` / `@PostMapping` (combined with class-level `@RequestMapping` prefix) → `route`
- `@Service`, `@Component`, `@Repository` → beans with bean metadata
- `@Bean` factory methods → tracked as bean producers
- `@Scheduled` methods → scheduled tasks

### Micronaut

Detected by `io.micronaut`. `@Get("/path")`, `@Post(...)` → `route`. `@Client` interfaces are captured.

### Quarkus

Detected by `io.quarkus`. JAX-RS `@GET` + `@Path` combinations → `route`. `@ApplicationScoped` → bean.

---

## ORM adapters

ORMs sit slightly off the routing-adapter spine because they don't add routes — they add *entities*, which downstream queries (`find_references`, `get_blast_radius`) treat the same as any other symbol.

| Adapter | Detected by | Extracts |
|---------|-------------|----------|
| **Hibernate** (Java) | `hibernate-core` / `jakarta.persistence` | `@Entity` classes, table name, columns with types and nullability, `@OneToMany` / `@ManyToOne` relationships, named queries |
| **SQLAlchemy** (Python) | `sqlalchemy` | `Base` / `DeclarativeBase` subclasses, `__tablename__`, `Column(Type)` fields, `relationship()` associations, `@hybrid_property`. Supports both 1.x and 2.0 (`mapped_column`) styles. |
| **Django ORM** | `manage.py` | `models.Model` subclasses with field types (`CharField`, `IntegerField`, `ForeignKey`, `ManyToManyField`, etc.) |
| **Prisma** | `prisma` in `package.json` or `schema.prisma` present | Model definitions and relations from `schema.prisma` |
| **TypeORM** | `typeorm` in `package.json` | `@Entity` classes and `@Column` / `@Relation` fields |

Once entities are first-class symbols, you can ask "what writes to the `users` table?" the same way you'd ask "what calls `validateToken`?".

---

## Mobile

### Flutter

Detected by `sdk: flutter` in `pubspec.yaml`. Extracts from `.dart` files:

- `StatelessWidget` subclasses → `widget`
- `StatefulWidget` subclasses → `widget` (linked to the State class)
- `ChangeNotifier` subclasses → `class` with `flutter_notifier: true`

---

## Disabling an adapter

If an adapter is misclassifying things in your project, turn it off:

```json
{
  "adapters": ["vue", "react"]   // explicit list — others stay off
}
```

Or to disable framework extraction entirely:

```json
{
  "adapters": "none"
}
```

The language handler still runs — you'll still get functions and classes, you just won't get `route` / `component` / `model` annotations on top.

---

## Adding a new adapter

Adapters follow the same three-layer rule as language handlers (Core → Handlers → Adapters; never the reverse). To add one:

1. Create a file in `src/adapters/`, implementing `FrameworkAdapter`
2. `detect(projectRoot)` returns true if the framework is present
3. `extractFrameworkSymbols(tree, source, filePath)` returns the framework-specific symbols
4. Optionally `enrichMetadata(symbol)` to add `frameworkMeta` to existing symbols
5. Add tests against fixture projects in `test/adapters/`

See `docs/25-architecture-overview.md` for the architecture rules and `src/adapters/vue.ts` for a good reference implementation.

---

→ Full parameter-level reference: [docs/08-framework-adapters.md](docs/08-framework-adapters.md)
→ The language handlers that adapters sit on top of: [LANGUAGE-SUPPORT.md](LANGUAGE-SUPPORT.md)
