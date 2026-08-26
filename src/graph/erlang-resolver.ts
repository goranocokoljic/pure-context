/**
 * Erlang import resolver (Phase 86).
 *
 * Erlang's language rule: module == file basename (`rabbit_channel` lives in
 * `rabbit_channel.erl`), so resolution is a basename lookup among indexed
 * files. The handler previously hardcoded every `-import` as external — wrong
 * for in-repo modules.
 *
 * Specifier shapes handled (as emitted by the Erlang handler):
 *   module:fun/arity     from -import(module, [fun/arity, …])
 *   path/to/file.hrl     from -include / -include_lib (Phase 86 addition);
 *                        resolved by header basename — include dirs are build
 *                        configuration the indexer cannot see
 *
 * Same basename in several directories → edges to ALL candidates (Phase 82
 * rule). Unmatched modules (OTP stdlib, deps) are external → no edge.
 */

import type Database from 'better-sqlite3';

// ─── Public surface ───────────────────────────────────────────────────────────

export const ERLANG_FAMILY_EXTENSIONS = new Set(['.erl', '.hrl']);

export function isErlangSourceFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.erl') || lower.endsWith('.hrl');
}

export interface ErlangResolver {
  /**
   * Resolve a specifier to repo-relative file paths (as stored in the DB).
   * Empty array = external (OTP, deps) or unresolvable.
   */
  resolve(specifier: string, sourceFile: string): string[];
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createErlangResolver(
  db: Database.Database,
  repoId: string,
): ErlangResolver {
  const allPaths = db
    .prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ?')
    .all(repoId)
    .map((r) => r.path);

  // module name → .erl files; header basename ("records.hrl") → .hrl files
  const modFiles = new Map<string, string[]>();
  const hrlFiles = new Map<string, string[]>();
  for (const f of allPaths) {
    const norm = f.replace(/\\/g, '/');
    const base = norm.slice(norm.lastIndexOf('/') + 1);
    const lower = base.toLowerCase();
    if (lower.endsWith('.erl')) {
      const mod = base.slice(0, -'.erl'.length);
      const list = modFiles.get(mod);
      if (list) list.push(f);
      else modFiles.set(mod, [f]);
    } else if (lower.endsWith('.hrl')) {
      const list = hrlFiles.get(base);
      if (list) list.push(f);
      else hrlFiles.set(base, [f]);
    }
  }

  return {
    resolve(specifier: string, sourceFile: string): string[] {
      const spec = specifier.trim();
      if (spec.length === 0) return [];

      // `module:fun/arity` — check FIRST: the arity slash would otherwise
      // look like a path separator.
      if (spec.includes(':')) {
        const mod = spec.split(':')[0]!.trim();
        return (modFiles.get(mod) ?? []).filter((f) => f !== sourceFile);
      }

      // Header include: path literal from -include / -include_lib
      if (spec.includes('/') || spec.toLowerCase().endsWith('.hrl')) {
        const base = spec.slice(spec.lastIndexOf('/') + 1);
        return (hrlFiles.get(base) ?? []).filter((f) => f !== sourceFile);
      }

      // Bare module name
      return (modFiles.get(spec) ?? []).filter((f) => f !== sourceFile);
    },
  };
}
