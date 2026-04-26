import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../core/logger.js';
import { VERSION } from '../version.js';
import { getConfig } from '../config/config-loader.js';
import { startHttpServer } from './http-server.js';
import type { TransportMode } from './transport.js';
import { PureContextError } from '../core/errors.js';
import { track } from '../core/telemetry.js';

// ── Tool modules ──────────────────────────────────────────────────────────────
import * as indexFolderTool from './tools/index-folder.js';
import * as listReposTool from './tools/list-repos.js';
import * as resolveRepoTool from './tools/resolve-repo.js';
import * as searchSymbolsTool from './tools/search-symbols.js';
import * as getSymbolSourceTool from './tools/get-symbol-source.js';
import * as getFileOutlineTool from './tools/get-file-outline.js';
import * as getRepoOutlineTool from './tools/get-repo-outline.js';
import * as getFileTreeTool from './tools/get-file-tree.js';
import * as getContextBundleTool from './tools/get-context-bundle.js';
import * as getBlastRadiusTool from './tools/get-blast-radius.js';
import * as findImportersTool from './tools/find-importers.js';
import * as findDeadCodeTool from './tools/find-dead-code.js';
import * as searchTextTool from './tools/search-text.js';
import * as getLayerViolationsTool from './tools/get-layer-violations.js';
import * as indexRepoTool from './tools/index-repo.js';
import * as searchSemanticTool from './tools/search-semantic.js';
import * as getSavingsStatsTool from './tools/get-savings-stats.js';

// ─── Tool error handling ──────────────────────────────────────────────────────

/**
 * Convert a known PureContextError into a structured MCP error response so the
 * AI agent sees the userMessage instead of a raw exception or server crash.
 * Re-throws anything that is not a PureContextError (let the SDK handle it).
 */
/**
 * Bridge the SDK's untyped args (unknown) to a strongly-typed handler.
 * registerTool in SDK >=1.20 leaves the callback args as `unknown` unless
 * InputArgs is explicitly provided; this helper restores the concrete type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function typed(handler: (args: any) => CallToolResult | Promise<CallToolResult>) {
  return async (args: unknown): Promise<CallToolResult> => {
    try {
      return await handler(args);
    } catch (err) {
      return handleToolError(err);
    }
  };
}

function handleToolError(err: unknown): CallToolResult {
  if (err instanceof PureContextError) {
    const msg = err.userMessage ?? err.message;
    const detail = err.suggestion ? `\n\nSuggestion: ${err.suggestion}` : '';
    return {
      content: [{ type: 'text', text: msg + detail }],
      isError: true,
    };
  }
  throw err;
}

// ─── Server factory ───────────────────────────────────────────────────────────

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'purecontext-mcp',
    version: VERSION,
  });

  // ── Register tools ─────────────────────────────────────────────────────────
  //
  // Convention: each tool module exports:
  //   name:        string (the tool name)
  //   description: string
  //   inputSchema: Record<string, ZodType> (raw Zod shape — not z.object())
  //   handler:     function(args) => CallToolResult | Promise<CallToolResult>
  //

  server.registerTool(indexFolderTool.name, {
    description: indexFolderTool.description,
    inputSchema: indexFolderTool.inputSchema,
  }, typed((args) => indexFolderTool.handler(args)));

  server.registerTool(listReposTool.name, {
    description: listReposTool.description,
    inputSchema: listReposTool.inputSchema,
  }, typed(() => listReposTool.handler()));

  server.registerTool(resolveRepoTool.name, {
    description: resolveRepoTool.description,
    inputSchema: resolveRepoTool.inputSchema,
  }, typed((args) => resolveRepoTool.handler(args)));

  server.registerTool(searchSymbolsTool.name, {
    description: searchSymbolsTool.description,
    inputSchema: searchSymbolsTool.inputSchema,
  }, typed((args) => searchSymbolsTool.handler(args)));

  server.registerTool(getSymbolSourceTool.name, {
    description: getSymbolSourceTool.description,
    inputSchema: getSymbolSourceTool.inputSchema,
  }, typed((args) => getSymbolSourceTool.handler(args)));

  server.registerTool(getFileOutlineTool.name, {
    description: getFileOutlineTool.description,
    inputSchema: getFileOutlineTool.inputSchema,
  }, typed((args) => getFileOutlineTool.handler(args)));

  server.registerTool(getRepoOutlineTool.name, {
    description: getRepoOutlineTool.description,
    inputSchema: getRepoOutlineTool.inputSchema,
  }, typed((args) => getRepoOutlineTool.handler(args)));

  server.registerTool(getFileTreeTool.name, {
    description: getFileTreeTool.description,
    inputSchema: getFileTreeTool.inputSchema,
  }, typed((args) => getFileTreeTool.handler(args)));

  server.registerTool(getContextBundleTool.name, {
    description: getContextBundleTool.description,
    inputSchema: getContextBundleTool.inputSchema,
  }, typed((args) => getContextBundleTool.handler(args)));

  server.registerTool(getBlastRadiusTool.name, {
    description: getBlastRadiusTool.description,
    inputSchema: getBlastRadiusTool.inputSchema,
  }, typed((args) => getBlastRadiusTool.handler(args)));

  server.registerTool(findImportersTool.name, {
    description: findImportersTool.description,
    inputSchema: findImportersTool.inputSchema,
  }, typed((args) => findImportersTool.handler(args)));

  server.registerTool(findDeadCodeTool.name, {
    description: findDeadCodeTool.description,
    inputSchema: findDeadCodeTool.inputSchema,
  }, typed((args) => findDeadCodeTool.handler(args)));

  server.registerTool(searchTextTool.name, {
    description: searchTextTool.description,
    inputSchema: searchTextTool.inputSchema,
  }, typed((args) => searchTextTool.handler(args)));

  server.registerTool(getLayerViolationsTool.name, {
    description: getLayerViolationsTool.description,
    inputSchema: getLayerViolationsTool.inputSchema,
  }, typed((args) => getLayerViolationsTool.handler(args)));

  server.registerTool(indexRepoTool.name, {
    description: indexRepoTool.description,
    inputSchema: indexRepoTool.inputSchema,
  }, typed((args) => indexRepoTool.handler(args)));

  server.registerTool(searchSemanticTool.name, {
    description: searchSemanticTool.description,
    inputSchema: searchSemanticTool.inputSchema,
  }, typed((args) => searchSemanticTool.handler(args)));

  server.registerTool(getSavingsStatsTool.name, {
    description: getSavingsStatsTool.description,
    inputSchema: getSavingsStatsTool.inputSchema,
  }, typed((args) => getSavingsStatsTool.handler(args)));

  return server;
}

// ─── Start the server ─────────────────────────────────────────────────────────

export interface StartServerOptions {
  /** Override the transport mode from config. */
  transport?: TransportMode;
  /** Override the HTTP port from config. */
  port?: number;
}

export async function startServer(options: StartServerOptions = {}): Promise<void> {
  // Fire-and-forget telemetry on startup
  track({ event: 'server_start' }).catch(() => { /* silently ignored */ });

  const cfg = getConfig();
  const mode: TransportMode = options.transport ?? cfg.transport;
  const port = options.port ?? cfg.http.port;
  const { host, corsOrigins } = cfg.http;

  let stdioServer: McpServer | undefined;

  // ── stdio transport ───────────────────────────────────────────────────────
  if (mode === 'stdio' || mode === 'both') {
    stdioServer = createMcpServer();
    const transport = new StdioServerTransport();
    await stdioServer.connect(transport);
    logger.info('PureContext MCP server started (stdio)');
  }

  // ── HTTP transport ────────────────────────────────────────────────────────
  let httpServer: import('node:http').Server | undefined;
  if (mode === 'http' || mode === 'both') {
    httpServer = await startHttpServer({
      port,
      host,
      corsOrigins,
      auth: cfg.http.auth,
      rateLimit: cfg.rateLimit,
      serverFactory: createMcpServer,
    });
    // startHttpServer logs the listen address internally.
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async () => {
    logger.info('Shutting down...');
    httpServer?.close();
    if (stdioServer) await stdioServer.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
