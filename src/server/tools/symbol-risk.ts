/**
 * symbol-risk.ts
 *
 * Composite, explainable "how risky is it to change this symbol?" scoring —
 * the Phase 76 fusion of risk primitives PureContext already computes:
 *   churn        — how often the symbol's file changes (git_metadata, 90d)
 *   centrality    — how many other files depend on it (afferent coupling) +
 *                   reverse blast radius
 *   complexity   — cyclomatic complexity of the symbol
 *   testGap       — whether the symbol appears to have any test coverage
 *   coChange      — how many files historically move with it (confidence ≥ 0.4)
 *
 * Each factor is normalized REPO-RELATIVE (percentile rank within the repo) so
 * the score is comparable inside a repo and not dominated by absolute size.
 * The blend is a config-weighted sum rescaled to 0–100, banded low/review/high.
 * Every score ships with `factors` (normalized + raw) and human `reasons[]` —
 * never a black-box number.
 *
 * Deliberately NO author / ownership / productivity metrics — code-centered only.
 */

import type Database from 'better-sqlite3';
import { getCommitsInWindow } from '../../core/db/git-metadata-store.js';
import { getCouplingMap, getCrossAfferentCounts } from '../../core/db/dep-store.js';
import { openWorkspace } from '../../graph/workspace-graph.js';
import { getBlastRadius } from '../../graph/graph-traversal.js';
import { countCommits } from '../../core/db/co-change-store.js';
import { getCoChange, type CoChangeResult } from './co-change.js';
import { getConfig } from '../../config/config-loader.js';
import {
  coverageRider,
  ensureTestMappings,
  getCoverageStatusMap,
  type CoverageStatus,
} from '../../core/test-mapper.js';
import { countSymbolRefs, getAfferentSymbolCounts, getCrossAfferentSymbolCounts } from '../../core/db/symbol-ref-store.js';

export interface RiskFactor {
  /** Repo-relative normalized value in [0,1] (percentile rank or binary). */
  value: number;
  /** The raw underlying measurement (commits, dependents, complexity, …). */
  raw: number;
  /**
   * Phase 101 (centrality only): distinct symbols that reference this one
   * through symbol-level `ref` edges. Present when the index has refs; the
   * percentile (`value`) is then computed over the SYMBOL distribution and
   * `raw` keeps the afferent FILE count as the second factor.
   */
  symbolRefs?: number;
}

export interface SymbolRiskResult {
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  riskScore: number;                 // 0–100
  band: 'low' | 'review' | 'high';
  factors: {
    churn: RiskFactor;
    centrality: RiskFactor;
    complexity: RiskFactor;
    testGap: RiskFactor;
    coChange: RiskFactor;
  };
  reasons: string[];
  /** "low" when the underlying signals are sparse (shallow history, tiny repo). */
  signalQuality: 'ok' | 'low';
}

const CHURN_DAY_WINDOW = 90;

/**
 * Midrank percentile of `value` within `dist`, in [0,1]:
 *   (count_less + 0.5 × count_equal) / N
 * Midrank (rather than fraction-<=) avoids tie inflation — a value that ties
 * with the repo minimum does not jump to a high percentile just because many
 * other symbols share that minimum. Empty distribution → 0.
 */
function percentileRank(dist: number[], value: number): number {
  if (dist.length === 0) return 0;
  let less = 0;
  let equal = 0;
  for (const v of dist) {
    if (v < value) less++;
    else if (v === value) equal++;
  }
  return (less + 0.5 * equal) / dist.length;
}

function band(score: number): SymbolRiskResult['band'] {
  if (score > 66) return 'high';
  if (score >= 33) return 'review';
  return 'low';
}

// ─── Test-coverage heuristic ──────────────────────────────────────────────────
// Phase 104: read from the stored test mapping (built incrementally at index
// time; built here on first use when absent / stale) instead of loading every
// test file's content per call and running one regex per symbol. Same
// `NAME` semantics; a name under 3 chars is never tested (was: regex).

// ─── Main ─────────────────────────────────────────────────────────────────────

interface TargetSymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  cyclomatic_complexity: number | null;
  cognitive_complexity: number | null;
  line_count: number | null;
}

/**
 * Pre-computed repo-relative distributions + lookups shared across many symbol
 * scorings. Built ONCE per call to `synthesizeChange` / `computeSymbolRisk`,
 * then reused so scoring N symbols is O(N × symbol) instead of O(N × repo).
 *
 * Holds: the 90d churn map + distribution, the afferent-coupling lookup +
 * distribution, the cyclomatic-complexity distribution, the (decoded) contents
 * of all test files, the co-change window size, and a per-file memoized
 * `getCoChange` cache (many changed symbols share a file).
 */
export interface RiskContext {
  /** file path → distinct commits touching it in the churn window. */
  fileCommitCounts: Map<string, number>;
  /** windowed commit counts across all files (the churn percentile basis). */
  churnDist: number[];
  /** file path → afferent coupling (distinct importers). */
  afferentByFile: Map<string, number>;
  /** afferent coupling across all files (the centrality percentile basis). */
  centralityDist: number[];
  /**
   * Phase 101: symbol id → distinct referencing symbols (local + linked), and
   * the distribution over EVERY symbol of the repo (zeros included). null when
   * the index has no `ref` rows — scoring then uses the file basis exactly as
   * before (byte-identical).
   */
  symbolCentrality: { bySymbol: Map<string, number>; dist: number[] } | null;
  /** cyclomatic complexity across all symbols (the complexity percentile basis). */
  complexityDist: number[];
  /** symbol id → stored test mapping (the test-gap basis). */
  coverage: Map<string, { status: CoverageStatus; testFiles: string[] }>;
  /** Present when this context had to build the mapping on demand (P4). */
  coverageRider: { coverage?: string };
  /** distinct commits captured for co-change (0 ⇒ no co-change data). */
  windowCommits: number;
  /** mega-commit exclusion threshold for co-change scoring. */
  megaCommitThreshold: number;
  /** risk blend weights. */
  weights: { churn: number; centrality: number; complexity: number; testGap: number; coChange: number };
  /** memoized getCoChange results, keyed by file path. */
  coChangeCache: Map<string, CoChangeResult>;
}

/**
 * Build the shared {@link RiskContext} once: all repo-wide distributions, the
 * afferent-coupling lookup, and the test-file content set. This is the
 * expensive part — callers should build it once and score many symbols against
 * it via {@link computeSymbolRiskWithContext}.
 */
export function buildRiskContext(db: Database.Database, repoId: string): RiskContext {
  // ── Churn: distinct commits per file in the 90d window. ─────────────────────
  const sinceTs = Math.floor(Date.now() / 1000) - CHURN_DAY_WINDOW * 86_400;
  const windowCommitRows = getCommitsInWindow(db, repoId, sinceTs);
  const fileCommitSets = new Map<string, Set<string>>();
  for (const c of windowCommitRows) {
    let s = fileCommitSets.get(c.filePath);
    if (!s) { s = new Set(); fileCommitSets.set(c.filePath, s); }
    s.add(c.commitSha);
  }
  const fileCommitCounts = new Map<string, number>();
  for (const [fp, s] of fileCommitSets) fileCommitCounts.set(fp, s.size);
  const churnDist = [...fileCommitCounts.values()];

  // ── Centrality: afferent coupling per file. ─────────────────────────────────
  const coupling = getCouplingMap(db, repoId);
  const afferentByFile = new Map<string, number>();
  for (const c of coupling) afferentByFile.set(c.filePath, c.afferentCoupling);
  // Phase 99: importers in LINKED indexes count toward centrality — a file
  // the whole build tree depends on is central even when its own index holds
  // no importer. Zero cost (and byte-identical) on a repo without links.
  const ws = openWorkspace(db, repoId);
  try {
    for (const m of ws.links) {
      for (const [file, n] of getCrossAfferentCounts(m.db, m.repoId, repoId)) {
        afferentByFile.set(file, (afferentByFile.get(file) ?? 0) + n);
      }
    }
  } finally {
    ws.close();
  }
  const centralityDist = ws.links.length > 0 ? [...afferentByFile.values()] : coupling.map((c) => c.afferentCoupling);

  // ── Phase 101: symbol-level centrality (only when refs exist). ──────────────
  let symbolCentrality: RiskContext['symbolCentrality'] = null;
  if (countSymbolRefs(db, repoId) > 0) {
    const bySymbol = getAfferentSymbolCounts(db, repoId);
    const ws2 = openWorkspace(db, repoId);
    try {
      for (const m of ws2.links) {
        for (const [id, n] of getCrossAfferentSymbolCounts(m.db, m.repoId, repoId)) {
          bySymbol.set(id, (bySymbol.get(id) ?? 0) + n);
        }
      }
    } finally {
      ws2.close();
    }
    const total =
      db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM symbols WHERE repo_id = ?').get(repoId)?.n ?? 0;
    const dist = [...bySymbol.values()];
    for (let i = dist.length; i < total; i++) dist.push(0);
    symbolCentrality = { bySymbol, dist };
  }

  // ── Complexity distribution across all symbols. ─────────────────────────────
  const complexityRows = db
    .prepare<[string], { cyclomatic_complexity: number | null }>(
      'SELECT cyclomatic_complexity FROM symbols WHERE repo_id = ? AND cyclomatic_complexity IS NOT NULL',
    )
    .all(repoId);
  const complexityDist = complexityRows.map((r) => r.cyclomatic_complexity ?? 0);

  // ── Test mapping (stored; on-demand build only when absent / stale). ───────
  const ensured = ensureTestMappings(repoId, db);
  const coverage = getCoverageStatusMap(repoId, db);

  return {
    fileCommitCounts,
    churnDist,
    afferentByFile,
    centralityDist,
    symbolCentrality,
    complexityDist,
    coverage,
    coverageRider: coverageRider(ensured),
    windowCommits: countCommits(db, repoId),
    megaCommitThreshold: getConfig().git?.megaCommitThreshold ?? 30,
    weights: getConfig().risk.weights,
    coChangeCache: new Map(),
  };
}

/** Co-change result for a file, memoized on the RiskContext. */
function cachedCoChange(
  db: Database.Database,
  repoId: string,
  filePath: string,
  ctx: RiskContext,
): CoChangeResult {
  let res = ctx.coChangeCache.get(filePath);
  if (!res) {
    res = getCoChange(db, repoId, filePath, {
      megaCommitThreshold: ctx.megaCommitThreshold,
      topN: 50,
    });
    ctx.coChangeCache.set(filePath, res);
  }
  return res;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Score a single symbol against a prebuilt {@link RiskContext}. Pure scoring —
 * no repo-wide queries beyond the symbol row + its reverse blast radius.
 * Returns null if the symbol does not exist in the repo.
 *
 * Output is byte-identical to {@link computeSymbolRisk} for the same symbol.
 */
export function computeSymbolRiskWithContext(
  db: Database.Database,
  repoId: string,
  symbolId: string,
  ctx: RiskContext,
): SymbolRiskResult | null {
  const sym = db
    .prepare<[string, string], TargetSymbolRow>(
      `SELECT id, name, kind, file_path,
              cyclomatic_complexity, cognitive_complexity, line_count
       FROM symbols WHERE repo_id = ? AND id = ?`,
    )
    .get(repoId, symbolId);
  if (!sym) return null;

  const reasons: string[] = [];

  // ── Churn ────────────────────────────────────────────────────────────────
  const churnRaw = ctx.fileCommitCounts.get(sym.file_path) ?? 0;
  const churnNorm = percentileRank(ctx.churnDist, churnRaw);
  if (churnRaw > 0) reasons.push(`churn ${churnRaw}/${CHURN_DAY_WINDOW}d`);

  // ── Centrality ───────────────────────────────────────────────────────────
  const afferent = ctx.afferentByFile.get(sym.file_path) ?? 0;
  // Phase 101: with symbol edges, centrality is how many SYMBOLS reference
  // this one (percentile over all symbols); the file count stays reported.
  const symbolRefs = ctx.symbolCentrality ? (ctx.symbolCentrality.bySymbol.get(sym.id) ?? 0) : undefined;
  const centralityNorm = ctx.symbolCentrality
    ? percentileRank(ctx.symbolCentrality.dist, symbolRefs ?? 0)
    : percentileRank(ctx.centralityDist, afferent);
  const blast = getBlastRadius(symbolId, repoId, db, 3);
  if (symbolRefs !== undefined && symbolRefs > 0) reasons.push(`${symbolRefs} symbol(s) reference ${sym.name}`);
  if (afferent > 0) reasons.push(`${afferent} file(s) import ${sym.file_path}`);
  if (blast.files.length > 1) reasons.push(`${blast.files.length} files in reverse blast radius`);

  // ── Complexity ───────────────────────────────────────────────────────────
  const cc = sym.cyclomatic_complexity ?? 0;
  const complexityNorm = percentileRank(ctx.complexityDist, cc);
  if (cc >= 5) reasons.push(`cyclomatic complexity ${cc}`);

  // ── Test gap ─────────────────────────────────────────────────────────────
  // "Some test file mentions the name" — for every kind (a structural
  // symbol is 'unknown' in the store but still lists its files).
  const tested = (ctx.coverage.get(sym.id)?.testFiles.length ?? 0) > 0;
  const testGapNorm = tested ? 0 : 1;
  if (!tested) reasons.push('no direct test reference');

  // ── Co-change spread ───────────────────────────────────────────────────────
  let coChangeNorm = 0;
  let coChangeRaw = 0;
  let coChangeLow = false;
  if (ctx.windowCommits > 0) {
    const cocc = cachedCoChange(db, repoId, sym.file_path, ctx);
    coChangeLow = cocc.signalQuality === 'low';
    const strong = cocc.partners.filter((p) => p.confidence >= 0.4);
    coChangeRaw = strong.length;
    coChangeNorm = Math.min(coChangeRaw / 5, 1);
    if (strong.length > 0) {
      const top = strong[0];
      reasons.push(`co-changes with ${top.filePath} (conf ${top.confidence})`);
    }
  } else {
    coChangeLow = true;
  }

  // ── Blend (config-weighted, rescaled to 0–100) ─────────────────────────────
  const w = ctx.weights;
  const weightSum = w.churn + w.centrality + w.complexity + w.testGap + w.coChange || 1;
  const weighted =
    w.churn * churnNorm +
    w.centrality * centralityNorm +
    w.complexity * complexityNorm +
    w.testGap * testGapNorm +
    w.coChange * coChangeNorm;
  const riskScore = Math.round((weighted / weightSum) * 100);

  if (reasons.length === 0) reasons.push('no elevated risk factors detected');

  // Signal quality: low when churn/co-change history is thin.
  const signalQuality: 'ok' | 'low' =
    ctx.churnDist.length < 5 && coChangeLow ? 'low' : 'ok';

  return {
    symbolId: sym.id,
    name: sym.name,
    kind: sym.kind,
    filePath: sym.file_path,
    riskScore,
    band: band(riskScore),
    factors: {
      churn: { value: round2(churnNorm), raw: churnRaw },
      centrality: { value: round2(centralityNorm), raw: afferent, ...(symbolRefs !== undefined ? { symbolRefs } : {}) },
      complexity: { value: round2(complexityNorm), raw: cc },
      testGap: { value: testGapNorm, raw: tested ? 1 : 0 },
      coChange: { value: round2(coChangeNorm), raw: coChangeRaw },
    },
    reasons,
    signalQuality,
  };
}

/**
 * Compute the composite risk verdict for a symbol. Returns null if the symbol
 * does not exist in the repo.
 *
 * Thin wrapper over {@link computeSymbolRiskWithContext}: builds a fresh
 * {@link RiskContext} for the single symbol. Callers scoring many symbols
 * should build the context once and call `computeSymbolRiskWithContext`.
 */
export function computeSymbolRisk(
  db: Database.Database,
  repoId: string,
  symbolId: string,
): SymbolRiskResult | null {
  return computeSymbolRiskWithContext(db, repoId, symbolId, buildRiskContext(db, repoId));
}
