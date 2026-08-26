/**
 * Worker thread entry point for parallel file parsing.
 *
 * Each worker maintains its own web-tree-sitter Parser instance — no shared
 * state, no mutex needed. Adapters are imported here so they self-register into
 * this worker's own adapter-registry instance.
 *
 * Protocol (main thread → worker):
 *   ParseJob       — process one file, respond with ParseResult
 *   ShutdownMsg    — graceful exit (worker calls process.exit)
 */

import { parentPort, isMainThread } from 'worker_threads';
import type { FrameworkAdapter, SymbolRecord, ImportRecord } from './types.js';
import { initParser, isInitialized } from './parse-dispatcher.js';
import { processFile } from './file-processor.js';
import { getRegisteredAdapters } from '../adapters/adapter-registry.js';
import { registerHandler } from '../handlers/handler-registry.js';

// ─── Language handler registration ────────────────────────────────────────────
// Workers have their own module instance — handlers must be registered here.
// (Unlike adapters, handlers don't self-register at module load time.)

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

registerHandler(typescriptHandler);
registerHandler(tsxHandler);
registerHandler(javascriptHandler);
registerHandler(pythonHandler);
registerHandler(goHandler);
registerHandler(rustHandler);
registerHandler(javaHandler);
registerHandler(csharpHandler);
registerHandler(phpHandler);
registerHandler(rubyHandler);
registerHandler(kotlinHandler);
registerHandler(cHandler);
registerHandler(cppHandler);
registerHandler(luaHandler);
registerHandler(dartHandler);
registerHandler(swiftHandler);
registerHandler(elixirHandler);
registerHandler(haskellHandler);
registerHandler(scalaHandler);
registerHandler(rHandler);
registerHandler(openApiHandler);
registerHandler(sqlHandler);
registerHandler(bashHandler);
registerHandler(perlHandler);
registerHandler(terraformHandler);
registerHandler(nixHandler);
registerHandler(protobufHandler);
registerHandler(graphqlHandler);
registerHandler(groovyHandler);
registerHandler(erlangHandler);
registerHandler(gleamHandler);
registerHandler(gdscriptHandler);
registerHandler(xmlHandler);
registerHandler(fortranHandler);
registerHandler(scssHandler);
registerHandler(lessHandler);
registerHandler(cssHandler);
registerHandler(objectiveCHandler);
registerHandler(hclHandler);
registerHandler(angularHtmlHandler);

// ─── Adapter self-registration ────────────────────────────────────────────────
// Workers have their own module instance — adapters must be imported here so
// they call registerAdapter() in *this* worker's registry.

import '../adapters/vue.js';
import '../adapters/nuxt.js';
import '../adapters/svelte.js';
import '../adapters/astro.js';
import '../adapters/react.js';
import '../adapters/nextjs.js';
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

// ─── Message types ─────────────────────────────────────────────────────────────

export interface ParseJob {
  relPath: string;
  /**
   * File content as Uint8Array. Sent via structured clone (not transferred) so
   * the main thread can still access the original Buffer for upsertFile.
   */
  content: Uint8Array;
  adapterNames: string[];
}

export interface ParseResult {
  relPath: string;
  symbols: SymbolRecord[];
  imports: ImportRecord[];
  /** Package the file declares (JVM languages) — see ProcessedResult.declaredPackage. */
  declaredPackage?: string | null;
  /** Set if an unrecoverable parse error occurred — worker stays alive. */
  error?: string;
}

interface ShutdownMsg {
  type: 'shutdown';
}

// ─── Worker entry point ───────────────────────────────────────────────────────

if (!isMainThread) {
  parentPort!.on('message', async (msg: ParseJob | ShutdownMsg) => {
    if ('type' in msg && msg.type === 'shutdown') {
      process.exit(0);
    }

    const job = msg as ParseJob;

    // Lazy-initialize parser on first message — one init per worker lifetime.
    if (!isInitialized()) {
      await initParser();
    }

    // Resolve adapters by name from this worker's self-registered registry.
    const allAdapters = getRegisteredAdapters();
    const adapters = job.adapterNames
      .map((name) => allAdapters.find((a) => a.name === name))
      .filter((a): a is FrameworkAdapter => a !== undefined);

    try {
      // Reconstruct a Buffer from the Uint8Array received via structured clone.
      const content = Buffer.from(job.content.buffer, job.content.byteOffset, job.content.byteLength);
      const { symbols, imports, declaredPackage } = await processFile(job.relPath, content, adapters);

      const result: ParseResult = { relPath: job.relPath, symbols, imports, declaredPackage };
      parentPort!.postMessage(result);
    } catch (err) {
      // Catch all errors so the worker stays alive for subsequent jobs.
      const result: ParseResult = {
        relPath: job.relPath,
        symbols: [],
        imports: [],
        error: err instanceof Error ? err.message : String(err),
      };
      parentPort!.postMessage(result);
    }
  });
}
