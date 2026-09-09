/**
 * Elixir import resolver (Phase 86).
 *
 * Maps `alias` / `import` / `use` / `require` specifiers (`A.B`) to files
 * inside the repo. Multiple `defmodule` per file are legal in Elixir, so the
 * module map comes from the SYMBOLS table (the handler stores fully qualified
 * module names like `App.Accounts.User` with kind 'class' — protocols get
 * 'interface'), not from a one-per-file declaration column.
 *
 * `A.B.C` with no exact module falls back to the longest known module prefix
 * (nested-module convention: `alias App.Accounts.User` may target a module
 * defined inside `App.Accounts`'s file). Unmatched specifiers (`Ecto.*`,
 * `Phoenix.*`, stdlib) are external → no edge.
 */

import type Database from 'better-sqlite3';
import { isTestFilePath } from '../core/test-paths.js';
import { dropForeignCandidates } from '../core/library-paths.js';

// ─── Public surface ───────────────────────────────────────────────────────────

export const ELIXIR_FAMILY_EXTENSIONS = new Set(['.ex', '.exs']);

export function isElixirSourceFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.ex') || lower.endsWith('.exs');
}

export interface ElixirResolver {
  /**
   * Resolve a module specifier to repo-relative file paths (as stored in the
   * DB). Empty array = external (deps, stdlib) or unresolvable.
   */
  resolve(specifier: string, sourceFile: string): string[];
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createElixirResolver(
  db: Database.Database,
  repoId: string,
): ElixirResolver {
  const allPaths = db
    .prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ?')
    .all(repoId)
    .map((r) => r.path);
  const exSet = new Set(allPaths.filter(isElixirSourceFile));

  // qualified module name → declaring files (defmodule/defprotocol symbols)
  const moduleFiles = new Map<string, string[]>();
  if (exSet.size > 0) {
    const rows = db
      .prepare<[string], { name: string; kind: string; file_path: string }>(
        'SELECT name, kind, file_path FROM symbols WHERE repo_id = ?',
      )
      .all(repoId);
    for (const { name, kind, file_path } of rows) {
      if (!exSet.has(file_path)) continue;
      if (kind !== 'class' && kind !== 'interface') continue;
      const list = moduleFiles.get(name);
      if (list) list.push(file_path);
      else moduleFiles.set(name, [file_path]);
    }
  }

  return {
    resolve(specifier: string, sourceFile: string): string[] {
      const spec = specifier.trim();
      if (spec.length === 0) return [];

      // Exact module first, then the longest known module prefix.
      const parts = spec.split('.').filter((p) => p.length > 0);
      for (let i = parts.length; i >= 1; i--) {
        const name = parts.slice(0, i).join('.');
        const hits = moduleFiles.get(name);
        if (!hits) continue;
        // Phase 98: a hit that hygiene removes (deps/ module, test/support
        // double) must not stop the prefix walk — a shorter first-party
        // prefix may still answer.
        const clean = hygiene(hits.filter((f) => f !== sourceFile), sourceFile);
        if (clean.length > 0) return clean;
      }
      return [];
    },
  };
}

/**
 * Phase 98 (Task 611) resolver hygiene, applied to every candidate list:
 *   - a first-party importer never resolves into a foreign directory
 *     (deps/, vendor/, _build/, node_modules/ …) — the Go vendor rule;
 *   - a non-test importer never resolves to a test file (Phase-89 rule).
 * Test importers and importers that themselves live in a foreign directory
 * are left alone (rabbitmq-server keeps its components under deps/).
 */
function hygiene(candidates: string[], sourceFile: string): string[] {
  const foreignFiltered = dropForeignCandidates(candidates, sourceFile);
  if (isTestFilePath(sourceFile)) return foreignFiltered;
  return foreignFiltered.filter((f) => !isTestFilePath(f));
}
