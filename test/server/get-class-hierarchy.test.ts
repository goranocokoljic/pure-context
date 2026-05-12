/**
 * Tests for the get_class_hierarchy tool (Task 175).
 *
 * Fixture: test/fixtures/class-hierarchy-fixture/src/
 *   - animal.ts          — abstract class Animal (base)
 *   - dog.ts             — class Dog extends Animal
 *   - golden-retriever.ts — class GoldenRetriever extends Dog
 *   - cat.ts             — class Cat extends Animal
 *   - app-error.ts       — class AppError extends Error  (external base)
 *   - flyable.ts         — interface Flyable
 *   - bird.ts            — class Bird extends Animal implements Flyable
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
import { handler as getClassHierarchyHandler } from '../../src/server/tools/get-class-hierarchy.js';
import type { HierarchyNode } from '../../src/graph/graph-traversal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/class-hierarchy-fixture');

let repoId: string;

// Helper: find symbolId by exact name and kind
function findSymbolId(name: string, kind: string): string {
  const db = openDatabase(repoId);
  try {
    const results = searchSymbols(db, repoId, name, { kind: kind as 'class' | 'interface' });
    const match = results.find((s) => s.name === name);
    if (!match) throw new Error(`Symbol "${name}" (${kind}) not found in index`);
    return match.id;
  } finally {
    db.close();
  }
}

// Helper: collect all node names in a hierarchy (BFS)
function collectNames(root: HierarchyNode): string[] {
  const names: string[] = [];
  const queue: HierarchyNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    names.push(node.name);
    for (const child of node.children) {
      queue.push(child);
    }
  }
  return names;
}

// Helper: find a node by name in the hierarchy
function findNode(root: HierarchyNode, name: string): HierarchyNode | null {
  if (root.name === name) return root;
  for (const child of root.children) {
    const found = findNode(child, name);
    if (found) return found;
  }
  return null;
}

interface ClassHierarchyOutput {
  root: HierarchyNode;
  totalNodes: number;
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string };
}

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

// ─── Test: ancestors chain ────────────────────────────────────────────────────

describe('ancestors traversal', () => {
  it('GoldenRetriever ancestors chain: depth 2 (Dog → Animal)', async () => {
    const symbolId = findSymbolId('GoldenRetriever', 'class');
    const raw = await getClassHierarchyHandler({ repoId, symbolId, direction: 'ancestors' });
    expect(raw.isError).toBeFalsy();

    const output = JSON.parse((raw.content[0] as { text: string }).text) as ClassHierarchyOutput;
    expect(output.root.name).toBe('GoldenRetriever');
    expect(output.root.depth).toBe(0);

    const dogNode = findNode(output.root, 'Dog');
    expect(dogNode).not.toBeNull();
    expect(dogNode!.depth).toBe(-1);

    const animalNode = findNode(output.root, 'Animal');
    expect(animalNode).not.toBeNull();
    expect(animalNode!.depth).toBe(-2);
  });

  it('direction: "ancestors" returns no descendants', async () => {
    const symbolId = findSymbolId('GoldenRetriever', 'class');
    const raw = await getClassHierarchyHandler({ repoId, symbolId, direction: 'ancestors' });

    const output = JSON.parse((raw.content[0] as { text: string }).text) as ClassHierarchyOutput;
    const allNames = collectNames(output.root);
    // GoldenRetriever has no subclasses in the fixture; just verify no positive-depth nodes
    const hasDescendants = allNames.some((_, i) => {
      const node = findNode(output.root, allNames[i]!);
      return node !== null && node.depth > 0;
    });
    expect(hasDescendants).toBe(false);
  });

  it('Animal is abstract — isAbstract flag set', async () => {
    const symbolId = findSymbolId('GoldenRetriever', 'class');
    const raw = await getClassHierarchyHandler({ repoId, symbolId, direction: 'ancestors' });

    const output = JSON.parse((raw.content[0] as { text: string }).text) as ClassHierarchyOutput;
    const animalNode = findNode(output.root, 'Animal');
    expect(animalNode?.isAbstract).toBe(true);
  });
});

// ─── Test: descendants traversal ─────────────────────────────────────────────

describe('descendants traversal', () => {
  it('Animal descendants: Dog, Cat, Bird (and GoldenRetriever as Dog child)', async () => {
    const symbolId = findSymbolId('Animal', 'class');
    const raw = await getClassHierarchyHandler({ repoId, symbolId, direction: 'descendants' });
    expect(raw.isError).toBeFalsy();

    const output = JSON.parse((raw.content[0] as { text: string }).text) as ClassHierarchyOutput;
    const allNames = collectNames(output.root);
    expect(allNames).toContain('Dog');
    expect(allNames).toContain('Cat');
    expect(allNames).toContain('Bird');
    expect(allNames).toContain('GoldenRetriever');
  });

  it('GoldenRetriever appears under Dog in the descendants tree', async () => {
    const symbolId = findSymbolId('Animal', 'class');
    const raw = await getClassHierarchyHandler({ repoId, symbolId, direction: 'descendants' });

    const output = JSON.parse((raw.content[0] as { text: string }).text) as ClassHierarchyOutput;
    const dogNode = findNode(output.root, 'Dog');
    expect(dogNode).not.toBeNull();
    const grNode = dogNode!.children.find((c) => c.name === 'GoldenRetriever');
    expect(grNode).toBeDefined();
  });

  it('descendants have positive depth values', async () => {
    const symbolId = findSymbolId('Animal', 'class');
    const raw = await getClassHierarchyHandler({ repoId, symbolId, direction: 'descendants' });

    const output = JSON.parse((raw.content[0] as { text: string }).text) as ClassHierarchyOutput;
    const dogNode = findNode(output.root, 'Dog');
    expect(dogNode!.depth).toBe(1);
    const grNode = findNode(output.root, 'GoldenRetriever');
    expect(grNode!.depth).toBe(2);
  });

  it('direction: "descendants" on GoldenRetriever returns only root (no subclasses)', async () => {
    const symbolId = findSymbolId('GoldenRetriever', 'class');
    const raw = await getClassHierarchyHandler({ repoId, symbolId, direction: 'descendants' });

    const output = JSON.parse((raw.content[0] as { text: string }).text) as ClassHierarchyOutput;
    expect(output.root.children).toHaveLength(0);
    expect(output.totalNodes).toBe(1);
  });
});

// ─── Test: external base class ────────────────────────────────────────────────

describe('external base class', () => {
  it('AppError extends Error — Error appears as leaf with symbolId: null', async () => {
    const symbolId = findSymbolId('AppError', 'class');
    const raw = await getClassHierarchyHandler({ repoId, symbolId, direction: 'ancestors' });
    expect(raw.isError).toBeFalsy();

    const output = JSON.parse((raw.content[0] as { text: string }).text) as ClassHierarchyOutput;
    const errorNode = findNode(output.root, 'Error');
    expect(errorNode).not.toBeNull();
    expect(errorNode!.symbolId).toBeNull();
    expect(errorNode!.filePath).toBeNull();
    expect(errorNode!.depth).toBe(-1);
  });
});

// ─── Test: interface inclusion ─────────────────────────────────────────────────

describe('includeInterfaces', () => {
  it('Bird ancestors with includeInterfaces: true includes Flyable', async () => {
    const symbolId = findSymbolId('Bird', 'class');
    const raw = await getClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'ancestors',
      includeInterfaces: true,
    });
    expect(raw.isError).toBeFalsy();

    const output = JSON.parse((raw.content[0] as { text: string }).text) as ClassHierarchyOutput;
    const allNames = collectNames(output.root);
    expect(allNames).toContain('Animal');
    expect(allNames).toContain('Flyable');
  });

  it('Flyable interface node has isInterface: true', async () => {
    const symbolId = findSymbolId('Bird', 'class');
    const raw = await getClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'ancestors',
      includeInterfaces: true,
    });

    const output = JSON.parse((raw.content[0] as { text: string }).text) as ClassHierarchyOutput;
    const flyableNode = findNode(output.root, 'Flyable');
    expect(flyableNode).not.toBeNull();
    expect(flyableNode!.isInterface).toBe(true);
  });

  it('Bird implementedInterfaces includes Flyable', async () => {
    const symbolId = findSymbolId('Bird', 'class');
    const raw = await getClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'ancestors',
      includeInterfaces: true,
    });

    const output = JSON.parse((raw.content[0] as { text: string }).text) as ClassHierarchyOutput;
    expect(output.root.implementedInterfaces).toContain('Flyable');
  });

  it('Bird ancestors with includeInterfaces: false excludes Flyable', async () => {
    const symbolId = findSymbolId('Bird', 'class');
    const raw = await getClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'ancestors',
      includeInterfaces: false,
    });

    const output = JSON.parse((raw.content[0] as { text: string }).text) as ClassHierarchyOutput;
    const flyableNode = findNode(output.root, 'Flyable');
    expect(flyableNode).toBeNull();
    // But Animal should still be present
    expect(findNode(output.root, 'Animal')).not.toBeNull();
  });
});

// ─── Test: direction 'both' ───────────────────────────────────────────────────

describe('direction: both', () => {
  it('Dog with direction both: includes ancestor Animal and descendant GoldenRetriever', async () => {
    const symbolId = findSymbolId('Dog', 'class');
    const raw = await getClassHierarchyHandler({ repoId, symbolId, direction: 'both' });
    expect(raw.isError).toBeFalsy();

    const output = JSON.parse((raw.content[0] as { text: string }).text) as ClassHierarchyOutput;
    const allNames = collectNames(output.root);
    expect(allNames).toContain('Animal');        // ancestor
    expect(allNames).toContain('GoldenRetriever'); // descendant
  });
});

// ─── Test: maxDepth ───────────────────────────────────────────────────────────

describe('maxDepth', () => {
  it('maxDepth: 1 on GoldenRetriever ancestors → only Dog, not Animal', async () => {
    const symbolId = findSymbolId('GoldenRetriever', 'class');
    const raw = await getClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'ancestors',
      maxDepth: 1,
    });

    const output = JSON.parse((raw.content[0] as { text: string }).text) as ClassHierarchyOutput;
    expect(findNode(output.root, 'Dog')).not.toBeNull();
    expect(findNode(output.root, 'Animal')).toBeNull();
  });
});

// ─── Test: startLine populated ────────────────────────────────────────────────

describe('startLine', () => {
  it('root node has startLine >= 1', async () => {
    const symbolId = findSymbolId('Dog', 'class');
    const raw = await getClassHierarchyHandler({ repoId, symbolId, direction: 'ancestors' });

    const output = JSON.parse((raw.content[0] as { text: string }).text) as ClassHierarchyOutput;
    expect(output.root.startLine).toBeGreaterThanOrEqual(1);
  });

  it('external node has startLine: 0', async () => {
    const symbolId = findSymbolId('AppError', 'class');
    const raw = await getClassHierarchyHandler({ repoId, symbolId, direction: 'ancestors' });

    const output = JSON.parse((raw.content[0] as { text: string }).text) as ClassHierarchyOutput;
    const errorNode = findNode(output.root, 'Error');
    expect(errorNode!.startLine).toBe(0);
  });
});

// ─── Test: error cases ────────────────────────────────────────────────────────

describe('error cases', () => {
  it('unknown symbolId returns error', async () => {
    const raw = await getClassHierarchyHandler({
      repoId,
      symbolId: 'nonexistent000000',
      direction: 'both',
    });
    expect(raw.isError).toBe(true);
  });

  it('non-class/interface symbol returns error', async () => {
    // Find a function symbol
    const db = openDatabase(repoId);
    let funcId: string | undefined;
    try {
      const results = searchSymbols(db, repoId, 'speak', { kind: 'method' });
      funcId = results[0]?.id;
    } finally {
      db.close();
    }
    if (!funcId) return; // skip if no method found

    const raw = await getClassHierarchyHandler({
      repoId,
      symbolId: funcId,
      direction: 'both',
    });
    expect(raw.isError).toBe(true);
  });
});

// ─── Test: _meta and _tokenEstimate ──────────────────────────────────────────

describe('response metadata', () => {
  it('response includes _tokenEstimate and _meta', async () => {
    const symbolId = findSymbolId('Animal', 'class');
    const raw = await getClassHierarchyHandler({ repoId, symbolId, direction: 'descendants' });

    const output = JSON.parse((raw.content[0] as { text: string }).text) as ClassHierarchyOutput;
    expect(typeof output._tokenEstimate).toBe('number');
    expect(output._tokenEstimate).toBeGreaterThan(0);
    expect(output._meta).toBeDefined();
    expect(typeof output._meta.timing_ms).toBe('number');
  });
});
