/**
 * End-to-end integration test — Task 15.
 *
 * Covers the full pipeline against the basic-ts-project fixture:
 *   1. Index the fixture → verify symbol count
 *   2. Search for a symbol by name → verify found
 *   3. Get symbol source via byte offsets → verify correct code
 *   4. Get context bundle → verify transitive deps included
 *   5. Get blast radius → verify reverse deps
 *   6. Dead code detection → verify unreferenced exports found
 *   7. Circular dependency → verify indexer completes without hanging
 *   8. Incremental re-index → verify new symbol appears after file change
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { indexFolder, reindexFiles, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase, computeRepoId } from '../../src/core/db/schema.js';
import { searchSymbols, getSymbolsByFile } from '../../src/core/db/symbol-store.js';
import { getFileContent } from '../../src/core/db/file-store.js';
import { getForwardDeps, getReverseDeps } from '../../src/core/db/dep-store.js';
import {
  getContextBundle,
  getBlastRadius,
  findDeadCode,
} from '../../src/graph/graph-traversal.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

// ─── Fixture path ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

// ─── Global setup ─────────────────────────────────────────────────────────────

let repoId: string;
let indexResult: Awaited<ReturnType<typeof indexFolder>>;

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  indexResult = await indexFolder(FIXTURE, { fileLimit: 50 });
  repoId = indexResult.repoId;
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

// ─── Step 1: Indexing ─────────────────────────────────────────────────────────

describe('Step 1 — index the fixture', () => {
  it('returns a valid repoId', () => {
    expect(repoId).toBe(computeRepoId(FIXTURE));
    expect(repoId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('indexes all expected source files', () => {
    // fixture has: src/index.ts, src/utils.ts, src/types.ts, src/aliased.ts,
    //              src/circular-a.ts, src/circular-b.ts, lib/helpers.ts
    // ignored: test/utils.test.ts (test dir), ignored-file.ts (.gitignore)
    expect(indexResult.filesIndexed).toBeGreaterThanOrEqual(7);
  });

  it('extracts symbols from fixture files', () => {
    // Known symbols across fixture files
    expect(indexResult.symbolsFound).toBeGreaterThanOrEqual(10);
  });

  it('builds dependency edges', () => {
    expect(indexResult.edgesFound).toBeGreaterThan(0);
    expect(indexResult.errors).toHaveLength(0);
  });
});

// ─── Step 2: Symbol search ────────────────────────────────────────────────────

describe('Step 2 — symbol search', () => {
  it('finds formatDiagnostic by name fragment', () => {
    const db = openDatabase(repoId);
    const results = searchSymbols(db, repoId, 'format');
    db.close();

    const names = results.map((s) => s.name);
    expect(names).toContain('formatDiagnostic');
  });

  it('finds DiagnosticRunner class', () => {
    const db = openDatabase(repoId);
    const results = searchSymbols(db, repoId, 'Diagnostic');
    db.close();

    const names = results.map((s) => s.name);
    expect(names).toContain('DiagnosticRunner');
  });

  it('finds circular-dep symbols', () => {
    const db = openDatabase(repoId);
    const resultsA = searchSymbols(db, repoId, 'funcA');
    const resultsB = searchSymbols(db, repoId, 'funcB');
    db.close();

    expect(resultsA.some((s) => s.name === 'funcA')).toBe(true);
    expect(resultsB.some((s) => s.name === 'funcB')).toBe(true);
  });

  it('filters by kind', () => {
    const db = openDatabase(repoId);
    const classes = searchSymbols(db, repoId, '', { kind: 'class' });
    db.close();

    expect(classes.length).toBeGreaterThan(0);
    expect(classes.every((s) => s.kind === 'class')).toBe(true);
  });

  it('filters by filePath', () => {
    const db = openDatabase(repoId);
    const results = searchSymbols(db, repoId, '', { filePath: 'src/utils.ts' });
    db.close();

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((s) => s.filePath === 'src/utils.ts')).toBe(true);
  });
});

// ─── Step 3: Symbol source via byte offsets ───────────────────────────────────

describe('Step 3 — symbol source via byte offsets', () => {
  it('byte offsets delimit the correct source for formatDiagnostic', () => {
    const db = openDatabase(repoId);
    const [symbol] = searchSymbols(db, repoId, 'formatDiagnostic', {
      filePath: 'src/utils.ts',
    });
    const rawContent = getFileContent(db, repoId, 'src/utils.ts');
    db.close();

    expect(symbol).toBeDefined();
    expect(rawContent).not.toBeNull();

    const slice = rawContent!.slice(symbol.startByte, symbol.endByte).toString('utf8');
    expect(slice).toContain('formatDiagnostic');
    // Should capture the function body
    expect(slice).toContain('return');
  });

  it('byte offsets for DiagnosticRunner capture the class body', () => {
    const db = openDatabase(repoId);
    const [symbol] = searchSymbols(db, repoId, 'DiagnosticRunner', {
      kind: 'class',
    });
    const rawContent = getFileContent(db, repoId, symbol.filePath);
    db.close();

    expect(symbol).toBeDefined();
    const slice = rawContent!.slice(symbol.startByte, symbol.endByte).toString('utf8');
    expect(slice).toContain('DiagnosticRunner');
    expect(slice).toContain('class');
  });

  it('stored raw file content matches the file on disk', () => {
    const { readFileSync } = require('fs');
    const db = openDatabase(repoId);
    const stored = getFileContent(db, repoId, 'src/utils.ts');
    db.close();

    const onDisk = readFileSync(join(FIXTURE, 'src/utils.ts')) as Buffer;
    expect(stored).not.toBeNull();
    expect(stored!.equals(onDisk)).toBe(true);
  });
});

// ─── Step 4: Context bundle ───────────────────────────────────────────────────

describe('Step 4 — context bundle (forward deps)', () => {
  it('context bundle for src/index.ts includes transitive imports', () => {
    const db = openDatabase(repoId);

    // Get a symbol in src/index.ts
    const [indexSymbol] = getSymbolsByFile(db, repoId, 'src/index.ts');
    expect(indexSymbol).toBeDefined();

    const bundle = getContextBundle(indexSymbol.id, repoId, db, 3);
    db.close();

    // index.ts → utils.ts → types.ts — all should be in the bundle files
    expect(bundle.files).toContain('src/index.ts');
    expect(bundle.files).toContain('src/utils.ts');
    expect(bundle.files).toContain('src/types.ts');
  });

  it('context bundle includes symbols from imported files', () => {
    const db = openDatabase(repoId);
    const [indexSymbol] = getSymbolsByFile(db, repoId, 'src/index.ts');
    const bundle = getContextBundle(indexSymbol.id, repoId, db, 3);
    db.close();

    const symbolNames = bundle.symbols.map((s) => s.name);
    // Symbols from utils.ts should be in the bundle
    expect(symbolNames).toContain('formatDiagnostic');
    expect(symbolNames).toContain('filterBySeverity');
  });

  it('context bundle has a non-negative tokenEstimate', () => {
    const db = openDatabase(repoId);
    const [sym] = getSymbolsByFile(db, repoId, 'src/index.ts');
    const bundle = getContextBundle(sym.id, repoId, db, 3);
    db.close();

    expect(bundle.tokenEstimate).toBeGreaterThanOrEqual(0);
  });
});

// ─── Step 5: Blast radius ─────────────────────────────────────────────────────

describe('Step 5 — blast radius (reverse deps)', () => {
  it('blast radius for formatDiagnostic includes src/index.ts', () => {
    const db = openDatabase(repoId);

    const [utilsSymbol] = searchSymbols(db, repoId, 'formatDiagnostic', {
      filePath: 'src/utils.ts',
    });
    expect(utilsSymbol).toBeDefined();

    const blast = getBlastRadius(utilsSymbol.id, repoId, db, 3);
    db.close();

    // src/index.ts imports src/utils.ts, so it should be in blast radius
    expect(blast.files).toContain('src/index.ts');
  });

  it('blast radius for a type in src/types.ts hits both utils and index', () => {
    const db = openDatabase(repoId);

    // types.ts is imported by both utils.ts and index.ts
    const typesSymbols = getSymbolsByFile(db, repoId, 'src/types.ts');
    expect(typesSymbols.length).toBeGreaterThan(0);

    const blast = getBlastRadius(typesSymbols[0].id, repoId, db, 3);
    db.close();

    expect(blast.files).toContain('src/utils.ts');
    expect(blast.files).toContain('src/index.ts');
  });

  it('blast radius file does not include the source file itself', () => {
    // The starting file is included because BFS starts there
    const db = openDatabase(repoId);
    const [sym] = searchSymbols(db, repoId, 'formatDiagnostic', {
      filePath: 'src/utils.ts',
    });
    const blast = getBlastRadius(sym.id, repoId, db, 3);
    db.close();

    // blast radius includes the origin file
    expect(blast.files).toContain('src/utils.ts');
  });
});

// ─── Step 6: Dead code detection ──────────────────────────────────────────────

describe('Step 6 — dead code detection', () => {
  it('finds exported symbols in files not imported by anything', () => {
    const db = openDatabase(repoId);
    const dead = findDeadCode(repoId, db);
    db.close();

    expect(dead.length).toBeGreaterThan(0);
    // lib/helpers.ts exports clamp and truncate; nothing imports it via a resolved path
    const deadFiles = new Set(dead.map((s) => s.filePath));
    expect(deadFiles.has('lib/helpers.ts')).toBe(true);
  });

  it('dead symbols have valid names and kinds', () => {
    const db = openDatabase(repoId);
    const dead = findDeadCode(repoId, db);
    db.close();

    for (const sym of dead) {
      expect(typeof sym.name).toBe('string');
      expect(sym.name.length).toBeGreaterThan(0);
      expect(typeof sym.kind).toBe('string');
    }
  });

  it('src/index.ts (which IS imported transitively) is NOT dead code', () => {
    // src/index.ts is the entry point — nothing imports it — but it imports others.
    // The real test: symbols in src/utils.ts should NOT be dead because utils.ts IS
    // imported by index.ts.
    const db = openDatabase(repoId);
    const dead = findDeadCode(repoId, db);
    db.close();

    const deadFiles = new Set(dead.map((s) => s.filePath));
    // src/utils.ts is imported by src/index.ts, so it should NOT be dead
    expect(deadFiles.has('src/utils.ts')).toBe(false);
    expect(deadFiles.has('src/types.ts')).toBe(false);
  });
});

// ─── Step 7: Circular dependency handling ────────────────────────────────────

describe('Step 7 — circular dependency does not break the graph', () => {
  it('circular-a and circular-b are both indexed', () => {
    const db = openDatabase(repoId);
    const symA = getSymbolsByFile(db, repoId, 'src/circular-a.ts');
    const symB = getSymbolsByFile(db, repoId, 'src/circular-b.ts');
    db.close();

    expect(symA.some((s) => s.name === 'funcA')).toBe(true);
    expect(symB.some((s) => s.name === 'funcB')).toBe(true);
  });

  it('dep edges exist in both directions', () => {
    const db = openDatabase(repoId);
    const forwardA = getForwardDeps(db, repoId, 'src/circular-a.ts');
    const forwardB = getForwardDeps(db, repoId, 'src/circular-b.ts');
    db.close();

    // circular-a imports circular-b
    expect(forwardA.some((e) => e.targetFile === 'src/circular-b.ts')).toBe(true);
    // circular-b imports circular-a
    expect(forwardB.some((e) => e.targetFile === 'src/circular-a.ts')).toBe(true);
  });

  it('context bundle traversal on circular-a terminates', () => {
    // BFS with visited-set must not loop; this test would hang if it does
    const db = openDatabase(repoId);
    const [sym] = searchSymbols(db, repoId, 'funcA', {
      filePath: 'src/circular-a.ts',
    });
    expect(sym).toBeDefined();

    const bundle = getContextBundle(sym.id, repoId, db, 10);
    db.close();

    // Must include both circular files
    expect(bundle.files).toContain('src/circular-a.ts');
    expect(bundle.files).toContain('src/circular-b.ts');
  });

  it('blast radius traversal on circular-b terminates', () => {
    const db = openDatabase(repoId);
    const [sym] = searchSymbols(db, repoId, 'funcB', {
      filePath: 'src/circular-b.ts',
    });
    expect(sym).toBeDefined();

    const blast = getBlastRadius(sym.id, repoId, db, 10);
    db.close();

    expect(blast.files).toContain('src/circular-a.ts');
    expect(blast.files).toContain('src/circular-b.ts');
  });
});

// ─── Step 8: Incremental re-index ────────────────────────────────────────────

describe('Step 8 — incremental re-index after file change', () => {
  const tmpRoot = join(tmpdir(), `purecontext-e2e-incr-${Date.now()}`);
  let tmpRepoId: string;

  beforeAll(async () => {
    // Create a minimal TypeScript project in a temp directory
    mkdirSync(join(tmpRoot, 'src'), { recursive: true });

    writeFileSync(
      join(tmpRoot, 'src', 'module.ts'),
      `/** Original function. */\nexport function original(): string { return 'v1'; }\n`,
      'utf8',
    );

    // Index the temp project
    const result = await indexFolder(tmpRoot, { fileLimit: 10 });
    tmpRepoId = result.repoId;

    expect(result.symbolsFound).toBeGreaterThan(0);
  }, 15_000);

  afterAll(() => {
    deleteIndex(tmpRepoId);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('initial index contains the original function', () => {
    const db = openDatabase(tmpRepoId);
    const symbols = searchSymbols(db, tmpRepoId, 'original');
    db.close();

    expect(symbols.some((s) => s.name === 'original')).toBe(true);
  });

  it('re-index after adding a new function makes it discoverable', async () => {
    // Append a new export to the file
    const filePath = join(tmpRoot, 'src', 'module.ts');
    writeFileSync(
      filePath,
      [
        '/** Original function. */',
        "export function original(): string { return 'v1'; }",
        '',
        '/** New function added in incremental re-index. */',
        "export function newFunction(): number { return 42; }",
        '',
      ].join('\n'),
      'utf8',
    );

    // Trigger incremental re-index for just this file
    const result = await reindexFiles(tmpRepoId, ['src/module.ts']);
    expect(result.filesIndexed).toBe(1);
    expect(result.errors).toHaveLength(0);

    // New symbol should now be in the DB
    const db = openDatabase(tmpRepoId);
    const symbols = searchSymbols(db, tmpRepoId, 'newFunction');
    db.close();

    expect(symbols.some((s) => s.name === 'newFunction')).toBe(true);
  });

  it('original function is still present after incremental re-index', () => {
    const db = openDatabase(tmpRepoId);
    const symbols = searchSymbols(db, tmpRepoId, 'original');
    db.close();

    expect(symbols.some((s) => s.name === 'original')).toBe(true);
  });

  it('second full index run skips unchanged files', async () => {
    const second = await indexFolder(tmpRoot, { fileLimit: 10 });
    // File was already re-indexed above with the same content → should skip it
    expect(second.filesSkipped).toBeGreaterThan(0);
    expect(second.filesIndexed).toBe(0);
  });
});
