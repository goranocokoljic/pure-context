/**
 * Phase 3 integration tests — Task 32.
 *
 * Validates the full Phase 3 pipeline:
 *   1.  Python: class, methods, and functions extracted
 *   2.  Python: docstring captured from auth.py
 *   3.  Python: @decorator functions extracted with correct name
 *   4.  Go: exported symbols extracted, unexported symbols skipped
 *   5.  Go: method name includes receiver type (e.g. AuthService.Login)
 *   6.  Go: docstring captured from preceding // comments
 *   7.  Next.js: Pages Router dynamic route /blog/:slug produced
 *   8.  Next.js: App Router route /dashboard with router: 'app'
 *   9.  Next.js: app/api/users/route.ts produces two route symbols (GET and POST)
 *   10. Next.js: src/components/Button.tsx produces kind 'component' (React adapter)
 *   11. search_text: literal match returns correct line number and context
 *   12. search_text: invalid regex returns error, no crash
 *   13. get_layer_violations: PureContext repo with default layers → zero violations
 *   14. HTTP transport: send MCP list-tools message → valid response
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { request as httpRequest } from 'node:http';
import type { Server as NodeHttpServer } from 'node:http';

import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase, computeRepoId } from '../../src/core/db/schema.js';
import { searchSymbols, getSymbolsByRepo } from '../../src/core/db/symbol-store.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { pythonHandler } from '../../src/handlers/python.js';
import { goHandler } from '../../src/handlers/go.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { reactAdapter } from '../../src/adapters/react.js';
import { nextjsAdapter } from '../../src/adapters/nextjs.js';
import { _resetForTesting as resetAdapters } from '../../src/adapters/adapter-registry.js';
import { handler as searchTextHandler } from '../../src/server/tools/search-text.js';
import { handler as layerViolationsHandler } from '../../src/server/tools/get-layer-violations.js';
import { startHttpServer } from '../../src/server/http-server.js';
import { createMcpServer } from '../../src/server/mcp-server.js';

// ─── Fixture paths ────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PYTHON_FIXTURE  = resolve(__dirname, '../fixtures/python-project');
const GO_FIXTURE      = resolve(__dirname, '../fixtures/go-project');
const NEXTJS_FIXTURE  = resolve(__dirname, '../fixtures/nextjs-project');
const PURECONTEXT_ROOT   = resolve(__dirname, '../..');

// ─── Shared state ─────────────────────────────────────────────────────────────

let pythonRepoId: string;
let goRepoId: string;
let nextjsRepoId: string;

// ─── Global setup ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  resetAdapters();

  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  registerHandler(pythonHandler);
  registerHandler(goHandler);

  await initParser();

  const [pythonResult, goResult, nextjsResult] = await Promise.all([
    indexFolder(PYTHON_FIXTURE, { fileLimit: 50 }),
    indexFolder(GO_FIXTURE, { fileLimit: 50 }),
    indexFolder(NEXTJS_FIXTURE, {
      fileLimit: 50,
      adapters: [reactAdapter, nextjsAdapter],
    }),
  ]);

  pythonRepoId = pythonResult.repoId;
  goRepoId     = goResult.repoId;
  nextjsRepoId = nextjsResult.repoId;
}, 60_000);

afterAll(() => {
  deleteIndex(pythonRepoId);
  deleteIndex(goRepoId);
  deleteIndex(nextjsRepoId);
});

// ─────────────────────────────────────────────────────────────────────────────
// Python
// ─────────────────────────────────────────────────────────────────────────────

describe('Python — symbol extraction', () => {
  it('1. extracts class, methods, and functions from python-project', () => {
    const db = openDatabase(pythonRepoId);
    const all = getSymbolsByRepo(db, pythonRepoId);
    db.close();

    const kinds = new Set(all.map((s) => s.kind));
    expect(kinds).toContain('class');
    expect(kinds).toContain('method');
    expect(kinds).toContain('function');

    // Spot-check: AuthService class exists
    const authServiceClass = all.find((s) => s.name === 'AuthService' && s.kind === 'class');
    expect(authServiceClass).toBeDefined();

    // Spot-check: login method exists
    const loginMethod = all.find((s) => s.name === 'AuthService.login' && s.kind === 'method');
    expect(loginMethod).toBeDefined();
    expect(loginMethod!.startByte).toBeGreaterThan(0);
    expect(loginMethod!.endByte).toBeGreaterThan(loginMethod!.startByte);
  });

  it('2. captures docstring from AuthService', () => {
    const db = openDatabase(pythonRepoId);
    const all = getSymbolsByRepo(db, pythonRepoId);
    db.close();

    const authService = all.find((s) => s.name === 'AuthService' && s.kind === 'class');
    expect(authService).toBeDefined();
    expect(authService!.summary).toBeTruthy();
    expect(authService!.summary).not.toMatch(/^def |^class /);
    // The docstring says "Service for handling user authentication"
    expect(authService!.summary.toLowerCase()).toContain('auth');
  });

  it('3. extracts @decorator functions with the inner function name', () => {
    const db = openDatabase(pythonRepoId);
    const all = getSymbolsByRepo(db, pythonRepoId);
    db.close();

    // AuthService.from_env is a @classmethod — should appear under that name
    const fromEnv = all.find((s) => s.name === 'AuthService.from_env');
    expect(fromEnv).toBeDefined();
    expect(fromEnv!.kind).toBe('method');

    // AuthService.validate_username is a @staticmethod
    const validateUsername = all.find((s) => s.name === 'AuthService.validate_username');
    expect(validateUsername).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Go
// ─────────────────────────────────────────────────────────────────────────────

describe('Go — symbol extraction', () => {
  it('4. extracts exported symbols and marks unexported ones (Phase 84)', () => {
    const db = openDatabase(goRepoId);
    const all = getSymbolsByRepo(db, goRepoId);
    db.close();

    // Exported symbols should be present, with no visibility metadata
    expect(all.find((s) => s.name === 'NewAuthService')).toBeDefined();
    expect(all.find((s) => s.name === 'GetSecretFromEnv')).toBeDefined();
    expect(all.find((s) => s.name === 'Run')).toBeDefined();
    expect(
      (all.find((s) => s.name === 'NewAuthService')?.frameworkMeta as Record<string, unknown>
        | undefined)?.visibility,
    ).toBeUndefined();

    // Unexported symbols ARE indexed since Phase 84, with visibility recorded
    const privateHelper = all.find((s) => s.name === 'privateHelper');
    expect(privateHelper).toBeDefined();
    expect(privateHelper?.frameworkMeta).toMatchObject({ visibility: 'unexported' });
  });

  it('5. method uses bare name (receiver type in signature)', () => {
    const db = openDatabase(goRepoId);
    const all = getSymbolsByRepo(db, goRepoId);
    db.close();

    // Phase 46: Go methods now store bare names (not qualified ReceiverType.MethodName)
    // Multiple Login methods exist (interface + struct) — verify at least one is indexed
    const loginMethods = all.filter((s) => s.kind === 'method' && s.name === 'Login');
    expect(loginMethods.length).toBeGreaterThanOrEqual(1);
    // The struct method's signature includes the func keyword and receiver
    const structLogin = loginMethods.find((s) => s.signature.includes('func ('));
    expect(structLogin).toBeDefined();
    expect(structLogin!.signature).toContain('Login');

    const logoutMethods = all.filter((s) => s.kind === 'method' && s.name === 'Logout');
    expect(logoutMethods.length).toBeGreaterThanOrEqual(1);

    // User model methods — bare names
    const displayName = all.find((s) => s.kind === 'method' && s.name === 'DisplayName');
    expect(displayName).toBeDefined();
  });

  it('6. captures docstring from preceding // comments', () => {
    const db = openDatabase(goRepoId);
    const all = getSymbolsByRepo(db, goRepoId);
    db.close();

    // NewAuthService has: "// NewAuthService creates a new AuthService with the given secret."
    const newAuthService = all.find((s) => s.name === 'NewAuthService');
    expect(newAuthService).toBeDefined();
    expect(newAuthService!.summary).toBeTruthy();
    expect(newAuthService!.summary.toLowerCase()).toMatch(/new|creat|auth/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Next.js
// ─────────────────────────────────────────────────────────────────────────────

describe('Next.js — adapter symbols', () => {
  it('7. Pages Router dynamic route /blog/:slug', () => {
    const db = openDatabase(nextjsRepoId);
    const all = getSymbolsByRepo(db, nextjsRepoId);
    db.close();

    // Pages Router page files are enriched React components — kind stays 'component'
    // with route_path and nextjs_page metadata added by the Next.js adapter.
    const slugRoute = all.find((s) => s.frameworkMeta?.['route_path'] === '/blog/:slug');
    expect(slugRoute).toBeDefined();
    expect(slugRoute!.frameworkMeta?.['nextjs_page']).toBe(true);
  });

  it('8. App Router nested route /dashboard with router: app', () => {
    const db = openDatabase(nextjsRepoId);
    const all = getSymbolsByRepo(db, nextjsRepoId);
    db.close();

    // App Router page files are also enriched components with router: 'app'
    const dashRoute = all.find((s) => s.frameworkMeta?.['route_path'] === '/dashboard');
    expect(dashRoute).toBeDefined();
    expect(dashRoute!.frameworkMeta?.['router']).toBe('app');
  });

  it('9. app/api/users/route.ts produces GET and POST route symbols', () => {
    const db = openDatabase(nextjsRepoId);
    const all = getSymbolsByRepo(db, nextjsRepoId);
    db.close();

    const apiRoutes = all.filter(
      (s) =>
        s.kind === 'route' &&
        s.filePath.replace(/\\/g, '/').includes('app/api/users/route') &&
        s.frameworkMeta?.['router'] === 'app',
    );

    const methods = apiRoutes.map((s) => s.frameworkMeta?.['http_method'] as string);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
  });

  it('10. src/components/Button.tsx produces kind component (React adapter)', () => {
    const db = openDatabase(nextjsRepoId);
    const all = getSymbolsByRepo(db, nextjsRepoId);
    db.close();

    const buttonSymbol = all.find(
      (s) => s.name === 'Button' && s.filePath.includes('components/Button'),
    );
    expect(buttonSymbol).toBeDefined();
    expect(buttonSymbol!.kind).toBe('component');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// search_text tool
// ─────────────────────────────────────────────────────────────────────────────

describe('search_text tool', () => {
  it('11. literal match returns correct line number and context', () => {
    const result = searchTextHandler({
      repoId: pythonRepoId,
      query: 'hash_password',
      isRegex: false,
      contextLines: 2,
      maxResults: 50,
    });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content[0] as { type: string; text: string }).text);

    expect(payload.matches.length).toBeGreaterThan(0);
    const match = payload.matches[0] as { file: string; line: number; match: string; context: string };
    expect(match.match).toContain('hash_password');
    expect(match.line).toBeGreaterThan(0);
    expect(match.context).toBeTruthy();
  });

  it('12. invalid regex returns error response, no crash', () => {
    const result = searchTextHandler({
      repoId: pythonRepoId,
      query: '[invalid(',
      isRegex: true,
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(payload.error).toMatch(/[Ii]nvalid regex/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get_layer_violations tool
// ─────────────────────────────────────────────────────────────────────────────

describe('get_layer_violations tool', () => {
  it('13. returns valid structure and detects violations in PureContext repo', async () => {
    // Index the PureContext src directory
    _resetForTesting();
    registerHandler(typescriptHandler);
    registerHandler(tsxHandler);
    registerHandler(javascriptHandler);
    await initParser();

    const result = await indexFolder(PURECONTEXT_ROOT, { fileLimit: 200, skipGit: true });
    const clRepoId = result.repoId;

    try {
      // Use a strict layer config where handlers→adapters is forbidden
      const toolResult = layerViolationsHandler({
        repoId: clRepoId,
        layers: {
          definitions: [
            { name: 'handlers', paths: ['src/handlers/**'] },
            { name: 'adapters', paths: ['src/adapters/**'] },
          ],
          rules: [
            { from: 'adapters', to: 'handlers', allowed: true },
            // Handlers must not import from adapters
            { from: 'handlers', to: 'adapters', allowed: false },
          ],
        },
      });

      expect(toolResult.isError).toBeFalsy();
      const payload = JSON.parse((toolResult.content[0] as { type: string; text: string }).text);

      // Verify the response has the expected structure
      expect(Array.isArray(payload.violations)).toBe(true);
      expect(typeof payload.summary).toBe('object');
      expect(typeof payload.summary.total_violations).toBe('number');
      expect(Array.isArray(payload.layers_analyzed)).toBe(true);
      expect(payload.layers_analyzed.length).toBeGreaterThan(0);

      // Handlers should never import adapters — verify zero violations in that direction
      const handlerToAdapterViolations = (payload.violations as Array<{ from_layer: string; to_layer: string }>)
        .filter((v) => v.from_layer === 'handlers' && v.to_layer === 'adapters');
      expect(handlerToAdapterViolations).toEqual([]);
    } finally {
      deleteIndex(clRepoId);
    }
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP transport
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP transport', () => {
  let httpServer: NodeHttpServer;
  let port: number;

  beforeAll(async () => {
    httpServer = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: ['http://localhost:*'],
      auth: { enabled: false, token: '' },
      serverFactory: createMcpServer,
    });
    port = (httpServer.address() as { port: number }).port;
  }, 15_000);

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      }),
  );

  it('14. POST /mcp with tools/list returns a valid MCP response', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });

    const responseText = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    // StreamableHTTP returns SSE format: "data: {...}\n\n"
    // Try SSE data lines first, then fall back to raw JSON
    let jsonText: string | undefined;
    for (const line of responseText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        jsonText = trimmed.slice('data: '.length);
        break;
      }
      if (trimmed.startsWith('{')) {
        jsonText = trimmed;
        break;
      }
    }
    expect(jsonText).toBeDefined();

    const parsed = JSON.parse(jsonText!);
    expect(parsed.jsonrpc).toBe('2.0');
    // If the SDK returns an error (e.g. uninitialized session), log it for diagnosis
    if (parsed.error) console.log('MCP error response:', JSON.stringify(parsed.error));
    expect(parsed.result).toBeDefined();
    // tools/list result has a `tools` array
    expect(Array.isArray(parsed.result.tools)).toBe(true);
    expect(parsed.result.tools.length).toBeGreaterThan(0);

    // Spot-check that known tools are present
    const toolNames = (parsed.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toContain('search_symbols');
    expect(toolNames).toContain('search_text');
    expect(toolNames).toContain('get_layer_violations');
  });
});
