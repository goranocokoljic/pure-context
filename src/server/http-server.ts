import { createServer, IncomingMessage, ServerResponse, Server as NodeHttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../core/logger.js';
import { QuotaExceededError } from '../core/errors.js';
import { VERSION } from '../version.js';
import { getIndexDir } from '../core/db/schema.js';
import { TokenBucketLimiter } from './rate-limiter.js';
import {
  ApiKeyValidator,
  extractApiKeyFromHeaders,
  validateFormat,
  getRequiredPermission,
  hasPermission,
  type AuthResult,
} from './auth/api-key.js';
import type { AdminApi } from './admin-api.js';
import type { HttpSseTransport } from './transport.js';
import { verifyGitHubSignature, parseGitHubPayload, extractChangedFiles } from './webhooks/github-webhook.js';
import { verifyGitLabToken, parseGitLabPayload, extractChangedFilesGitLab } from './webhooks/gitlab-webhook.js';
import {
  findRepoByFullName,
  findRepoByPath,
  isRateLimited,
  triggerIncrementalReindex,
  triggerAutoIndex,
} from './webhooks/webhook-utils.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 1_048_576; // 1 MB — guard against malformed / oversized requests
const SSE_KEEPALIVE_MS = 30_000;  // 30 s — prevents proxy/load-balancer timeouts on idle SSE streams

// ─── Options ──────────────────────────────────────────────────────────────────

export interface HttpAuthConfig {
  /** When true, require a Bearer token on all /mcp requests. */
  enabled: boolean;
  /** Expected Bearer token value. */
  token: string;
}

export interface RateLimitConfig {
  /** When true, rate limiting is applied to all MCP tool calls. */
  enabled: boolean;
  /** Maximum tokens a single client bucket can hold (burst capacity). */
  maxTokens: number;
  /** Tokens replenished per second. */
  refillRate: number;
  /** Token cost per tool name. Tools not listed cost 1 token. */
  perToolLimits: Record<string, number>;
}

export interface ApiKeyAuthConfig {
  /**
   * When true, require a valid API key on all /mcp requests.
   * Supersedes `auth` (bearer token) when enabled.
   */
  enabled: boolean;
  /** Validator instance backed by the auth database. */
  validator: ApiKeyValidator;
}

export interface AdminApiConfig {
  /** AdminApi instance. When present, /admin/* routes are enabled. */
  api: AdminApi;
}

export interface WebhookConfig {
  /** Enable /webhooks/* endpoints. Default: false. */
  enabled: boolean;
  /** HMAC secret for GitHub HMAC-SHA256 and GitLab plain-token verification. */
  secret: string;
  /** Optional allowlist of repo full names. Empty = all matched repos allowed. */
  allowedRepos: string[];
  /** Auto-index repos not yet indexed when a webhook arrives. Default: false. */
  autoIndex: boolean;
}

export interface HttpServerOptions {
  port: number;
  host: string;
  corsOrigins: string[];
  auth: HttpAuthConfig;
  /**
   * API key authentication (Task 97).
   * When present and enabled, replaces simple bearer token auth.
   */
  apiKeyAuth?: ApiKeyAuthConfig;
  /** Rate limiting config. When omitted, rate limiting is disabled. */
  rateLimit?: RateLimitConfig;
  /**
   * Admin API (Task 99).
   * When present, /admin/* routes are enabled (requires apiKeyAuth + admin permission).
   */
  adminApi?: AdminApiConfig;
  /** Called once per MCP request to produce a fresh McpServer instance (stateless mode). */
  serverFactory: () => McpServer;
  /**
   * Stateful SSE transport for team/server mode (Task 130).
   * When provided, enables the /mcp/sse endpoint where agents connect with
   * persistent sessions (GET → SSE stream, POST → tool calls).
   * Must already be initialised (init() called) before the first request.
   */
  sseTransport?: HttpSseTransport;
  /**
   * Whether to serve the built UI from dist/ui/ for non-API paths.
   * Defaults to true. Set to false in tests to avoid SPA fallback interfering
   * with 404 assertions.
   */
  serveUi?: boolean;
  /**
   * Webhook auto-reindex configuration.
   * When provided and enabled, registers /webhooks/github, /webhooks/gitlab,
   * and /webhooks/generic routes.
   */
  webhook?: WebhookConfig;
}

// ─── CORS ──────────────────────────────────────────────────────────────────────

/**
 * Match an origin against a list of patterns.
 * Patterns may contain `*` as a wildcard within a path segment (e.g. `http://localhost:*`).
 */
export function originAllowed(origin: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Escape regex special chars except *, then replace * with a segment wildcard
    const re = new RegExp(
      '^' +
        pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') +
        '$',
    );
    if (re.test(origin)) return true;
  }
  return false;
}

function setCorsHeaders(req: IncomingMessage, res: ServerResponse, corsOrigins: string[]): void {
  const origin = (req.headers['origin'] as string | undefined) ?? '';
  if (origin && originAllowed(origin, corsOrigins)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, last-event-id');
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Check the Authorization header against the configured bearer token.
 * Uses timing-safe comparison to prevent timing attacks.
 * Returns true if auth is disabled OR the token matches.
 */
export function checkAuth(req: IncomingMessage, auth: HttpAuthConfig): boolean {
  if (!auth.enabled) return true;

  const header = (req.headers['authorization'] as string | undefined) ?? '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;

  const provided = header.slice(prefix.length);
  if (!provided || !auth.token) return false;

  // Pad to same length before comparison to avoid length-based oracle
  try {
    const a = Buffer.from(provided.padEnd(auth.token.length, '\0'));
    const b = Buffer.from(auth.token.padEnd(provided.length, '\0'));
    // timingSafeEqual requires same-length buffers
    const maxLen = Math.max(a.length, b.length);
    const ba = Buffer.alloc(maxLen);
    const bb = Buffer.alloc(maxLen);
    a.copy(ba);
    b.copy(bb);
    return timingSafeEqual(ba, bb) && provided.length === auth.token.length;
  } catch {
    return false;
  }
}

// ─── Body reader ──────────────────────────────────────────────────────────────

export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ─── Rate limit helpers ────────────────────────────────────────────────────────

/**
 * Extract the MCP tool name from a parsed JSON-RPC request body.
 * Returns undefined for non-tool-call methods (e.g. initialize, list_tools).
 */
export function extractToolName(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (b['method'] !== 'tools/call') return undefined;
  const params = b['params'];
  if (typeof params !== 'object' || params === null) return undefined;
  const name = (params as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : undefined;
}

/**
 * Return the token cost for a tool call.
 * Falls back to 1 for tools not in the perToolLimits map.
 */
export function getToolCost(toolName: string | undefined, perToolLimits: Record<string, number>): number {
  if (toolName === undefined) return 1;
  return perToolLimits[toolName] ?? 1;
}

// ─── Health helpers ───────────────────────────────────────────────────────────

function getRepoCount(): number {
  const dir = getIndexDir();
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.db')).length;
  } catch {
    return 0;
  }
}

// ─── REST API ─────────────────────────────────────────────────────────────────

/**
 * Parse URL search params from a URL string that may include a query string.
 */
export function parseQuery(url: string): URLSearchParams {
  const idx = url.indexOf('?');
  return new URLSearchParams(idx >= 0 ? url.slice(idx + 1) : '');
}

/**
 * Match a URL pattern with named segments. Returns captured groups or null.
 * Pattern example: '/api/repos/:id/tree'
 */
export function matchRoute(url: string, pattern: string): Record<string, string> | null {
  const urlPath = url.split('?')[0];
  const patternParts = pattern.split('/');
  const urlParts = urlPath.split('/');
  if (patternParts.length !== urlParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    const u = urlParts[i];
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(u ?? '');
    } else if (p !== u) {
      return null;
    }
  }
  return params;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/**
 * The list-repos MCP tool returns `id` and `indexedAt` on each repo record, but the
 * REST API exposes them as `repoId` and `lastIndexed` (ISO string) for UI clients.
 */
function normalizeReposResponse(rawJson: string): string {
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const repos = parsed['repos'];
    if (Array.isArray(repos)) {
      parsed['repos'] = repos.map((repo: Record<string, unknown>) => {
        const out: Record<string, unknown> = { ...repo };
        if ('id' in out && !('repoId' in out)) {
          out['repoId'] = out['id'];
          delete out['id'];
        }
        if ('indexedAt' in out && !('lastIndexed' in out)) {
          const ts = out['indexedAt'];
          out['lastIndexed'] = typeof ts === 'number' ? new Date(ts).toISOString() : String(ts);
          delete out['indexedAt'];
        }
        return out;
      });
    }
    return JSON.stringify(parsed);
  } catch {
    return rawJson;
  }
}

/**
 * The search-symbols MCP tool returns `symbols` in its JSON, but the REST API
 * exposes them as `results` for consistency. Transform the raw tool JSON before
 * sending it to UI clients.
 */
function normalizeSearchResponse(rawJson: string): string {
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    if ('symbols' in parsed && !('results' in parsed)) {
      parsed['results'] = parsed['symbols'];
      delete parsed['symbols'];
    }
    return JSON.stringify(parsed);
  } catch {
    return rawJson;
  }
}

async function handleRestApi(
  _req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
): Promise<void> {
  if (method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const query = parseQuery(url);

  // GET /api/repos
  if (matchRoute(url, '/api/repos') !== null) {
    const { handler } = await import('./tools/list-repos.js');
    const result = handler();
    const text = result.content[0];
    if (text && text.type === 'text') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(normalizeReposResponse(text.text));
    } else {
      sendJson(res, 500, { error: 'Unexpected tool response' });
    }
    return;
  }

  // GET /api/repos/:id/tree
  const treeParams = matchRoute(url, '/api/repos/:id/tree');
  if (treeParams !== null) {
    const { handler } = await import('./tools/get-file-tree.js');
    const result = handler({ repoId: treeParams['id']! });
    const text = result.content[0];
    if (text && text.type === 'text') {
      if (result.isError) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
      }
      res.end(text.text);
    } else {
      sendJson(res, 500, { error: 'Unexpected tool response' });
    }
    return;
  }

  // GET /api/repos/:id/outline
  const outlineParams = matchRoute(url, '/api/repos/:id/outline');
  if (outlineParams !== null) {
    const { handler } = await import('./tools/get-repo-outline.js');
    const limitStr = query.get('limit');
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    const result = handler({ repoId: outlineParams['id']!, limit });
    const text = result.content[0];
    if (text && text.type === 'text') {
      if (result.isError) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
      }
      res.end(text.text);
    } else {
      sendJson(res, 500, { error: 'Unexpected tool response' });
    }
    return;
  }

  // GET /api/search (cross-repo: ?query=...&repoIds=id1,id2&...)
  if (url.split('?')[0] === '/api/search') {
    const q = query.get('query');
    if (!q) {
      sendJson(res, 400, { error: 'Missing required query parameter: query' });
      return;
    }
    const { handler } = await import('./tools/search-symbols.js');
    const repoIdsStr = query.get('repoIds');
    const repoIds = repoIdsStr ? repoIdsStr.split(',').filter(Boolean) : undefined;
    const limitStr = query.get('limit');
    const result = await handler({
      repoIds,
      query: q,
      kind: (query.get('kind') as Parameters<typeof handler>[0]['kind']) ?? undefined,
      filePath: query.get('filePath') ?? undefined,
      limit: limitStr ? parseInt(limitStr, 10) : undefined,
      mode: (query.get('mode') as Parameters<typeof handler>[0]['mode']) ?? undefined,
    });
    const text = result.content[0];
    if (text && text.type === 'text') {
      if (result.isError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
      }
      res.end(normalizeSearchResponse(text.text));
    } else {
      sendJson(res, 500, { error: 'Unexpected tool response' });
    }
    return;
  }

  // GET /api/repos/:id/search
  const searchParams = matchRoute(url, '/api/repos/:id/search');
  if (searchParams !== null) {
    const q = query.get('query');
    if (!q) {
      sendJson(res, 400, { error: 'Missing required query parameter: query' });
      return;
    }
    const { handler } = await import('./tools/search-symbols.js');
    const limitStr = query.get('limit');
    const result = await handler({
      repoId: searchParams['id']!,
      query: q,
      kind: (query.get('kind') as Parameters<typeof handler>[0]['kind']) ?? undefined,
      filePath: query.get('filePath') ?? undefined,
      limit: limitStr ? parseInt(limitStr, 10) : undefined,
      mode: (query.get('mode') as Parameters<typeof handler>[0]['mode']) ?? undefined,
    });
    const text = result.content[0];
    if (text && text.type === 'text') {
      if (result.isError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
      }
      res.end(normalizeSearchResponse(text.text));
    } else {
      sendJson(res, 500, { error: 'Unexpected tool response' });
    }
    return;
  }

  // GET /api/symbols/:id
  const symbolParams = matchRoute(url, '/api/symbols/:id');
  if (symbolParams !== null) {
    const repoId = query.get('repoId');
    if (!repoId) {
      sendJson(res, 400, { error: 'Missing required query parameter: repoId' });
      return;
    }
    const { handler } = await import('./tools/get-symbol-source.js');
    const result = handler({ repoId, symbolId: symbolParams['id']! });
    const text = result.content[0];
    if (text && text.type === 'text') {
      if (result.isError) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
      }
      res.end(text.text);
    } else {
      sendJson(res, 500, { error: 'Unexpected tool response' });
    }
    return;
  }

  // GET /api/repos/:id/file-outline
  const fileOutlineParams = matchRoute(url, '/api/repos/:id/file-outline');
  if (fileOutlineParams !== null) {
    const filePath = query.get('filePath');
    if (!filePath) {
      sendJson(res, 400, { error: 'Missing required query parameter: filePath' });
      return;
    }
    const { handler } = await import('./tools/get-file-outline.js');
    const result = handler({ repoId: fileOutlineParams['id']!, filePath });
    const text = result.content[0];
    if (text && text.type === 'text') {
      if (result.isError) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
      }
      res.end(text.text);
    } else {
      sendJson(res, 500, { error: 'Unexpected tool response' });
    }
    return;
  }

  // GET /api/repos/:id/graph
  const graphParams = matchRoute(url, '/api/repos/:id/graph');
  if (graphParams !== null) {
    const { handler } = await import('./tools/get-graph.js');
    const depthStr = query.get('depth');
    const limitStr2 = query.get('limit');
    const result = handler({
      repoId: graphParams['id']!,
      filePath: query.get('filePath') ?? undefined,
      depth: depthStr ? parseInt(depthStr, 10) : undefined,
      limit: limitStr2 ? parseInt(limitStr2, 10) : undefined,
    });
    const text = result.content[0];
    if (text && text.type === 'text') {
      if (result.isError) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
      }
      res.end(text.text);
    } else {
      sendJson(res, 500, { error: 'Unexpected tool response' });
    }
    return;
  }

  // GET /api/repos/:id/blast-radius?symbolId=...&depth=...
  const blastRadiusParams = matchRoute(url, '/api/repos/:id/blast-radius');
  if (blastRadiusParams !== null) {
    const symbolId = query.get('symbolId');
    if (!symbolId) {
      sendJson(res, 400, { error: 'Missing required query parameter: symbolId' });
      return;
    }
    const depthStr = query.get('depth');
    const depth = depthStr ? parseInt(depthStr, 10) : undefined;
    const t0 = Date.now();
    try {
      const { openDatabase } = await import('../core/db/schema.js');
      const { getBlastRadiusWithDepths } = await import('../graph/graph-traversal.js');
      const db = openDatabase(blastRadiusParams['id']!);
      const result = getBlastRadiusWithDepths(symbolId, blastRadiusParams['id']!, db, depth);
      db.close();
      if (!result) {
        sendJson(res, 404, { error: `Symbol not found: ${symbolId}` });
        return;
      }
      const payload = JSON.stringify({ ...result, _meta: { timingMs: Date.now() - t0 } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return;
  }

  // GET /api/repos/:id/coverage?symbolId=...
  const coverageParams = matchRoute(url, '/api/repos/:id/coverage');
  if (coverageParams !== null) {
    const symbolId = query.get('symbolId') ?? undefined;
    const t0 = Date.now();
    try {
      const { openDatabase } = await import('../core/db/schema.js');
      const { getSymbolCoverage, getAllCoverageForRepo } = await import('../core/test-mapper.js');
      const db = openDatabase(coverageParams['id']!);
      let payload: string;
      if (symbolId) {
        const mapping = getSymbolCoverage(coverageParams['id']!, symbolId, db);
        db.close();
        if (!mapping) {
          sendJson(res, 404, { error: `No coverage data for symbol: ${symbolId}` });
          return;
        }
        payload = JSON.stringify({ mapping, _meta: { timingMs: Date.now() - t0 } });
      } else {
        const mappings = getAllCoverageForRepo(coverageParams['id']!, db);
        db.close();
        payload = JSON.stringify({ mappings, _meta: { timingMs: Date.now() - t0 } });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return;
  }

  // GET /api/repos/:id/quality?scope=...
  const qualityParams = matchRoute(url, '/api/repos/:id/quality');
  if (qualityParams !== null) {
    const scope = query.get('scope') ?? undefined;
    const { handler } = await import('./tools/get-quality-metrics.js');
    const result = await handler({ repoId: qualityParams['id']!, scope, limit: 200 });
    const text = result.content[0];
    if (text && text.type === 'text') {
      if (result.isError) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
      }
      res.end(text.text);
    } else {
      sendJson(res, 500, { error: 'Unexpected tool response' });
    }
    return;
  }

  // GET /api/repos/:id/churn?scope=...&days=...
  const churnParams = matchRoute(url, '/api/repos/:id/churn');
  if (churnParams !== null) {
    const scope = query.get('scope') ?? undefined;
    const daysStr = query.get('days');
    const dayWindow = daysStr ? parseInt(daysStr, 10) : 90;
    const { handler } = await import('./tools/get-churn-metrics.js');
    const result = await handler({
      repoId: churnParams['id']!,
      scope,
      dayWindow,
      topN: 200,
      granularity: 'file',
    });
    const text = result.content[0];
    if (text && text.type === 'text') {
      if (result.isError) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
      }
      res.end(text.text);
    } else {
      sendJson(res, 500, { error: 'Unexpected tool response' });
    }
    return;
  }

  // GET /api/repos/:id/symbols/:symbolId/history?limit=...
  const symbolHistoryParams = matchRoute(url, '/api/repos/:id/symbols/:symbolId/history');
  if (symbolHistoryParams !== null) {
    const limitStr = query.get('limit');
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    const { handler } = await import('./tools/get-symbol-history.js');
    const result = await handler({
      repoId: symbolHistoryParams['id']!,
      symbolId: symbolHistoryParams['symbolId']!,
      limit,
    });
    const text = result.content[0];
    if (text && text.type === 'text') {
      if (result.isError) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
      }
      res.end(text.text);
    } else {
      sendJson(res, 500, { error: 'Unexpected tool response' });
    }
    return;
  }

  // GET /api/repos/:id/importers
  const importersParams = matchRoute(url, '/api/repos/:id/importers');
  if (importersParams !== null) {
    const filePath = query.get('filePath');
    if (!filePath) {
      sendJson(res, 400, { error: 'Missing required query parameter: filePath' });
      return;
    }
    const { handler } = await import('./tools/find-importers.js');
    const result = handler({ repoId: importersParams['id']!, filePath });
    const text = result.content[0];
    if (text && text.type === 'text') {
      if (result.isError) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
      }
      res.end(text.text);
    } else {
      sendJson(res, 500, { error: 'Unexpected tool response' });
    }
    return;
  }

  sendJson(res, 404, { error: 'API route not found' });
}

// ─── Static file serving ──────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Resolve path to the built UI directory. */
function getUiDir(): string {
  // In production:  dist/server/http-server.js  →  dist/server/ → dist/ → project root
  // In source/test: src/server/http-server.ts   →  src/server/  → src/  → project root
  // Either way, the compiled UI lives at <project root>/dist/ui/
  const __filename = fileURLToPath(import.meta.url);
  const projectRoot = resolvePath(__filename, '..', '..', '..');
  return join(projectRoot, 'dist', 'ui');
}

/**
 * Serve a static file from dist/ui/. Returns true if handled.
 * For SPA: unknown paths serve index.html.
 * Returns false immediately when serveUi is false.
 */
function serveStatic(_req: IncomingMessage, res: ServerResponse, url: string, serveUi: boolean): boolean {
  if (!serveUi) return false;
  const uiDir = getUiDir();
  if (!existsSync(uiDir)) return false; // UI not built — skip

  // Strip query string for file lookup
  const pathname = url.split('?')[0];
  const safePath = resolvePath(uiDir, '.' + pathname);

  // Path traversal guard
  if (!safePath.startsWith(uiDir)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return true;
  }

  let filePath = safePath;
  let stat;
  try {
    stat = statSync(filePath);
    if (stat.isDirectory()) {
      filePath = join(filePath, 'index.html');
      stat = statSync(filePath);
    }
  } catch {
    // File not found — SPA fallback to index.html
    filePath = join(uiDir, 'index.html');
    try {
      stat = statSync(filePath);
    } catch {
      return false; // No index.html either
    }
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
  });

  createReadStream(filePath).pipe(res);
  return true;
}

// ─── Webhook handler ──────────────────────────────────────────────────────────

async function handleWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  cfg: WebhookConfig,
): Promise<void> {
  // Read body first (needed for signature verification)
  let body: Buffer;
  try {
    body = await readBody(req, MAX_BODY_BYTES);
  } catch {
    sendJson(res, 400, { error: 'Failed to read request body' });
    return;
  }

  const path = url.split('?')[0];

  // ── GitHub push ─────────────────────────────────────────────────────────────
  if (path === '/webhooks/github') {
    const sig = req.headers['x-hub-signature-256'] as string | undefined;
    if (!verifyGitHubSignature(body, sig, cfg.secret)) {
      sendJson(res, 403, { error: 'Forbidden: invalid signature' });
      return;
    }

    const payload = parseGitHubPayload(body);
    if (!payload) {
      sendJson(res, 400, { error: 'Invalid GitHub push payload' });
      return;
    }

    const fullName = payload.repository.full_name;

    if (cfg.allowedRepos.length > 0 && !cfg.allowedRepos.includes(fullName)) {
      sendJson(res, 403, { error: `Forbidden: repo ${fullName} is not in allowedRepos` });
      return;
    }

    const repo = findRepoByFullName(fullName);
    if (!repo) {
      if (cfg.autoIndex) {
        // Auto-index not applicable without a local path — nothing to do
        sendJson(res, 202, { status: 'accepted', message: 'Repo not indexed locally; autoIndex requires a local clone' });
      } else {
        sendJson(res, 404, { error: `Repo not found: ${fullName}` });
      }
      return;
    }

    if (isRateLimited(repo.id)) {
      sendJson(res, 202, { status: 'accepted', message: 'Reindex skipped: rate limited (max 1/min per repo)' });
      return;
    }

    const { changedPaths, deletedPaths } = extractChangedFiles(payload);
    logger.info(`Webhook: incremental reindex triggered for ${fullName} (${repo.id})`);
    triggerIncrementalReindex(repo.id, changedPaths, deletedPaths, fullName);
    sendJson(res, 202, { status: 'accepted', repoId: repo.id });
    return;
  }

  // ── GitLab push ─────────────────────────────────────────────────────────────
  if (path === '/webhooks/gitlab') {
    const token = req.headers['x-gitlab-token'] as string | undefined;
    if (!verifyGitLabToken(token, cfg.secret)) {
      sendJson(res, 403, { error: 'Forbidden: invalid token' });
      return;
    }

    const payload = parseGitLabPayload(body);
    if (!payload) {
      sendJson(res, 400, { error: 'Invalid GitLab push payload' });
      return;
    }

    const fullName = payload.project.path_with_namespace;

    if (cfg.allowedRepos.length > 0 && !cfg.allowedRepos.includes(fullName)) {
      sendJson(res, 403, { error: `Forbidden: repo ${fullName} is not in allowedRepos` });
      return;
    }

    const repo = findRepoByFullName(fullName);
    if (!repo) {
      sendJson(res, 404, { error: `Repo not found: ${fullName}` });
      return;
    }

    if (isRateLimited(repo.id)) {
      sendJson(res, 202, { status: 'accepted', message: 'Reindex skipped: rate limited (max 1/min per repo)' });
      return;
    }

    const { changedPaths, deletedPaths } = extractChangedFilesGitLab(payload);
    logger.info(`Webhook: incremental reindex triggered for ${fullName} (${repo.id})`);
    triggerIncrementalReindex(repo.id, changedPaths, deletedPaths, fullName);
    sendJson(res, 202, { status: 'accepted', repoId: repo.id });
    return;
  }

  // ── Generic push ────────────────────────────────────────────────────────────
  if (path === '/webhooks/generic') {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON in request body' });
      return;
    }

    const repoPath = parsed['repoPath'];
    if (typeof repoPath !== 'string') {
      sendJson(res, 400, { error: 'Missing required field: repoPath (string)' });
      return;
    }

    const changedFiles = Array.isArray(parsed['changedFiles'])
      ? (parsed['changedFiles'] as string[]).filter((f) => typeof f === 'string')
      : [];
    const deletedFiles = Array.isArray(parsed['deletedFiles'])
      ? (parsed['deletedFiles'] as string[]).filter((f) => typeof f === 'string')
      : [];

    const repo = findRepoByPath(repoPath);
    if (!repo) {
      if (cfg.autoIndex) {
        logger.info(`Webhook: auto-indexing ${repoPath}`);
        triggerAutoIndex(repoPath);
        sendJson(res, 202, { status: 'accepted', message: 'Auto-indexing started' });
      } else {
        sendJson(res, 404, { error: `Repo not found: ${repoPath}` });
      }
      return;
    }

    if (isRateLimited(repo.id)) {
      sendJson(res, 202, { status: 'accepted', message: 'Reindex skipped: rate limited (max 1/min per repo)' });
      return;
    }

    logger.info(`Webhook: incremental reindex triggered for ${repoPath} (${repo.id})`);
    triggerIncrementalReindex(repo.id, changedFiles, deletedFiles, repoPath);
    sendJson(res, 202, { status: 'accepted', repoId: repo.id });
    return;
  }

  sendJson(res, 404, { error: 'Unknown webhook path' });
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

export function startHttpServer(options: HttpServerOptions): Promise<NodeHttpServer> {
  const startTime = Date.now();

  // Create a single limiter instance shared across all requests
  const rl = options.rateLimit;
  const limiter = (rl?.enabled ?? false)
    ? new TokenBucketLimiter({
        maxTokens: rl!.maxTokens,
        refillRate: rl!.refillRate,
      })
    : null;

  return new Promise((resolve, reject) => {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    const clientIp = req.socket.remoteAddress ?? 'unknown';

    logger.debug(`${method} ${url} from ${clientIp}`);

    setCorsHeaders(req, res, options.corsOrigins);

    // ── CORS preflight ──────────────────────────────────────────────────────
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Health check ────────────────────────────────────────────────────────
    if (url === '/health' && method === 'GET') {
      const body = JSON.stringify({
        status: 'ok',
        version: VERSION,
        repoCount: getRepoCount(),
        uptime: (Date.now() - startTime) / 1000,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    // ── MCP SSE endpoint (stateful sessions, for agent connections) ─────────
    if ((url === '/mcp/sse' || url.startsWith('/mcp/sse?')) && options.sseTransport) {
      // ── Authentication ─────────────────────────────────────────────────
      let authResult: AuthResult | null = null;

      if (options.apiKeyAuth?.enabled) {
        const apiKey = extractApiKeyFromHeaders(req.headers as Record<string, string | string[] | undefined>);

        if (apiKey === null) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: API key required (Authorization: Bearer or X-API-Key)' }));
          return;
        }
        if (!validateFormat(apiKey)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: invalid API key format' }));
          return;
        }
        authResult = await options.apiKeyAuth.validator.validate(apiKey);
        if (!authResult.valid) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: API key not found or revoked' }));
          return;
        }
      } else if (!checkAuth(req, options.auth)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      // ── POST-specific: body reading, permissions, rate limiting ────────
      let sseParsedBody: unknown;

      if (method === 'POST') {
        const contentLength = parseInt((req.headers['content-length'] as string | undefined) ?? '0', 10);
        if (!isNaN(contentLength) && contentLength > MAX_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request body too large' }));
          return;
        }

        try {
          const raw = await readBody(req, MAX_BODY_BYTES);
          sseParsedBody = JSON.parse(raw.toString('utf8'));
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Bad request: ${err}` }));
          }
          return;
        }

        const toolName = extractToolName(sseParsedBody);

        if (authResult !== null && toolName !== undefined) {
          const required = getRequiredPermission(toolName);
          if (!hasPermission(authResult, required)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: `Forbidden: '${required}' permission required for ${toolName}`,
            }));
            return;
          }
        }

        if (limiter !== null) {
          const rateLimitKey = authResult?.tenantId ? `tenant:${authResult.tenantId}` : clientIp;
          const cost = getToolCost(toolName, rl!.perToolLimits);
          const rlResult = limiter.tryConsume(rateLimitKey, cost);
          if (!rlResult.allowed) {
            const retryAfterSec = Math.ceil(rlResult.retryAfterMs / 1000);
            res.writeHead(429, {
              'Content-Type': 'application/json',
              'Retry-After': String(retryAfterSec),
              'X-RateLimit-Limit': String(rl!.maxTokens),
              'X-RateLimit-Remaining': String(rlResult.remainingTokens),
            });
            res.end(JSON.stringify({ error: 'Too Many Requests', retryAfterMs: rlResult.retryAfterMs }));
            return;
          }
        }
      }

      // ── Keepalive pings for GET (SSE) connections ──────────────────────
      // Writes a comment line every 30 s to prevent proxy/LB connection timeouts.
      if (method === 'GET') {
        const keepaliveTimer = setInterval(() => {
          if (!res.writableEnded) {
            res.write(': ping\n\n');
          } else {
            clearInterval(keepaliveTimer);
          }
        }, SSE_KEEPALIVE_MS);
        res.on('close', () => clearInterval(keepaliveTimer));
      }

      try {
        await options.sseTransport.handleRequest(req, res, sseParsedBody);
      } catch (err) {
        logger.warn(`MCP SSE request error: ${err}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }));
        }
      }
      return;
    }

    // ── MCP endpoint (Streamable HTTP, stateless per-request) ───────────────
    if (url === '/mcp') {
      if (method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed. Use POST for MCP requests.' }));
        return;
      }

      // ── Authentication ───────────────────────────────────────────────────
      let authResult: AuthResult | null = null;

      if (options.apiKeyAuth?.enabled) {
        // API key authentication (Task 97) — supersedes simple bearer token
        const apiKey = extractApiKeyFromHeaders(req.headers as Record<string, string | string[] | undefined>);

        if (apiKey === null) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: API key required (Authorization: Bearer or X-API-Key)' }));
          return;
        }

        // Fast format check before any DB access
        if (!validateFormat(apiKey)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: invalid API key format' }));
          return;
        }

        // Full DB validation
        authResult = await options.apiKeyAuth.validator.validate(apiKey);
        if (!authResult.valid) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: API key not found or revoked' }));
          return;
        }
      } else {
        // Legacy bearer token authentication
        if (!checkAuth(req, options.auth)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      // Reject oversized requests before reading body
      const contentLength = parseInt((req.headers['content-length'] as string | undefined) ?? '0', 10);
      if (!isNaN(contentLength) && contentLength > MAX_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        return;
      }

      let body: unknown;
      try {
        const raw = await readBody(req, MAX_BODY_BYTES);
        body = JSON.parse(raw.toString('utf8'));
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Bad request: ${err}` }));
        }
        return;
      }

      // Extract tool name once — used by both permission check and rate limiting
      const toolName = extractToolName(body);

      // ── Permission check (API key auth only) ─────────────────────────────
      if (authResult !== null && toolName !== undefined) {
        const required = getRequiredPermission(toolName);
        if (!hasPermission(authResult, required)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: `Forbidden: '${required}' permission required for ${toolName}`,
          }));
          return;
        }
      }

      // ── Rate limiting ────────────────────────────────────────────────────
      if (limiter !== null) {
        // Prefer tenant ID as rate-limit key when authenticated; fall back to IP
        const rateLimitKey = authResult?.tenantId ? `tenant:${authResult.tenantId}` : clientIp;
        const cost = getToolCost(toolName, rl!.perToolLimits);
        const result = limiter.tryConsume(rateLimitKey, cost);

        if (!result.allowed) {
          const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': String(retryAfterSec),
            'X-RateLimit-Limit': String(rl!.maxTokens),
            'X-RateLimit-Remaining': String(result.remainingTokens),
          });
          res.end(JSON.stringify({
            error: 'Too Many Requests',
            retryAfterMs: result.retryAfterMs,
          }));
          logger.debug(`Rate limit exceeded for ${rateLimitKey} (tool: ${toolName ?? 'unknown'})`);
          options.adminApi?.api.logRequest({
            timestamp: new Date().toISOString(),
            tenantId: authResult?.tenantId ?? null,
            tool: toolName ?? '__unknown__',
            durationMs: 0,
            status: 'rate_limited',
            errorMessage: null,
          });
          return;
        }
      }

      // Each request gets a fresh McpServer + transport (stateless mode)
      const mcpServer = options.serverFactory();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcpStart = Date.now();

      try {
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, body);

        options.adminApi?.api.logRequest({
          timestamp: new Date().toISOString(),
          tenantId: authResult?.tenantId ?? null,
          tool: toolName ?? '__unknown__',
          durationMs: Date.now() - mcpStart,
          status: 'success',
          errorMessage: null,
        });

        res.on('close', () => {
          transport.close().catch(() => {});
          mcpServer.close().catch(() => {});
        });
      } catch (err) {
        logger.warn(`MCP request error: ${err}`);
        options.adminApi?.api.logRequest({
          timestamp: new Date().toISOString(),
          tenantId: authResult?.tenantId ?? null,
          tool: toolName ?? '__unknown__',
          durationMs: Date.now() - mcpStart,
          status: 'error',
          errorMessage: String(err),
        });
        if (!res.headersSent) {
          if (err instanceof QuotaExceededError) {
            res.writeHead(507, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'Insufficient Storage',
                tenantId: err.tenantId,
                quotaBytes: err.quotaBytes,
                usedBytes: err.usedBytes,
                requestedBytes: err.requestedBytes,
              }),
            );
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null,
              }),
            );
          }
        }
      }
      return;
    }

    // ── Admin API ────────────────────────────────────────────────────────────
    if (url.startsWith('/admin') && options.adminApi) {
      // Admin routes require API key authentication
      if (!options.apiKeyAuth?.enabled) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: admin API requires API key authentication' }));
        return;
      }

      const adminApiKey = extractApiKeyFromHeaders(
        req.headers as Record<string, string | string[] | undefined>,
      );
      if (adminApiKey === null || !validateFormat(adminApiKey)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: valid API key required' }));
        return;
      }

      const adminAuth = await options.apiKeyAuth.validator.validate(adminApiKey);
      if (!adminAuth.valid) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: API key not found or revoked' }));
        return;
      }

      if (!hasPermission(adminAuth, 'admin')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: admin permission required' }));
        return;
      }

      await options.adminApi.api.handle(req, res, adminAuth);
      return;
    }

    // ── Webhook endpoints ────────────────────────────────────────────────────
    if (url.startsWith('/webhooks/') && method === 'POST' && options.webhook?.enabled) {
      await handleWebhook(req, res, url, options.webhook);
      return;
    }

    // ── REST API for web UI ──────────────────────────────────────────────────
    if (url.startsWith('/api/')) {
      // Apply the same API key auth as the MCP endpoint when apiKeyAuth is enabled
      if (options.apiKeyAuth?.enabled) {
        const apiKey = extractApiKeyFromHeaders(req.headers as Record<string, string | string[] | undefined>);
        if (apiKey === null || !validateFormat(apiKey)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: API key required (Authorization: Bearer pctx_...)' }));
          return;
        }
        const auth = await options.apiKeyAuth.validator.validate(apiKey);
        if (!auth.valid) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden: invalid or revoked API key' }));
          return;
        }
      }
      await handleRestApi(req, res, url, method);
      return;
    }

    // ── Static UI assets ─────────────────────────────────────────────────────
    {
      const served = serveStatic(req, res, url, options.serveUi ?? true);
      if (served) return;
    }

    // ── 404 ─────────────────────────────────────────────────────────────────
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(options.port, options.host, () => {
    const addr = server.address() as { port: number };
    logger.info(`PureContext MCP listening on http://${options.host}:${addr.port}`);
    resolve(server);
  });

  server.on('error', reject);
  }); // end Promise
}
