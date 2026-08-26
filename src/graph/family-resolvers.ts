/**
 * Family-resolver construction (Phase 84).
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

export function buildFamilyResolvers(
  db: Database.Database,
  repoId: string,
  projectRoot: string,
  imports: ImportRecord[],
): FamilyResolvers | undefined {
  let hasJvm = false;
  let hasPython = false;
  let hasGo = false;
  for (const imp of imports) {
    if (!hasJvm && isDeclaredModuleSourceFile(imp.sourceFile)) hasJvm = true;
    else if (!hasPython && isPythonSourceFile(imp.sourceFile)) hasPython = true;
    else if (!hasGo && isGoSourceFile(imp.sourceFile)) hasGo = true;
    if (hasJvm && hasPython && hasGo) break;
  }
  if (!hasJvm && !hasPython && !hasGo) return undefined;

  const families: FamilyResolvers = {};
  if (hasJvm) families.jvm = createJvmResolver(db, repoId, projectRoot);
  if (hasPython) families.python = createPythonResolver(db, repoId);
  if (hasGo) families.go = createGoResolver(db, repoId, projectRoot);
  return families;
}
