/**
 * Phase 108 — a resolver-config change re-resolves the WHOLE graph.
 *
 * The kurirfe report: a Nuxt repo whose root tsconfig is only
 * `{ "extends": "./.nuxt/tsconfig.json" }` had 420 edges for 1,012 files.
 * Fixing alias resolution alone was not enough — a whole-tree run skips
 * unchanged files, so their import records kept the pre-fix (null) targets.
 * The resolver now carries a config stamp; when it differs from the stored
 * one, the next run re-resolves every stored import record.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { indexFolder, reindexFiles } from '../../src/core/index-manager.js';
import { openDatabase, getResolverStamp } from '../../src/core/db/schema.js';
import { getAllDepEdges } from '../../src/core/db/dep-store.js';
import { registerHandler } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';

registerHandler(typescriptHandler);

let dir: string;
let repoId: string;

function edgePairs(): Array<[string, string]> {
  const db = openDatabase(repoId);
  try {
    return getAllDepEdges(db, repoId)
      .map((e) => [e.sourceFile, e.targetFile] as [string, string])
      .sort((a, b) => a[0].localeCompare(b[0]));
  } finally {
    db.close();
  }
}

function stamp(): string | null {
  const db = openDatabase(repoId);
  try {
    return getResolverStamp(db, repoId);
  } finally {
    db.close();
  }
}

describe('resolver config stamp → full edge re-resolve', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pctx-resolver-stamp-'));
    mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'src', 'lib', 'a.ts'), 'export const A = 1;\n');
    writeFileSync(join(dir, 'src', 'b.ts'), "import { A } from '@/lib/a';\nexport const B = A + 1;\n");
    writeFileSync(join(dir, 'src', 'c.ts'), "import { B } from './b';\nexport const C = B + 1;\n");
    const result = await indexFolder(dir);
    repoId = result.repoId;
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('without a tsconfig the alias import yields no edge, and a stamp is stored', () => {
    expect(edgePairs()).toEqual([['src/c.ts', 'src/b.ts']]);
    expect(stamp()).not.toBeNull();
  });

  it('adding a tsconfig alias re-resolves unchanged files on the next whole-tree run', async () => {
    const before = stamp();
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    );
    await indexFolder(dir); // no .ts file changed
    expect(edgePairs()).toEqual([
      ['src/b.ts', 'src/lib/a.ts'],
      ['src/c.ts', 'src/b.ts'],
    ]);
    expect(stamp()).not.toBe(before);
  });

  it('a no-op run keeps the stamp and the edges', async () => {
    const before = stamp();
    await indexFolder(dir);
    expect(stamp()).toBe(before);
    expect(edgePairs()).toEqual([
      ['src/b.ts', 'src/lib/a.ts'],
      ['src/c.ts', 'src/b.ts'],
    ]);
  });

  it('a tsconfig edit seen by a targeted re-index also re-resolves the whole graph', async () => {
    // Point the alias somewhere else: the b → a edge must disappear even
    // though only c.ts is re-indexed.
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['nowhere/*'] } } }),
    );
    writeFileSync(join(dir, 'src', 'c.ts'), "import { B } from './b';\nexport const C = B + 2;\n");
    await reindexFiles(repoId, ['src/c.ts']);
    expect(edgePairs()).toEqual([['src/c.ts', 'src/b.ts']]);
  });

  it('the extends chain is part of the stamp', async () => {
    writeFileSync(join(dir, 'base.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }));
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ extends: './base.json' }));
    await indexFolder(dir);
    expect(edgePairs()).toEqual([
      ['src/b.ts', 'src/lib/a.ts'],
      ['src/c.ts', 'src/b.ts'],
    ]);
    const before = stamp();
    // Edit only the PARENT config: the alias target moves, the root file is untouched.
    writeFileSync(join(dir, 'base.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['nowhere/*'] } } }));
    await indexFolder(dir);
    expect(stamp()).not.toBe(before);
    expect(edgePairs()).toEqual([['src/c.ts', 'src/b.ts']]);
  });
});
