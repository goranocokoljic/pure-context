/**
 * Symbol-edge build step (Phase 101, Task 630) — the index-manager side of
 * `src/graph/symbol-edges.ts`.
 *
 * Runs right after the file edges of a build are stored, while the linked
 * indexes of that build are still open, so cross `ref` rows and re-export
 * chains across a seam see the same workspace the file edges did.
 *
 * Scope rules (design note §2.5):
 *   - 'all'        → drop every row and rebuild from every indexed file
 *                    (whole-tree first build, link-set change, full
 *                    re-resolve, or the one-time backfill of a pre-v14 index);
 *   - file list    → rebuild those files PLUS their direct local importers
 *                    (a re-keyed target symbol dangles otherwise), and drop
 *                    rows into the listed files whose target id vanished.
 * Never throws: a failure is logged and the run continues (the test-mapper
 * discipline) — the readers fall back to the file answer.
 */
import type Database from 'better-sqlite3';
import { getConfig } from '../config/config-loader.js';
import { logger } from './logger.js';
import { buildSymbolEdges, type RefIndexView } from '../graph/symbol-edges.js';
import type { LinkedGraphTarget } from '../graph/graph-builder.js';
import { getSymbolsByFile } from './db/symbol-store.js';
import { getImportRecordsByFile } from './db/import-store.js';
import { getForwardDeps, getImportersOf } from './db/dep-store.js';
import { getFileContent, getAllFileHashes } from './db/file-store.js';
import {
  countSymbolRefs,
  deleteAllSymbolRefs,
  deleteDanglingSymbolRefsInto,
  deleteSymbolRefsBySource,
  insertSymbolRefs,
} from './db/symbol-ref-store.js';

/** Config + env + per-run option folded into one switch. */
export function symbolEdgesEnabled(skip?: boolean): boolean {
  if (skip) return false;
  return getConfig().graph.symbolEdges !== 'off';
}

/** The local index as the builder sees it. */
export function localRefView(db: Database.Database, repoId: string): RefIndexView {
  return {
    repoId,
    symbolsByFile: (path) => getSymbolsByFile(db, repoId, path),
    importRecordsByFile: (path) => getImportRecordsByFile(db, repoId, path),
    forwardDeps: (path) => getForwardDeps(db, repoId, path, undefined, true),
    fileContent: (path) => getFileContent(db, repoId, path),
  };
}

export interface SymbolRefBuildStats {
  refs: number;
  filesScanned: number;
  ms: number;
  scope: 'all' | 'files';
}

/**
 * Rebuild `ref` rows. `scope` is `'all'` or the files this run reprocessed.
 * A repo that has file edges but NO refs yet is backfilled whole once (a
 * pre-v14 index on its first v14 run), whatever the scope.
 */
export function rebuildSymbolRefs(
  db: Database.Database,
  repoId: string,
  scope: 'all' | string[],
  links: LinkedGraphTarget[],
): SymbolRefBuildStats | null {
  const t0 = Date.now();
  try {
    const backfill = scope !== 'all' && countSymbolRefs(db, repoId) === 0;
    const effective: 'all' | string[] = backfill ? 'all' : scope;

    let sourceFiles: string[];
    if (effective === 'all') {
      deleteAllSymbolRefs(db, repoId);
      sourceFiles = [...getAllFileHashes(db, repoId).keys()];
    } else {
      const set = new Set(effective);
      for (const f of effective) {
        for (const importer of getImportersOf(db, repoId, f)) set.add(importer);
      }
      db.transaction(() => {
        for (const f of set) deleteSymbolRefsBySource(db, repoId, f);
        for (const f of effective) deleteDanglingSymbolRefsInto(db, repoId, f);
      })();
      sourceFiles = [...set];
    }
    if (sourceFiles.length === 0) {
      return { refs: 0, filesScanned: 0, ms: Date.now() - t0, scope: effective === 'all' ? 'all' : 'files' };
    }

    const linkViews = new Map<string, RefIndexView>();
    for (const t of links) {
      if (t.refView) linkViews.set(t.repoId, t.refView());
    }

    const result = buildSymbolEdges(localRefView(db, repoId), sourceFiles, {
      maxWildcardFanout: getConfig().graph.maxWildcardFanout,
      links: linkViews,
    });
    insertSymbolRefs(db, result.refs);

    const ms = Date.now() - t0;
    if (result.cappedExpansions > 0) {
      logger.debug(
        `symbol-edges: ${result.cappedExpansions} open-import expansion(s) hit graph.maxWildcardFanout`,
      );
    }
    logger.info(
      `symbol-edges: ${result.refs.length} ref(s) from ${result.filesScanned} file(s) in ${ms} ms` +
        (effective === 'all' ? (backfill ? ' (backfill)' : ' (full)') : ''),
    );
    return { refs: result.refs.length, filesScanned: result.filesScanned, ms, scope: effective === 'all' ? 'all' : 'files' };
  } catch (err) {
    logger.warn(`symbol-edges: build failed (${String(err)}) — tools answer at file granularity`);
    return null;
  }
}
