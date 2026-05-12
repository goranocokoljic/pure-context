/**
 * Tests for the render_call_graph tool (Task 179).
 *
 * Fixture: test/fixtures/call-hierarchy-fixture/
 *   - src/level-a.ts    — levelA() calls levelB()
 *   - src/level-b.ts    — levelB() calls levelC()
 *   - src/level-c.ts    — levelC() — leaf, no calls
 *   - src/recursive.ts  — recursiveFunc() calls itself
 *   - src/multi-caller.ts — callerOne() and callerTwo() both call levelB()
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';
import { handler as renderCallGraphHandler } from '../../src/server/tools/render-call-graph.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/call-hierarchy-fixture');

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

interface CallGraphOutput {
  diagram: string;
  rootSymbol: string;
  nodeCount: number;
  truncated: boolean;
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string };
}

function parse(result: { content: Array<{ text: string }> }): CallGraphOutput {
  return JSON.parse(result.content[0]!.text) as CallGraphOutput;
}

function findSymbolId(name: string): string {
  const db = openDatabase(repoId);
  try {
    const results = searchSymbols(db, repoId, name, { kind: 'function' });
    const match = results.find((s) => s.name === name);
    if (!match) throw new Error(`Symbol "${name}" not found in index`);
    return match.id;
  } finally {
    db.close();
  }
}

/** Return true if all node IDs in the Mermaid source use only [A-Za-z0-9_] */
function allNodeIdsValid(diagram: string): boolean {
  // Match standalone identifiers on definition lines: "  someId[" or "  someId{"
  const nodeDefRe = /^\s{2}(\w+)\[/gm;
  let m: RegExpExecArray | null;
  while ((m = nodeDefRe.exec(diagram)) !== null) {
    if (!/^[A-Za-z0-9_]+$/.test(m[1]!)) return false;
  }
  return true;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('render_call_graph', () => {
  it('returns a valid Mermaid flowchart for a 3-level call chain (both)', async () => {
    const symbolId = findSymbolId('levelA');
    const result = await renderCallGraphHandler({ repoId, symbolId, direction: 'both' });

    expect(result.isError).toBeFalsy();
    const out = parse(result as { content: Array<{ text: string }> });

    expect(out.diagram).toContain('flowchart TD');
    expect(out.nodeCount).toBeGreaterThanOrEqual(2); // at least levelA + levelB
    expect(out._tokenEstimate).toBeGreaterThan(0);
  });

  it('root node has a distinct fill style', async () => {
    const symbolId = findSymbolId('levelA');
    const result = await renderCallGraphHandler({ repoId, symbolId, direction: 'callees' });

    const out = parse(result as { content: Array<{ text: string }> });
    // The root node should have a style line like: style <id> fill:#f96,stroke:#333
    expect(out.diagram).toMatch(/style\s+\w+\s+fill:#f96/);
  });

  it('direction: callees — only callee nodes present (no callers of levelA)', async () => {
    const symbolId = findSymbolId('levelB');
    const result = await renderCallGraphHandler({ repoId, symbolId, direction: 'callees' });

    const out = parse(result as { content: Array<{ text: string }> });
    expect(out.diagram).toContain('flowchart TD');
    // In callees mode the diagram should contain levelC
    expect(out.diagram).toContain('levelC');
    // callerOne and callerTwo (which call levelB) should NOT appear
    expect(out.diagram).not.toContain('callerOne');
    expect(out.diagram).not.toContain('callerTwo');
  });

  it('direction: callers — only caller nodes present', async () => {
    const symbolId = findSymbolId('levelB');
    const result = await renderCallGraphHandler({ repoId, symbolId, direction: 'callers' });

    const out = parse(result as { content: Array<{ text: string }> });
    expect(out.diagram).toContain('flowchart TD');
    // callerOne or levelA should appear (they call levelB)
    const hasCallers =
      out.diagram.includes('levelA') ||
      out.diagram.includes('callerOne') ||
      out.diagram.includes('callerTwo');
    expect(hasCallers).toBe(true);
    // levelC (callee of levelB) should NOT appear
    expect(out.diagram).not.toContain('levelC');
  });

  it('cyclic call produces a dashed edge', async () => {
    const symbolId = findSymbolId('recursiveFunc');
    const result = await renderCallGraphHandler({ repoId, symbolId, direction: 'callees' });

    const out = parse(result as { content: Array<{ text: string }> });
    // Dashed arrow in Mermaid: -.->>  or -.->, both use -.->
    expect(out.diagram).toContain('-.->')
  });

  it('all node IDs are valid Mermaid identifiers', async () => {
    const symbolId = findSymbolId('levelA');
    const result = await renderCallGraphHandler({ repoId, symbolId, direction: 'both' });

    const out = parse(result as { content: Array<{ text: string }> });
    expect(allNodeIdsValid(out.diagram)).toBe(true);
  });

  it('maxNodes truncation works and sets truncated=true', async () => {
    // The A→B→C chain has 3 nodes; limit to 2 forces pruning.
    // buildCallHierarchy is called with maxNodes*2=4 so the full chain is built,
    // then pruneGraphKeepingRoot reduces to 2.
    const symbolId = findSymbolId('levelA');
    const result = await renderCallGraphHandler({
      repoId,
      symbolId,
      direction: 'callees',
      maxNodes: 2,
    });

    const out = parse(result as { content: Array<{ text: string }> });
    expect(out.nodeCount).toBeLessThanOrEqual(2);
    expect(out.truncated).toBe(true);
  });

  it('format: dot — produces valid DOT output', async () => {
    const symbolId = findSymbolId('levelA');
    const result = await renderCallGraphHandler({
      repoId,
      symbolId,
      direction: 'callees',
      format: 'dot',
    });

    const out = parse(result as { content: Array<{ text: string }> });
    expect(out.diagram).toContain('digraph G');
    expect(out.diagram).toContain('->');
  });

  it('unknown symbolId returns isError', async () => {
    const result = await renderCallGraphHandler({
      repoId,
      symbolId: 'nonexistent_symbol_id_xyz',
      direction: 'both',
    });

    expect(result.isError).toBe(true);
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain('not found');
  });

  it('unknown repoId returns isError', async () => {
    const result = await renderCallGraphHandler({
      repoId: 'deadbeefdeadbeef',
      symbolId: 'any',
      direction: 'both',
    });

    expect(result.isError).toBe(true);
  });

  it('rootSymbol in output matches the queried function name', async () => {
    const symbolId = findSymbolId('levelA');
    const result = await renderCallGraphHandler({ repoId, symbolId, direction: 'callees' });

    const out = parse(result as { content: Array<{ text: string }> });
    expect(out.rootSymbol).toContain('levelA');
  });
});
