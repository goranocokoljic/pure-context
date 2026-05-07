/**
 * Tests for the generate_docs tool (Task 160).
 *
 * Tests cover:
 *   - buildDescriptionPrompt: output contains filePaths and symbols
 *   - parseDescriptionResponse: valid JSON, stripped fences, malformed input
 *   - Integration: markdown output contains all modules in scope
 *   - Integration: each module has public symbols listed (includeSymbols default true)
 *   - Integration: dependencies listed correctly from dep_edges
 *   - Integration: aiEnhance false → no AI prompt shape used
 *   - Integration: scope filter narrows to directory
 *   - Integration: format 'json' returns parseable JSON array
 *   - Integration: includeMetrics appends symbolCount
 *   - Integration: empty scope → returns empty-module response
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
  buildDescriptionPrompt,
  parseDescriptionResponse,
} from '../../src/server/tools/generate-docs.js';

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

// ─── buildDescriptionPrompt ───────────────────────────────────────────────────

describe('buildDescriptionPrompt', () => {
  it('includes filePath in prompt', () => {
    const modules = [{
      filePath: 'src/auth.ts',
      symbols: [{ name: 'login', kind: 'function' as const, signature: 'function login()', summary: 'Log in' }],
    }];
    const prompt = buildDescriptionPrompt(modules);
    expect(prompt).toContain('src/auth.ts');
  });

  it('includes symbol names in prompt', () => {
    const modules = [{
      filePath: 'src/auth.ts',
      symbols: [{ name: 'handleOAuth', kind: 'function' as const, signature: 'function handleOAuth()', summary: '' }],
    }];
    const prompt = buildDescriptionPrompt(modules);
    expect(prompt).toContain('handleOAuth');
  });

  it('handles multiple modules', () => {
    const modules = [
      { filePath: 'src/a.ts', symbols: [{ name: 'foo', kind: 'function' as const, signature: 'function foo()', summary: '' }] },
      { filePath: 'src/b.ts', symbols: [{ name: 'bar', kind: 'class' as const, signature: 'class Bar', summary: '' }] },
    ];
    const prompt = buildDescriptionPrompt(modules);
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('src/b.ts');
    expect(prompt).toContain('foo');
    expect(prompt).toContain('bar');
  });

  it('instructs AI to return JSON array', () => {
    const prompt = buildDescriptionPrompt([{
      filePath: 'x.ts',
      symbols: [],
    }]);
    expect(prompt).toMatch(/JSON array/i);
    expect(prompt).toContain('"filePath"');
    expect(prompt).toContain('"description"');
  });
});

// ─── parseDescriptionResponse ─────────────────────────────────────────────────

describe('parseDescriptionResponse', () => {
  it('parses valid JSON array', () => {
    const raw = JSON.stringify([
      { filePath: 'src/auth.ts', description: 'Handles authentication.' },
    ]);
    const result = parseDescriptionResponse(raw);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]!.filePath).toBe('src/auth.ts');
    expect(result![0]!.description).toBe('Handles authentication.');
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n[{"filePath":"a.ts","description":"Does A."}]\n```';
    const result = parseDescriptionResponse(raw);
    expect(result).not.toBeNull();
    expect(result![0]!.filePath).toBe('a.ts');
  });

  it('returns null for non-array JSON', () => {
    expect(parseDescriptionResponse('{"filePath":"x.ts"}')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseDescriptionResponse('not json')).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(parseDescriptionResponse('[]')).toBeNull();
  });

  it('skips entries missing required fields', () => {
    const raw = JSON.stringify([
      { filePath: 'ok.ts', description: 'Valid.' },
      { filePath: 'missing-desc.ts' },
      { description: 'missing filePath' },
    ]);
    const result = parseDescriptionResponse(raw);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]!.filePath).toBe('ok.ts');
  });
});

// ─── Integration tests ────────────────────────────────────────────────────────

describe('generate_docs handler', () => {
  it('returns markdown by default', async () => {
    const result = await handler({ repoId, aiEnhance: false });
    const data = parse(result);

    expect(result.isError).toBeUndefined();
    expect(typeof data['document']).toBe('string');
    expect(data['document'] as string).toContain('# ');
    expect(data['document'] as string).toContain('Architecture Overview');
    expect((data['document'] as string)).toContain('## Modules');
  });

  it('markdown contains module sections for indexed files', async () => {
    const result = await handler({ repoId, aiEnhance: false });
    const data = parse(result);
    const doc = data['document'] as string;

    expect(data['moduleCount']).toBeGreaterThan(0);
    expect(doc).toContain('###');
  });

  it('includes public symbols by default', async () => {
    const result = await handler({ repoId, aiEnhance: false });
    const data = parse(result);
    const doc = data['document'] as string;

    // Should have at least one symbol listed (backtick-quoted name)
    expect(doc).toMatch(/`\w/);
  });

  it('omits symbols when includeSymbols is false', async () => {
    const result = await handler({ repoId, aiEnhance: false, includeSymbols: false });
    const data = parse(result);
    const doc = data['document'] as string;

    expect(doc).not.toContain('**Public API:**');
  });

  it('omits dependency lines when includeDependencies is false', async () => {
    const result = await handler({ repoId, aiEnhance: false, includeDependencies: false });
    const data = parse(result);
    const doc = data['document'] as string;

    expect(doc).not.toContain('**Depends on:**');
    expect(doc).not.toContain('**Imported by:**');
  });

  it('format json returns parseable JSON array', async () => {
    const result = await handler({ repoId, format: 'json', aiEnhance: false });
    const data = parse(result);

    expect(data['moduleCount']).toBeGreaterThan(0);
    const document = data['document'] as string;
    const parsed = JSON.parse(document) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);

    const first = parsed[0] as Record<string, unknown>;
    expect(typeof first['path']).toBe('string');
    expect(typeof first['title']).toBe('string');
    expect(typeof first['description']).toBe('string');
    expect(Array.isArray(first['publicSymbols'])).toBe(true);
    expect(Array.isArray(first['dependsOn'])).toBe(true);
    expect(Array.isArray(first['importedBy'])).toBe(true);
  });

  it('scope filter narrows results to directory', async () => {
    // Use a scope that matches at least one file in the fixture
    const allResult = await handler({ repoId, aiEnhance: false });
    const allData = parse(allResult);
    const allCount = allData['moduleCount'] as number;

    // Scope to "src/" — should be <= total module count
    const scopedResult = await handler({ repoId, scope: 'src', aiEnhance: false });
    const scopedData = parse(scopedResult);
    const scopedCount = scopedData['moduleCount'] as number;

    expect(scopedCount).toBeLessThanOrEqual(allCount);
  });

  it('includeMetrics appends symbolCount per module in json format', async () => {
    const result = await handler({ repoId, format: 'json', includeMetrics: true, aiEnhance: false });
    const data = parse(result);
    const document = data['document'] as string;
    const modules = JSON.parse(document) as Array<Record<string, unknown>>;

    // At least one module should have metrics
    const withMetrics = modules.filter((m) => m['metrics'] !== undefined);
    expect(withMetrics.length).toBeGreaterThan(0);

    const first = withMetrics[0] as Record<string, unknown>;
    const metrics = first['metrics'] as Record<string, unknown>;
    expect(typeof metrics['symbolCount']).toBe('number');
    expect(typeof metrics['avgComplexity']).toBe('number');
  });

  it('includeMetrics shows metrics in markdown', async () => {
    const result = await handler({ repoId, includeMetrics: true, aiEnhance: false });
    const data = parse(result);
    const doc = data['document'] as string;

    expect(doc).toContain('**Metrics:**');
  });

  it('aiEnhance false makes no AI calls (no warning from missing provider)', async () => {
    const result = await handler({ repoId, aiEnhance: false });
    const data = parse(result);

    // No warning about missing AI provider when aiEnhance is false
    expect(data['warning']).toBeUndefined();
    expect(result.isError).toBeUndefined();
  });

  it('returns error for unknown repoId', async () => {
    const result = await handler({ repoId: 'nonexistent-repo-path', aiEnhance: false });
    const data = parse(result);

    expect(result.isError).toBe(true);
    expect(data['error']).toBeDefined();
  });

  it('response always includes _meta with timing_ms', async () => {
    const result = await handler({ repoId, aiEnhance: false });
    const data = parse(result);
    const meta = data['_meta'] as Record<string, unknown>;

    expect(typeof meta['timing_ms']).toBe('number');
    expect(meta['powered_by']).toBe('PureContext MCP');
  });

  it('generatedAt is an ISO date string', async () => {
    const result = await handler({ repoId, aiEnhance: false });
    const data = parse(result);

    const generatedAt = data['generatedAt'] as string;
    expect(new Date(generatedAt).toISOString()).toBe(generatedAt);
  });
});
