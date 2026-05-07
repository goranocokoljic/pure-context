/**
 * Tests for export_index and import_index tools (Task 168).
 *
 * Tests run against real SQLite databases in a temp directory to avoid
 * polluting ~/.purecontext.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ─── Redirect homedir so test DBs land in a temp dir ────────────────────────

vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return {
    ...orig,
    homedir: () => process.env['PURECONTEXT_TEST_HOME'] ?? orig.homedir(),
  };
});

// Import after mocks are set up
import { handler as exportHandler } from '../../src/server/tools/export-index.js';
import { handler as importHandler } from '../../src/server/tools/import-index.js';
import { PureContextError } from '../../src/core/errors.js';
import {
  openDatabase,
  computeRepoId,
  upsertRepo,
  SCHEMA_VERSION,
} from '../../src/core/db/schema.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import { upsertFile } from '../../src/core/db/file-store.js';
import { insertEdges } from '../../src/core/db/dep-store.js';
import type { SymbolRecord, DepEdge } from '../../src/core/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpHome(): string {
  const dir = join(tmpdir(), `pctx-export-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedRepo(tmpHome: string, repoPath: string): string {
  process.env['PURECONTEXT_TEST_HOME'] = tmpHome;
  const repoId = computeRepoId(repoPath);
  const db = openDatabase(repoId);
  try {
    upsertRepo(db, {
      id: repoId,
      rootPath: repoPath,
      symbolCount: 2,
      fileCount: 1,
      languages: ['typescript'],
      indexedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
      clonePath: null,
      tenantId: 'local',
    });

    const symbols: SymbolRecord[] = [
      {
        id: 'sym001',
        name: 'greet',
        kind: 'function',
        filePath: 'src/index.ts',
        startByte: 0,
        endByte: 50,
        signature: 'function greet(name: string): string',
        summary: 'Greet a user by name',
      },
      {
        id: 'sym002',
        name: 'Greeter',
        kind: 'class',
        filePath: 'src/index.ts',
        startByte: 52,
        endByte: 120,
        signature: 'class Greeter',
        summary: 'Greeter class',
      },
    ];
    insertSymbols(db, repoId, symbols);

    upsertFile(db, repoId, 'src/index.ts', 'abc123', Buffer.from('export function greet(name: string) { return name; }'));

    const edges: DepEdge[] = [
      {
        repoId,
        sourceFile: 'src/app.ts',
        sourceSymbolId: null,
        targetFile: 'src/index.ts',
        targetSymbolId: 'sym001',
        edgeType: 'import',
        specifier: './index',
      },
    ];
    insertEdges(db, edges);
  } finally {
    db.close();
  }
  return repoId;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('export_index + import_index', () => {
  let tmpHome: string;
  let bundleDir: string;

  beforeEach(() => {
    tmpHome = makeTmpHome();
    bundleDir = join(tmpHome, 'bundles');
    mkdirSync(bundleDir, { recursive: true });
    process.env['PURECONTEXT_TEST_HOME'] = tmpHome;
  });

  afterEach(() => {
    process.env['PURECONTEXT_TEST_HOME'] = undefined;
    if (existsSync(tmpHome)) {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('creates a bundle file at the specified output path', async () => {
    const repoPath = '/projects/my-app';
    const repoId = seedRepo(tmpHome, repoPath);
    const outputPath = join(bundleDir, 'my-app.pcx');

    const result = await exportHandler({ repoId, outputPath });

    expect(result.isError).toBeFalsy();
    expect(existsSync(outputPath)).toBe(true);

    const text = result.content[0];
    expect(text.type).toBe('text');
    const payload = JSON.parse((text as { type: 'text'; text: string }).text);
    expect(payload.outputPath).toBe(outputPath);
    expect(payload.symbolCount).toBe(2);
    expect(payload.fileCount).toBe(1);
    expect(payload.bundleSize).toBeGreaterThan(0);
  });

  it('imports and restores all symbols and files', async () => {
    const repoPath = '/projects/my-app';
    const repoId = seedRepo(tmpHome, repoPath);
    const outputPath = join(bundleDir, 'my-app.pcx');

    // Export
    await exportHandler({ repoId, outputPath });

    // Clear the index so import has something to restore
    const db = openDatabase(repoId);
    db.prepare('DELETE FROM symbols WHERE repo_id = ?').run(repoId);
    db.prepare('DELETE FROM files WHERE repo_id = ?').run(repoId);
    db.prepare('DELETE FROM dep_edges WHERE repo_id = ?').run(repoId);
    db.close();

    // Import
    const importResult = await importHandler({ bundlePath: outputPath, merge: true });
    expect(importResult.isError).toBeFalsy();

    const importText = importResult.content[0];
    expect(importText.type).toBe('text');
    const importPayload = JSON.parse((importText as { type: 'text'; text: string }).text);
    expect(importPayload.symbolCount).toBe(2);
    expect(importPayload.fileCount).toBe(1);
    expect(importPayload.alreadyExisted).toBe(false);

    // Verify symbols are in the DB
    const db2 = openDatabase(repoId);
    const syms = db2.prepare('SELECT * FROM symbols WHERE repo_id = ?').all(repoId);
    const files = db2.prepare('SELECT * FROM files WHERE repo_id = ?').all(repoId);
    db2.close();
    expect(syms).toHaveLength(2);
    expect(files).toHaveLength(1);
  });

  it('applies repoPath override on import', async () => {
    const originalPath = '/projects/my-app';
    const repoId = seedRepo(tmpHome, originalPath);
    const outputPath = join(bundleDir, 'my-app.pcx');
    await exportHandler({ repoId, outputPath });

    // Import with a different root path (simulating a different machine)
    const newRepoPath = '/home/user/repos/my-app';

    // Use merge=true so we re-import even if repo already exists
    const result = await importHandler({ bundlePath: outputPath, repoPath: newRepoPath, merge: true });
    const text = result.content[0];
    const payload = JSON.parse((text as { type: 'text'; text: string }).text);
    expect(payload.repoPath).toBe(newRepoPath);

    // Verify the repos table was updated
    const db = openDatabase(repoId);
    const row = db.prepare('SELECT root_path FROM repos WHERE id = ?').get(repoId) as { root_path: string } | undefined;
    db.close();
    expect(row?.root_path).toBe(newRepoPath);
  });

  it('rejects bundles with a version mismatch', async () => {
    const repoPath = '/projects/my-app';
    const repoId = seedRepo(tmpHome, repoPath);
    const outputPath = join(bundleDir, 'my-app.pcx');
    await exportHandler({ repoId, outputPath });

    // Decompress, tamper with version, recompress
    const { readFileSync, writeFileSync } = await import('fs');
    const { gunzipSync, gzipSync } = await import('zlib');
    const raw = readFileSync(outputPath);
    const json = gunzipSync(raw).toString('utf8');
    const bundle = JSON.parse(json);
    bundle.header.version = 999; // future/incompatible version
    const tampered = gzipSync(Buffer.from(JSON.stringify(bundle)));
    writeFileSync(outputPath, tampered);

    await expect(importHandler({ bundlePath: outputPath })).rejects.toThrow(PureContextError);
    await expect(importHandler({ bundlePath: outputPath })).rejects.toThrow('version mismatch');
  });

  it('skips import when repo already exists and merge is false (default)', async () => {
    const repoPath = '/projects/my-app';
    const repoId = seedRepo(tmpHome, repoPath);
    const outputPath = join(bundleDir, 'my-app.pcx');
    await exportHandler({ repoId, outputPath });

    // First import — should succeed
    const first = await importHandler({ bundlePath: outputPath });
    const firstText = JSON.parse((first.content[0] as { type: 'text'; text: string }).text);
    // Repo already existed from seed (merge=false → alreadyExisted=true)
    expect(firstText.alreadyExisted).toBe(true);
  });

  it('round-trip produces identical symbol count', async () => {
    const repoPath = '/projects/round-trip';
    const repoId = seedRepo(tmpHome, repoPath);
    const outputPath = join(bundleDir, 'round-trip.pcx');

    // Export
    const exportResult = await exportHandler({ repoId, outputPath });
    const exportPayload = JSON.parse(
      (exportResult.content[0] as { type: 'text'; text: string }).text,
    );
    const exportedSymbolCount = exportPayload.symbolCount as number;

    // Clear and re-import
    const db = openDatabase(repoId);
    db.prepare('DELETE FROM symbols WHERE repo_id = ?').run(repoId);
    db.prepare('DELETE FROM files WHERE repo_id = ?').run(repoId);
    db.close();

    await importHandler({ bundlePath: outputPath, merge: true });

    // Verify count matches
    const db2 = openDatabase(repoId);
    const count = (
      db2.prepare('SELECT COUNT(*) AS c FROM symbols WHERE repo_id = ?').get(repoId) as { c: number }
    ).c;
    db2.close();
    expect(count).toBe(exportedSymbolCount);
  });

  it('exports uncompressed bundle when compress is false', async () => {
    const repoPath = '/projects/my-app';
    const repoId = seedRepo(tmpHome, repoPath);
    const outputPath = join(bundleDir, 'my-app-raw.pcx');

    await exportHandler({ repoId, outputPath, compress: false });

    // Should be valid plain JSON (not gzipped)
    const { readFileSync } = await import('fs');
    const raw = readFileSync(outputPath).toString('utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.header.repoId).toBe(repoId);
  });

  it('imports plain (non-gzipped) bundle', async () => {
    const repoPath = '/projects/my-app';
    const repoId = seedRepo(tmpHome, repoPath);
    const outputPath = join(bundleDir, 'my-app-raw.pcx');

    await exportHandler({ repoId, outputPath, compress: false });

    // Clear and re-import
    const db = openDatabase(repoId);
    db.prepare('DELETE FROM symbols WHERE repo_id = ?').run(repoId);
    db.close();

    const result = await importHandler({ bundlePath: outputPath, merge: true });
    const payload = JSON.parse(
      (result.content[0] as { type: 'text'; text: string }).text,
    );
    expect(payload.symbolCount).toBe(2);
  });

  it('throws when bundle file does not exist', async () => {
    await expect(
      importHandler({ bundlePath: '/nonexistent/path/bundle.pcx' }),
    ).rejects.toThrow(PureContextError);
    await expect(
      importHandler({ bundlePath: '/nonexistent/path/bundle.pcx' }),
    ).rejects.toThrow('not found');
  });

  it('throws when exporting a non-existent repo', async () => {
    await expect(
      exportHandler({ repoId: 'deadbeefdeadbeef', outputPath: '/tmp/test.pcx' }),
    ).rejects.toThrow(PureContextError);
    await expect(
      exportHandler({ repoId: 'deadbeefdeadbeef', outputPath: '/tmp/test.pcx' }),
    ).rejects.toThrow('not found');
  });
});
