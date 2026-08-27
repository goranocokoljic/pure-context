/**
 * THE single registration list (Task 553).
 *
 * Handlers and adapters used to be registered in four separate hand-kept
 * lists — src/index.ts, this worker's sibling (indexing-worker.ts), and the
 * two benchmark-harness entry points — and they drifted exactly as the
 * Phase-75 lesson predicted (at extraction time: 41 / 41 / 40 / 21). Every
 * entry point now calls registerStandardHandlers(); adapters self-register
 * when this module is imported (their registration order is meaningful —
 * see the android comment below).
 *
 * Workers get their own module instance, so importing this file inside the
 * worker registers into the worker's own registries — no shared state.
 *
 * Also the public library surface (report Issue H): consumers who want to
 * drive indexFolder programmatically import { registerStandardHandlers }
 * from the package instead of side-effect-importing worker internals.
 */

import { registerHandler } from '../handlers/handler-registry.js';

import { typescriptHandler, tsxHandler } from '../handlers/typescript.js';
import { javascriptHandler } from '../handlers/javascript.js';
import { pythonHandler } from '../handlers/python.js';
import { goHandler } from '../handlers/go.js';
import { rustHandler } from '../handlers/rust.js';
import { javaHandler } from '../handlers/java.js';
import { csharpHandler } from '../handlers/csharp.js';
import { phpHandler } from '../handlers/php.js';
import { rubyHandler } from '../handlers/ruby.js';
import { kotlinHandler } from '../handlers/kotlin.js';
import { cHandler } from '../handlers/c.js';
import { cppHandler } from '../handlers/cpp.js';
import { luaHandler } from '../handlers/lua.js';
import { dartHandler } from '../handlers/dart.js';
import { swiftHandler } from '../handlers/swift.js';
import { elixirHandler } from '../handlers/elixir.js';
import { haskellHandler } from '../handlers/haskell.js';
import { scalaHandler } from '../handlers/scala.js';
import { rHandler } from '../handlers/r.js';
import { openApiHandler } from '../handlers/openapi.js';
import { sqlHandler } from '../handlers/sql.js';
import { bashHandler } from '../handlers/bash.js';
import { perlHandler } from '../handlers/perl.js';
import { terraformHandler } from '../handlers/terraform.js';
import { nixHandler } from '../handlers/nix.js';
import { protobufHandler } from '../handlers/protobuf.js';
import { graphqlHandler } from '../handlers/graphql.js';
import { groovyHandler } from '../handlers/groovy.js';
import { erlangHandler } from '../handlers/erlang.js';
import { gleamHandler } from '../handlers/gleam.js';
import { gdscriptHandler } from '../handlers/gdscript.js';
import { xmlHandler } from '../handlers/xml.js';
import { fortranHandler } from '../handlers/fortran.js';
import { scssHandler } from '../handlers/scss.js';
import { lessHandler } from '../handlers/less.js';
import { cssHandler } from '../handlers/css.js';
import { objectiveCHandler } from '../handlers/objective-c.js';
import { hclHandler } from '../handlers/hcl.js';
import { angularHtmlHandler } from '../handlers/angular-html.js';

// ─── Adapter self-registration (import order is the routing order) ───────────
import '../adapters/vue.js';
import '../adapters/nuxt.js';
import '../adapters/svelte.js';
import '../adapters/astro.js';
// nextjs BEFORE react — react's fileFilter claims every .tsx/.jsx, and every
// Next.js repo has react in deps; first matching adapter wins the file.
import '../adapters/nextjs.js';
import '../adapters/react.js';
// angular BEFORE nestjs — both claim `.service/.module/.guard/.pipe/
// .interceptor.ts`, and first matching adapter wins the file. On repos where
// BOTH are active (full-stack monorepos), angular therefore owns those
// suffixes; its extractFrameworkSymbols yields `[]` for files importing from
// '@nestjs/' so it never mislabels NestJS code (Phase 94, Task 587 / A-12) —
// but nestjs route/provider extraction does not run for such shadowed files.
import '../adapters/angular.js';
import '../adapters/nestjs.js';
import '../adapters/express.js';
import '../adapters/fastify.js';
import '../adapters/flask.js';
import '../adapters/fastapi.js';
import '../adapters/django.js';
import '../adapters/django-orm.js';
import '../adapters/gin.js';
import '../adapters/echo.js';
import '../adapters/fiber.js';
import '../adapters/laravel.js';
import '../adapters/symfony.js';
import '../adapters/rails.js';
import '../adapters/sinatra.js';
// android BEFORE the other JVM adapters — first matching adapter wins .kt/.java.
import '../adapters/android.js';
import '../adapters/spring-boot.js';
import '../adapters/spring-kotlin.js';
import '../adapters/micronaut.js';
import '../adapters/quarkus.js';
import '../adapters/hibernate.js';
import '../adapters/sqlalchemy.js';
import '../adapters/axum.js';
import '../adapters/actix-web.js';
import '../adapters/rocket.js';
import '../adapters/ktor.js';
import '../adapters/flutter.js';
import '../adapters/vapor.js';

const STANDARD_HANDLERS = [
  typescriptHandler,
  tsxHandler,
  javascriptHandler,
  pythonHandler,
  goHandler,
  rustHandler,
  javaHandler,
  csharpHandler,
  phpHandler,
  rubyHandler,
  kotlinHandler,
  cHandler,
  cppHandler,
  luaHandler,
  dartHandler,
  swiftHandler,
  elixirHandler,
  haskellHandler,
  scalaHandler,
  rHandler,
  openApiHandler,
  sqlHandler,
  bashHandler,
  perlHandler,
  terraformHandler,
  nixHandler,
  protobufHandler,
  graphqlHandler,
  groovyHandler,
  erlangHandler,
  gleamHandler,
  gdscriptHandler,
  xmlHandler,
  fortranHandler,
  scssHandler,
  lessHandler,
  objectiveCHandler,
  hclHandler,
  angularHtmlHandler,
];

/**
 * Register every standard language handler into this module instance's
 * registry. Idempotent (the registry dedupes). Adapters are registered as a
 * side effect of importing this module.
 *
 * `cssVariables`: the CSS handler is config-gated in the MCP entry point
 * (`indexing.cssVariables`, default off — CSS custom properties are opt-in
 * for discovery). Workers and the benchmark harness pass true (their
 * historical behavior); the main entry passes the config flag.
 */
export function registerStandardHandlers(options?: { cssVariables?: boolean }): void {
  for (const handler of STANDARD_HANDLERS) {
    registerHandler(handler);
  }
  if (options?.cssVariables !== false) {
    registerHandler(cssHandler);
  }
}
