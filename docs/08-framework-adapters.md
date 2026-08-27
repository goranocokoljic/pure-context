# Framework Adapters — Reference

This is the reference page: detection criteria, extracted symbol kinds, and `frameworkMeta` shape for every adapter.

For the **user-friendly tour** — how adapters change what you see in search results, with examples and "useful for" notes — see [`FRAMEWORK-ADAPTERS.md`](../FRAMEWORK-ADAPTERS.md) at the project root.

---

Framework adapters layer domain-specific symbol extraction on top of language handlers. They are auto-detected from project config files.

## The `FrameworkAdapter` interface

Each adapter implements the `FrameworkAdapter` interface:

- `detect(projectRoot)` — returns `true` if this framework is present (checks `package.json`, `go.mod`, etc.)
- `fileFilter(filePath)` — returns `true` for files this adapter should process
- `preProcess(source, filePath)` — splits multi-language files into parseable blocks (e.g., Vue SFCs)
- `extractFrameworkSymbols(tree, source, filePath)` — extracts framework-specific symbols from the AST
- `enrichMetadata(symbol)` — adds `frameworkMeta` to existing symbols

Multiple adapters can be active simultaneously. Adapters compose — a Vue + Nuxt project activates both.

## Configuring adapters

```json
{
  "adapters": "auto"       // auto-detect from project files (default)
  "adapters": "none"       // disable all adapters
  "adapters": ["vue", "nuxt"]  // explicit list
}
```

---

## JavaScript / TypeScript frameworks

### Vue 3

**Detected by:** `vue` in `package.json`, or any `.vue` file present.

Extracts from `.vue` Single File Components:
- `component` — the component itself (from filename or `defineComponent`)
- `composable` — exported `use*` functions

`frameworkMeta` includes: `vue_component: true`, `vue_composable: true`.

### Nuxt

**Detected by:** `nuxt.config.ts` (or `.js`, `.mts`, `.mjs`) in project root.

Extracts:
- `route` from `pages/**/*.vue` (derives route path: `pages/blog/[slug].vue` → `/blog/:slug`)
- `route` from `server/api/**/*.ts` (HTTP method from filename suffix)
- `middleware` from `plugins/**` and `middleware/**`
- Enriches composables in `composables/**` with `nuxt_auto_import: true`

### React

**Detected by:** `react` in `package.json` dependencies (root or nested — bounded
monorepo scan), or any `.tsx`/`.jsx` file in the tree.

Enriches TypeScript handler symbols (name heuristics — JSX-return detection is
not implemented):
- PascalCase-named functions/consts in `.tsx`/`.jsx` files → `component`
  (true PascalCase only: `API_URL`/`HTTP` stay `const`)
- `use*` functions/consts → `hook` — in `.tsx`/`.jsx` files, or in plain
  `.ts`/`.js` files under a `hooks/` path segment

Known limitation: a `use*` symbol in a plain `.ts` file outside any `hooks/`
directory, in a repo where both Vue and React are detected, is stored as
`composable` (the FTS kind-alias tokens keep it retrievable either way).

### Next.js

**Detected by:** `next.config.*` or `next` in `package.json`. Registered
BEFORE the React adapter — its `fileFilter` claims only Next-specific paths;
all other `.tsx`/`.jsx` files fall through to React.

Extracts:
- **Pages Router** (`pages/**`): `route` symbols with path derivation
  - `pages/blog/[slug].tsx` → `/blog/:slug`
  - `frameworkMeta.ssr: true` when the page exports `getServerSideProps`;
    `ssg: true` for `getStaticProps`
- **App Router** (`app/**/page.tsx` + layout/loading/error/not-found/template):
  `route`/`component` symbols
  - `app/(marketing)/about/page.tsx` → `/about` (route groups stripped)
  - Detects the `'use client'` / `'use server'` directive (first statement —
    survives license headers) → `client_component` / `server_action`;
    default is `server_component: true`
- **API routes**: `pages/api/**` and `app/**/route.ts` with HTTP method exports
- **Middleware** (`middleware.ts`): `middleware` symbol (the `matcher` config
  export is not extracted)

### Angular

**Detected by:** `@angular/core` in `package.json`.

Extracts from decorated classes:
- `@Component` → `component` (with `selector`)
- `@Injectable` → `class` (service)
- `@NgModule` → `class` (module)
- `@Directive` → `component` (with `selector`)
- `@Pipe` → `component` (with pipe name)
- `RouterModule.forRoot/forChild` → `route` symbols

### NestJS

**Detected by:** `@nestjs/core` in `package.json`.

Extracts from decorated controllers:
- `@Controller('prefix')` + `@Get(':id')` → `route` with combined path (`GET /prefix/:id`)
- `@Injectable` → `class` with `nestjs_provider: true`
- `@Module` → `class` with `nestjs_module: true`
- `@Guard` / `CanActivate` → `middleware`

### Express

**Detected by:** `express` in `package.json`.

Extracts string-literal route registrations:
- `app.get('/path', ...)` → `route`
- `router.post('/path', ...)` → `route`
- `app.use('/path', ...)` → `middleware`

Dynamic paths (variables, template literals) are skipped.

### Fastify

**Detected by:** `fastify` in `package.json`.

Same pattern as Express: `fastify.get(path, ...)` → `route`.

---

## Python frameworks

### Flask

**Detected by:** `Flask` in `requirements.txt` or `pyproject.toml`.

Extracts:
- `@app.route('/path')` → `route`
- `@app.get('/path')`, `@app.post(...)` → `route`
- Blueprint routes: `@bp.route(...)` → `route`
- Class-based views (inheriting `MethodView`) → `view`

Flask path parameters (`<int:user_id>`) are preserved as-is.

### FastAPI

**Detected by:** `fastapi` in `requirements.txt` or `pyproject.toml`.

Extracts:
- `@app.get('/items/{id}')` → `route`
- `@router.post(...)` (APIRouter) → `route`

FastAPI path parameters (`{param}`) are preserved.

### Django

**Detected by:** `manage.py` at project root, or `django` in requirements.

Extracts:
- `models.Model` subclasses → `model`
- Class-based views (`APIView`, `ViewSet`, etc.) → `view`
- Function-based views (with `@login_required`, `@api_view`) → `view`
- `path(...)` / `re_path(...)` in `urls.py` → `route`
- `@receiver(post_save)` → `signal`

---

## Go frameworks

### Gin

**Detected by:** `github.com/gin-gonic/gin` in `go.mod`.

Extracts: `r.GET("/path", handler)`, `r.POST(...)`, etc. → `route`. Groups: `r.Group("/api")` prefix applied to child routes.

### Echo

**Detected by:** `github.com/labstack/echo` in `go.mod`.

Same pattern as Gin: `e.GET("/path", handler)` → `route`.

### Fiber

**Detected by:** `github.com/gofiber/fiber` in `go.mod`.

Title-case methods: `app.Get("/path", handler)` → `route`.

---

## PHP frameworks

### Laravel

**Detected by:** `laravel/framework` in `composer.json`.

Extracts:
- `Route::get('/path', ...)` → `route`
- `Route::resource('users', Controller::class)` → multiple CRUD routes
- `Route::group(['prefix' => '/api'], ...)` → prefix applied to children
- `User extends Model` → `model`
- Controller public methods → `view`
- Middleware classes → `middleware`

### Symfony

**Detected by:** `symfony/framework-bundle` in `composer.json`.

Extracts:
- `#[Route('/path', methods: ['GET'])]` → `route` (PHP 8 attributes)
- `@Route('/path')` in docblock → `route` (annotation style)

---

## Ruby frameworks

### Rails

**Detected by:** `gem 'rails'` in `Gemfile`.

Extracts:
- `ApplicationRecord` subclasses → `model` (with `has_many` associations)
- Controller public methods → `view` (action)
- `get '/path'`, `resources :users` in `routes.rb` → `route`

### Sinatra

**Detected by:** `gem 'sinatra'` in `Gemfile` or `require 'sinatra'` in source.

Extracts: `get '/path' do ... end` → `route`.

---

## Kotlin frameworks

### Ktor

**Detected by:** `io.ktor` in `build.gradle` / `pom.xml`.

Extracts from routing DSL:
- `get("/path") { ... }` → `route`
- `route("/api") { get("/users") }` → combined path `/api/users`
- `authenticate { ... }` → `frameworkMeta.authenticated: true`

### Spring (Kotlin)

**Detected by:** `org.springframework.boot` in `build.gradle` / `pom.xml`.

Extracts: `@RestController` + `@GetMapping("/path")` → `route`; `@Service`, `@Component`, `@Repository` → class with metadata.

### Android

**Detected by:** an `AndroidManifest.xml` anywhere in the tree, or `com.android.application` / `com.android.library` in a `build.gradle(.kts)` (bounded recursive scan). Handles `.kt`, `.java`, and `AndroidManifest.xml`.

Extracts:
- `@Composable` functions → `composable` (`frameworkMeta.android: 'compose'`; `@Preview` funs carry `preview: true`)
- Hilt/Dagger annotations → `frameworkMeta.di` (`@Module` role `module`; `@Provides`/`@Binds` role `provider` + `providedType`; `@Inject` constructor/field role `consumer` + `consumedTypes`; `@HiltViewModel` / `@AndroidEntryPoint` flags; scope annotations as `scope`)
- Manifest `<activity>`/`<service>`/`<receiver>`/`<provider>` → `route` (`frameworkMeta.android: 'manifest'`, with `component`, `exported`, `intentFilters`, `launcher`) — surfaced by `get_entry_points` as `android_component`, LAUNCHER first
- `frameworkMeta.gradleModule` on every symbol (`:app`, `:feature:login`, `:` = root) from the path before the first `src/` segment

At graph-build time, `frameworkMeta.di` produces `di` dependency edges (consumer file → provider file, specifier `di:<TypeName>`) — name-based matching, ambiguous names edge to all providers. `find_cycles` excludes `di` edges (the `@Binds` module ↔ impl pair is by design, not a cycle).

---

## Rust frameworks

### Axum

**Detected by:** `axum` in `Cargo.toml`.

Extracts: `.route("/path", get(handler))` chains → `route`. Layers: `.layer(...)` → `middleware`.

### Actix-web

**Detected by:** `actix-web` in `Cargo.toml`.

Extracts: `#[get("/path")]` attribute macro → `route`; `.wrap(...)` → `middleware`.

### Rocket

**Detected by:** `rocket` in `Cargo.toml`.

Extracts: `#[get("/path")]` → `route`; `#[catch(404)]` → error catcher; `Fairing` implementations → `middleware`.

---

## Java frameworks

### Spring Boot

**Detected by:** `spring-boot-starter` in `pom.xml` / `build.gradle`.

Extracts: `@GetMapping`, `@PostMapping` (combined with `@RequestMapping` prefix) → `route`; `@Service`, `@Component`, `@Repository` → beans; `@Bean` methods; `@Scheduled` methods → scheduled tasks.

### Micronaut

**Detected by:** `io.micronaut` in build files.

Extracts: `@Get("/path")`, `@Post(...)` → `route`; `@Client` interfaces.

### Quarkus

**Detected by:** `io.quarkus` in build files.

Extracts: JAX-RS `@GET` / `@Path` → `route`; `@ApplicationScoped` → bean.

---

## ORM adapters

### Hibernate (Java)

**Detected by:** `hibernate-core` or `jakarta.persistence` in dependencies.

Extracts from `@Entity` classes: table name, columns with types and nullability, relationships (`@OneToMany`, etc.), named queries.

### SQLAlchemy (Python)

**Detected by:** `sqlalchemy` in requirements.

Extracts from `Base` / `DeclarativeBase` subclasses: `__tablename__`, `Column(Type)` fields, `relationship()` associations, `@hybrid_property` methods. Supports both SQLAlchemy 1.x and 2.0 (`mapped_column`) styles.

### Django ORM

**Detected by:** Django project with `manage.py`.

Extracts `models.Model` subclasses with field types: `CharField`, `IntegerField`, `ForeignKey`, `ManyToManyField`, etc.

### Prisma

**Detected by:** `prisma` in `package.json` or `schema.prisma` present.

Extracts model definitions and relations from `schema.prisma`.

### TypeORM

**Detected by:** `typeorm` in `package.json`.

Extracts `@Entity` classes and `@Column` / `@Relation` fields.

---

## Mobile frameworks

### Flutter

**Detected by:** `sdk: flutter` in `pubspec.yaml`.

Extracts from `.dart` files:
- `StatelessWidget` subclasses → `widget`
- `StatefulWidget` subclasses → `widget` (with linked State class)
- `ChangeNotifier` subclasses → `class` with `flutter_notifier: true`

