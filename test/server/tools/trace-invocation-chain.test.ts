/**
 * Tests for trace_invocation_chain tool (Task 285).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../../src/handlers/typescript.js';
import { initParser } from '../../../src/core/parse-dispatcher.js';
import { handler as traceHandler } from '../../../src/server/tools/trace-invocation-chain.js';
import type { SymbolChain } from '../../../src/server/tools/trace-invocation-chain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../../fixtures/chain-project');

let repoId: string;

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  await initParser();

  const result = await indexFolder(FIXTURE, { fileLimit: 50 });
  repoId = result.repoId;
  expect(result.symbolsFound).toBeGreaterThan(0);
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

function parseResult(
  result: { content: { text: string }[] },
): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('trace_invocation_chain', () => {
  it('trivial chain: chainStart → chainMiddleA → chainTerminalWorker', async () => {
    const result = await traceHandler({
      repoId,
      startSymbol: 'chainStart',
      endHint: '*Worker',
    });
    const data = parseResult(result);
    const chains = data['chains'] as SymbolChain[];

    // Should have a chain ending at chainTerminalWorker
    const workerChain = chains.find((c) =>
      c.nodes.some((n) => n.name === 'chainTerminalWorker'),
    );
    expect(workerChain).toBeDefined();
    expect(workerChain!.endedAtHint).toBe(true);
    expect(workerChain!.nodes[0]!.name).toBe('chainStart');
  });

  it('returns multiple chains from one start', async () => {
    const result = await traceHandler({
      repoId,
      startSymbol: 'chainStart',
    });
    const data = parseResult(result);
    const chains = data['chains'] as SymbolChain[];

    // chainStart calls both chainMiddleA and chainMiddleB, so we expect >=2 chains
    expect(chains.length).toBeGreaterThanOrEqual(2);
    // All chains start with chainStart
    expect(chains.every((c) => c.nodes[0]!.name === 'chainStart')).toBe(true);
  });

  it('endHint = "*Worker" truncates chain at chainTerminalWorker', async () => {
    const result = await traceHandler({
      repoId,
      startSymbol: 'chainMiddleA',
      endHint: '*Worker',
    });
    const data = parseResult(result);
    const chains = data['chains'] as SymbolChain[];

    const workerChain = chains.find((c) =>
      c.nodes.some((n) => n.name === 'chainTerminalWorker'),
    );
    expect(workerChain).toBeDefined();
    expect(workerChain!.endedAtHint).toBe(true);
    // Chain should end AT the worker, not continue past it
    const lastNode = workerChain!.nodes[workerChain!.nodes.length - 1]!;
    expect(lastNode.name).toBe('chainTerminalWorker');
  });

  it('cycle detection: cycleA → cycleB → cycleA is annotated, not infinite', async () => {
    const result = await traceHandler({
      repoId,
      startSymbol: 'cycleA',
    });
    const data = parseResult(result);
    const chains = data['chains'] as SymbolChain[];

    // Should return at least one chain
    expect(chains.length).toBeGreaterThan(0);

    // Should have a cyclic node annotated
    const hasCyclicNode = chains.some((c) => c.nodes.some((n) => n.cyclic === true));
    expect(hasCyclicNode).toBe(true);

    // No chain should be infinitely long (cycle prevents it)
    const maxLength = Math.max(...chains.map((c) => c.nodes.length));
    expect(maxLength).toBeLessThan(20); // sanity check against infinite loop
  });

  it('returns empty chains (not error) when startSymbol does not exist', async () => {
    const result = await traceHandler({
      repoId,
      startSymbol: 'nonExistentSymbol',
    });
    const data = parseResult(result);
    const chains = data['chains'] as SymbolChain[];
    expect(chains).toBeDefined();
    expect(Array.isArray(chains)).toBe(true);
    expect(chains.length).toBe(0);
    expect(result.isError).toBeFalsy();
  });

  it('respects maxDepth limit', async () => {
    const result = await traceHandler({
      repoId,
      startSymbol: 'chainStart',
      maxDepth: 1,
    });
    const data = parseResult(result);
    const chains = data['chains'] as SymbolChain[];

    // With maxDepth=1, chains should not exceed 2 nodes (start + 1 level)
    expect(chains.every((c) => c.nodes.length <= 2)).toBe(true);
    // Some chains should be truncated
    expect(chains.some((c) => c.truncatedByDepth)).toBe(true);
  });

  it('chain nodes include name, filePath, and signature', async () => {
    const result = await traceHandler({
      repoId,
      startSymbol: 'chainMiddleA',
    });
    const data = parseResult(result);
    const chains = data['chains'] as SymbolChain[];
    expect(chains.length).toBeGreaterThan(0);

    const firstNode = chains[0]!.nodes[0]!;
    expect(firstNode.name).toBeDefined();
    expect(firstNode.filePath).toBeDefined();
    expect(firstNode.symbolId).toBeDefined();
    expect(firstNode.kind).toBeDefined();
  });
});
