/**
 * Task 502 (Phase 82): empty-graph honesty signal.
 *
 * On repos whose language mix has no import resolution (see the support matrix
 * in LANGUAGE-SUPPORT.md), the dependency graph is EMPTY — and an empty blast
 * radius then looks identical to "nothing depends on this symbol". Graph-backed
 * tools attach this warning so agents can tell a missing graph from a safe
 * change.
 */
import type Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getIndexDir, openDatabase } from '../../core/db/schema.js';

/** Below this many indexed files an empty graph is unremarkable (tiny repos). */
const MIN_FILES_FOR_SIGNAL = 20;

export interface GraphCoverageWarning {
  /**
   * 'empty'   — no RESOLVABLE edge at all (Phase 98: rows whose target is
   *             not an indexed file no longer count; pre-98 they masked this).
   * 'partial' — more than half of the stored rows are dangling (target not
   *             indexed) — an index built before v1.31.0 still carries the
   *             phantom rows Phase 98 stopped emitting; re-index to heal.
   */
  graphCoverage: 'empty' | 'partial';
  graphCoverageNote: string;
  /** Present on 'partial': how many rows dangle vs resolve. */
  danglingEdges?: number;
  resolvableEdges?: number;
  /**
   * Phase 99: cross-index rows whose LINKED index is gone or no longer holds
   * the target — per link. Present whenever at least one such row exists.
   */
  danglingLinked?: Array<{ repoId: string; count: number; reason: 'index_missing' | 'file_missing' }>;
}

/**
 * Cross-index rows: resolvable when the linked DB holds the target (one
 * second-connection query per linked repo — no ATTACH). Returns per-repo
 * counts of resolvable vs dangling rows.
 */
function crossCoverage(
  db: Database.Database,
  repoId: string,
): { resolvable: number; dangling: NonNullable<GraphCoverageWarning['danglingLinked']> } {
  const rows = db
    .prepare<[string], { target_repo_id: string; target_file: string; n: number }>(
      'SELECT target_repo_id, target_file, COUNT(*) AS n FROM dep_edges ' +
        'WHERE repo_id = ? AND target_repo_id IS NOT NULL GROUP BY target_repo_id, target_file',
    )
    .all(repoId);
  if (rows.length === 0) return { resolvable: 0, dangling: [] };
  const byRepo = new Map<string, Array<{ file: string; n: number }>>();
  for (const r of rows) {
    const list = byRepo.get(r.target_repo_id) ?? [];
    list.push({ file: r.target_file, n: r.n });
    byRepo.set(r.target_repo_id, list);
  }
  let resolvable = 0;
  const dangling: NonNullable<GraphCoverageWarning['danglingLinked']> = [];
  for (const [linkedId, targets] of byRepo) {
    const total = targets.reduce((s, t) => s + t.n, 0);
    if (!existsSync(join(getIndexDir(), `${linkedId}.db`))) {
      dangling.push({ repoId: linkedId, count: total, reason: 'index_missing' });
      continue;
    }
    let ldb: Database.Database | null = null;
    try {
      ldb = openDatabase(linkedId);
      const has = ldb.prepare<[string, string], { x: number }>(
        'SELECT 1 AS x FROM files WHERE repo_id = ? AND path = ?',
      );
      let missing = 0;
      for (const t of targets) {
        if (has.get(linkedId, t.file)) resolvable += t.n;
        else missing += t.n;
      }
      if (missing > 0) dangling.push({ repoId: linkedId, count: missing, reason: 'file_missing' });
    } catch {
      dangling.push({ repoId: linkedId, count: total, reason: 'index_missing' });
    } finally {
      try {
        ldb?.close();
      } catch {
        /* ignore */
      }
    }
  }
  return { resolvable, dangling };
}

/**
 * Returns the warning when the repo has zero dependency edges despite a
 * non-trivial number of indexed files; null otherwise (normal case — two cheap
 * COUNT queries).
 */
export function graphCoverageWarning(
  db: Database.Database,
  repoId: string,
): GraphCoverageWarning | null {
  const edges =
    db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM dep_edges WHERE repo_id = ?')
      .get(repoId)?.n ?? 0;
  const localResolvable =
    db
      .prepare<[string], { n: number }>(
        'SELECT COUNT(*) AS n FROM dep_edges e WHERE e.repo_id = ? AND e.target_repo_id IS NULL AND EXISTS ' +
          '(SELECT 1 FROM files f WHERE f.repo_id = e.repo_id AND f.path = e.target_file)',
      )
      .get(repoId)?.n ?? 0;
  // Phase 99: a cross-index row resolves when the LINKED index holds the target.
  const cross = crossCoverage(db, repoId);
  const resolvable = localResolvable + cross.resolvable;
  const linkedNote =
    cross.dangling.length > 0
      ? ` ${cross.dangling.reduce((s, d) => s + d.count, 0)} cross-index edge(s) dangle: ` +
        cross.dangling
          .map((d) => `${d.repoId} (${d.reason === 'index_missing' ? 'linked index missing' : 'files gone from the linked index'}: ${d.count})`)
          .join(', ') +
        ' — re-run index_folder on this root to re-resolve the seam.'
      : '';
  if (resolvable > 0) {
    const dangling = edges - resolvable;
    if (dangling > resolvable) {
      return {
        graphCoverage: 'partial',
        graphCoverageNote:
          `${dangling} of ${edges} import edges point at files that are not in the index ` +
          '(phantom targets from an index built before v1.31.0, or excluded/deleted files). ' +
          'Graph answers are incomplete for those importers — re-run index_folder to heal.' +
          linkedNote,
        danglingEdges: dangling,
        resolvableEdges: resolvable,
        ...(cross.dangling.length > 0 ? { danglingLinked: cross.dangling } : {}),
      };
    }
    if (cross.dangling.length > 0) {
      return {
        graphCoverage: 'partial',
        graphCoverageNote: `Cross-index edges are stale.${linkedNote}`,
        danglingEdges: dangling,
        resolvableEdges: resolvable,
        danglingLinked: cross.dangling,
      };
    }
    return null;
  }

  const files =
    db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM files WHERE repo_id = ?')
      .get(repoId)?.n ?? 0;
  if (files < MIN_FILES_FOR_SIGNAL) return null;

  return {
    graphCoverage: 'empty',
    graphCoverageNote:
      'This repo has ZERO resolvable import edges — empty results here mean the dependency graph is missing, ' +
      'NOT that nothing depends on the symbol. Import resolution may not cover this language mix ' +
      '(unresolved: Protobuf, SQL/dbt, GDScript, Gleam, Lua, R — see LANGUAGE-SUPPORT.md). Use find_references ' +
      '(content scan) and get_co_change (git history) instead, and re-index if the repo was indexed ' +
      'before the version that added its resolver (JVM v1.15.0, C# v1.16.0, Python/Go v1.17.0, ' +
      'PHP/Haskell/Elixir/Erlang/Fortran v1.19.0, Rust v1.20.0, Dart v1.31.0, Ruby v1.36.0).',
  };
}
