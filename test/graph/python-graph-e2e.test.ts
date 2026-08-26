/**
 * Task 519 (Phase 84): Python dependency edges, end to end.
 *
 * Authors a real Python project on disk (src/ layout + package with relative
 * imports), runs the full indexFolder pipeline, and asserts the dep_edges the
 * Python resolver produced — including the smoking-gun assertion from the
 * Phase 82 lesson: a Python repo indexes to MORE THAN ZERO dependency edges,
 * and get_blast_radius on an imported symbol returns its importers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { pythonHandler } from '../../src/handlers/python.js';
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
  registerHandler(pythonHandler);
  await initParser();

  root = resolve(mkdtempSync(join(tmpdir(), 'pc-py-e2e-')));

  // src/ layout package
  write('src/mypkg/__init__.py', 'from .core import Engine\n');
  write(
    'src/mypkg/core.py',
    'class Engine:\n    """The engine."""\n    def run(self):\n        return 1\n',
  );
  write(
    'src/mypkg/util.py',
    'def format_number(n):\n    """Format a number."""\n    return str(n)\n',
  );
  write(
    'src/mypkg/service.py',
    'from .core import Engine\nfrom .util import format_number\nimport os\n\n'
      + 'class Service:\n    def go(self):\n        return format_number(Engine().run())\n',
  );
  write(
    'src/mypkg/sub/deep.py',
    'from ..util import format_number\n\ndef deep():\n    return format_number(2)\n',
  );
  // consumer outside src/ importing without the src prefix
  write(
    'tests/test_service.py',
    'from mypkg.service import Service\nimport numpy\n\ndef test_service():\n    assert Service().go()\n',
  );

  const result = await indexFolder(root, { fileLimit: 100 });
  repoId = result.repoId;
}, 60_000);

afterAll(() => {
  if (repoId) deleteIndex(repoId);
  rmSync(root, { recursive: true, force: true });
});

describe('Python dependency edges end to end (Task 519)', () => {
  it('a Python repo no longer indexes to zero dependency edges', () => {
    const db = openDatabase(repoId);
    const row = db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM dep_edges WHERE repo_id = ?')
      .get(repoId);
    db.close();
    expect(row!.n).toBeGreaterThan(0);
  });

  it('resolves relative imports exactly (service.py → core.py + util.py)', () => {
    const db = openDatabase(repoId);
    const targets = edgesFrom(db, 'src/mypkg/service.py');
    db.close();
    expect(targets).toEqual(['src/mypkg/core.py', 'src/mypkg/util.py']);
  });

  it('resolves a two-dot relative import (sub/deep.py → util.py)', () => {
    const db = openDatabase(repoId);
    const targets = edgesFrom(db, 'src/mypkg/sub/deep.py');
    db.close();
    expect(targets).toEqual(['src/mypkg/util.py']);
  });

  it('resolves an absolute import through the src/ layout, drops externals', () => {
    const db = openDatabase(repoId);
    const targets = edgesFrom(db, 'tests/test_service.py');
    db.close();
    // numpy produces no edge; mypkg.service resolves through the src/ root
    expect(targets).toEqual(['src/mypkg/service.py']);
  });

  it('get_blast_radius on an imported symbol returns its importers', () => {
    const db = openDatabase(repoId);
    const engine = db
      .prepare<[string, string], { id: string }>(
        'SELECT id FROM symbols WHERE repo_id = ? AND name = ?',
      )
      .get(repoId, 'Engine');
    expect(engine).toBeDefined();
    const radius = getBlastRadius(engine!.id, repoId, db, 3);
    const files = radius.files.map((f) => f.replace(/\\/g, '/'));
    db.close();
    expect(files).toContain('src/mypkg/service.py');
  });
});
