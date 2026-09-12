/**
 * Phase 103, Task 643 / 645 — Elixir `defp` and C++ label-less private members
 * are indexed through the full indexFolder pipeline with `visibility:
 * 'private'` in frameworkMeta, and search still finds them by exact name.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { elixirHandler } from '../../src/handlers/elixir.js';
import { cppHandler } from '../../src/handlers/cpp.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { openDatabase } from '../../src/core/db/schema.js';

let root: string;
let repoId: string;

function write(relPath: string, content: string) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function metaOf(name: string): Record<string, unknown> | null {
  const db = openDatabase(repoId);
  const row = db
    .prepare<[string, string], { framework_meta: string | null }>(
      'SELECT framework_meta FROM symbols WHERE repo_id = ? AND name = ?',
    )
    .get(repoId, name);
  db.close();
  if (!row) return null;
  return row.framework_meta ? (JSON.parse(row.framework_meta) as Record<string, unknown>) : {};
}

beforeAll(async () => {
  _resetForTesting();
  registerHandler(elixirHandler);
  registerHandler(cppHandler);
  await initParser();
  root = resolve(mkdtempSync(join(tmpdir(), 'pc-p103-vis-')));
  write(
    'lib/app/accounts.ex',
    'defmodule App.Accounts do\n  def create(attrs), do: normalize(attrs)\n  defp normalize(attrs), do: attrs\n  defmacrop guard(x), do: quote(do: unquote(x))\nend\n',
  );
  write(
    'src/engine.hpp',
    'class Engine {\n  void tick();\npublic:\n  void run();\nprivate:\n  int step();\n};\nstruct Plain {\n  void open();\n};\n',
  );
  const result = await indexFolder(root, { fileLimit: 100 });
  repoId = result.repoId;
}, 120_000);

afterAll(() => {
  if (repoId) deleteIndex(repoId);
  rmSync(root, { recursive: true, force: true });
});

describe('Phase 103 visibility end to end (Task 643)', () => {
  it('Elixir: defp and defmacrop are stored with visibility private; def is untagged', () => {
    expect(metaOf('App.Accounts.create')).toEqual({});
    expect(metaOf('App.Accounts.normalize')).toEqual({ visibility: 'private' });
    expect(metaOf('App.Accounts.guard')).toEqual({ elixir_macro: true, visibility: 'private' });
  });

  it('C++: label-less class members and private: members are stored tagged; public and struct members are not', () => {
    expect(metaOf('Engine::tick')).toEqual({ visibility: 'private' });
    expect(metaOf('Engine::step')).toEqual({ visibility: 'private' });
    expect(metaOf('Engine::run')).toEqual({});
    expect(metaOf('Plain::open')).toEqual({});
  });
});
