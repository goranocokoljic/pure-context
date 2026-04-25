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
