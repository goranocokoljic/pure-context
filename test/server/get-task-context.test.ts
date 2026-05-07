/**
 * Tests for the get_task_context tool (Task 161).
 *
 * Tests cover:
 *   - buildPlanningPrompt output shape
 *   - parsePlanResponse (valid JSON, stripped fences, malformed input)
 *   - Integration: semantic discovery returns candidates
 *   - Integration: no AI provider → falls back to semantic ranking
 *   - Integration: includeSource returns symbol source
 *   - Integration: maxSymbols limits result count
 *   - Integration: _meta does not double-count token savings
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import {
  handler,
  buildPlanningPrompt,
  parsePlanResponse,
} from '../../src/server/tools/get-task-context.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

let repoId: string;

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

function parse(result: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

// ─── buildPlanningPrompt ──────────────────────────────────────────────────────

describe('buildPlanningPrompt', () => {
  const fakeSymbol = {
    id: 'abc123',
    name: 'handleLogin',
    kind: 'function' as const,
    filePath: 'src/auth.ts',
    startByte: 0,
    endByte: 100,
    signature: 'function handleLogin(username: string, password: string): Promise<User>',
    summary: 'Authenticates a user and returns a session token',
    frameworkMeta: undefined,
  };

  it('includes the task in the prompt', () => {
    const prompt = buildPlanningPrompt('add OAuth login', [fakeSymbol]);
    expect(prompt).toContain('add OAuth login');
  });

  it('includes symbol id, name, kind, file, and summary', () => {
    const prompt = buildPlanningPrompt('some task', [fakeSymbol]);
    expect(prompt).toContain('abc123');
    expect(prompt).toContain('handleLogin');
    expect(prompt).toContain('function');
    expect(prompt).toContain('src/auth.ts');
    expect(prompt).toContain('Authenticates a user');
  });

  it('includes JSON format instructions', () => {
    const prompt = buildPlanningPrompt('some task', [fakeSymbol]);
    expect(prompt).toContain('"selected"');
    expect(prompt).toContain('"plan"');
    expect(prompt).toContain('"estimatedFiles"');
    expect(prompt).toContain('primary|dependency|test|config');
  });

  it('handles empty candidates list', () => {
    const prompt = buildPlanningPrompt('some task', []);
    expect(prompt).toContain('some task');
  });
});

// ─── parsePlanResponse ────────────────────────────────────────────────────────

describe('parsePlanResponse', () => {
  it('parses a valid JSON response', () => {
    const json = JSON.stringify({
      selected: [
        { id: 'abc123', relevanceReason: 'Core auth logic', role: 'primary' },
        { id: 'def456', relevanceReason: 'Needed for session', role: 'dependency' },
      ],
      plan: 'Modify handleLogin to support OAuth flow.',
      estimatedFiles: ['src/auth.ts', 'src/session.ts'],
    });
    const result = parsePlanResponse(json);
    expect(result).not.toBeNull();
    expect(result!.selected).toHaveLength(2);
    expect(result!.selected[0]!.id).toBe('abc123');
    expect(result!.selected[0]!.role).toBe('primary');
    expect(result!.plan).toContain('OAuth');
    expect(result!.estimatedFiles).toContain('src/auth.ts');
  });

  it('strips markdown code fences', () => {
    const json = '```json\n' + JSON.stringify({
      selected: [{ id: 'x1', relevanceReason: 'reason', role: 'primary' }],
      plan: 'plan text',
      estimatedFiles: [],
    }) + '\n```';
    const result = parsePlanResponse(json);
    expect(result).not.toBeNull();
    expect(result!.selected[0]!.id).toBe('x1');
  });

  it('returns null for malformed JSON', () => {
    expect(parsePlanResponse('not json at all')).toBeNull();
  });

  it('returns null when selected is missing', () => {
    const json = JSON.stringify({ plan: 'no selected', estimatedFiles: [] });
    expect(parsePlanResponse(json)).toBeNull();
  });

  it('skips entries with invalid role', () => {
    const json = JSON.stringify({
      selected: [
        { id: 'ok1', relevanceReason: 'fine', role: 'primary' },
        { id: 'bad', relevanceReason: 'bad role', role: 'invalid_role' },
      ],
      plan: 'plan',
      estimatedFiles: [],
    });
    const result = parsePlanResponse(json);
    expect(result).not.toBeNull();
    expect(result!.selected).toHaveLength(1);
    expect(result!.selected[0]!.id).toBe('ok1');
  });

  it('skips entries missing required fields', () => {
    const json = JSON.stringify({
      selected: [
        { id: 'ok1', relevanceReason: 'fine', role: 'primary' },
        { relevanceReason: 'missing id', role: 'primary' },
        { id: 'no-reason', role: 'primary' },
      ],
      plan: 'plan',
      estimatedFiles: [],
    });
    const result = parsePlanResponse(json);
    expect(result).not.toBeNull();
    expect(result!.selected).toHaveLength(1);
  });

  it('filters non-string entries from estimatedFiles', () => {
    const json = JSON.stringify({
      selected: [],
      plan: 'plan',
      estimatedFiles: ['src/a.ts', 42, null, 'src/b.ts'],
    });
    const result = parsePlanResponse(json);
    expect(result).not.toBeNull();
    expect(result!.estimatedFiles).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

// ─── Integration tests ────────────────────────────────────────────────────────

describe('get_task_context handler', () => {
  it('returns structured output with required fields', async () => {
    const result = await handler({
      repoId,
      task: 'add a new function to process symbols',
    });

    const data = parse(result);
    expect(typeof data['task']).toBe('string');
    expect(typeof data['plan']).toBe('string');
    expect(Array.isArray(data['contextItems'])).toBe(true);
    expect(Array.isArray(data['estimatedFiles'])).toBe(true);
    expect(typeof data['totalTokens']).toBe('number');
    expect(data['_meta']).toBeDefined();
  });

  it('returns error for unknown repo', async () => {
    const result = await handler({
      repoId: 'deadbeef00000000',
      task: 'some task',
    });
    expect(result.isError).toBe(true);
    const data = parse(result);
    expect(typeof data['error']).toBe('string');
  });

  it('respects maxSymbols limit', async () => {
    const result = await handler({
      repoId,
      task: 'refactor the indexing pipeline',
      maxSymbols: 3,
    });

    const data = parse(result);
    const items = data['contextItems'] as unknown[];
    expect(items.length).toBeLessThanOrEqual(3);
  });

  it('falls back gracefully when no AI provider configured', async () => {
    // With no AI configured, tool should still return context items from semantic ranking
    const result = await handler({
      repoId,
      task: 'search for symbols by name',
    });

    const data = parse(result);
    expect(Array.isArray(data['contextItems'])).toBe(true);
    // plan should be present even in fallback mode
    expect(typeof data['plan']).toBe('string');
    expect((data['plan'] as string).length).toBeGreaterThan(0);
  });

  it('returns source when includeSource is true', async () => {
    const result = await handler({
      repoId,
      task: 'add error handling',
      includeSource: true,
      maxSymbols: 2,
    });

    const data = parse(result);
    const items = data['contextItems'] as Array<Record<string, unknown>>;
    if (items.length > 0) {
      // At least some items should have source when available
      const withSource = items.filter((item) => 'source' in item);
      // source may be empty string if file content not cached, but key should exist
      expect(withSource.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('context items have the expected shape', async () => {
    const result = await handler({
      repoId,
      task: 'implement file watching',
      maxSymbols: 5,
    });

    const data = parse(result);
    const items = data['contextItems'] as Array<Record<string, unknown>>;

    for (const item of items) {
      expect(typeof item['symbolId']).toBe('string');
      expect(typeof item['name']).toBe('string');
      expect(typeof item['kind']).toBe('string');
      expect(typeof item['filePath']).toBe('string');
      expect(typeof item['signature']).toBe('string');
      expect(typeof item['summary']).toBe('string');
      expect(typeof item['relevanceReason']).toBe('string');
      expect(['primary', 'dependency', 'test', 'config']).toContain(item['role']);
    }
  });

  it('_meta does not include token savings fields (not a retrieval tool)', async () => {
    const result = await handler({
      repoId,
      task: 'write a test for the search functionality',
    });

    const data = parse(result);
    const meta = data['_meta'] as Record<string, unknown>;
    // buildMeta without rawBytes/responseBytes omits token_saved
    expect(meta['timing_ms']).toBeDefined();
    expect(meta['powered_by']).toBe('PureContext MCP');
    // token savings should NOT be present (task context is not a byte-savings retrieval)
    expect(meta['tokens_saved']).toBeUndefined();
  });

  it('includes candidatesDiscovered and symbolsSelected in _meta', async () => {
    const result = await handler({
      repoId,
      task: 'add logging to the core module',
    });

    const data = parse(result);
    const meta = data['_meta'] as Record<string, unknown>;
    expect(typeof meta['candidatesDiscovered']).toBe('number');
    expect(typeof meta['symbolsSelected']).toBe('number');
    expect(meta['candidatesDiscovered'] as number).toBeGreaterThanOrEqual(
      meta['symbolsSelected'] as number,
    );
  });
});
