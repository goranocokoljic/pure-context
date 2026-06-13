/**
 * co-change.ts
 *
 * Pure query/scoring functions for temporal coupling (co-change) — files that
 * historically change together in the same commits. Unit-testable without MCP.
 *
 * Data source: the `commit_files` table (repo-level commit→files capture, see
 * co-change-store.ts). Co-change of two files is a self-join on `commit_sha`.
 *
 * Explainable association metrics (not raw counts):
 *   support    — number of shared commits (after noise filtering)
 *   confidence — support / commits(target)  (directional A→B; the signal agents want)
 *   lift       — support × N / (commits(A) × commits(B))
 *
 * Noise handling (the part generic "churn dashboards" skip):
 *   - Mega-commit filter: commits touching > megaCommitThreshold files are
 *     excluded entirely (reformats, lockfile sweeps, codemods).
 *   - Mega-commit down-weighting: each retained shared commit contributes
 *     1/(k−1) (k = files in commit), so a 25-file commit counts far less than a
 *     focused 2-file commit. `weightedSupport` ranks partners.
 *   - Min-support floor drops one-off coincidences.
 *   - signalQuality:"low" flags sparse/shallow histories rather than presenting
 *     weak ratios as strong.
 */

import type Database from 'better-sqlite3';
import { countCommits, countCommitsForFile } from '../../core/db/co-change-store.js';

export interface CoChangeOptions {
  /** Drop partners with fewer than this many shared commits (default 2). */
  minSupport?: number;
  /** Commits touching more than this many files are excluded (default 30). */
  megaCommitThreshold?: number;
  /** Look back N days (optional; default: entire captured window). */
  dayWindow?: number;
  /** Maximum partners to return (default 20). */
  topN?: number;
}

export interface CoChangePartner {
  filePath: string;
  /** Shared commit count (after mega-commit exclusion). */
  support: number;
  /** Sum of 1/(k−1) over shared commits — the down-weighted ranking score. */
  weightedSupport: number;
  /** support / commits(target) — directional, in [0,1]. */
  confidence: number;
  /** support × N / (commits(target) × commits(partner)). >1 ⇒ positive coupling. */
  lift: number;
  /** Most recent shared commit date (ISO string), or null. */
  coChangeDate: string | null;
}

export interface CoChangeResult {
  targetFilePath: string;
  /** Distinct commits touching the target (the confidence denominator). */
  targetCommits: number;
  /** Total distinct commits in the analysis window. */
  windowCommits: number;
  signalQuality: 'ok' | 'low';
  partners: CoChangePartner[];
}

interface SharedCommitRow {
  commit_sha: string;
  commit_date: number;
  k: number;
}

interface PartnerFileRow {
  commit_sha: string;
  file_path: string;
}

function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Compute ranked co-change partners for a target file.
 *
 * Returns an empty partner list (never throws) when the repo has no co-change
 * data or the target file has no recorded commits.
 */
export function getCoChange(
  db: Database.Database,
  repoId: string,
  targetFilePath: string,
  opts: CoChangeOptions = {},
): CoChangeResult {
  const minSupport = opts.minSupport ?? 2;
  const megaThreshold = opts.megaCommitThreshold ?? 30;
  const topN = opts.topN ?? 20;

  const windowCommits = countCommits(db, repoId);
  const targetCommits = countCommitsForFile(db, repoId, targetFilePath);

  const empty: CoChangeResult = {
    targetFilePath,
    targetCommits,
    windowCommits,
    signalQuality: targetCommits < 5 || windowCommits < 20 ? 'low' : 'ok',
    partners: [],
  };

  if (windowCommits === 0 || targetCommits === 0) return empty;

  const sinceTs =
    opts.dayWindow && opts.dayWindow > 0
      ? Math.floor(Date.now() / 1000) - opts.dayWindow * 86_400
      : null;

  // 1. Commits touching the target, each annotated with its total file count k.
  const dateClause = sinceTs !== null ? 'AND cf.commit_date >= ?' : '';
  const sharedRows = db
    .prepare<unknown[], SharedCommitRow>(`
      SELECT cf.commit_sha AS commit_sha,
             cf.commit_date AS commit_date,
             (SELECT COUNT(*) FROM commit_files c2
                WHERE c2.repo_id = ? AND c2.commit_sha = cf.commit_sha) AS k
      FROM commit_files cf
      WHERE cf.repo_id = ? AND cf.file_path = ? ${dateClause}
    `)
    .all(
      sinceTs !== null
        ? [repoId, repoId, targetFilePath, sinceTs]
        : [repoId, repoId, targetFilePath],
    );

  // Keep only non-mega commits that touched at least one other file (k >= 2).
  const retained = sharedRows.filter((r) => r.k >= 2 && r.k <= megaThreshold);
  if (retained.length === 0) return empty;

  const shaToWeight = new Map<string, number>();   // 1/(k-1)
  const shaToDate = new Map<string, number>();
  for (const r of retained) {
    shaToWeight.set(r.commit_sha, 1 / (r.k - 1));
    shaToDate.set(r.commit_sha, r.commit_date);
  }

  // 2. All (commit, file) pairs for the retained commits — partners are the
  //    non-target files in those commits.
  const shas = [...shaToWeight.keys()];
  const placeholders = shas.map(() => '?').join(', ');
  const partnerRows = db
    .prepare<unknown[], PartnerFileRow>(`
      SELECT commit_sha, file_path
      FROM commit_files
      WHERE repo_id = ? AND commit_sha IN (${placeholders})
    `)
    .all([repoId, ...shas]);

  interface Acc { support: number; weighted: number; latest: number; }
  const byPartner = new Map<string, Acc>();
  for (const row of partnerRows) {
    if (row.file_path === targetFilePath) continue;
    let acc = byPartner.get(row.file_path);
    if (!acc) { acc = { support: 0, weighted: 0, latest: 0 }; byPartner.set(row.file_path, acc); }
    acc.support += 1;
    acc.weighted += shaToWeight.get(row.commit_sha) ?? 0;
    const d = shaToDate.get(row.commit_sha) ?? 0;
    if (d > acc.latest) acc.latest = d;
  }

  // 3. commits(partner) for lift — batched distinct-commit counts.
  const candidatePartners = [...byPartner.entries()].filter(
    ([, acc]) => acc.support >= minSupport,
  );
  const partnerCommitCounts = new Map<string, number>();
  if (candidatePartners.length > 0) {
    const ph = candidatePartners.map(() => '?').join(', ');
    const counts = db
      .prepare<unknown[], { file_path: string; n: number }>(`
        SELECT file_path, COUNT(DISTINCT commit_sha) AS n
        FROM commit_files
        WHERE repo_id = ? AND file_path IN (${ph})
        GROUP BY file_path
      `)
      .all([repoId, ...candidatePartners.map(([fp]) => fp)]);
    for (const c of counts) partnerCommitCounts.set(c.file_path, c.n);
  }

  // 4. Build ranked partners.
  const partners: CoChangePartner[] = [];
  for (const [filePath, acc] of candidatePartners) {
    const commitsPartner = partnerCommitCounts.get(filePath) ?? acc.support;
    const confidence = targetCommits > 0 ? acc.support / targetCommits : 0;
    const lift =
      targetCommits > 0 && commitsPartner > 0
        ? (acc.support * windowCommits) / (targetCommits * commitsPartner)
        : 0;
    partners.push({
      filePath,
      support: acc.support,
      weightedSupport: round(acc.weighted),
      confidence: round(Math.min(confidence, 1)),
      lift: round(lift),
      coChangeDate: acc.latest > 0 ? new Date(acc.latest * 1000).toISOString() : null,
    });
  }

  partners.sort(
    (a, b) => b.weightedSupport - a.weightedSupport || b.support - a.support || b.confidence - a.confidence,
  );

  return {
    targetFilePath,
    targetCommits,
    windowCommits,
    signalQuality: targetCommits < 5 || windowCommits < 20 ? 'low' : 'ok',
    partners: partners.slice(0, topN),
  };
}
