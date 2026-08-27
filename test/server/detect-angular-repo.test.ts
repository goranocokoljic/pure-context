/**
 * Phase 94 (Task 588 / A-10) — repo-evidence Angular detection.
 * The flag comes from the files table (angular.json or ≥3 .component.ts),
 * never from the current search's candidate pool.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import {
  detectAngularRepo,
  _clearAngularRepoCacheForTesting,
} from '../../src/server/tools/search-symbols.js';

let ngRoot: string;
let nestRoot: string;
let ngRepoId: string;
let nestRepoId: string;

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  await initParser();
  _clearAngularRepoCacheForTesting();

  // Angular-shaped repo: 3 .component.ts files.
  ngRoot = join(tmpdir(), `purecontext-ngdetect-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(ngRoot, 'src'), { recursive: true });
  for (const n of ['home', 'list', 'detail']) {
    writeFileSync(join(ngRoot, 'src', `${n}.component.ts`), `export class C${n} {}`);
  }
  ngRepoId = (await indexFolder(ngRoot)).repoId;

  // NestJS-shaped repo: .module.ts + .service.ts but ZERO .component.ts.
  nestRoot = join(tmpdir(), `purecontext-nestdetect-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(nestRoot, 'src'), { recursive: true });
  writeFileSync(join(nestRoot, 'src', 'app.module.ts'), `export class AppModule {}`);
  writeFileSync(join(nestRoot, 'src', 'app.service.ts'), `export class AppService {}`);
  nestRepoId = (await indexFolder(nestRoot)).repoId;
}, 30_000);

afterAll(() => {
  if (ngRepoId) deleteIndex(ngRepoId);
  if (nestRepoId) deleteIndex(nestRepoId);
  rmSync(ngRoot, { recursive: true, force: true });
  rmSync(nestRoot, { recursive: true, force: true });
});

describe('detectAngularRepo', () => {
  it('true for a repo with ≥3 .component.ts files', () => {
    const db = openDatabase(ngRepoId);
    expect(detectAngularRepo(db, ngRepoId)).toBe(true);
    db.close();
  });

  it('false for a NestJS-shaped repo (.module.ts does not count — the A-10 leak)', () => {
    const db = openDatabase(nestRepoId);
    expect(detectAngularRepo(db, nestRepoId)).toBe(false);
    db.close();
  });

  it('memoizes per repoId', () => {
    const db = openDatabase(ngRepoId);
    expect(detectAngularRepo(db, ngRepoId)).toBe(true);
    // Second call must not need the DB at all.
    const throwingDb = { prepare(): never { throw new Error('no query expected'); } };
    expect(detectAngularRepo(throwingDb as never, ngRepoId)).toBe(true);
    db.close();
  });
});
