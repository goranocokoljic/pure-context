/**
 * Tests for the check_consistency tool (Phase 80, Task 483/485).
 *
 * Structural-only pre-write checks: dedup, pattern-fit, placement, api pointer,
 * and signalQuality suppression on a sparse index.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { handler as checkConsistency } from '../../src/server/tools/check-consistency.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

interface Output {
  mode: string;
  signalQuality: 'ok' | 'low';
  duplicates: Array<{ name: string; filePath: string; similarity: number; reasons: string[] }>;
  patternFit: Array<{ name: string; kind: string; filePath: string; reasons: string[] }>;
  placement: { intendedFilePath: string; fits: boolean; reasons: string[] } | null;
  existingApiPointer: { dir: string; symbols: string[] } | null;
  error?: string;
}

function parse(result: { content: { text: string }[] }): Output {
  return JSON.parse(result.content[0].text) as Output;
}

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();
}, 30_000);

describe('check_consistency — populated index', () => {
  let root: string;
  let repoId: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'pc-consistency-'));
    mkdirSync(join(root, 'src', 'connectors'), { recursive: true });
    mkdirSync(join(root, 'src', 'util'), { recursive: true });

    writeFileSync(
      join(root, 'src', 'connectors', 'copilot.ts'),
      'export class CopilotConnector { connect(): void {} }\n' +
        'export function parseExpenseRow(line: string): number { return line.length; }\n',
    );
    writeFileSync(
      join(root, 'src', 'connectors', 'cursor.ts'),
      'export class CursorConnector { connect(): void {} }\n',
    );
    // Padding so the index is not "sparse" (signalQuality === 'ok').
    const consts = Array.from({ length: 16 }, (_, i) => `export const PAD_${i} = ${i};`).join('\n');
    writeFileSync(join(root, 'src', 'util', 'consts.ts'), consts + '\n');

    root = resolve(root);
    const r = await indexFolder(root, { fileLimit: 50 });
    repoId = r.repoId;
  }, 30_000);

  afterAll(() => {
    deleteIndex(repoId);
    rmSync(root, { recursive: true, force: true });
  });

  it('mode is structural and signalQuality is ok', () => {
    const data = parse(checkConsistency({ repoId, name: 'somethingNew' }));
    expect(data.mode).toBe('structural');
    expect(data.signalQuality).toBe('ok');
  });

  it('flags an exact-name duplicate', () => {
    const data = parse(checkConsistency({ repoId, name: 'parseExpenseRow', kind: 'function' }));
    const hit = data.duplicates.find((d) => d.name === 'parseExpenseRow');
    expect(hit).toBeDefined();
    expect(hit!.similarity).toBe(1);
    expect(hit!.reasons.join(' ')).toMatch(/already exists/i);
  });

  it('surfaces sibling pattern-fit for a new connector', () => {
    const data = parse(
      checkConsistency({
        repoId,
        name: 'WindsurfConnector',
        kind: 'class',
        intendedFilePath: 'src/connectors/windsurf.ts',
      }),
    );
    const names = data.patternFit.map((p) => p.name);
    expect(names).toContain('CopilotConnector');
    expect(names).toContain('CursorConnector');
  });

  it('placement fits when the intended dir matches the sibling family', () => {
    const data = parse(
      checkConsistency({
        repoId,
        name: 'WindsurfConnector',
        kind: 'class',
        intendedFilePath: 'src/connectors/windsurf.ts',
      }),
    );
    expect(data.placement?.fits).toBe(true);
    expect(data.existingApiPointer?.dir).toBe('src/connectors');
    expect(data.existingApiPointer?.symbols).toContain('CopilotConnector');
  });

  it('placement does NOT fit when the intended dir diverges from siblings', () => {
    const data = parse(
      checkConsistency({
        repoId,
        name: 'WindsurfConnector',
        kind: 'class',
        intendedFilePath: 'src/wrong-place/windsurf.ts',
      }),
    );
    expect(data.placement?.fits).toBe(false);
    expect(data.placement?.reasons.join(' ')).toMatch(/connectors/);
  });
});

describe('check_consistency — sparse index suppresses dedup', () => {
  let root: string;
  let repoId: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'pc-consistency-sparse-'));
    writeFileSync(join(root, 'only.ts'), 'export function parseExpenseRow(): number { return 1; }\n');
    root = resolve(root);
    const r = await indexFolder(root, { fileLimit: 50 });
    repoId = r.repoId;
  }, 30_000);

  afterAll(() => {
    deleteIndex(repoId);
    rmSync(root, { recursive: true, force: true });
  });

  it('reports signalQuality low and makes no duplicate claims', () => {
    const data = parse(checkConsistency({ repoId, name: 'parseExpenseRow', kind: 'function' }));
    expect(data.signalQuality).toBe('low');
    expect(data.duplicates).toHaveLength(0);
  });
});
