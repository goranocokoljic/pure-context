/**
 * Fortran import resolver (Phase 86).
 *
 * Maps `USE module_name` specifiers to files whose symbol table declares that
 * MODULE. The Fortran handler emits modules as kind 'class' with signature
 * `MODULE <name>` and stores names lowercased; Fortran is case-insensitive,
 * so lookups lowercase the specifier too (the handler already lowercases the
 * USE specifier, but external callers may not).
 *
 * Unmatched modules (compiler intrinsics like iso_fortran_env, external
 * libraries) are external → no edge.
 */

import type Database from 'better-sqlite3';

// ─── Public surface ───────────────────────────────────────────────────────────

export const FORTRAN_FAMILY_EXTENSIONS = new Set([
  '.f90', '.f95', '.f03', '.f08', '.for', '.f',
]);

export function isFortranSourceFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return false;
  return FORTRAN_FAMILY_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

export interface FortranResolver {
  /**
   * Resolve a module specifier to repo-relative file paths (as stored in the
   * DB). Empty array = external (intrinsic, library) or unresolvable.
   */
  resolve(specifier: string, sourceFile: string): string[];
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createFortranResolver(
  db: Database.Database,
  repoId: string,
): FortranResolver {
  const allPaths = db
    .prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ?')
    .all(repoId)
    .map((r) => r.path);
  const fortSet = new Set(allPaths.filter(isFortranSourceFile));

  // module name (lowercase) → declaring files. Discriminated by the handler's
  // signature shape — Fortran 'class' symbols also cover PROGRAM/TYPE units.
  const moduleFiles = new Map<string, string[]>();
  if (fortSet.size > 0) {
    const rows = db
      .prepare<[string], { name: string; kind: string; signature: string; file_path: string }>(
        'SELECT name, kind, signature, file_path FROM symbols WHERE repo_id = ?',
      )
      .all(repoId);
    for (const { name, kind, signature, file_path } of rows) {
      if (!fortSet.has(file_path)) continue;
      if (kind !== 'class' || !signature.startsWith('MODULE ')) continue;
      const key = name.toLowerCase();
      const list = moduleFiles.get(key);
      if (list) list.push(file_path);
      else moduleFiles.set(key, [file_path]);
    }
  }

  return {
    resolve(specifier: string, sourceFile: string): string[] {
      const spec = specifier.trim().toLowerCase();
      if (spec.length === 0) return [];
      return (moduleFiles.get(spec) ?? []).filter((f) => f !== sourceFile);
    },
  };
}
