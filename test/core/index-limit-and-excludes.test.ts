/**
 * Tasks 504 + 505 (Phase 82):
 *  - index_folder reports limitReached/totalBeforeLimit instead of truncating silently
 *  - JVM/Android build dirs (.gradle, .idea, nested build/generated) are excluded
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { discoverFiles } from '../../src/core/file-discovery.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { kotlinHandler } from '../../src/handlers/kotlin.js';
import { initParser } from '../../src/core/parse-dispatcher.js';

let root: string;
const repoIds: string[] = [];

function write(relPath: string, content: string) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(kotlinHandler);
  await initParser();

  root = resolve(mkdtempSync(join(tmpdir(), 'pc-limit-')));
  write('a.ts', 'export const a = 1;\n');
  write('b.ts', 'export const b = 2;\n');
  write('c.ts', 'export const c = 3;\n');
  write('d.ts', 'export const d = 4;\n');
}, 30_000);

afterAll(() => {
  for (const id of repoIds) deleteIndex(id);
  rmSync(root, { recursive: true, force: true });
});

describe('limitReached signal (Task 504)', () => {
  it('reports a hit file limit as structured fields + a warning', async () => {
    const result = await indexFolder(root, { fileLimit: 2 });
    repoIds.push(result.repoId);
    expect(result.limitReached).toBe(true);
    expect(result.totalBeforeLimit).toBe(4);
    expect(result.filesIndexed).toBe(2);
    expect(result.warnings.some((w) => w.includes('fileLimit'))).toBe(true);
  });

  it('reports limitReached: false when everything fits', async () => {
    const result = await indexFolder(root, { fileLimit: 50 });
    repoIds.push(result.repoId);
    expect(result.limitReached).toBe(false);
    expect(result.totalBeforeLimit).toBe(4);
    expect(result.warnings).toEqual([]);
  });
});

describe('JVM/Android excludes (Task 505)', () => {
  it('skips .gradle, .idea, and nested build/generated directories', () => {
    const jvmRoot = resolve(mkdtempSync(join(tmpdir(), 'pc-excl-')));
    try {
      const w = (rel: string, content: string) => {
        const abs = join(jvmRoot, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      };
      w('app/src/main/kotlin/com/example/Real.kt', 'package com.example\nclass Real\n');
      w('.gradle/caches/Cached.kt', 'class Cached\n');
      w('.idea/config/Ide.kt', 'class Ide\n');
      w('app/build/generated/source/Gen.kt', 'class Gen\n');
      w('app/build/intermediates/Inter.kt', 'class Inter\n');

      const { files } = discoverFiles(jvmRoot, { extensions: ['.kt'] });
      const paths = files.map((f) => f.path.replace(/\\/g, '/')).sort();
      expect(paths).toEqual(['app/src/main/kotlin/com/example/Real.kt']);
    } finally {
      rmSync(jvmRoot, { recursive: true, force: true });
    }
  });
});
