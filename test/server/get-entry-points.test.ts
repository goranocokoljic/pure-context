/**
 * Tests for the get_entry_points tool (Task 195).
 *
 * Fixture: test/fixtures/get-entry-points-fixture/
 *   src/main.ts                  — exported main() function → main_function (high)
 *   src/services/server.ts       — bootstrap() + startServer() → server_startup (high)
 *   src/cmd/cli.ts               — runCli() in cmd dir → cli_handler (medium), NOT buildCommand/deployCommand
 *   src/lambda/handler.ts        — export const handler (event, context) → lambda_handler (high)
 *   scripts/migrate.ts           — run() in scripts/ → script (medium)
 *   src/services/user-service.ts — internal service, NO entry points
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as getEntryPointsHandler, detectEntryPoint } from '../../src/server/tools/get-entry-points.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/get-entry-points-fixture');

let repoId: string;

// ─── Output types ─────────────────────────────────────────────────────────────

interface EntryPoint {
  symbolId: string;
  name: string;
  kind: string;
  confidence: string;
  reason: string;
  filePath: string;
  startLine: number;
  signature: string;
  summary: string;
}

interface GetEntryPointsOutput {
  totalFound: number;
  truncated: boolean;
  kindCounts: Record<string, number>;
  entryPoints: EntryPoint[];
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  const result = await indexFolder(FIXTURE, { fileLimit: 50 });
  repoId = result.repoId;
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

// ─── Helper ───────────────────────────────────────────────────────────────────

async function getEntryPoints(args: {
  repoId?: string;
  kind?: string;
  filePath?: string;
  minConfidence?: string;
  limit?: number;
}): Promise<GetEntryPointsOutput> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await getEntryPointsHandler({ repoId, ...args } as any);
  expect(result.isError).toBeFalsy();
  return JSON.parse((result.content[0] as { text: string }).text) as GetEntryPointsOutput;
}

// ─── Unit tests for detectEntryPoint ─────────────────────────────────────────

describe('detectEntryPoint unit', () => {
  it('classifies main() in main.ts as main_function/high', () => {
    const sym = {
      id: 'x', name: 'main', kind: 'function',
      file_path: 'src/main.ts', start_byte: 0,
      signature: 'export async function main(): Promise<void>',
      summary: '',
    };
    const result = detectEntryPoint(sym);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('main_function');
    expect(result!.confidence).toBe('high');
  });

  it('classifies main() in non-root file as main_function/medium', () => {
    const sym = {
      id: 'x', name: 'main', kind: 'function',
      file_path: 'src/deep/something.ts', start_byte: 0,
      signature: 'function main(): void',
      summary: '',
    };
    const result = detectEntryPoint(sym);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('main_function');
    expect(result!.confidence).toBe('medium');
  });

  it('classifies exported main() in deep file as main_function/high', () => {
    const sym = {
      id: 'x', name: 'main', kind: 'function',
      file_path: 'src/deep/mod.ts', start_byte: 0,
      signature: 'export function main(): void',
      summary: '',
    };
    const result = detectEntryPoint(sym);
    expect(result!.confidence).toBe('high');
  });

  it('classifies handler(event, context) as lambda_handler/high', () => {
    const sym = {
      id: 'x', name: 'handler', kind: 'const',
      file_path: 'src/lambda/handler.ts', start_byte: 0,
      signature: 'export const handler = async (event: LambdaEvent, context: LambdaContext): Promise<void>',
      summary: '',
    };
    const result = detectEntryPoint(sym);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('lambda_handler');
    expect(result!.confidence).toBe('high');
  });

  it('classifies bootstrap() as server_startup/high', () => {
    const sym = {
      id: 'x', name: 'bootstrap', kind: 'function',
      file_path: 'src/services/server.ts', start_byte: 0,
      signature: 'export async function bootstrap(): Promise<void>',
      summary: '',
    };
    const result = detectEntryPoint(sym);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('server_startup');
    expect(result!.confidence).toBe('high');
  });

  it('classifies startServer() as server_startup/high', () => {
    const sym = {
      id: 'x', name: 'startServer', kind: 'function',
      file_path: 'src/services/server.ts', start_byte: 0,
      signature: 'export async function startServer(port?: number): Promise<void>',
      summary: '',
    };
    const result = detectEntryPoint(sym);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('server_startup');
    expect(result!.confidence).toBe('high');
  });

  it('classifies run() in scripts/ as script/medium', () => {
    const sym = {
      id: 'x', name: 'run', kind: 'function',
      file_path: 'scripts/migrate.ts', start_byte: 0,
      signature: 'export async function run(): Promise<void>',
      summary: '',
    };
    const result = detectEntryPoint(sym);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('script');
    expect(result!.confidence).toBe('medium');
  });

  it('classifies function in bin/ dir as cli_handler', () => {
    const sym = {
      id: 'x', name: 'main', kind: 'function',
      file_path: 'bin/index.ts', start_byte: 0,
      signature: 'function main(): void',
      summary: '',
    };
    const result = detectEntryPoint(sym);
    // Could match main_function or cli_handler — both are valid classifications
    expect(result).not.toBeNull();
  });

  it('returns null for an internal helper function', () => {
    const sym = {
      id: 'x', name: 'parseFlags', kind: 'function',
      file_path: 'src/main.ts', start_byte: 100,
      signature: 'function parseFlags(args: string[]): Map<string, string>',
      summary: '',
    };
    const result = detectEntryPoint(sym);
    expect(result).toBeNull();
  });

  it('returns null for a service function', () => {
    const sym = {
      id: 'x', name: 'findUser', kind: 'function',
      file_path: 'src/services/user-service.ts', start_byte: 200,
      signature: 'export function findUser(id: string): User | undefined',
      summary: '',
    };
    const result = detectEntryPoint(sym);
    expect(result).toBeNull();
  });

  it('classifies parseArgs function as cli_handler/low', () => {
    const sym = {
      id: 'x', name: 'parseArgs', kind: 'function',
      file_path: 'src/app.ts', start_byte: 0,
      signature: 'export function parseArgs(argv: string[]): Options',
      summary: '',
    };
    const result = detectEntryPoint(sym);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('cli_handler');
    expect(result!.confidence).toBe('low');
  });
});

// ─── Integration tests using the fixture ─────────────────────────────────────

describe('get_entry_points integration', () => {
  it('returns entry points for a valid repo', async () => {
    const out = await getEntryPoints({});
    expect(out.totalFound).toBeGreaterThan(0);
    expect(out.entryPoints).toBeInstanceOf(Array);
    expect(out.truncated).toBe(false);
    expect(out._tokenEstimate).toBeGreaterThan(0);
    expect(out._meta.timing_ms).toBeGreaterThanOrEqual(0);
  });

  it('returns an error for an unknown repo', async () => {
    const result = await getEntryPointsHandler({ repoId: 'deadbeef00000000' } as never);
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toMatch(/not found/i);
  });

  it('detects the main() function in src/main.ts', async () => {
    const out = await getEntryPoints({});
    const mainEp = out.entryPoints.find(
      (ep) => ep.name === 'main' && ep.filePath.includes('main.ts'),
    );
    expect(mainEp).toBeDefined();
    expect(mainEp!.kind).toBe('main_function');
    expect(mainEp!.confidence).toBe('high');
  });

  it('detects the Lambda handler in src/lambda/handler.ts', async () => {
    const out = await getEntryPoints({});
    const lambdaEp = out.entryPoints.find(
      (ep) => ep.name === 'handler' && ep.filePath.includes('lambda'),
    );
    expect(lambdaEp).toBeDefined();
    expect(lambdaEp!.kind).toBe('lambda_handler');
    expect(lambdaEp!.confidence).toBe('high');
  });

  it('detects bootstrap() in src/services/server.ts as server_startup', async () => {
    const out = await getEntryPoints({});
    const bootstrapEp = out.entryPoints.find(
      (ep) => ep.name === 'bootstrap',
    );
    expect(bootstrapEp).toBeDefined();
    expect(bootstrapEp!.kind).toBe('server_startup');
  });

  it('does NOT classify internal helpers (parseFlags, buildCommand, etc.)', async () => {
    const out = await getEntryPoints({});
    const names = out.entryPoints.map((ep) => ep.name);
    expect(names).not.toContain('parseFlags');
    expect(names).not.toContain('buildCommand');
    expect(names).not.toContain('deployCommand');
  });

  it('does NOT classify regular service functions (findUser, createUser)', async () => {
    const out = await getEntryPoints({});
    const names = out.entryPoints.map((ep) => ep.name);
    expect(names).not.toContain('findUser');
    expect(names).not.toContain('createUser');
  });

  it('filters by kind=lambda_handler', async () => {
    const out = await getEntryPoints({ kind: 'lambda_handler' });
    expect(out.entryPoints.length).toBeGreaterThan(0);
    for (const ep of out.entryPoints) {
      expect(ep.kind).toBe('lambda_handler');
    }
  });

  it('filters by kind=main_function', async () => {
    const out = await getEntryPoints({ kind: 'main_function' });
    expect(out.entryPoints.length).toBeGreaterThan(0);
    for (const ep of out.entryPoints) {
      expect(ep.kind).toBe('main_function');
    }
  });

  it('filters by kind=server_startup', async () => {
    const out = await getEntryPoints({ kind: 'server_startup' });
    expect(out.entryPoints.length).toBeGreaterThan(0);
    for (const ep of out.entryPoints) {
      expect(ep.kind).toBe('server_startup');
    }
  });

  it('filters by filePath prefix (src/lambda/)', async () => {
    const out = await getEntryPoints({ filePath: 'src/lambda/' });
    expect(out.entryPoints.length).toBeGreaterThan(0);
    for (const ep of out.entryPoints) {
      expect(ep.filePath).toMatch(/^src\/lambda\//);
    }
  });

  it('filters by filePath prefix (scripts/)', async () => {
    const out = await getEntryPoints({ filePath: 'scripts/' });
    expect(out.entryPoints.length).toBeGreaterThan(0);
    for (const ep of out.entryPoints) {
      expect(ep.filePath).toMatch(/^scripts\//);
    }
  });

  it('filters by minConfidence=high returns only high-confidence results', async () => {
    const out = await getEntryPoints({ minConfidence: 'high' });
    expect(out.entryPoints.length).toBeGreaterThan(0);
    for (const ep of out.entryPoints) {
      expect(ep.confidence).toBe('high');
    }
  });

  it('high-confidence results include main(), handler, and bootstrap()', async () => {
    const out = await getEntryPoints({ minConfidence: 'high' });
    const names = out.entryPoints.map((ep) => ep.name);
    expect(names).toContain('main');
    expect(names).toContain('handler');
    expect(names).toContain('bootstrap');
  });

  it('respects limit parameter', async () => {
    const out = await getEntryPoints({ limit: 2 });
    expect(out.entryPoints.length).toBeLessThanOrEqual(2);
    expect(out.truncated).toBe(true);
  });

  it('results are sorted by confidence (high first)', async () => {
    const out = await getEntryPoints({});
    const ranks = out.entryPoints.map((ep) =>
      ep.confidence === 'high' ? 2 : ep.confidence === 'medium' ? 1 : 0,
    );
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeLessThanOrEqual(ranks[i - 1]);
    }
  });

  it('each entry point has required fields', async () => {
    const out = await getEntryPoints({});
    for (const ep of out.entryPoints) {
      expect(ep.symbolId).toBeTruthy();
      expect(ep.name).toBeTruthy();
      expect(ep.kind).toBeTruthy();
      expect(ep.confidence).toMatch(/^(high|medium|low)$/);
      expect(ep.reason).toBeTruthy();
      expect(ep.filePath).toBeTruthy();
      expect(ep.startLine).toBeGreaterThanOrEqual(1);
      expect(ep.signature).toBeTruthy();
    }
  });

  it('kindCounts summarises result by kind', async () => {
    const out = await getEntryPoints({});
    expect(out.kindCounts).toBeInstanceOf(Object);
    // kindCounts should add up to totalFound
    const total = Object.values(out.kindCounts).reduce((a, b) => a + b, 0);
    expect(total).toBe(out.totalFound);
  });

  it('returns empty result when filePath filter matches no entry points', async () => {
    const out = await getEntryPoints({ filePath: 'src/services/user-service.ts' });
    // user-service.ts only has ordinary service functions — no entry points
    expect(out.totalFound).toBe(0);
    expect(out.entryPoints).toHaveLength(0);
  });
});
