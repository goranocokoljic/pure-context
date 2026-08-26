/**
 * Task 512 (Phase 83): C# dependency edges, end to end.
 *
 * Authors a real two-project C# solution on disk (each project marked by a
 * *.csproj file), runs the full indexFolder pipeline, and asserts the
 * dep_edges the declared-module resolver produced: namespace usings, static
 * usings, external usings dropped, blast radius returning importers, and the
 * Phase-83 visibility fix (internal class findable).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { csharpHandler } from '../../src/handlers/csharp.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { getBlastRadius } from '../../src/graph/graph-traversal.js';

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
  registerHandler(csharpHandler);
  await initParser();

  root = resolve(mkdtempSync(join(tmpdir(), 'pc-cs-e2e-')));

  write('ProjLib/ProjLib.csproj', '<Project Sdk="Microsoft.NET.Sdk" />\n');
  write('ProjApp/ProjApp.csproj', '<Project Sdk="Microsoft.NET.Sdk" />\n');

  // ProjLib: the "library" — file-scoped AND block-scoped namespaces
  write(
    'ProjLib/Services/OrderService.cs',
    'namespace Demo.Lib.Services;\n\npublic class OrderService {\n  public void Place() {}\n}\n',
  );
  write(
    'ProjLib/Util/Guard.cs',
    'namespace Demo.Lib.Util {\n  public static class Guard {\n    public static void NotNull(object o) {}\n  }\n}\n',
  );
  // Phase 83 visibility fix: internal class must be indexed and findable
  write(
    'ProjLib/Internal/Cache.cs',
    'namespace Demo.Lib.Internal;\n\ninternal class Cache {\n  public void Clear() {}\n}\n',
  );
  // Cross-project ambiguity: both projects declare Demo.Shared
  write(
    'ProjLib/Shared/Config.cs',
    'namespace Demo.Shared;\n\npublic class Config {\n  public string Name { get; set; }\n}\n',
  );
  write(
    'ProjLib/Consumer.cs',
    'using Demo.Shared;\n\nnamespace Demo.Lib;\n\npublic class Consumer {\n  public Config Cfg { get; set; }\n}\n',
  );

  // ProjApp: the "app"
  write(
    'ProjApp/Shared/Config.cs',
    'namespace Demo.Shared;\n\npublic class Config {\n  public string Name { get; set; }\n}\n',
  );
  write(
    'ProjApp/Program.cs',
    'using System;\nusing Demo.Lib.Services;\nusing static Demo.Lib.Util.Guard;\n\nnamespace Demo.App;\n\npublic class Program {\n  public void Run() {\n    NotNull(new OrderService());\n  }\n}\n',
  );

  const result = await indexFolder(root, { fileLimit: 100 });
  repoId = result.repoId;
}, 60_000);

afterAll(() => {
  if (repoId) deleteIndex(repoId);
  rmSync(root, { recursive: true, force: true });
});

describe('C# dependency edges end to end (Task 512)', () => {
  it('a C# repo no longer indexes to zero dependency edges', () => {
    const db = openDatabase(repoId);
    const row = db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM dep_edges WHERE repo_id = ?')
      .get(repoId);
    db.close();
    expect(row!.n).toBeGreaterThan(0);
  });

  it('resolves a cross-project namespace using and static using; drops external usings', () => {
    const db = openDatabase(repoId);
    const targets = edgesFrom(db, 'ProjApp/Program.cs');
    db.close();
    // `using System;` must produce no edge; the two internal usings resolve.
    expect(targets).toEqual([
      'ProjLib/Services/OrderService.cs',
      'ProjLib/Util/Guard.cs',
    ]);
  });

  it('prefers the importing .csproj project when the same namespace+type exists in both', () => {
    const db = openDatabase(repoId);
    const targets = edgesFrom(db, 'ProjLib/Consumer.cs');
    db.close();
    expect(targets).toEqual(['ProjLib/Shared/Config.cs']);
  });

  it('get_blast_radius on an imported class returns its importers', () => {
    const db = openDatabase(repoId);
    const svc = db
      .prepare<[string, string], { id: string }>(
        'SELECT id FROM symbols WHERE repo_id = ? AND name = ?',
      )
      .get(repoId, 'OrderService');
    expect(svc).toBeDefined();
    const radius = getBlastRadius(svc!.id, repoId, db, 3);
    const files = radius.files.map((f) => f.replace(/\\/g, '/'));
    db.close();
    expect(files).toContain('ProjApp/Program.cs');
  });

  it('an internal class is indexed and findable (Phase 83 visibility fix)', () => {
    const db = openDatabase(repoId);
    const cache = db
      .prepare<[string, string], { id: string; framework_meta: string | null }>(
        'SELECT id, framework_meta FROM symbols WHERE repo_id = ? AND name = ?',
      )
      .get(repoId, 'Cache');
    db.close();
    expect(cache).toBeDefined();
    const meta = cache!.framework_meta ? JSON.parse(cache!.framework_meta) : {};
    expect(meta.visibility).toBe('internal');
  });

  it('declared_package is captured for both namespace styles', () => {
    const db = openDatabase(repoId);
    const rows = db
      .prepare<[string], { path: string; declared_package: string | null }>(
        'SELECT path, declared_package FROM files WHERE repo_id = ?',
      )
      .all(repoId);
    db.close();
    const byPath = new Map(
      rows.map((r) => [r.path.replace(/\\/g, '/'), r.declared_package]),
    );
    expect(byPath.get('ProjLib/Services/OrderService.cs')).toBe('Demo.Lib.Services');
    expect(byPath.get('ProjLib/Util/Guard.cs')).toBe('Demo.Lib.Util');
  });
});
