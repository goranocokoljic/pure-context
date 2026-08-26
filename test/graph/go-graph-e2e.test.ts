/**
 * Task 519 + 520 (Phase 84): Go dependency edges + unexported symbols, end to end.
 *
 * Authors a real Go module (with a nested workspace module) on disk, runs the
 * full indexFolder pipeline, and asserts the dep_edges the Go resolver
 * produced — including the smoking-gun assertion from the Phase 82 lesson:
 * a Go repo indexes to MORE THAN ZERO dependency edges, and get_blast_radius
 * on an imported symbol returns its importers. Also asserts unexported Go
 * symbols are now indexed with visibility metadata (Task 520).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { goHandler } from '../../src/handlers/go.js';
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
  registerHandler(goHandler);
  await initParser();

  root = resolve(mkdtempSync(join(tmpdir(), 'pc-go-e2e-')));

  write('go.mod', 'module github.com/acme/app\n\ngo 1.22\n');
  write(
    'internal/store/store.go',
    'package store\n\n// Store persists things.\ntype Store struct{}\n\n'
      + 'func (s *Store) Get(id string) string { return id }\n\n'
      + 'func helperLookup(id string) string { return id }\n',
  );
  write(
    'internal/store/query.go',
    'package store\n\n// Query builds queries.\nfunc Query(q string) string { return q }\n',
  );
  write(
    'main.go',
    'package main\n\nimport (\n\t"fmt"\n\n\t"github.com/acme/app/internal/store"\n)\n\n'
      + 'func main() { fmt.Println(store.Query("x")) }\n',
  );

  // nested workspace module
  write('libs/auth/go.mod', 'module github.com/acme/auth\n\ngo 1.22\n');
  write(
    'libs/auth/token/token.go',
    'package token\n\n// New makes a token.\nfunc New() string { return "t" }\n',
  );
  write(
    'libs/auth/client.go',
    'package auth\n\nimport "github.com/acme/auth/token"\n\n'
      + 'func Client() string { return token.New() }\n',
  );

  const result = await indexFolder(root, { fileLimit: 100 });
  repoId = result.repoId;
}, 60_000);

afterAll(() => {
  if (repoId) deleteIndex(repoId);
  rmSync(root, { recursive: true, force: true });
});

describe('Go dependency edges end to end (Task 519)', () => {
  it('a Go repo no longer indexes to zero dependency edges', () => {
    const db = openDatabase(repoId);
    const row = db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM dep_edges WHERE repo_id = ?')
      .get(repoId);
    db.close();
    expect(row!.n).toBeGreaterThan(0);
  });

  it('resolves a package import to every file of that package, drops stdlib', () => {
    const db = openDatabase(repoId);
    const targets = edgesFrom(db, 'main.go');
    db.close();
    // fmt produces no edge; the store package = both its files
    expect(targets).toEqual(['internal/store/query.go', 'internal/store/store.go']);
  });

  it('resolves through a nested workspace module (longest prefix)', () => {
    const db = openDatabase(repoId);
    const targets = edgesFrom(db, 'libs/auth/client.go');
    db.close();
    expect(targets).toEqual(['libs/auth/token/token.go']);
  });

  it('get_blast_radius on an imported symbol returns its importers', () => {
    const db = openDatabase(repoId);
    const query = db
      .prepare<[string, string], { id: string }>(
        'SELECT id FROM symbols WHERE repo_id = ? AND name = ?',
      )
      .get(repoId, 'Query');
    expect(query).toBeDefined();
    const radius = getBlastRadius(query!.id, repoId, db, 3);
    const files = radius.files.map((f) => f.replace(/\\/g, '/'));
    db.close();
    expect(files).toContain('main.go');
  });
});

describe('Go unexported symbols (Task 520)', () => {
  it('indexes an unexported function with visibility metadata', () => {
    const db = openDatabase(repoId);
    const row = db
      .prepare<[string, string], { name: string; framework_meta: string | null }>(
        'SELECT name, framework_meta FROM symbols WHERE repo_id = ? AND name = ?',
      )
      .get(repoId, 'helperLookup');
    db.close();
    expect(row).toBeDefined();
    expect(JSON.parse(row!.framework_meta ?? '{}')).toMatchObject({
      visibility: 'unexported',
    });
  });

  it('exported symbols carry no visibility metadata', () => {
    const db = openDatabase(repoId);
    const row = db
      .prepare<[string, string], { framework_meta: string | null }>(
        'SELECT framework_meta FROM symbols WHERE repo_id = ? AND name = ?',
      )
      .get(repoId, 'Query');
    db.close();
    expect(row).toBeDefined();
    const meta = row!.framework_meta ? JSON.parse(row!.framework_meta) : {};
    expect(meta.visibility).toBeUndefined();
  });
});
