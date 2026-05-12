/**
 * Tests for the render_diagram tool (Task 178).
 *
 * Strategy: index the basic-ts-project fixture (which has real internal imports
 * and a class hierarchy via circular-a.ts / circular-b.ts) then verify:
 *   - type: 'module' → valid Mermaid graph TD output
 *   - maxNodes truncation
 *   - Node IDs are valid Mermaid identifiers (no special chars)
 *   - format: 'dot' → valid DOT output
 *   - Empty graph (unknown filePath) → minimal diagram, no error
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as renderDiagramHandler } from '../../src/server/tools/render-diagram.js';

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface DiagramOutput {
  diagram: string;
  format: string;
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string };
}

function parse(result: { content: Array<{ text: string }> }): DiagramOutput {
  return JSON.parse(result.content[0]!.text) as DiagramOutput;
}

/** Return true if all node IDs in the Mermaid source match [A-Za-z0-9_]+ only. */
function allNodeIdsClean(mermaid: string): boolean {
  // Extract node declarations: `  someId["label"]` or `  someId --> otherId`
  const idRe = /^\s{1,4}([A-Za-z0-9_]+)[\s\["[]/gm;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(mermaid)) !== null) {
    ids.push(m[1]!);
  }
  return ids.length > 0 && ids.every((id) => /^[A-Za-z0-9_]+$/.test(id));
}

// ─── repo validation ──────────────────────────────────────────────────────────

describe('render_diagram — repo validation', () => {
  it('returns error for unknown repoId', async () => {
    const result = await renderDiagramHandler({ repoId: 'deadbeef00000000', type: 'module' });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/not found/i);
  });

  it('returns error for type "call" without rootSymbolId', async () => {
    const result = await renderDiagramHandler({ repoId, type: 'call' });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/rootSymbolId/i);
  });

  it('returns error for type "class" without rootSymbolId', async () => {
    const result = await renderDiagramHandler({ repoId, type: 'class' });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { error: string };
    expect(data.error).toMatch(/rootSymbolId/i);
  });
});

// ─── module diagram ───────────────────────────────────────────────────────────

describe('render_diagram — type: module', () => {
  it('returns expected top-level fields', async () => {
    const result = await renderDiagramHandler({ repoId, type: 'module' });
    expect(result.isError).toBeUndefined();
    const data = parse(result);

    expect(typeof data.diagram).toBe('string');
    expect(data.diagram.length).toBeGreaterThan(0);
    expect(data.format).toBe('mermaid');
    expect(typeof data.nodeCount).toBe('number');
    expect(typeof data.edgeCount).toBe('number');
    expect(typeof data.truncated).toBe('boolean');
    expect(typeof data._tokenEstimate).toBe('number');
    expect(typeof data._meta).toBe('object');
  });

  it('output starts with "graph TD"', async () => {
    const result = await renderDiagramHandler({ repoId, type: 'module' });
    const data = parse(result);
    expect(data.diagram.trimStart()).toMatch(/^graph TD/);
  });

  it('nodeCount matches actual node declarations', async () => {
    const result = await renderDiagramHandler({ repoId, type: 'module' });
    const data = parse(result);
    // Count occurrences of `["..."]` node declarations
    const declarations = (data.diagram.match(/\["/g) ?? []).length;
    // Each node appears in one declaration; nodeCount should be positive and
    // not exceed declarations (subgraph names also use [" sometimes, so ≥)
    expect(data.nodeCount).toBeGreaterThan(0);
    expect(declarations).toBeGreaterThanOrEqual(data.nodeCount);
  });

  it('contains --> edge arrows when there are imports', async () => {
    const result = await renderDiagramHandler({ repoId, type: 'module' });
    const data = parse(result);
    // The fixture has several imports, so there should be at least one edge
    if (data.edgeCount > 0) {
      expect(data.diagram).toContain('-->');
    }
  });

  it('node IDs contain no special characters', async () => {
    const result = await renderDiagramHandler({ repoId, type: 'module' });
    const data = parse(result);
    expect(allNodeIdsClean(data.diagram)).toBe(true);
  });

  it('_tokenEstimate is positive', async () => {
    const result = await renderDiagramHandler({ repoId, type: 'module' });
    const data = parse(result);
    expect(data._tokenEstimate).toBeGreaterThan(0);
  });
});

// ─── maxNodes truncation ──────────────────────────────────────────────────────

describe('render_diagram — maxNodes truncation', () => {
  it('maxNodes: 2 returns truncated: true when repo has more nodes', async () => {
    const full = await renderDiagramHandler({ repoId, type: 'module' });
    const fullData = parse(full);

    if (fullData.nodeCount > 2) {
      const result = await renderDiagramHandler({ repoId, type: 'module', maxNodes: 2 });
      const data = parse(result);
      expect(data.truncated).toBe(true);
      expect(data.nodeCount).toBeLessThanOrEqual(2);
    }
  });

  it('maxNodes: 5 on a larger graph → at most 5 nodes', async () => {
    const result = await renderDiagramHandler({ repoId, type: 'module', maxNodes: 5 });
    const data = parse(result);
    expect(data.nodeCount).toBeLessThanOrEqual(5);
  });

  it('maxNodes larger than node count → truncated: false', async () => {
    const result = await renderDiagramHandler({ repoId, type: 'module', maxNodes: 200 });
    const data = parse(result);
    expect(data.truncated).toBe(false);
  });
});

// ─── filePath scoping ─────────────────────────────────────────────────────────

describe('render_diagram — filePath scoping', () => {
  it('unknown filePath returns empty graph (no error)', async () => {
    const result = await renderDiagramHandler({
      repoId,
      type: 'module',
      filePath: 'src/nonexistent-dir/',
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.nodeCount).toBe(0);
    expect(data.edgeCount).toBe(0);
    expect(data.diagram.length).toBeGreaterThan(0); // minimal diagram, not empty string
  });

  it('scoped filePath returns fewer nodes than the full graph', async () => {
    const full = await renderDiagramHandler({ repoId, type: 'module', maxNodes: 200 });
    const scoped = await renderDiagramHandler({
      repoId,
      type: 'module',
      filePath: 'src/',
      maxNodes: 200,
    });
    const fullData = parse(full);
    const scopedData = parse(scoped);
    // Scoped to src/ should include at most the files in src/
    expect(scopedData.nodeCount).toBeLessThanOrEqual(fullData.nodeCount);
  });
});

// ─── subgraph grouping ────────────────────────────────────────────────────────

describe('render_diagram — subgraph grouping', () => {
  it('output contains subgraph blocks when files span multiple directories', async () => {
    const result = await renderDiagramHandler({ repoId, type: 'module', maxNodes: 200 });
    const data = parse(result);
    // The fixture has files in src/ so subgraph should appear
    if (data.nodeCount > 0) {
      expect(data.diagram).toContain('subgraph');
    }
  });
});

// ─── DOT format ───────────────────────────────────────────────────────────────

describe('render_diagram — format: dot', () => {
  it('output starts with "digraph G"', async () => {
    const result = await renderDiagramHandler({ repoId, type: 'module', format: 'dot' });
    const data = parse(result);
    expect(data.format).toBe('dot');
    expect(data.diagram.trimStart()).toMatch(/^digraph G/);
  });

  it('contains -> edge syntax', async () => {
    const result = await renderDiagramHandler({ repoId, type: 'module', format: 'dot' });
    const data = parse(result);
    if (data.edgeCount > 0) {
      expect(data.diagram).toContain('->');
    }
  });

  it('is valid DOT structure (has opening and closing brace)', async () => {
    const result = await renderDiagramHandler({ repoId, type: 'module', format: 'dot' });
    const data = parse(result);
    expect(data.diagram).toContain('{');
    expect(data.diagram).toContain('}');
  });
});

// ─── import type alias ────────────────────────────────────────────────────────

describe('render_diagram — type: import alias', () => {
  it('type "import" produces same structure as "module"', async () => {
    const modResult = await renderDiagramHandler({ repoId, type: 'module' });
    const impResult = await renderDiagramHandler({ repoId, type: 'import' });
    const modData = parse(modResult);
    const impData = parse(impResult);

    expect(impData.nodeCount).toBe(modData.nodeCount);
    expect(impData.edgeCount).toBe(modData.edgeCount);
    expect(impData.diagram.trimStart()).toMatch(/^graph TD/);
  });
});

// ─── _meta ────────────────────────────────────────────────────────────────────

describe('render_diagram — _meta', () => {
  it('_meta.timing_ms is a non-negative number', async () => {
    const result = await renderDiagramHandler({ repoId, type: 'module' });
    const data = parse(result);
    expect(data._meta.timing_ms).toBeGreaterThanOrEqual(0);
  });

  it('_meta.powered_by is present', async () => {
    const result = await renderDiagramHandler({ repoId, type: 'module' });
    const data = parse(result);
    expect(typeof data._meta.powered_by).toBe('string');
    expect(data._meta.powered_by.length).toBeGreaterThan(0);
  });
});
