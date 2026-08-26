/**
 * Task 535 (Phase 86): Declared-Module Wave 2 dependency edges, end to end.
 *
 * Authors one fixture repo containing PHP, Haskell, Elixir, Erlang, and
 * Fortran two-file fixtures, runs the full indexFolder pipeline once, and
 * asserts each language produces its dependency edge plus a blast radius —
 * the Phase 82 smoking-gun test, five more times.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { phpHandler } from '../../src/handlers/php.js';
import { haskellHandler } from '../../src/handlers/haskell.js';
import { elixirHandler } from '../../src/handlers/elixir.js';
import { erlangHandler } from '../../src/handlers/erlang.js';
import { fortranHandler } from '../../src/handlers/fortran.js';
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
function edgesFrom(sourceSuffix: string): string[] {
  const db = openDatabase(repoId);
  const rows = db
    .prepare<[string], { source_file: string; target_file: string }>(
      'SELECT source_file, target_file FROM dep_edges WHERE repo_id = ?',
    )
    .all(repoId);
  db.close();
  return rows
    .filter((r) => r.source_file.replace(/\\/g, '/').endsWith(sourceSuffix))
    .map((r) => r.target_file.replace(/\\/g, '/'))
    .sort();
}

/** blast-radius files (forward slashes) for the symbol with this exact name. */
function blastFilesOf(symbolName: string): string[] {
  const db = openDatabase(repoId);
  const sym = db
    .prepare<[string, string], { id: string }>(
      'SELECT id FROM symbols WHERE repo_id = ? AND name = ?',
    )
    .get(repoId, symbolName);
  expect(sym).toBeDefined();
  const radius = getBlastRadius(sym!.id, repoId, db, 3);
  db.close();
  return radius.files.map((f) => f.replace(/\\/g, '/'));
}

beforeAll(async () => {
  _resetForTesting();
  registerHandler(phpHandler);
  registerHandler(haskellHandler);
  registerHandler(elixirHandler);
  registerHandler(erlangHandler);
  registerHandler(fortranHandler);
  await initParser();

  root = resolve(mkdtempSync(join(tmpdir(), 'pc-wave2-e2e-')));

  // ── PHP ────────────────────────────────────────────────────────────────────
  write(
    'php/src/Support/Logger.php',
    '<?php\n\nnamespace App\\Support;\n\nclass Logger\n{\n'
      + '    public function log(string $message): void {}\n}\n',
  );
  write(
    'php/src/Kernel.php',
    '<?php\n\nnamespace App;\n\nuse App\\Support\\Logger;\n\n'
      + 'class Kernel\n{\n    public function boot(): Logger { return new Logger(); }\n}\n',
  );

  // ── Haskell ────────────────────────────────────────────────────────────────
  write(
    'haskell/src/Data/Util.hs',
    'module Data.Util where\n\nshout :: String -> String\nshout s = s\n',
  );
  write(
    'haskell/app/Main.hs',
    'module Main where\n\nimport Data.Util\n\nmain :: IO ()\nmain = putStrLn (shout "hi")\n',
  );

  // ── Elixir ─────────────────────────────────────────────────────────────────
  write(
    'elixir/lib/app/accounts.ex',
    'defmodule App.Accounts do\n  def create(user), do: user\nend\n',
  );
  write(
    'elixir/lib/app_web/controller.ex',
    'defmodule AppWeb.Controller do\n  alias App.Accounts\n\n'
      + '  def index, do: Accounts.create(:user)\nend\n',
  );

  // ── Erlang ─────────────────────────────────────────────────────────────────
  write('erlang/include/records.hrl', '-record(user, {name}).\n');
  write(
    'erlang/src/util.erl',
    '-module(util).\n-export([go/0]).\n\ngo() -> ok.\n',
  );
  write(
    'erlang/src/main.erl',
    '-module(main).\n-import(util, [go/0]).\n-include("records.hrl").\n'
      + '-export([run/0]).\n\nrun() -> go().\n',
  );

  // ── Fortran ────────────────────────────────────────────────────────────────
  write(
    'fortran/src/math_utils.f90',
    'module math_utils\ncontains\n  function add(a, b) result(c)\n'
      + '    integer :: a, b, c\n    c = a + b\n  end function add\nend module math_utils\n',
  );
  write(
    'fortran/src/main.f90',
    'program driver\n  use math_utils\n  print *, add(1, 2)\nend program driver\n',
  );

  const result = await indexFolder(root, { fileLimit: 100 });
  repoId = result.repoId;
}, 120_000);

afterAll(() => {
  if (repoId) deleteIndex(repoId);
  rmSync(root, { recursive: true, force: true });
});

describe('Wave 2 dependency edges end to end (Task 535)', () => {
  it('the mixed repo no longer indexes to zero dependency edges', () => {
    const db = openDatabase(repoId);
    const row = db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM dep_edges WHERE repo_id = ?')
      .get(repoId);
    db.close();
    expect(row!.n).toBeGreaterThanOrEqual(5);
  });

  it('PHP: use-clause resolves via declared namespace; blast radius sees the importer', () => {
    expect(edgesFrom('php/src/Kernel.php')).toEqual(['php/src/Support/Logger.php']);
    expect(blastFilesOf('App\\Support\\Logger')).toContain('php/src/Kernel.php');
  });

  it('Haskell: import resolves via the declared module header; blast radius sees the importer', () => {
    expect(edgesFrom('haskell/app/Main.hs')).toEqual(['haskell/src/Data/Util.hs']);
    expect(blastFilesOf('shout')).toContain('haskell/app/Main.hs');
  });

  it('Elixir: alias resolves via the module symbol table; blast radius sees the importer', () => {
    expect(edgesFrom('elixir/lib/app_web/controller.ex')).toEqual(['elixir/lib/app/accounts.ex']);
    expect(blastFilesOf('App.Accounts')).toContain('elixir/lib/app_web/controller.ex');
  });

  it('Erlang: -import resolves by module basename AND -include by header basename', () => {
    expect(edgesFrom('erlang/src/main.erl')).toEqual([
      'erlang/include/records.hrl',
      'erlang/src/util.erl',
    ]);
    expect(blastFilesOf('go')).toContain('erlang/src/main.erl');
  });

  it('Fortran: USE resolves via the module symbol table; blast radius sees the importer', () => {
    expect(edgesFrom('fortran/src/main.f90')).toEqual(['fortran/src/math_utils.f90']);
    expect(blastFilesOf('math_utils')).toContain('fortran/src/main.f90');
  });
});
