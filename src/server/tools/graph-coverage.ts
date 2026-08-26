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

/** Below this many indexed files an empty graph is unremarkable (tiny repos). */
const MIN_FILES_FOR_SIGNAL = 20;

export interface GraphCoverageWarning {
  graphCoverage: 'empty';
  graphCoverageNote: string;
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
  if (edges > 0) return null;

  const files =
    db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM files WHERE repo_id = ?')
      .get(repoId)?.n ?? 0;
  if (files < MIN_FILES_FOR_SIGNAL) return null;

  return {
    graphCoverage: 'empty',
    graphCoverageNote:
      'This repo has ZERO import edges — empty results here mean the dependency graph is missing, ' +
      'NOT that nothing depends on the symbol. Import resolution may not cover this language mix ' +
      '(unresolved: Ruby and the long tail — see LANGUAGE-SUPPORT.md). Use find_references ' +
      '(content scan) and get_co_change (git history) instead, and re-index if the repo was indexed ' +
      'before the version that added its resolver (JVM v1.15.0, C# v1.16.0, Python/Go v1.17.0, ' +
      'PHP/Haskell/Elixir/Erlang/Fortran v1.19.0, Rust v1.20.0).',
  };
}
