/**
 * Tasks 501 + 507 (Phase 82): JVM dependency edges, end to end.
 *
 * Authors a real multi-module Kotlin/Java project on disk, runs the full
 * indexFolder pipeline, and asserts the dep_edges the JVM resolver produced —
 * including the one assertion that would have caught the original bug:
 * a Kotlin repo indexes to MORE THAN ZERO dependency edges, and
 * get_blast_radius on an imported symbol returns its importers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { kotlinHandler } from '../../src/handlers/kotlin.js';
import { javaHandler } from '../../src/handlers/java.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { getBlastRadius } from '../../src/graph/graph-traversal.js';
import { buildGraph } from '../../src/graph/graph-builder.js';
import { createResolver } from '../../src/graph/path-resolver.js';
import type { ImportRecord } from '../../src/core/types.js';

let root: string;
let repoId: string;

function write(relPath: string, content: string) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** dep_edges targets for a source file, path-normalized to forward slashes. */
function edgesFrom(db: ReturnType<typeof openDatabase>, sourceSuffix: string): string[] {
  const rows = db
    .prepare<[string], { source_file: string; target_file: string }>(
      'SELECT source_file, target_file FROM dep_edges WHERE repo_id = ?',
    )
    .all(repoId);
  return rows
    .filter((r) => r.source_file.replace(/\\/g, '/').endsWith(sourceSuffix))
    .map((r) => r.target_file.replace(/\\/g, '/'))
    .sort();
}

beforeAll(async () => {
  _resetForTesting();
  registerHandler(kotlinHandler);
  registerHandler(javaHandler);
  await initParser();

  root = resolve(mkdtempSync(join(tmpdir(), 'pc-jvm-e2e-')));

  write('settings.gradle.kts', 'include(":module-a", ":module-b")\n');
  write('module-a/build.gradle.kts', '// module marker\n');
  write('module-b/build.gradle.kts', '// module marker\n');

  // module-a: the "library"
  write(
    'module-a/src/main/kotlin/com/example/util/Bar.kt',
    'package com.example.util\n\nclass Bar {\n  fun run(): Int = 1\n}\n',
  );
  write(
    'module-a/src/main/kotlin/com/example/util/TimeUtils.kt',
    'package com.example.util\n\nfun formatDuration(ms: Long): String = "$ms ms"\n',
  );
  write(
    'module-a/src/main/kotlin/com/example/shared/Config.kt',
    'package com.example.shared\n\nclass Config {\n  val name = "a"\n}\n',
  );
  write(
    'module-a/src/main/kotlin/com/example/consumera/Consumer.kt',
    'package com.example.consumera\n\nimport com.example.shared.Config\n\nclass Consumer {\n  val cfg = Config()\n}\n',
  );

  // module-b: the "app" — plus its OWN com.example.shared.Config (ambiguity case)
  write(
    'module-b/src/main/kotlin/com/example/shared/Config.kt',
    'package com.example.shared\n\nclass Config {\n  val name = "b"\n}\n',
  );
  write(
    'module-b/src/main/kotlin/com/example/app/Main.kt',
    'package com.example.app\n\nimport com.example.util.Bar\nimport com.example.util.formatDuration\nimport java.util.UUID\n\nclass Main {\n  fun go(): String = formatDuration(1) + Bar().run() + UUID.randomUUID()\n}\n',
  );
  write(
    'module-b/src/main/kotlin/com/example/app/Wild.kt',
    'package com.example.app\n\nimport com.example.util.*\n\nclass Wild {\n  val b = Bar()\n}\n',
  );
  write(
    'module-b/src/main/java/com/example/japp/JavaUser.java',
    'package com.example.japp;\n\nimport com.example.util.Bar;\n\npublic class JavaUser {\n  private Bar bar = new Bar();\n}\n',
  );

  const result = await indexFolder(root, { fileLimit: 100 });
  repoId = result.repoId;
}, 60_000);

afterAll(() => {
  if (repoId) deleteIndex(repoId);
  rmSync(root, { recursive: true, force: true });
});

describe('JVM dependency edges end to end (Tasks 501+507)', () => {
  it('a Kotlin repo no longer indexes to zero dependency edges', () => {
    const db = openDatabase(repoId);
    const row = db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM dep_edges WHERE repo_id = ?')
      .get(repoId);
    db.close();
    expect(row!.n).toBeGreaterThan(0);
  });

  it('resolves a plain class import across modules (Main.kt → Bar.kt)', () => {
    const db = openDatabase(repoId);
    const targets = edgesFrom(db, 'module-b/src/main/kotlin/com/example/app/Main.kt');
    db.close();
    expect(targets).toContain('module-a/src/main/kotlin/com/example/util/Bar.kt');
  });

  it('resolves a member import via the symbol table (Main.kt → TimeUtils.kt)', () => {
    const db = openDatabase(repoId);
    const targets = edgesFrom(db, 'module-b/src/main/kotlin/com/example/app/Main.kt');
    db.close();
    expect(targets).toContain('module-a/src/main/kotlin/com/example/util/TimeUtils.kt');
  });

  it('drops external imports (java.util.UUID produces no edge)', () => {
    const db = openDatabase(repoId);
    const targets = edgesFrom(db, 'module-b/src/main/kotlin/com/example/app/Main.kt');
    db.close();
    expect(targets).toEqual([
      'module-a/src/main/kotlin/com/example/util/Bar.kt',
      'module-a/src/main/kotlin/com/example/util/TimeUtils.kt',
    ]);
  });

  it('resolves a Kotlin wildcard import to every file in the package', () => {
    const db = openDatabase(repoId);
    const targets = edgesFrom(db, 'module-b/src/main/kotlin/com/example/app/Wild.kt');
    db.close();
    expect(targets).toEqual([
      'module-a/src/main/kotlin/com/example/util/Bar.kt',
      'module-a/src/main/kotlin/com/example/util/TimeUtils.kt',
    ]);
  });

  it('resolves a Java import of a Kotlin class', () => {
    const db = openDatabase(repoId);
    const targets = edgesFrom(db, 'module-b/src/main/java/com/example/japp/JavaUser.java');
    db.close();
    expect(targets).toEqual(['module-a/src/main/kotlin/com/example/util/Bar.kt']);
  });

  it('prefers the importing module when the same package+class exists in two modules', () => {
    const db = openDatabase(repoId);
    const targets = edgesFrom(db, 'module-a/src/main/kotlin/com/example/consumera/Consumer.kt');
    db.close();
    expect(targets).toEqual(['module-a/src/main/kotlin/com/example/shared/Config.kt']);
  });

  it('get_blast_radius on an imported symbol returns its importers (the report\'s smoking gun)', () => {
    const db = openDatabase(repoId);
    const bar = db
      .prepare<[string, string], { id: string }>(
        'SELECT id FROM symbols WHERE repo_id = ? AND name = ?',
      )
      .get(repoId, 'Bar');
    expect(bar).toBeDefined();
    const radius = getBlastRadius(bar!.id, repoId, db, 3);
    const files = radius.files.map((f) => f.replace(/\\/g, '/'));
    db.close();
    expect(files).toContain('module-b/src/main/kotlin/com/example/app/Main.kt');
    expect(files).toContain('module-b/src/main/kotlin/com/example/app/Wild.kt');
    expect(files).toContain('module-b/src/main/java/com/example/japp/JavaUser.java');
  });
});

describe('non-JVM behavior is unchanged (Task 501 regression guard)', () => {
  it('buildGraph output for TS imports is identical with and without a JVM resolver', () => {
    const resolver = createResolver(root); // no tsconfig — relative resolution only
    const imports: ImportRecord[] = [
      {
        sourceFile: 'src/a.ts',
        specifier: './b',
        resolvedPath: 'src/b.ts',
        importedNames: ['b'],
        isTypeOnly: false,
      },
      {
        sourceFile: 'src/a.ts',
        specifier: 'express',
        resolvedPath: null,
        importedNames: ['express'],
        isTypeOnly: false,
      },
    ];
    const throwingJvmResolver = {
      resolve(): string[] {
        throw new Error('JVM resolver must never be consulted for non-JVM source files');
      },
    };
    const without = buildGraph(imports, resolver, 'repo-x');
    const withJvm = buildGraph(imports, resolver, 'repo-x', throwingJvmResolver);
    expect(withJvm).toEqual(without);
    expect(withJvm).toHaveLength(1);
    expect(withJvm[0]!.targetFile).toBe('src/b.ts');
  });
});
