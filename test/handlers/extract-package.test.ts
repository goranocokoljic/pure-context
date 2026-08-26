/**
 * Task 499 (Phase 82): per-file package capture for JVM languages.
 *
 * extractPackage on the Kotlin/Java/Scala/Groovy handlers feeds the
 * declared_package column, which the JVM import resolver uses to map
 * package-qualified imports to repo files.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { kotlinHandler } from '../../src/handlers/kotlin.js';
import { csharpHandler } from '../../src/handlers/csharp.js';
import { javaHandler } from '../../src/handlers/java.js';
import { scalaHandler } from '../../src/handlers/scala.js';
import { groovyHandler } from '../../src/handlers/groovy.js';
import type { LanguageHandler } from '../../src/core/types.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { upsertFile, getDeclaredPackages } from '../../src/core/db/file-store.js';

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

async function pkgOf(handler: LanguageHandler, source: string): Promise<string | null> {
  const buf = Buffer.from(source);
  if (handler.grammarPath() === null) {
    return handler.extractPackage!(null, buf);
  }
  const tree = await parseFile(buf, handler);
  return handler.extractPackage!(tree, buf);
}

// ─── Kotlin ───────────────────────────────────────────────────────────────────

describe('Kotlin extractPackage', () => {
  it('extracts a qualified package header', async () => {
    const pkg = await pkgOf(
      kotlinHandler,
      `package com.example.foo\n\nimport com.example.util.Bar\n\nclass Baz\n`,
    );
    expect(pkg).toBe('com.example.foo');
  });

  it('returns null when the file declares no package', async () => {
    expect(await pkgOf(kotlinHandler, `fun main() {}\n`)).toBeNull();
  });

  it('ignores comments before the package header', async () => {
    const pkg = await pkgOf(
      kotlinHandler,
      `// copyright\n/* header */\npackage com.example.a.b\n\nobject X\n`,
    );
    expect(pkg).toBe('com.example.a.b');
  });
});

// ─── Java ─────────────────────────────────────────────────────────────────────

describe('Java extractPackage', () => {
  it('extracts a qualified package declaration', async () => {
    const pkg = await pkgOf(
      javaHandler,
      `package com.example.service;\n\npublic class OrderService {}\n`,
    );
    expect(pkg).toBe('com.example.service');
  });

  it('extracts a single-segment package', async () => {
    const pkg = await pkgOf(javaHandler, `package example;\n\npublic class A {}\n`);
    expect(pkg).toBe('example');
  });

  it('returns null for the default package', async () => {
    expect(await pkgOf(javaHandler, `public class NoPkg {}\n`)).toBeNull();
  });
});

// ─── Scala ────────────────────────────────────────────────────────────────────

describe('Scala extractPackage', () => {
  it('extracts a qualified package clause', async () => {
    const pkg = await pkgOf(scalaHandler, `package com.example.data\n\nclass Row\n`);
    expect(pkg).toBe('com.example.data');
  });

  it('concatenates chained Scala 2 package clauses', async () => {
    const pkg = await pkgOf(
      scalaHandler,
      `package com.example\npackage inner\n\nclass Deep\n`,
    );
    expect(pkg).toBe('com.example.inner');
  });

  it('returns null when no package is declared', async () => {
    expect(await pkgOf(scalaHandler, `object Main { def run(): Unit = () }\n`)).toBeNull();
  });
});

// ─── Groovy (regex handler, null tree) ────────────────────────────────────────

describe('Groovy extractPackage', () => {
  it('extracts the package line', async () => {
    const pkg = await pkgOf(groovyHandler, `package com.example.jobs\n\nclass Job {}\n`);
    expect(pkg).toBe('com.example.jobs');
  });

  it('accepts comments and blank lines before the package', async () => {
    const pkg = await pkgOf(
      groovyHandler,
      `// header\n\n/* multi\n * line\n */\npackage com.example.x\nclass Y {}\n`,
    );
    expect(pkg).toBe('com.example.x');
  });

  it('does not match a package word after code has started (e.g. inside a Gradle block)', async () => {
    const pkg = await pkgOf(
      groovyHandler,
      `task doIt {\n  doLast {\n    println 'package com.fake.pkg'\n  }\n}\n`,
    );
    expect(pkg).toBeNull();
  });

  it('returns null for a typical build.gradle with no package', async () => {
    expect(await pkgOf(groovyHandler, `plugins {\n  id 'java'\n}\n`)).toBeNull();
  });
});

// ─── C# (Phase 83, Task 510) ──────────────────────────────────────────────────

describe('C# extractPackage', () => {
  it('extracts a block-scoped namespace', async () => {
    const pkg = await pkgOf(
      csharpHandler,
      `using System;\n\nnamespace My.App.Services {\n  public class Svc {}\n}\n`,
    );
    expect(pkg).toBe('My.App.Services');
  });

  it('extracts a file-scoped namespace', async () => {
    const pkg = await pkgOf(
      csharpHandler,
      `namespace My.App.Data;\n\npublic class Row {}\n`,
    );
    expect(pkg).toBe('My.App.Data');
  });

  it('stores only the OUTERMOST namespace for nested blocks (v1 limitation)', async () => {
    const pkg = await pkgOf(
      csharpHandler,
      `namespace Outer {\n  namespace Inner {\n    public class Deep {}\n  }\n}\n`,
    );
    expect(pkg).toBe('Outer');
  });

  it('returns null when the file declares no namespace', async () => {
    expect(await pkgOf(csharpHandler, `public class NoNs {}\n`)).toBeNull();
  });
});

// ─── Persistence: declared_package column ─────────────────────────────────────

describe('files.declared_package persistence', () => {
  function seedRepo(db: ReturnType<typeof openInMemoryDatabase>, repoId: string) {
    upsertRepo(db, {
      id: repoId,
      rootPath: `/tmp/${repoId}`,
      symbolCount: 0,
      fileCount: 0,
      languages: [],
      indexedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
      clonePath: null,
      tenantId: 'local',
    });
  }

  it('schema v9 has the declared_package column', () => {
    const db = openInMemoryDatabase();
    const cols = db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'declared_package')).toBe(true);
    db.close();
  });

  it('round-trips a declared package through upsertFile → getDeclaredPackages', () => {
    const db = openInMemoryDatabase();
    seedRepo(db, 'repo1');
    upsertFile(db, 'repo1', 'src/main/kotlin/com/example/Foo.kt', 'hash1', undefined, 'local', 'com.example');
    upsertFile(db, 'repo1', 'src/NoPkg.kt', 'hash2', undefined, 'local', null);
    const map = getDeclaredPackages(db, 'repo1');
    expect(map.get('src/main/kotlin/com/example/Foo.kt')).toBe('com.example');
    expect(map.has('src/NoPkg.kt')).toBe(false);
    db.close();
  });

  it('a hash-only upsert (declaredPackage undefined) preserves the stored package', () => {
    const db = openInMemoryDatabase();
    seedRepo(db, 'repo1');
    upsertFile(db, 'repo1', 'A.kt', 'hash1', undefined, 'local', 'com.example');
    // Hash-only update — the caller does not know the package.
    upsertFile(db, 'repo1', 'A.kt', 'hash2');
    const map = getDeclaredPackages(db, 'repo1');
    expect(map.get('A.kt')).toBe('com.example');
    db.close();
  });

  it('an explicit null clears the stored package (package removed from the file)', () => {
    const db = openInMemoryDatabase();
    seedRepo(db, 'repo1');
    upsertFile(db, 'repo1', 'A.kt', 'hash1', undefined, 'local', 'com.example');
    upsertFile(db, 'repo1', 'A.kt', 'hash2', undefined, 'local', null);
    expect(getDeclaredPackages(db, 'repo1').has('A.kt')).toBe(false);
    db.close();
  });
});
