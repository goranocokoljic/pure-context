#!/usr/bin/env node
/**
 * PureContext MCP — entry point.
 *
 * Usage:
 *   purecontext-mcp                    Start the MCP server (stdio transport)
 *   purecontext-mcp config             Show effective configuration
 *   purecontext-mcp config --init      Generate ~/.purecontext/config.json
 *   purecontext-mcp config --check     Validate config + check prerequisites
 *   purecontext-mcp --version / -v     Print version and exit
 *   purecontext-mcp --help / -h        Print usage and exit
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { logger } from './core/logger.js';
import { initParser } from './core/parse-dispatcher.js';
import { registerHandler } from './handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from './handlers/typescript.js';
import { javascriptHandler } from './handlers/javascript.js';
import { pythonHandler } from './handlers/python.js';
import { goHandler } from './handlers/go.js';
import { rustHandler } from './handlers/rust.js';
import { javaHandler } from './handlers/java.js';
import { csharpHandler } from './handlers/csharp.js';
import { phpHandler } from './handlers/php.js';
import { rubyHandler } from './handlers/ruby.js';
import { kotlinHandler } from './handlers/kotlin.js';
import { cHandler } from './handlers/c.js';
import { cppHandler } from './handlers/cpp.js';
import { luaHandler } from './handlers/lua.js';
import { dartHandler } from './handlers/dart.js';
import { swiftHandler } from './handlers/swift.js';
import { elixirHandler } from './handlers/elixir.js';
import { haskellHandler } from './handlers/haskell.js';
import { scalaHandler } from './handlers/scala.js';
import { rHandler } from './handlers/r.js';
// Framework adapters — imported for side-effect self-registration
import './adapters/vue.js';
import './adapters/nuxt.js';
import './adapters/react.js';
import './adapters/nextjs.js';
import './adapters/angular.js';
import './adapters/nestjs.js';
import './adapters/express.js';
import './adapters/fastify.js';
import './adapters/flask.js';
import './adapters/fastapi.js';
import './adapters/django.js';
import './adapters/gin.js';
import './adapters/echo.js';
import './adapters/fiber.js';
import './adapters/laravel.js';
import './adapters/symfony.js';
import './adapters/rails.js';
import './adapters/sinatra.js';
import './adapters/ktor.js';
import './adapters/spring-kotlin.js';
import './adapters/flutter.js';
import './adapters/vapor.js';
import './adapters/axum.js';
import './adapters/actix-web.js';
import './adapters/rocket.js';
import './adapters/spring-boot.js';
import './adapters/micronaut.js';
import './adapters/quarkus.js';
import './adapters/hibernate.js';
import './adapters/sqlalchemy.js';
import './adapters/django-orm.js';
import { startServer } from './server/mcp-server.js';
import { cmdInit, cmdCheck, cmdShow, cmdHealth } from './config/cli.js';
import { runKeysCommand } from './config/keys-cli.js';
import { runWorkspacesCommand } from './config/workspaces-cli.js';
import { VERSION } from './version.js';
import { PureContextError, formatErrorBox } from './core/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const require = createRequire(import.meta.url);
const pkg = require(resolve(__dirname, '../package.json')) as { name: string };
const NAME = pkg.name;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function printHelp(): void {
  process.stdout.write(`
${NAME} v${VERSION} — token-efficient source code navigation for AI agents

Usage:
  purecontext-mcp                         Start the MCP server (stdio)
  purecontext-mcp --server                Start as a shared HTTP server (team mode)
  purecontext-mcp --server --port 3001    Override HTTP port
  purecontext-mcp --server --host 0.0.0.0 Bind to all interfaces
  purecontext-mcp --server --no-auth      Disable auth (local testing only)
  purecontext-mcp --transport http        Start HTTP/SSE server on port 3000
  purecontext-mcp --transport both        Start stdio AND HTTP simultaneously
  purecontext-mcp config                  Show effective configuration
  purecontext-mcp config --init           Generate default config file
  purecontext-mcp config --check          Validate config and prerequisites
  purecontext-mcp keys create             Create an API key for HTTP access
  purecontext-mcp keys list               List tenants and API keys
  purecontext-mcp keys revoke <prefix>    Revoke an API key
  purecontext-mcp workspaces list         List workspaces
  purecontext-mcp workspaces create --name   Create a workspace
  purecontext-mcp --version               Print version
  purecontext-mcp --help                  Print this help

Environment variables:
  PCTX_ADMIN_KEY    Admin key for /admin/* endpoints
  PCTX_DATA_DIR     Override data directory (default: ~/.purecontext)
  PCTX_PORT         Override HTTP port
  PCTX_HOST         Override HTTP host

Claude Code integration:
  claude mcp add purecontext-mcp -- npx purecontext-mcp
`.trimStart());
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  // Register all language handlers before any indexing can happen
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

  // Initialise tree-sitter (loads WASM runtime + grammars lazily on first use)
  await initParser();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ── Version / help / health flags (before bootstrap) ────────────────────
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${NAME} v${VERSION}\n`);
    process.exit(0);
  }

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  if (args.includes('--health')) {
    const ok = cmdHealth();
    process.exit(ok ? 0 : 1);
  }

  // ── keys sub-command ─────────────────────────────────────────────────────
  if (args[0] === 'keys') {
    runKeysCommand(args.slice(1));
    // runKeysCommand handles process.exit() internally for synchronous paths;
    // for async paths (keys list) it calls .then(() => process.exit(0))
    return;
  }

  // ── workspaces sub-command ────────────────────────────────────────────────
  if (args[0] === 'workspaces') {
    runWorkspacesCommand(args.slice(1));
    return;
  }

  // ── config sub-command ────────────────────────────────────────────────────
  if (args[0] === 'config') {
    const flag = args[1];

    if (flag === '--init') {
      await cmdInit();
      process.exit(0);
    }

    if (flag === '--check') {
      // --check needs grammars path, which requires bootstrap
      await bootstrap();
      const ok = cmdCheck();
      process.exit(ok ? 0 : 1);
    }

    // Default: show effective config (no bootstrap needed)
    cmdShow();
    process.exit(0);
  }

  // ── Parse server flags ────────────────────────────────────────────────────
  const serverMode = args.includes('--server');
  const noAuth = args.includes('--no-auth');

  const knownServerFlags = new Set(['--transport', '--port', '--host']);
  const knownBoolFlags = new Set(['--server', '--no-auth']);
  const remainingArgs = args.filter((a, i) => {
    // Drop known bool flags
    if (knownBoolFlags.has(a)) return false;
    // Drop known value flags and their values
    if (knownServerFlags.has(a)) return false;
    if (i > 0 && knownServerFlags.has(args[i - 1])) return false;
    return true;
  });

  // ── Unknown sub-command ───────────────────────────────────────────────────
  if (remainingArgs.length > 0) {
    process.stderr.write(`Unknown command: ${remainingArgs[0]}\n`);
    process.stderr.write(`Run 'purecontext-mcp --help' for usage.\n`);
    process.exit(1);
  }

  // ── Resolve flags ─────────────────────────────────────────────────────────
  const transportIdx = args.indexOf('--transport');
  const transportFlag = transportIdx >= 0 ? args[transportIdx + 1] : undefined;

  const portIdx = args.indexOf('--port');
  const portRaw = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : undefined;
  const portFlag = portRaw !== undefined && !isNaN(portRaw) ? portRaw : undefined;

  const hostIdx = args.indexOf('--host');
  const hostFlag = hostIdx >= 0 ? args[hostIdx + 1] : undefined;

  // --server implies HTTP transport; defaults host to 0.0.0.0 for team use
  const effectiveTransport = serverMode
    ? 'http'
    : (transportFlag as import('./server/transport.js').TransportMode | undefined);

  const effectiveHost = serverMode
    ? (hostFlag ?? '0.0.0.0')
    : hostFlag;

  // --server enables auth by default; --no-auth disables it (dev only)
  const effectiveRequireAuth = serverMode ? !noAuth : undefined;

  try {
    await bootstrap();
    logger.info(`${NAME} v${VERSION} starting`);

    // Print a startup hint only when running in an interactive terminal.
    // stdin.isTTY is undefined when piped — writing to stdout when piped
    // would corrupt the MCP stdio protocol stream. Always use stderr here.
    if (!serverMode && process.stdin.isTTY) {
      process.stderr.write(
        `${NAME} v${VERSION} — ready for MCP connections (stdio)\n` +
          `Run with --help for usage, --health to verify installation.\n`,
      );
    }

    await startServer({
      transport: effectiveTransport,
      port: portFlag,
      host: effectiveHost,
      requireAuth: effectiveRequireAuth,
      serverMode,
    });
  } catch (err) {
    printFatalError(err);
    process.exit(1);
  }
}

function printFatalError(err: unknown): void {
  if (err instanceof PureContextError && err.userMessage) {
    process.stderr.write(formatErrorBox(err.userMessage, err.suggestion ?? '') + '\n');
  } else {
    process.stderr.write(
      'Unexpected error — please report this at https://github.com/gococ/purecontext-mcp/issues\n',
    );
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n');
    } else {
      process.stderr.write(String(err) + '\n');
    }
  }
}

main().catch((err) => {
  printFatalError(err);
  process.exit(1);
});
