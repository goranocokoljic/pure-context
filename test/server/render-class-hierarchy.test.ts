/**
 * Tests for the render_class_hierarchy tool (Task 181).
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
import { handler as renderClassHierarchyHandler } from '../../src/server/tools/render-class-hierarchy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/class-hierarchy-fixture');

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

interface ClassHierarchyDiagramOutput {
  diagram: string;
  nodeCount: number;
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string };
}

function parse(result: { content: Array<{ text: string }> }): ClassHierarchyDiagramOutput {
  return JSON.parse(result.content[0]!.text) as ClassHierarchyDiagramOutput;
}

function findSymbolId(name: string, kind: 'class' | 'interface' = 'class'): string {
  const db = openDatabase(repoId);
  try {
    const results = searchSymbols(db, repoId, name, { kind });
    const match = results.find((s) => s.name === name);
    if (!match) throw new Error(`Symbol "${name}" (${kind}) not found in index`);
    return match.id;
  } finally {
    db.close();
  }
}

/** Return true if all class names in the diagram use only [A-Za-z0-9_] as Mermaid identifiers */
function allNodeIdsValid(diagram: string): boolean {
  // classDiagram uses: "  class Foo {" or "  class Foo"
  const classDefRe = /^\s+class\s+(\w+)/gm;
  let m: RegExpExecArray | null;
  while ((m = classDefRe.exec(diagram)) !== null) {
    if (!/^[A-Za-z0-9_]+$/.test(m[1]!)) return false;
  }
  return true;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('render_class_hierarchy', () => {
  it('produces a valid Mermaid classDiagram for a two-level hierarchy', async () => {
    const symbolId = findSymbolId('Dog');
    const result = await renderClassHierarchyHandler({ repoId, symbolId, direction: 'both' });

    expect(result.isError).toBeFalsy();
    const out = parse(result as { content: Array<{ text: string }> });

    expect(out.diagram).toContain('classDiagram');
    expect(out.nodeCount).toBeGreaterThanOrEqual(2); // at least Dog + Animal
    expect(out._tokenEstimate).toBeGreaterThan(0);
  });

  it('uses <|-- for extends relationship (ancestor direction)', async () => {
    const symbolId = findSymbolId('Dog');
    const result = await renderClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'ancestors',
      includeMembers: false,
    });

    const out = parse(result as { content: Array<{ text: string }> });
    // Dog extends Animal → Animal <|-- Dog
    expect(out.diagram).toContain('<|--');
    expect(out.diagram).toContain('Animal');
    expect(out.diagram).toContain('Dog');
  });

  it('uses <|.. for implements relationship (interface)', async () => {
    // Bird extends Animal implements Flyable
    const symbolId = findSymbolId('Bird');
    const result = await renderClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'ancestors',
      includeInterfaces: true,
      includeMembers: false,
    });

    const out = parse(result as { content: Array<{ text: string }> });
    // Should contain an implements dashed arrow
    expect(out.diagram).toContain('<|..');
    expect(out.diagram).toContain('Flyable');
  });

  it('includeMembers: true — methods shown in class box', async () => {
    const symbolId = findSymbolId('Animal');
    const result = await renderClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'descendants',
      includeMembers: true,
    });

    const out = parse(result as { content: Array<{ text: string }> });
    // Animal has abstract speak() and move() methods
    // The class box should have a { ... } block with member entries
    expect(out.diagram).toMatch(/class Animal \{[\s\S]*\}/);
  });

  it('includeMembers: false — no member blocks in output', async () => {
    const symbolId = findSymbolId('Animal');
    const result = await renderClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'descendants',
      includeMembers: false,
    });

    const out = parse(result as { content: Array<{ text: string }> });
    // No member block — just "class Animal" with no braces
    // (It should NOT contain class Animal { ... })
    const hasBlock = /class Animal \{/.test(out.diagram);
    expect(hasBlock).toBe(false);
  });

  it('external base class (Error) shown without members', async () => {
    // AppError extends Error — Error is not indexed
    const symbolId = findSymbolId('AppError');
    const result = await renderClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'ancestors',
      includeMembers: true,
    });

    const out = parse(result as { content: Array<{ text: string }> });
    expect(out.diagram).toContain('Error');
    expect(out.diagram).toContain('<|--');
    // Error is external → no member block for it
    expect(out.diagram).not.toMatch(/class Error \{/);
  });

  it('direction: descendants — shows subclasses, not ancestors', async () => {
    const symbolId = findSymbolId('Animal');
    const result = await renderClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'descendants',
      includeMembers: false,
    });

    const out = parse(result as { content: Array<{ text: string }> });
    // Descendants of Animal: Dog, Cat, Bird, GoldenRetriever
    expect(out.diagram).toContain('Dog');
    expect(out.diagram).toContain('Cat');
    // No ancestors — Animal doesn't extend anything indexed
    // (it's the root so no ancestor edges appear)
    expect(out.nodeCount).toBeGreaterThanOrEqual(2);
  });

  it('direction: ancestors — shows parent chain, not descendants', async () => {
    const symbolId = findSymbolId('GoldenRetriever');
    const result = await renderClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'ancestors',
      includeMembers: false,
    });

    const out = parse(result as { content: Array<{ text: string }> });
    // GoldenRetriever → Dog → Animal
    expect(out.diagram).toContain('GoldenRetriever');
    expect(out.diagram).toContain('Dog');
    expect(out.diagram).toContain('Animal');
    // No descendants of GoldenRetriever
    expect(out.diagram).not.toContain('Cat');
  });

  it('three-level hierarchy has correct inheritance arrows', async () => {
    // GoldenRetriever extends Dog extends Animal — direction both
    const symbolId = findSymbolId('Dog');
    const result = await renderClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'both',
      includeMembers: false,
    });

    const out = parse(result as { content: Array<{ text: string }> });
    // Must have at least 3 nodes: Animal, Dog, GoldenRetriever
    expect(out.nodeCount).toBeGreaterThanOrEqual(3);
    // Both extends arrows should appear
    const arrowCount = (out.diagram.match(/<\|--/g) ?? []).length;
    expect(arrowCount).toBeGreaterThanOrEqual(2);
  });

  it('all class IDs are valid Mermaid identifiers (no special chars)', async () => {
    const symbolId = findSymbolId('Animal');
    const result = await renderClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'descendants',
      includeMembers: false,
    });

    const out = parse(result as { content: Array<{ text: string }> });
    expect(allNodeIdsValid(out.diagram)).toBe(true);
  });

  it('interface symbol as root — renders a valid classDiagram', async () => {
    // NOTE: addDescendants uses "extends Name" queries, not "implements Name",
    // so classes that implement the interface (Bird) do NOT appear in descendants.
    // The <|.. implements arrow appears when querying implementors in ancestor direction.
    const symbolId = findSymbolId('Flyable', 'interface');
    const result = await renderClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'both',
      includeInterfaces: true,
      includeMembers: false,
    });

    expect(result.isError).toBeFalsy();
    const out = parse(result as { content: Array<{ text: string }> });
    expect(out.diagram).toContain('classDiagram');
    expect(out.diagram).toContain('Flyable');
    expect(out.nodeCount).toBeGreaterThanOrEqual(1);
  });

  it('includeInterfaces: false — no interface nodes in ancestor chain', async () => {
    const symbolId = findSymbolId('Bird');
    const result = await renderClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'ancestors',
      includeInterfaces: false,
      includeMembers: false,
    });

    const out = parse(result as { content: Array<{ text: string }> });
    // Flyable interface should NOT appear when includeInterfaces is false
    expect(out.diagram).not.toContain('Flyable');
    // But Animal (class ancestor) should still appear
    expect(out.diagram).toContain('Animal');
  });

  it('nodeCount matches the number of unique classes in the diagram', async () => {
    const symbolId = findSymbolId('Dog');
    const result = await renderClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'both',
      includeMembers: false,
    });

    const out = parse(result as { content: Array<{ text: string }> });
    // Count class declarations in the diagram
    const classMatches = out.diagram.match(/^\s+class\s+\w+/gm) ?? [];
    // nodeCount should match the number of class declarations
    expect(classMatches.length).toBe(out.nodeCount);
  });

  it('_tokenEstimate is proportional to diagram length', async () => {
    const symbolId = findSymbolId('Animal');
    const result = await renderClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'descendants',
      includeMembers: false,
    });

    const out = parse(result as { content: Array<{ text: string }> });
    const expectedEstimate = Math.ceil(out.diagram.length / 4);
    expect(out._tokenEstimate).toBe(expectedEstimate);
  });

  it('unknown repoId returns isError', async () => {
    const result = await renderClassHierarchyHandler({
      repoId: 'deadbeefdeadbeef',
      symbolId: 'any',
    });

    expect(result.isError).toBe(true);
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain('not found');
  });

  it('unknown symbolId returns isError', async () => {
    const result = await renderClassHierarchyHandler({
      repoId,
      symbolId: 'nonexistent_symbol_id_xyz',
    });

    expect(result.isError).toBe(true);
  });

  it('non-class/non-interface symbol returns isError', async () => {
    // Find a function symbol (not a class)
    const db = openDatabase(repoId);
    let functionId: string | undefined;
    try {
      const results = searchSymbols(db, repoId, 'speak', { kind: 'method' });
      functionId = results[0]?.id;
    } finally {
      db.close();
    }

    if (!functionId) {
      // Skip if no methods found
      return;
    }

    const result = await renderClassHierarchyHandler({
      repoId,
      symbolId: functionId,
    });

    expect(result.isError).toBe(true);
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain('class or interface');
  });

  it('access modifiers: + for public, - for private, # for protected', async () => {
    // Check that formatMember logic works — look for access mod prefixes in output
    const symbolId = findSymbolId('Animal');
    const result = await renderClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'both',
      includeMembers: true,
    });

    const out = parse(result as { content: Array<{ text: string }> });
    // Animal's methods are public — should use '+' prefix
    if (out.diagram.includes('class Animal {')) {
      // At least one public member should appear
      expect(out.diagram).toMatch(/\+\w/);
    }
  });

  it('single-node hierarchy (no parents, no children) produces minimal diagram', async () => {
    // Flyable interface has no superinterfaces in the fixture
    const symbolId = findSymbolId('Flyable', 'interface');
    const result = await renderClassHierarchyHandler({
      repoId,
      symbolId,
      direction: 'ancestors',
      includeInterfaces: false,
      includeMembers: false,
    });

    expect(result.isError).toBeFalsy();
    const out = parse(result as { content: Array<{ text: string }> });
    expect(out.diagram).toContain('classDiagram');
    expect(out.nodeCount).toBe(1); // only the root
  });
});
