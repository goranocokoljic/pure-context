/**
 * Tests for the get_call_hierarchy tool (Task 174).
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
import { handler as getCallHierarchyHandler } from '../../src/server/tools/get-call-hierarchy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/call-hierarchy-fixture');

let repoId: string;

// Helper: find symbolId by exact name and kind
function findSymbolId(name: string, kind: string): string {
  const db = openDatabase(repoId);
  try {
    const results = searchSymbols(db, repoId, name, { kind: kind as 'function' });
    const match = results.find((s) => s.name === name);
    if (!match) throw new Error(`Symbol "${name}" (${kind}) not found in index`);
    return match.id;
  } finally {
    db.close();
  }
}

// Helper: flatten all node names in a tree (BFS)
function flattenNames(root: CallNodeResult): string[] {
  const names: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    names.push(node.name);
    for (const child of node.children) queue.push(child);
  }
  return names;
}

// Helper: compute max depth of a tree (0-indexed — root alone = 0)
function treeDepth(node: CallNodeResult): number {
  if (node.children.length === 0) return 0;
  return 1 + Math.max(...node.children.map(treeDepth));
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface CallNodeResult {
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  signature: string;
  callCount: number;
  cyclic: boolean;
  children: CallNodeResult[];
}

interface GetCallHierarchyOutput {
  root: CallNodeResult;
  direction: 'callers' | 'callees' | 'both';
  totalNodes: number;
  truncated: boolean;
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('get_call_hierarchy', () => {
  it('callees direction — 3-level chain has correct depth', async () => {
    const symbolId = findSymbolId('levelA', 'function');
    const rawResult = await getCallHierarchyHandler({
      repoId,
      symbolId,
      direction: 'callees',
      maxDepth: 3,
    });

    expect(rawResult.isError).toBeFalsy();
    const output = JSON.parse(
      (rawResult.content[0] as { type: string; text: string }).text,
    ) as GetCallHierarchyOutput;

    expect(output.root.name).toBe('levelA');
    expect(output.direction).toBe('callees');

    // levelA → levelB → levelC — depth of 2
    expect(treeDepth(output.root)).toBeGreaterThanOrEqual(2);

    const names = flattenNames(output.root);
    expect(names).toContain('levelB');
    expect(names).toContain('levelC');
  });

  it('callers direction — only upward traversal from levelC', async () => {
    const symbolId = findSymbolId('levelC', 'function');
    const rawResult = await getCallHierarchyHandler({
      repoId,
      symbolId,
      direction: 'callers',
      maxDepth: 3,
    });

    expect(rawResult.isError).toBeFalsy();
    const output = JSON.parse(
      (rawResult.content[0] as { type: string; text: string }).text,
    ) as GetCallHierarchyOutput;

    expect(output.root.name).toBe('levelC');
    expect(output.direction).toBe('callers');

    const names = flattenNames(output.root);
    // levelB calls levelC, so levelB should appear as a caller
    expect(names).toContain('levelB');
    // levelC should NOT appear as a callee child of itself
    const nonRootNames = names.slice(1);
    // levelC is the root — it should not call anything in this direction
    expect(nonRootNames.filter((n) => n === 'levelC').length).toBe(0);
  });

  it('callers direction — levelB has multiple callers', async () => {
    const symbolId = findSymbolId('levelB', 'function');
    const rawResult = await getCallHierarchyHandler({
      repoId,
      symbolId,
      direction: 'callers',
      maxDepth: 1,
    });

    expect(rawResult.isError).toBeFalsy();
    const output = JSON.parse(
      (rawResult.content[0] as { type: string; text: string }).text,
    ) as GetCallHierarchyOutput;

    const callerNames = output.root.children.map((c) => c.name);
    // levelA, callerOne, callerTwo all call levelB
    expect(callerNames).toContain('levelA');
    expect(callerNames).toContain('callerOne');
    expect(callerNames).toContain('callerTwo');
  });

  it('recursive function — no infinite loop, cyclic=true on cycle node', async () => {
    const symbolId = findSymbolId('recursiveFunc', 'function');
    const rawResult = await getCallHierarchyHandler({
      repoId,
      symbolId,
      direction: 'callees',
      maxDepth: 5,
    });

    expect(rawResult.isError).toBeFalsy();
    const output = JSON.parse(
      (rawResult.content[0] as { type: string; text: string }).text,
    ) as GetCallHierarchyOutput;

    // Should NOT have thrown or hung — result is present
    expect(output.root.name).toBe('recursiveFunc');
    expect(output.totalNodes).toBeGreaterThan(0);

    // The self-call should appear as a cyclic child
    const cycleChild = output.root.children.find(
      (c) => c.name === 'recursiveFunc' && c.cyclic,
    );
    expect(cycleChild).toBeDefined();
    // Cyclic nodes have no children
    expect(cycleChild!.children.length).toBe(0);
  });

  it('maxDepth: 1 — only direct callees returned', async () => {
    const symbolId = findSymbolId('levelA', 'function');
    const rawResult = await getCallHierarchyHandler({
      repoId,
      symbolId,
      direction: 'callees',
      maxDepth: 1,
    });

    expect(rawResult.isError).toBeFalsy();
    const output = JSON.parse(
      (rawResult.content[0] as { type: string; text: string }).text,
    ) as GetCallHierarchyOutput;

    // With maxDepth=1, only direct callees (levelB) should appear — levelC
    // is a grandchild and should be absent.
    expect(treeDepth(output.root)).toBe(1);
    const names = flattenNames(output.root);
    expect(names).toContain('levelB');
    expect(names).not.toContain('levelC');
  });

  it('maxNodes hit — truncated=true', async () => {
    const symbolId = findSymbolId('levelA', 'function');
    const rawResult = await getCallHierarchyHandler({
      repoId,
      symbolId,
      direction: 'callees',
      maxDepth: 6,
      maxNodes: 1, // only the root itself — any child causes truncation
    });

    expect(rawResult.isError).toBeFalsy();
    const output = JSON.parse(
      (rawResult.content[0] as { type: string; text: string }).text,
    ) as GetCallHierarchyOutput;

    expect(output.truncated).toBe(true);
  });

  it('both direction — returns callers and callees of levelB', async () => {
    const symbolId = findSymbolId('levelB', 'function');
    const rawResult = await getCallHierarchyHandler({
      repoId,
      symbolId,
      direction: 'both',
      maxDepth: 2,
    });

    expect(rawResult.isError).toBeFalsy();
    const output = JSON.parse(
      (rawResult.content[0] as { type: string; text: string }).text,
    ) as GetCallHierarchyOutput;

    expect(output.direction).toBe('both');
    const childNames = output.root.children.map((c) => c.name);
    // levelA calls levelB (caller), levelC is called by levelB (callee)
    expect(childNames).toContain('levelA');
    expect(childNames).toContain('levelC');
  });

  it('unknown symbolId — returns error', async () => {
    const rawResult = await getCallHierarchyHandler({
      repoId,
      symbolId: 'nonexistent0000000',
      direction: 'callees',
    });

    expect(rawResult.isError).toBe(true);
  });

  it('root node has correct fields', async () => {
    const symbolId = findSymbolId('levelA', 'function');
    const rawResult = await getCallHierarchyHandler({
      repoId,
      symbolId,
      direction: 'callees',
      maxDepth: 1,
    });

    const output = JSON.parse(
      (rawResult.content[0] as { type: string; text: string }).text,
    ) as GetCallHierarchyOutput;

    const root = output.root;
    expect(root.symbolId).toBeTruthy();
    expect(root.name).toBe('levelA');
    expect(root.filePath).toMatch(/level-a\.ts$/);
    expect(root.startLine).toBeGreaterThan(0);
    expect(root.signature).toBeTruthy();
    expect(root.cyclic).toBe(false);
    expect(typeof root.callCount).toBe('number');
  });

  it('_tokenEstimate and _meta are present', async () => {
    const symbolId = findSymbolId('levelA', 'function');
    const rawResult = await getCallHierarchyHandler({
      repoId,
      symbolId,
      direction: 'callees',
    });

    const output = JSON.parse(
      (rawResult.content[0] as { type: string; text: string }).text,
    ) as GetCallHierarchyOutput;

    expect(output._tokenEstimate).toBeGreaterThan(0);
    expect(output._meta.timing_ms).toBeGreaterThanOrEqual(0);
    expect(output._meta.powered_by).toBe('PureContext MCP');
  });
});
