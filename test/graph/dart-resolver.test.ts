/**
 * Phase 98, Task 610 — Dart `package:` import resolver (pubspec name → lib/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDartResolver, isDartSourceFile } from '../../src/graph/dart-resolver.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { upsertFile } from '../../src/core/db/file-store.js';

const REPO = 'darttest1';

function seedDb(root: string) {
  const db = openInMemoryDatabase();
  upsertRepo(db, {
    id: REPO,
    rootPath: root,
    symbolCount: 0,
    fileCount: 0,
    languages: [],
    indexedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
    clonePath: null,
    tenantId: 'local',
  });
  return db;
}

describe('isDartSourceFile', () => {
  it('accepts .dart only', () => {
    expect(isDartSourceFile('lib/a.dart')).toBe(true);
    expect(isDartSourceFile('lib/a.ts')).toBe(false);
  });
});

describe('createDartResolver', () => {
  let root: string;
  let db: ReturnType<typeof seedDb>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pc-dart-'));
    writeFileSync(join(root, 'pubspec.yaml'), 'name: myapp\ndescription: x\n');
    mkdirSync(join(root, 'packages', 'shared'), { recursive: true });
    writeFileSync(join(root, 'packages', 'shared', 'pubspec.yaml'), 'name: "shared"\n');
    db = seedDb(root);
    for (const p of ['lib/main.dart', 'lib/src/b.dart', 'packages/shared/lib/util.dart', 'packages/shared/lib/src/deep.dart']) {
      upsertFile(db, REPO, p, 'h');
    }
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves package:<own-name>/path to lib/path', () => {
    const r = createDartResolver(db, REPO, root);
    expect(r.resolve('package:myapp/src/b.dart', 'lib/main.dart')).toEqual(['lib/src/b.dart']);
  });

  it('resolves a nested monorepo package via its own pubspec', () => {
    const r = createDartResolver(db, REPO, root);
    expect(r.resolve('package:shared/util.dart', 'lib/main.dart')).toEqual(['packages/shared/lib/util.dart']);
    expect(r.resolve('package:shared/src/deep.dart', 'packages/shared/lib/util.dart')).toEqual(['packages/shared/lib/src/deep.dart']);
  });

  it('external packages, dart: URIs, missing files and self-imports resolve to nothing', () => {
    const r = createDartResolver(db, REPO, root);
    expect(r.resolve('package:flutter/material.dart', 'lib/main.dart')).toEqual([]);
    expect(r.resolve('dart:io', 'lib/main.dart')).toEqual([]);
    expect(r.resolve('package:myapp/src/nope.dart', 'lib/main.dart')).toEqual([]);
    expect(r.resolve('package:myapp/main.dart', 'lib/main.dart')).toEqual([]);
  });
});
