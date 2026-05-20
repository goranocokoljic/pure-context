/**
 * Tests for get_lexical_scope_matches tool (Task 284).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../../src/handlers/handler-registry.js';
import { rubyHandler } from '../../../src/handlers/ruby.js';
import { initParser } from '../../../src/core/parse-dispatcher.js';
import { handler as scopeHandler } from '../../../src/server/tools/get-lexical-scope-matches.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../../fixtures/ruby-scope-project');

let repoId: string;

beforeAll(async () => {
  _resetForTesting();
  registerHandler(rubyHandler);
  await initParser();

  const result = await indexFolder(FIXTURE, { fileLimit: 50 });
  repoId = result.repoId;
  expect(result.symbolsFound).toBeGreaterThanOrEqual(0);
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

function parseResult(
  result: { content: { text: string }[] },
): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

type ScopeMatch = {
  filePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
  parentName: string;
  resolvedArg?: string;
};

describe('get_lexical_scope_matches', () => {
  it('finds get calls inside routing block (parentKind = call)', async () => {
    const result = await scopeHandler({
      repoId,
      childCall: 'get',
      parentCall: 'routing',
      parentKind: 'call',
    });
    const data = parseResult(result);
    const matches = data['matches'] as ScopeMatch[];
    // Should find get "/users" and get "/posts" inside routing, NOT get "/standalone"
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches.every((m) => m.snippet.includes('get '))).toBe(true);
    // Ensure standalone get is excluded
    const hasStandalone = matches.some((m) => m.snippet.includes('standalone'));
    expect(hasStandalone).toBe(false);
  });

  it('finds register calls inside ClassMethods module (parentKind = module)', async () => {
    const result = await scopeHandler({
      repoId,
      childCall: 'register',
      parentCall: 'ClassMethods',
      parentKind: 'module',
    });
    const data = parseResult(result);
    const matches = data['matches'] as ScopeMatch[];
    // Should find register :handler and register :formatter (not :helper which is in OtherMethods)
    expect(matches.length).toBe(2);
    const snippets = matches.map((m) => m.snippet);
    expect(snippets.some((s) => s.includes(':handler'))).toBe(true);
    expect(snippets.some((s) => s.includes(':formatter'))).toBe(true);
    expect(snippets.every((s) => !s.includes(':helper'))).toBe(true);
  });

  it('finds before_action calls inside PostsController (parentKind = class)', async () => {
    const result = await scopeHandler({
      repoId,
      childCall: 'before_action',
      parentCall: 'PostsController',
      parentKind: 'class',
    });
    const data = parseResult(result);
    const matches = data['matches'] as ScopeMatch[];
    // Should find both before_action :authenticate and before_action :load_post
    expect(matches.length).toBe(2);
  });

  it('filters before_action to private methods only when matchesPrivate = true', async () => {
    const result = await scopeHandler({
      repoId,
      childCall: 'before_action',
      parentCall: 'PostsController',
      parentKind: 'class',
      childArgMatches: {
        position: 0,
        type: 'symbol',
        matchesPrivate: true,
      },
    });
    const data = parseResult(result);
    const matches = data['matches'] as ScopeMatch[];
    // Only :authenticate is private; :load_post is public
    expect(matches.length).toBe(1);
    expect(matches[0]!.resolvedArg).toBe('authenticate');
    expect(matches[0]!.snippet).toContain('authenticate');
  });

  it('returns empty array (not error) when no matches', async () => {
    const result = await scopeHandler({
      repoId,
      childCall: 'nonexistent_call',
      parentCall: 'routing',
      parentKind: 'call',
    });
    const data = parseResult(result);
    const matches = data['matches'] as ScopeMatch[];
    expect(matches).toBeDefined();
    expect(Array.isArray(matches)).toBe(true);
    expect(matches.length).toBe(0);
    // Should not be an error
    expect(result.isError).toBeFalsy();
  });

  it('returns empty array when parent scope does not exist', async () => {
    const result = await scopeHandler({
      repoId,
      childCall: 'get',
      parentCall: 'nonexistent_scope',
      parentKind: 'call',
    });
    const data = parseResult(result);
    const matches = data['matches'] as ScopeMatch[];
    expect(matches.length).toBe(0);
    expect(result.isError).toBeFalsy();
  });

  it('without parentKind finds get inside routing using auto-detection', async () => {
    const result = await scopeHandler({
      repoId,
      childCall: 'get',
      parentCall: 'routing',
      // no parentKind — should still find call scopes
    });
    const data = parseResult(result);
    const matches = data['matches'] as ScopeMatch[];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const hasStandalone = matches.some((m) => m.snippet.includes('standalone'));
    expect(hasStandalone).toBe(false);
  });

  it('resolves argument value when childArgMatches.type = symbol', async () => {
    const result = await scopeHandler({
      repoId,
      childCall: 'before_action',
      parentCall: 'PostsController',
      parentKind: 'class',
      childArgMatches: {
        position: 0,
        type: 'symbol',
      },
    });
    const data = parseResult(result);
    const matches = data['matches'] as ScopeMatch[];
    // Both before_action calls have symbol at position 0
    expect(matches.length).toBe(2);
    const resolvedArgs = matches.map((m) => m.resolvedArg);
    expect(resolvedArgs).toContain('authenticate');
    expect(resolvedArgs).toContain('load_post');
  });
});
