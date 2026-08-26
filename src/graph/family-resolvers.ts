/**
 * Family-resolver construction (Phase 84; table-driven since Phase 86).
 *
 * One place that decides which per-family import resolvers a graph build
 * needs, based on the source files present in the import batch. Each resolver
 * reads the full files/symbols tables, so it must be built AFTER file/symbol
 * persistence (both index-manager call sites do this). A batch with none of a
 * family's files pays zero cost for that family.
 */

import type Database from 'better-sqlite3';
import type { ImportRecord } from '../core/types.js';
import type { FamilyResolvers } from './graph-builder.js';
import { createJvmResolver, isDeclaredModuleSourceFile } from './jvm-resolver.js';
import { createPythonResolver, isPythonSourceFile } from './python-resolver.js';
import { createGoResolver, isGoSourceFile } from './go-resolver.js';
import { createPhpResolver, isPhpSourceFile } from './php-resolver.js';
import { createHaskellResolver, isHaskellSourceFile } from './haskell-resolver.js';
import { createElixirResolver, isElixirSourceFile } from './elixir-resolver.js';
import { createErlangResolver, isErlangSourceFile } from './erlang-resolver.js';
import { createFortranResolver, isFortranSourceFile } from './fortran-resolver.js';
import { createRustResolver, isRustSourceFile } from './rust-resolver.js';

interface FamilyDef {
  key: keyof FamilyResolvers;
  isFile: (filePath: string) => boolean;
  build: (
    db: Database.Database,
    repoId: string,
    projectRoot: string,
  ) => FamilyResolvers[keyof FamilyResolvers];
}

const FAMILY_DEFS: FamilyDef[] = [
  { key: 'jvm', isFile: isDeclaredModuleSourceFile, build: (db, id, root) => createJvmResolver(db, id, root) },
  { key: 'python', isFile: isPythonSourceFile, build: (db, id) => createPythonResolver(db, id) },
  { key: 'go', isFile: isGoSourceFile, build: (db, id, root) => createGoResolver(db, id, root) },
  { key: 'php', isFile: isPhpSourceFile, build: (db, id, root) => createPhpResolver(db, id, root) },
  { key: 'haskell', isFile: isHaskellSourceFile, build: (db, id) => createHaskellResolver(db, id) },
  { key: 'elixir', isFile: isElixirSourceFile, build: (db, id) => createElixirResolver(db, id) },
  { key: 'erlang', isFile: isErlangSourceFile, build: (db, id) => createErlangResolver(db, id) },
  { key: 'fortran', isFile: isFortranSourceFile, build: (db, id) => createFortranResolver(db, id) },
  { key: 'rust', isFile: isRustSourceFile, build: (db, id, root) => createRustResolver(db, id, root) },
];

export function buildFamilyResolvers(
  db: Database.Database,
  repoId: string,
  projectRoot: string,
  imports: ImportRecord[],
): FamilyResolvers | undefined {
  const present = new Set<keyof FamilyResolvers>();
  for (const imp of imports) {
    if (present.size === FAMILY_DEFS.length) break;
    for (const def of FAMILY_DEFS) {
      if (!present.has(def.key) && def.isFile(imp.sourceFile)) {
        present.add(def.key);
        break;
      }
    }
  }
  if (present.size === 0) return undefined;

  const families: FamilyResolvers = {};
  for (const def of FAMILY_DEFS) {
    if (present.has(def.key)) {
      (families as Record<string, unknown>)[def.key] = def.build(db, repoId, projectRoot);
    }
  }
  return families;
}
