import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// ─── Transport types ──────────────────────────────────────────────────────────

/**
 * Which MCP transport(s) to start.
 *   'stdio' — stdin/stdout (default; required for Claude Code integration)
 *   'http'  — HTTP + Streamable HTTP (for web clients and remote dev environments)
 *   'both'  — stdio AND HTTP simultaneously (useful for development)
 */
export type TransportMode = 'stdio' | 'http' | 'both';

/** Options passed through to the HTTP server when mode is 'http' or 'both'. */
export interface TransportOptions {
  port?: number;
  host?: string;
  corsOrigins?: string[];
}

// ─── HttpSseTransport ─────────────────────────────────────────────────────────

interface ManagedSession {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
}

/**
 * Manages stateful MCP-over-HTTP+SSE sessions for a shared server.
 *
 * Each agent session is an independent `StreamableHTTPServerTransport` +
 * `McpServer` pair, keyed by the `mcp-session-id` assigned during initialization.
 * Multiple agents can connect concurrently; their sessions are fully isolated.
 *
 * Protocol (Streamable HTTP):
 *   POST /mcp/sse (no session ID)    → initialize  → creates session, returns mcp-session-id
 *   POST /mcp/sse (with session ID)  → tool call   → routes to the correct session
 *   GET  /mcp/sse (with session ID)  → SSE stream  → server-initiated notifications
 *   DELETE /mcp/sse (with session ID) → close session
 *
 * Connect Claude Code:
 *   claude mcp add purecontext-remote \
 *     --transport http \
 *     --url https://your-server/mcp/sse \
 *     --header "Authorization: Bearer pctx_yourkey"
 */
export class HttpSseTransport {
  private readonly serverFactory: () => McpServer;
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(serverFactory: () => McpServer) {
    this.serverFactory = serverFactory;
  }

  /**
   * No-op: sessions are created on demand during initialization requests.
   * Call this once before the first handleRequest for API symmetry.
   */
  async init(): Promise<void> {
    // Sessions are created on demand.
  }

  /**
   * Route an HTTP request to the appropriate MCP session.
   *
   * - No `mcp-session-id` header (first request): create a new session.
   * - With `mcp-session-id` header: look up the existing session.
   *
   * Handles GET (SSE open), POST (tool calls), DELETE (close session).
   * Auth must be validated by the caller before this method is invoked.
   *
   * @param parsedBody Pre-parsed JSON body for POST requests; omit for GET/DELETE.
   */
  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId) {
      // Route to existing session
      const session = this.sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        }));
        return;
      }
      await session.transport.handleRequest(
        req,
        res,
        parsedBody as Record<string, unknown> | undefined,
      );
    } else {
      // New session — create a fresh transport + McpServer pair.
      // onsessioninitialized fires during handleRequest once the session ID is assigned.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          // Store immediately so subsequent requests can find this session.
          // mcpServer is already assigned (it's a const in the enclosing block).
          this.sessions.set(sid, { transport, mcpServer }); // eslint-disable-line @typescript-eslint/no-use-before-define
        },
        onsessionclosed: (sid) => {
          if (sid) this.sessions.delete(sid);
        },
      });

      const mcpServer = this.serverFactory();
      await mcpServer.connect(transport);
      await transport.handleRequest(
        req,
        res,
        parsedBody as Record<string, unknown> | undefined,
      );
    }
  }

  /** Close all active sessions and their underlying transports. */
  async close(): Promise<void> {
    const closings = Array.from(this.sessions.values()).map(async (s) => {
      await s.transport.close().catch(() => {});
      await s.mcpServer.close().catch(() => {});
    });
    await Promise.all(closings);
    this.sessions.clear();
  }
}
