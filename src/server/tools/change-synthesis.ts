/**
 * change-synthesis.ts
 *
 * The shared "change-impact synthesis" core (Phase 77). Pure, MCP-free, and
 * unit-testable: given the set of symbols + files a change touches, it fuses
 * PureContext's existing risk primitives into one impact-aware report —
 *
 *   aggregateRisk      — composite per-symbol risk (Phase 76) over the changed
 *                        symbols, with the max band + the top offenders.
 *   missingCoChange    — the senior-reviewer instinct: files that *historically*
 *                        move with the edited files but are NOT in this change
 *                        ("you touched refundService but ledgerService usually
 *                        moves with it — and it's not here"). Suppressed entirely
 *                        on thin/squashed history (never invents warnings).
 *   recommendedTests   — test files that exercise the changed symbols, plus
 *                        co-changing test files.
 *   coverageGaps       — changed symbols with no detected test coverage.
 *   architecturalFlags — does the change currently sit on an import cycle / cross
 *                        a layer boundary. These are CURRENT-STATE flags, not
 *                        "regressions introduced by the diff" (a before/after
 *                        graph delta is deferred to compare_change_impact).
 *
 * This is the engine that both `analyze_diff` (post-edit) and Phase B's
 * `prepare_change` (pre-edit) consume — keep it free of tool/transport concerns.
 *
 * Everything is bounded by caps (token discipline) and built against a single
 * shared RiskContext (perf — score N symbols against one set of repo
 * distributions instead of recomputing per symbol).
 */

import type Database from 'better-sqlite3';
import {
  buildRiskContext,
  computeSymbolRiskWithContext,
  type RiskContext,
  type SymbolRiskResult,
} from './symbol-risk.js';
import { getCoChange, type CoChangeResult } from './co-change.js';
import { getSymbolCoverage } from '../../core/test-mapper.js';
import { getAllDepEdges } from '../../core/db/dep-store.js';
import { buildAdjacencyList, findCycles } from './detect-antipatterns.js';
import { assignLayer, isAllowed } from './get-layer-violations.js';
import { getConfig } from '../../config/config-loader.js';
import { isTestFilePath as isTestFile } from '../../core/test-paths.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChangeSynthesisInput {
  /** Resolved symbol ids that the change touches (deleted/unresolved excluded). */
  changedSymbolIds: string[];
  /** Normalized (forward-slash) file paths in the change. */
  changedFilePaths: string[];
  /** Per-section caps (fall back to config.changeSynthesis defaults). */
  caps?: {
    maxSymbolsScored?: number;
    maxCoChangeGaps?: number;
    maxRecommendedTests?: number;
  };
  /** Min directional co-change confidence for "missing" detection (default config). */
  coChangeConfidenceThreshold?: number;
  /** Section toggles — all default ON; switch off for cheaper runs. */
  includeRisk?: boolean;
  includeCoChangeGaps?: boolean;
  includeTests?: boolean;
  includeArchitectureFlags?: boolean;
}

export interface ChangeSynthesis {
  aggregateRisk: {
    band: 'low' | 'review' | 'high';
    topRiskSymbols: { symbolId: string; name: string; band: 'low' | 'review' | 'high'; riskScore: number }[];
  };
  missingCoChange: { filePath: string; confidence: number; support: number }[];
  recommendedTests: { testFilePath: string; reason: string }[];
  coverageGaps: { symbolId: string; name: string }[];
  architecturalFlags: {
    cyclesTouched: string[][];
    layerViolations: { from: string; to: string }[];
  };
  signalQuality: 'ok' | 'low';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Test-file classification: shared predicate (Task 549 — was one of five
// private copies). Imported at the top of the file.

const BAND_RANK: Record<'low' | 'review' | 'high', number> = { low: 0, review: 1, high: 2 };

function maxBand(bands: Array<'low' | 'review' | 'high'>): 'low' | 'review' | 'high' {
  let best: 'low' | 'review' | 'high' = 'low';
  for (const b of bands) if (BAND_RANK[b] > BAND_RANK[best]) best = b;
  return best;
}

interface ChangedSymbolRow {
  id: string;
  name: string;
  file_path: string;
}

// ─── Core ───────────────────────────────────────────────────────────────────

/**
 * Synthesize the impact report for a set of changed symbols + files.
 *
 * Pure with respect to the DB (reads only). Builds ONE {@link RiskContext} and
 * scores up to `maxSymbolsScored` symbols against it. Never throws on missing
 * data — sparse repos degrade to empty sections + `signalQuality: 'low'`.
 */
export function synthesizeChange(
  db: Database.Database,
  repoId: string,
  input: ChangeSynthesisInput,
): ChangeSynthesis {
  const cfg = getConfig().changeSynthesis;
  const threshold = input.coChangeConfidenceThreshold ?? cfg.coChangeConfidenceThreshold;
  const maxSymbolsScored = input.caps?.maxSymbolsScored ?? cfg.maxSymbolsScored;
  const maxCoChangeGaps = input.caps?.maxCoChangeGaps ?? cfg.maxCoChangeGaps;
  const maxRecommendedTests = input.caps?.maxRecommendedTests ?? cfg.maxRecommendedTests;

  const includeRisk = input.includeRisk ?? true;
  const includeCoChangeGaps = input.includeCoChangeGaps ?? true;
  const includeTests = input.includeTests ?? true;
  const includeArchitectureFlags = input.includeArchitectureFlags ?? true;

  const ctx: RiskContext = buildRiskContext(db, repoId);
  const signalQuality: 'ok' | 'low' = ctx.windowCommits < 20 ? 'low' : 'ok';

  const changedFilePaths = input.changedFilePaths.map((p) => p.replace(/\\/g, '/'));
  const inDiff = new Set(changedFilePaths);
  const uniqueChangedFiles = [...new Set(changedFilePaths)];

  // ── Look up name + file for each changed symbol (one batch). ────────────────
  const idToName = new Map<string, string>();
  const idToFile = new Map<string, string>();
  const symbolIds = [...new Set(input.changedSymbolIds.filter((s) => s))];
  if (symbolIds.length > 0) {
    const ph = symbolIds.map(() => '?').join(', ');
    const rows = db
      .prepare<unknown[], ChangedSymbolRow>(
        `SELECT id, name, file_path FROM symbols WHERE repo_id = ? AND id IN (${ph})`,
      )
      .all([repoId, ...symbolIds]);
    for (const r of rows) {
      idToName.set(r.id, r.name);
      idToFile.set(r.id, r.file_path);
    }
  }

  // ── Co-change results per changed file (memoized + shared with risk). ───────
  const coChangeByFile = new Map<string, CoChangeResult>();
  if ((includeCoChangeGaps || includeTests) && ctx.windowCommits > 0) {
    for (const fp of uniqueChangedFiles) {
      const res = getCoChange(db, repoId, fp, {
        megaCommitThreshold: ctx.megaCommitThreshold,
        topN: 50,
      });
      coChangeByFile.set(fp, res);
      ctx.coChangeCache.set(fp, res); // risk scoring reuses this
    }
  }

  // ── 1. Aggregate risk ──────────────────────────────────────────────────────
  let aggregateRisk: ChangeSynthesis['aggregateRisk'] = { band: 'low', topRiskSymbols: [] };
  if (includeRisk && symbolIds.length > 0) {
    // Rank by afferent coupling (cheap reverse-dependency proxy for blast radius)
    // so the most-connected symbols are always scored when over the cap.
    const ranked = [...symbolIds].sort(
      (a, b) =>
        (ctx.afferentByFile.get(idToFile.get(b) ?? '') ?? 0) -
        (ctx.afferentByFile.get(idToFile.get(a) ?? '') ?? 0),
    );
    const toScore = ranked.slice(0, maxSymbolsScored);
    const scored: SymbolRiskResult[] = [];
    for (const id of toScore) {
      const r = computeSymbolRiskWithContext(db, repoId, id, ctx);
      if (r) scored.push(r);
    }
    const band = maxBand(scored.map((s) => s.band));
    const topRiskSymbols = scored
      .slice()
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 10)
      .map((s) => ({ symbolId: s.symbolId, name: s.name, band: s.band, riskScore: s.riskScore }));
    aggregateRisk = { band, topRiskSymbols };
  }

  // ── 2. Missing co-change (absence detection) ───────────────────────────────
  const missingCoChange: ChangeSynthesis['missingCoChange'] = [];
  if (includeCoChangeGaps && signalQuality === 'ok') {
    const best = new Map<string, { filePath: string; confidence: number; support: number }>();
    for (const [, res] of coChangeByFile) {
      if (res.signalQuality === 'low') continue;
      for (const p of res.partners) {
        if (p.confidence < threshold) continue;
        if (inDiff.has(p.filePath)) continue;
        if (isTestFile(p.filePath)) continue; // tests go to recommendedTests
        const existing = best.get(p.filePath);
        if (!existing || p.confidence > existing.confidence) {
          best.set(p.filePath, { filePath: p.filePath, confidence: p.confidence, support: p.support });
        }
      }
    }
    const sorted = [...best.values()].sort(
      (a, b) => b.confidence - a.confidence || b.support - a.support,
    );
    missingCoChange.push(...sorted.slice(0, maxCoChangeGaps));
  }

  // ── 3. Recommended tests + 4. Coverage gaps ────────────────────────────────
  const recommendedTests: ChangeSynthesis['recommendedTests'] = [];
  const coverageGaps: ChangeSynthesis['coverageGaps'] = [];
  if (includeTests) {
    const testReasons = new Map<string, string>();
    for (const id of symbolIds) {
      const cov = getSymbolCoverage(repoId, id, db);
      const name = idToName.get(id) ?? id;
      if (cov) {
        for (const tf of cov.testFilePaths) {
          if (!testReasons.has(tf)) testReasons.set(tf, `exercises changed symbol ${name}`);
        }
        if (cov.coverageStatus === 'untested') coverageGaps.push({ symbolId: id, name });
      }
    }
    // Co-change partners that are themselves test files.
    for (const [, res] of coChangeByFile) {
      for (const p of res.partners) {
        if (!isTestFile(p.filePath) || inDiff.has(p.filePath)) continue;
        if (!testReasons.has(p.filePath)) {
          testReasons.set(p.filePath, `historically co-changes with edited files (conf ${p.confidence})`);
        }
      }
    }
    for (const [testFilePath, reason] of testReasons) {
      recommendedTests.push({ testFilePath, reason });
    }
    recommendedTests.splice(maxRecommendedTests);
    coverageGaps.splice(maxSymbolsScored);
  }

  // ── 5. Architectural flags (current-state, NOT regressions introduced) ─────
  const architecturalFlags: ChangeSynthesis['architecturalFlags'] = {
    cyclesTouched: [],
    layerViolations: [],
  };
  if (includeArchitectureFlags && uniqueChangedFiles.length > 0) {
    const edges = getAllDepEdges(db, repoId);

    // Cycles currently containing at least one changed file.
    const adj = buildAdjacencyList(edges);
    const cycles = findCycles(adj);
    for (const cycle of cycles) {
      if (cycle.some((f) => inDiff.has(f))) {
        architecturalFlags.cyclesTouched.push(cycle);
        if (architecturalFlags.cyclesTouched.length >= maxCoChangeGaps) break;
      }
    }

    // Layer-boundary crossings on edges touching a changed file.
    const layers = getConfig().layers;
    if (layers) {
      const seenPairs = new Set<string>();
      for (const edge of edges) {
        const src = edge.sourceFile.replace(/\\/g, '/');
        const tgt = edge.targetFile.replace(/\\/g, '/');
        if (!inDiff.has(src) && !inDiff.has(tgt)) continue;
        const from = assignLayer(edge.sourceFile, layers.definitions);
        const to = assignLayer(edge.targetFile, layers.definitions);
        if (from === 'unclassified' || to === 'unclassified' || from === to) continue;
        if (isAllowed(from, to, layers.rules)) continue;
        const key = `${from}→${to}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        architecturalFlags.layerViolations.push({ from, to });
        if (architecturalFlags.layerViolations.length >= maxCoChangeGaps) break;
      }
    }
  }

  return {
    aggregateRisk,
    missingCoChange,
    recommendedTests,
    coverageGaps,
    architecturalFlags,
    signalQuality,
  };
}
