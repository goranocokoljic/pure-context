/**
 * Task 500 (Phase 82): JVM import resolver.
 *
 * Seeds an in-memory DB with files (declared_package) + symbols and asserts
 * that package-qualified specifiers resolve to the right repo files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createJvmResolver,
  derivePackageFromPath,
  isJvmSourceFile,
} from '../../src/graph/jvm-resolver.js';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import { upsertFile } from '../../src/core/db/file-store.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import type { SymbolRecord, SymbolKind } from '../../src/core/types.js';

const REPO = 'jvmtest';

function sym(name: string, filePath: string, kind: SymbolKind = 'class'): SymbolRecord {
  return {
    id: `${name}-${filePath}`.replace(/[^a-z0-9]/gi, '').slice(0, 16).padEnd(16, '0'),
    name,
    kind,
    filePath,
    startByte: 0,
    endByte: 10,
    signature: name,
    summary: name,
  };
}

function seedDb() {
  const db = openInMemoryDatabase();
  upsertRepo(db, {
    id: REPO,
    rootPath: '/tmp/jvmtest',
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

function addFile(db: ReturnType<typeof seedDb>, path: string, pkg: string | null) {
  upsertFile(db, REPO, path, 'hash', undefined, 'local', pkg);
}

describe('isJvmSourceFile', () => {
  it('accepts declared-module extensions and rejects others', () => {
    expect(isJvmSourceFile('a/B.kt')).toBe(true);
    expect(isJvmSourceFile('a/B.java')).toBe(true);
    expect(isJvmSourceFile('a/B.scala')).toBe(true);
    expect(isJvmSourceFile('a/B.groovy')).toBe(true);
    expect(isJvmSourceFile('a/B.cs')).toBe(true); // Phase 83
    expect(isJvmSourceFile('a/B.ts')).toBe(false);
    expect(isJvmSourceFile('a/noext')).toBe(false);
  });
});

describe('derivePackageFromPath (pre-v9 fallback)', () => {
  it('derives from a src/main/kotlin root', () => {
    expect(derivePackageFromPath('module-a/src/main/kotlin/com/example/foo/Bar.kt')).toBe(
      'com.example.foo',
    );
  });

  it('derives from a bare java dir', () => {
    expect(derivePackageFromPath('app/java/com/example/Baz.java')).toBe('com.example');
  });

  it('returns null when no source root is recognizable', () => {
    expect(derivePackageFromPath('scripts/Tool.kt')).toBeNull();
  });

  it('returns null for a file directly under the source root (default package)', () => {
    expect(derivePackageFromPath('src/main/kotlin/Main.kt')).toBeNull();
  });
});

describe('createJvmResolver', () => {
  let db: ReturnType<typeof seedDb>;

  beforeEach(() => {
    db = seedDb();
  });

  afterEach(() => {
    db.close();
  });

  it('resolves a plain class import via declared package + basename', () => {
    addFile(db, 'module-a/src/main/kotlin/com/example/foo/Bar.kt', 'com.example.foo');
    addFile(db, 'module-b/src/main/kotlin/com/example/app/Main.kt', 'com.example.app');
    const r = createJvmResolver(db, REPO, '/nonexistent');
    expect(
      r.resolve('com.example.foo.Bar', 'module-b/src/main/kotlin/com/example/app/Main.kt'),
    ).toEqual(['module-a/src/main/kotlin/com/example/foo/Bar.kt']);
  });

  it('resolves a member import through the symbol table when no basename matches', () => {
    addFile(db, 'lib/src/main/kotlin/com/example/util/TimeUtils.kt', 'com.example.util');
    addFile(db, 'app/src/main/kotlin/com/example/Main.kt', 'com.example');
    insertSymbols(db, REPO, [
      sym('formatDuration', 'lib/src/main/kotlin/com/example/util/TimeUtils.kt', 'function'),
    ]);
    const r = createJvmResolver(db, REPO, '/nonexistent');
    expect(
      r.resolve('com.example.util.formatDuration', 'app/src/main/kotlin/com/example/Main.kt'),
    ).toEqual(['lib/src/main/kotlin/com/example/util/TimeUtils.kt']);
  });

  it('resolves a Kotlin/Java wildcard (bare package specifier) to all package files', () => {
    addFile(db, 'lib/com/example/util/A.kt', 'com.example.util');
    addFile(db, 'lib/com/example/util/B.kt', 'com.example.util');
    addFile(db, 'app/Main.kt', 'com.example.app');
    const r = createJvmResolver(db, REPO, '/nonexistent');
    const hits = r.resolve('com.example.util', 'app/Main.kt');
    expect(hits.sort()).toEqual(['lib/com/example/util/A.kt', 'lib/com/example/util/B.kt']);
  });

  it('resolves Groovy `.*` and Scala `._` wildcard suffixes', () => {
    addFile(db, 'lib/com/example/util/A.groovy', 'com.example.util');
    addFile(db, 'app/Main.groovy', 'com.example.app');
    const r = createJvmResolver(db, REPO, '/nonexistent');
    expect(r.resolve('com.example.util.*', 'app/Main.groovy')).toEqual([
      'lib/com/example/util/A.groovy',
    ]);
    expect(r.resolve('com.example.util._', 'app/Main.groovy')).toEqual([
      'lib/com/example/util/A.groovy',
    ]);
  });

  it('resolves a Scala selector clause to each named member', () => {
    addFile(db, 's/com/example/col/MapX.scala', 'com.example.col');
    addFile(db, 's/com/example/col/SetX.scala', 'com.example.col');
    addFile(db, 's/com/example/col/Other.scala', 'com.example.col');
    addFile(db, 'app/Main.scala', 'com.example.app');
    const r = createJvmResolver(db, REPO, '/nonexistent');
    const hits = r.resolve('com.example.col.{MapX, SetX => MutableSet}', 'app/Main.scala');
    expect(hits.sort()).toEqual(['s/com/example/col/MapX.scala', 's/com/example/col/SetX.scala']);
  });

  it('resolves a nested class import via the longest package prefix', () => {
    addFile(db, 'lib/com/example/Outer.java', 'com.example');
    addFile(db, 'app/Main.java', 'com.example.app');
    const r = createJvmResolver(db, REPO, '/nonexistent');
    expect(r.resolve('com.example.Outer.Inner', 'app/Main.java')).toEqual([
      'lib/com/example/Outer.java',
    ]);
  });

  it('returns [] for external packages', () => {
    addFile(db, 'app/Main.kt', 'com.example.app');
    const r = createJvmResolver(db, REPO, '/nonexistent');
    expect(r.resolve('java.util.List', 'app/Main.kt')).toEqual([]);
    expect(r.resolve('androidx.compose.runtime.*', 'app/Main.kt')).toEqual([]);
  });

  it('never resolves a file to itself', () => {
    addFile(db, 'lib/com/example/A.kt', 'com.example');
    const r = createJvmResolver(db, REPO, '/nonexistent');
    expect(r.resolve('com.example.A', 'lib/com/example/A.kt')).toEqual([]);
  });

  it('uses the path-derived package for files without declared_package (pre-v9 rows)', () => {
    addFile(db, 'legacy/src/main/java/com/example/old/Legacy.java', null);
    addFile(db, 'app/src/main/java/com/example/Main.java', 'com.example');
    const r = createJvmResolver(db, REPO, '/nonexistent');
    expect(
      r.resolve('com.example.old.Legacy', 'app/src/main/java/com/example/Main.java'),
    ).toEqual(['legacy/src/main/java/com/example/old/Legacy.java']);
  });

  it('prefers candidates in the importing file\'s own Gradle module on ambiguity', () => {
    // Two modules declare the same package + class name; markers on disk decide.
    const root = mkdtempSync(join(tmpdir(), 'pc-jvm-'));
    try {
      mkdirSync(join(root, 'module-a', 'src'), { recursive: true });
      mkdirSync(join(root, 'module-b', 'src'), { recursive: true });
      writeFileSync(join(root, 'module-a', 'build.gradle.kts'), '');
      writeFileSync(join(root, 'module-b', 'build.gradle'), '');

      addFile(db, 'module-a/src/Config.kt', 'com.example.shared');
      addFile(db, 'module-b/src/Config.kt', 'com.example.shared');
      addFile(db, 'module-a/src/Main.kt', 'com.example.app');
      const r = createJvmResolver(db, REPO, root);
      expect(r.resolve('com.example.shared.Config', 'module-a/src/Main.kt')).toEqual([
        'module-a/src/Config.kt',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to ALL candidates when none share the importer\'s module', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-jvm-'));
    try {
      mkdirSync(join(root, 'module-a', 'src'), { recursive: true });
      mkdirSync(join(root, 'module-b', 'src'), { recursive: true });
      mkdirSync(join(root, 'module-c', 'src'), { recursive: true });
      writeFileSync(join(root, 'module-a', 'build.gradle'), '');
      writeFileSync(join(root, 'module-b', 'build.gradle'), '');
      writeFileSync(join(root, 'module-c', 'build.gradle'), '');

      addFile(db, 'module-a/src/Config.kt', 'com.example.shared');
      addFile(db, 'module-b/src/Config.kt', 'com.example.shared');
      addFile(db, 'module-c/src/Main.kt', 'com.example.app');
      const r = createJvmResolver(db, REPO, root);
      const hits = r.resolve('com.example.shared.Config', 'module-c/src/Main.kt');
      expect(hits.sort()).toEqual(['module-a/src/Config.kt', 'module-b/src/Config.kt']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('static import (class-path specifier from the Java handler) resolves to the class file', () => {
    // `import static com.example.Assertions.assertThat` reaches the resolver as
    // specifier "com.example.Assertions".
    addFile(db, 'lib/com/example/Assertions.java', 'com.example');
    addFile(db, 'app/Main.java', 'com.example.app');
    const r = createJvmResolver(db, REPO, '/nonexistent');
    expect(r.resolve('com.example.Assertions', 'app/Main.java')).toEqual([
      'lib/com/example/Assertions.java',
    ]);
  });

  // ── C# (Phase 83, Task 511) ─────────────────────────────────────────────────

  it('resolves a C# namespace using to all files declaring the namespace', () => {
    addFile(db, 'Lib/Services/OrderService.cs', 'My.App.Services');
    addFile(db, 'Lib/Services/UserService.cs', 'My.App.Services');
    addFile(db, 'Web/Program.cs', 'My.Web');
    const r = createJvmResolver(db, REPO, '/nonexistent');
    const hits = r.resolve('My.App.Services', 'Web/Program.cs');
    expect(hits.sort()).toEqual([
      'Lib/Services/OrderService.cs',
      'Lib/Services/UserService.cs',
    ]);
  });

  it('resolves a C# static using (class-path specifier) to the type file', () => {
    // `using static My.App.Util.Guard;` reaches the resolver as "My.App.Util.Guard".
    addFile(db, 'Lib/Util/Guard.cs', 'My.App.Util');
    addFile(db, 'Web/Program.cs', 'My.Web');
    const r = createJvmResolver(db, REPO, '/nonexistent');
    expect(r.resolve('My.App.Util.Guard', 'Web/Program.cs')).toEqual(['Lib/Util/Guard.cs']);
  });

  it('resolves a C# alias using (rhs specifier) to the target type file', () => {
    // `using Db = My.App.Data.Context;` reaches the resolver as "My.App.Data.Context".
    addFile(db, 'Lib/Data/Context.cs', 'My.App.Data');
    addFile(db, 'Web/Program.cs', 'My.Web');
    const r = createJvmResolver(db, REPO, '/nonexistent');
    expect(r.resolve('My.App.Data.Context', 'Web/Program.cs')).toEqual(['Lib/Data/Context.cs']);
  });

  it('caps wildcard/namespace fanout at maxWildcardFanout (deterministic order)', () => {
    for (let i = 0; i < 5; i++) {
      addFile(db, `Lib/Big/File${i}.cs`, 'My.App.Big');
    }
    addFile(db, 'Web/Program.cs', 'My.Web');
    const r = createJvmResolver(db, REPO, '/nonexistent', { maxWildcardFanout: 2 });
    const hits = r.resolve('My.App.Big', 'Web/Program.cs');
    expect(hits).toEqual(['Lib/Big/File0.cs', 'Lib/Big/File1.cs']);
    // 0 = uncapped
    const r2 = createJvmResolver(db, REPO, '/nonexistent', { maxWildcardFanout: 0 });
    expect(r2.resolve('My.App.Big', 'Web/Program.cs')).toHaveLength(5);
  });

  it('prefers candidates in the importing file\'s own .csproj project on ambiguity', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-clr-'));
    try {
      mkdirSync(join(root, 'ProjA', 'Models'), { recursive: true });
      mkdirSync(join(root, 'ProjB', 'Models'), { recursive: true });
      writeFileSync(join(root, 'ProjA', 'ProjA.csproj'), '');
      writeFileSync(join(root, 'ProjB', 'ProjB.csproj'), '');

      addFile(db, 'ProjA/Models/Config.cs', 'My.Shared');
      addFile(db, 'ProjB/Models/Config.cs', 'My.Shared');
      addFile(db, 'ProjA/Program.cs', 'My.A');
      const r = createJvmResolver(db, REPO, root);
      expect(r.resolve('My.Shared.Config', 'ProjA/Program.cs')).toEqual([
        'ProjA/Models/Config.cs',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
