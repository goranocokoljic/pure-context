import type { ImportRecord, DepEdge } from '../core/types.js';
import type { PathResolver } from './path-resolver.js';
import { isDeclaredModuleSourceFile, type JvmResolver } from './jvm-resolver.js';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert a batch of ImportRecords into DepEdges.
 *
 * Each ImportRecord may or may not have `resolvedPath` pre-filled; if it is
 * null a resolver is called to fill it. Imports from declared-module source
 * files (.kt/.java/.scala/.groovy/.cs/…) go through the package resolver when one is
 * supplied — it can yield SEVERAL targets (wildcard imports, cross-module
 * ambiguity), each becoming an edge. All other files use the path resolver,
 * whose behavior is unchanged. Records that resolve to nothing (external
 * packages) are silently dropped — they don't belong in the in-project graph.
 *
 * Phase 1 emits one file-level edge per unique (sourceFile, targetFile) pair.
 * Symbol-level edge population is deferred to Phase 2 when we have a DB
 * handle available during incremental reindexing.
 */
export function buildGraph(
  imports: ImportRecord[],
  resolver: PathResolver,
  repoId: string,
  jvmResolver?: JvmResolver,
): DepEdge[] {
  // Deduplicate by (sourceFile, targetFile) to avoid flooding the dep table
  // with one row per named import specifier from the same module.
  const seen = new Set<string>();
  const edges: DepEdge[] = [];

  for (const rec of imports) {
    if (!rec.sourceFile) continue; // guard against unfilled sourceFile

    // Resolve the path(s) if the handler left resolvedPath null
    let targetFiles: string[];
    if (rec.resolvedPath !== null) {
      targetFiles = [rec.resolvedPath];
    } else if (jvmResolver && isDeclaredModuleSourceFile(rec.sourceFile)) {
      targetFiles = jvmResolver.resolve(rec.specifier, rec.sourceFile);
    } else {
      const resolved = resolver.resolve(rec.specifier, rec.sourceFile);
      targetFiles = resolved === null ? [] : [resolved];
    }

    for (const targetFile of targetFiles) {
      const key = `${rec.sourceFile}\0${targetFile}`;
      if (seen.has(key)) continue;
      seen.add(key);

      edges.push({
        repoId,
        sourceFile: rec.sourceFile,
        sourceSymbolId: null,
        targetFile,
        targetSymbolId: null,
        edgeType: detectEdgeType(rec),
        specifier: rec.specifier,
      });
    }
  }

  return edges;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectEdgeType(rec: ImportRecord): string {
  // re-exports: `export { foo } from './foo'` — importedNames contains
  // re-exported names. We can't distinguish this from a regular named import
  // at the ImportRecord level in Phase 1, so everything is 'import'.
  void rec;
  return 'import';
}
