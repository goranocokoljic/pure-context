/**
 * Tests for the index_file tool (Phase 80, Task 479).
 *
 * The targeted single-file re-index path: re-parse one file and replace only its
 * rows, without the full-tree discovery pass. Covers parity with index_folder,
 * deletion handling, unparseable degradation, and stale-row clearing when an edit
 * removes a file's last symbol.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, relative, sep } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as indexFileHandler } from '../../src/server/tools/index-file.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { getSymbolsByFile } from '../../src/core/db/symbol-store.js';

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();
}, 30_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface IndexFileOutput {
  repoId: string;
  filesIndexed: number;
  filesDeleted: number;
  filesSkipped: number;
  symbolsFound: number;
  edgesFound: number;
  errors: Array<{ file: string; message: string }>;
  error?: string;
  _meta?: { timing_ms: number; powered_by: string };
}

function parseResult(result: { content: { text: string }[]; isError?: boolean }): IndexFileOutput {
  return JSON.parse(result.content[0].text) as IndexFileOutput;
}

function relPathOf(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

function fileSymbolNames(repoId: string, relPath: string): string[] {
  const db = openDatabase(repoId);
  try {
    return getSymbolsByFile(db, repoId, relPath).map((s) => s.name).sort();
  } finally {
    db.close();
  }
}

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc-index-file-'));
  writeFileSync(
    join(dir, 'index.ts'),
    'export function existing(): number { return 1; }\n',
  );
  return resolve(dir);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('index_file — unknown repo', () => {
  it('returns an isError result for an unknown repoId (no throw)', async () => {
    const result = await indexFileHandler({ repoId: 'deadbeefdeadbeef', filePaths: ['x.ts'] });
    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toMatch(/not found/i);
  });
});

describe('index_file — add + parity with index_folder', () => {
  let root: string;
  let repoId: string;

  beforeAll(async () => {
    root = makeTempProject();
    const r = await indexFolder(root, { fileLimit: 50 });
    repoId = r.repoId;
  }, 30_000);

  afterAll(() => {
    deleteIndex(repoId);
    rmSync(root, { recursive: true, force: true });
  });

  it('indexes a brand-new file via the targeted path', async () => {
    const newAbs = join(root, 'widget.ts');
    writeFileSync(
      newAbs,
      'export function buildWidget(): string { return "w"; }\n' +
        'export class WidgetFactory { make(): number { return 2; } }\n',
    );

    const result = await indexFileHandler({ repoId, filePaths: [newAbs] });
    const data = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(data.filesIndexed).toBe(1);
    expect(data.symbolsFound).toBeGreaterThan(0);

    const names = fileSymbolNames(repoId, relPathOf(root, newAbs));
    expect(names).toContain('buildWidget');
  });

  it('produces the same rows for that file as a full index_folder (parity)', async () => {
    const newRel = 'widget.ts';
    const afterTargeted = fileSymbolNames(repoId, newRel);

    // A full re-index must yield an identical symbol set for that file.
    await indexFolder(root, { fileLimit: 50 });
    const afterFull = fileSymbolNames(repoId, newRel);

    expect(afterTargeted).toEqual(afterFull);
  }, 30_000);
});

describe('index_file — deletion', () => {
  let root: string;
  let repoId: string;

  beforeAll(async () => {
    root = makeTempProject();
    writeFileSync(join(root, 'doomed.ts'), 'export function doomed(): void {}\n');
    const r = await indexFolder(root, { fileLimit: 50 });
    repoId = r.repoId;
  }, 30_000);

  afterAll(() => {
    deleteIndex(repoId);
    rmSync(root, { recursive: true, force: true });
  });

  it('removes a file’s rows when the path no longer exists on disk', async () => {
    const abs = join(root, 'doomed.ts');
    const rel = relPathOf(root, abs);
    expect(fileSymbolNames(repoId, rel)).toContain('doomed');

    unlinkSync(abs);
    const result = await indexFileHandler({ repoId, filePaths: [abs] });
    const data = parseResult(result);

    expect(data.filesDeleted).toBe(1);
    expect(fileSymbolNames(repoId, rel)).toHaveLength(0);
  });
});

describe('index_file — stale-row clearing when a file is emptied', () => {
  let root: string;
  let repoId: string;

  beforeAll(async () => {
    root = makeTempProject();
    writeFileSync(join(root, 'shrink.ts'), 'export function willVanish(): void {}\n');
    const r = await indexFolder(root, { fileLimit: 50 });
    repoId = r.repoId;
  }, 30_000);

  afterAll(() => {
    deleteIndex(repoId);
    rmSync(root, { recursive: true, force: true });
  });

  it('clears stale symbols when an edit removes the file’s last symbol', async () => {
    const abs = join(root, 'shrink.ts');
    const rel = relPathOf(root, abs);
    expect(fileSymbolNames(repoId, rel)).toContain('willVanish');

    // Overwrite with content that has no symbols.
    writeFileSync(abs, '// just a comment now\n');
    const result = await indexFileHandler({ repoId, filePaths: [abs] });
    expect(result.isError).toBeUndefined();

    expect(fileSymbolNames(repoId, rel)).toHaveLength(0);
  });
});

describe('index_file — unparseable file degrades gracefully', () => {
  let root: string;
  let repoId: string;

  beforeAll(async () => {
    root = makeTempProject();
    const r = await indexFolder(root, { fileLimit: 50 });
    repoId = r.repoId;
  }, 30_000);

  afterAll(() => {
    deleteIndex(repoId);
    rmSync(root, { recursive: true, force: true });
  });

  it('never throws on a broken file and indexes 0 symbols for it', async () => {
    const abs = join(root, 'broken.ts');
    writeFileSync(abs, 'export function (((( {{{{ <<<< not valid typescript\n');

    const result = await indexFileHandler({ repoId, filePaths: [abs] });
    const data = parseResult(result);

    // Must not throw; the file simply yields no symbols.
    expect(result.isError).toBeUndefined();
    expect(fileSymbolNames(repoId, relPathOf(root, abs))).toHaveLength(0);
    expect(typeof data.durationMs).toBe('number');
  });
});

describe('index_file — batch of mixed changed + deleted', () => {
  let root: string;
  let repoId: string;

  beforeAll(async () => {
    root = makeTempProject();
    writeFileSync(join(root, 'gone.ts'), 'export function gone(): void {}\n');
    const r = await indexFolder(root, { fileLimit: 50 });
    repoId = r.repoId;
  }, 30_000);

  afterAll(() => {
    deleteIndex(repoId);
    rmSync(root, { recursive: true, force: true });
  });

  it('handles a changed file and a deleted file in one call', async () => {
    const changed = join(root, 'added.ts');
    writeFileSync(changed, 'export const ADDED = 42;\n');
    const deleted = join(root, 'gone.ts');
    unlinkSync(deleted);

    const result = await indexFileHandler({ repoId, filePaths: [changed, deleted] });
    const data = parseResult(result);

    expect(data.filesIndexed).toBe(1);
    expect(data.filesDeleted).toBe(1);
    expect(fileSymbolNames(repoId, relPathOf(root, changed))).toContain('ADDED');
    expect(fileSymbolNames(repoId, relPathOf(root, deleted))).toHaveLength(0);
  });
});
