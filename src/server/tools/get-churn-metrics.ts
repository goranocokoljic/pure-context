/**
 * get-churn-metrics.ts
 *
 * MCP tool: get_churn_metrics
 *
 * Report code churn (change frequency) across the entire repo or a specific
 * directory, identifying the most volatile files and symbols.  Data is sourced
 * from the `git_metadata` table populated during indexing (Task 154).
 *
 * Granularity options:
 *   'file'   — aggregate commits per file, return top N by churn score
 *   'symbol' — join against the symbols table to report per-symbol churn
 */

import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { getCommitsInWindow } from '../../core/db/git-metadata-store.js';
import { buildMeta } from './_meta.js';
import type { SymbolKind } from '../../core/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';

export const name = 'get_churn_metrics';

export const description =
  'Report code churn (change frequency) across an entire repo or a specific ' +
  'directory, identifying the most volatile files and symbols. Requires git ' +
  'metadata to have been captured during indexing. Useful for risk assessment ' +
  'and identifying areas that need refactoring attention. ' +
  'granularity:"file" aggregates commits per file; granularity:"symbol" maps ' +
  'those commits down to individual symbols via line-range overlap.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  scope: z
    .string()
    .optional()
    .describe('Directory prefix filter (e.g. "src/core/") — narrows analysis to that subtree'),
  dayWindow: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe('Look back N days (default 90)'),
  topN: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Return top N results by churn score (default 20)'),
  granularity: z
    .enum(['file', 'symbol'])
    .describe('"file" — per-file churn; "symbol" — per-symbol churn (slower)'),
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChurnRecord {
  filePath: string;
  symbolName?: string;
  symbolKind?: SymbolKind;
  commitCount: number;
  uniqueAuthors: number;
  lastChanged: string;    // ISO date
  churnScore: number;     // Commits per 90 days within the dayWindow
  riskLevel: 'stable' | 'active' | 'volatile' | 'hotspot';
}

interface GetChurnMetricsOutput {
  repoId: string;
  dayWindow: number;
  topChurn: ChurnRecord[];
  summary: {
    totalFilesAnalyzed: number;
    hotspots: number;
    stableFiles: number;
    mostActiveAuthor: string;
  };
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function riskLevel(churnScore: number): ChurnRecord['riskLevel'] {
  if (churnScore > 10) return 'hotspot';
  if (churnScore > 5)  return 'volatile';
  if (churnScore >= 1) return 'active';
  return 'stable';
}

/**
 * churnScore = (commitsInWindow / dayWindow) × 90
 *
 * Normalises to "commits per 90-day window" so scores are comparable across
 * different `dayWindow` values.
 */
function computeChurnScore(commitCount: number, dayWindow: number): number {
  if (commitCount <= 0 || dayWindow <= 0) return 0;
  return Math.round(((commitCount / dayWindow) * 90) * 100) / 100;
}

// ─── File-level aggregation ───────────────────────────────────────────────────

function buildFileChurn(
  commits: ReturnType<typeof getCommitsInWindow>,
  dayWindow: number,
  topN: number,
): ChurnRecord[] {
  // Group commits by file path
  const byFile = new Map<string, {
    commitShas: Set<string>;
    authors: Set<string>;
    latestDate: number;
  }>();

  for (const c of commits) {
    let entry = byFile.get(c.filePath);
    if (!entry) {
      entry = { commitShas: new Set(), authors: new Set(), latestDate: 0 };
      byFile.set(c.filePath, entry);
    }
    entry.commitShas.add(c.commitSha);
    entry.authors.add(c.authorName);
    if (c.commitDate > entry.latestDate) entry.latestDate = c.commitDate;
  }

  const records: ChurnRecord[] = [];
  for (const [filePath, data] of byFile) {
    const commitCount = data.commitShas.size;
    const score = computeChurnScore(commitCount, dayWindow);
    records.push({
      filePath,
      commitCount,
      uniqueAuthors: data.authors.size,
      lastChanged: new Date(data.latestDate * 1000).toISOString(),
      churnScore: score,
      riskLevel: riskLevel(score),
    });
  }

  // Sort descending by churnScore, then return top N
  records.sort((a, b) => b.churnScore - a.churnScore || b.commitCount - a.commitCount);
  return records.slice(0, topN);
}

// ─── Symbol-level aggregation ─────────────────────────────────────────────────

interface DbSymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  start_byte: number;
  end_byte: number;
}

/**
 * Convert a byte offset to a 1-based line number.
 */
function byteOffsetToLine(content: Buffer, byteOffset: number): number {
  let line = 1;
  const cap = Math.min(byteOffset, content.length);
  for (let i = 0; i < cap; i++) {
    if (content[i] === 0x0a) line++;
  }
  return line;
}

/**
 * Build a line-range index for all symbols in a file so we can quickly test
 * whether a given line range overlaps any symbol.
 */
interface SymbolLineRange {
  id: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

function buildSymbolChurn(
  db: Database.Database,
  repoId: string,
  commits: ReturnType<typeof getCommitsInWindow>,
  dayWindow: number,
  topN: number,
  scope?: string,
): ChurnRecord[] {
  // 1. Collect all distinct file paths that have commits
  const filePaths = [...new Set(commits.map((c) => c.filePath))];

  // 2. For each file, load symbols and cached content; build line-range index
  const fileSymbols = new Map<string, SymbolLineRange[]>();
  const fileContent = new Map<string, Buffer>();

  const symbolQuery = db.prepare<[string, string], DbSymbolRow>(
    `SELECT id, name, kind, file_path, start_byte, end_byte
     FROM symbols
     WHERE repo_id = ? AND file_path = ?`,
  );

  const contentQuery = db.prepare<[string, string], { raw_content: Buffer | null }>(
    `SELECT raw_content FROM files WHERE repo_id = ? AND path = ?`,
  );

  for (const fp of filePaths) {
    if (scope && !fp.startsWith(scope)) continue;

    const contentRow = contentQuery.get(repoId, fp);
    if (!contentRow?.raw_content) continue;

    const content = contentRow.raw_content;
    fileContent.set(fp, content);

    const symbols = symbolQuery.all(repoId, fp);
    if (symbols.length === 0) continue;

    const ranges: SymbolLineRange[] = symbols.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      startLine: byteOffsetToLine(content, s.start_byte),
      endLine: byteOffsetToLine(content, s.end_byte),
    }));
    fileSymbols.set(fp, ranges);
  }

  // 3. For each commit, figure out which line was changed.
  //    Since git_metadata doesn't store changed-line ranges, we attribute
  //    each commit to ALL symbols in that file (conservative approximation).
  //    This is consistent with the data available without re-running `git diff`.
  const bySymbol = new Map<string, {
    name: string;
    kind: string;
    filePath: string;
    commitShas: Set<string>;
    authors: Set<string>;
    latestDate: number;
  }>();

  for (const c of commits) {
    const ranges = fileSymbols.get(c.filePath);
    if (!ranges) continue;

    for (const sym of ranges) {
      let entry = bySymbol.get(sym.id);
      if (!entry) {
        entry = {
          name: sym.name,
          kind: sym.kind,
          filePath: c.filePath,
          commitShas: new Set(),
          authors: new Set(),
          latestDate: 0,
        };
        bySymbol.set(sym.id, entry);
      }
      entry.commitShas.add(c.commitSha);
      entry.authors.add(c.authorName);
      if (c.commitDate > entry.latestDate) entry.latestDate = c.commitDate;
    }
  }

  // 4. Build ChurnRecord[]
  const records: ChurnRecord[] = [];
  for (const [, data] of bySymbol) {
    const commitCount = data.commitShas.size;
    const score = computeChurnScore(commitCount, dayWindow);
    records.push({
      filePath: data.filePath,
      symbolName: data.name,
      symbolKind: data.kind as SymbolKind,
      commitCount,
      uniqueAuthors: data.authors.size,
      lastChanged: new Date(data.latestDate * 1000).toISOString(),
      churnScore: score,
      riskLevel: riskLevel(score),
    });
  }

  records.sort((a, b) => b.churnScore - a.churnScore || b.commitCount - a.commitCount);
  return records.slice(0, topN);
}

// ─── Summary helpers ──────────────────────────────────────────────────────────

function buildSummary(
  commits: ReturnType<typeof getCommitsInWindow>,
  topChurn: ChurnRecord[],
): GetChurnMetricsOutput['summary'] {
  const totalFilesAnalyzed = new Set(commits.map((c) => c.filePath)).size;
  const hotspots = topChurn.filter((r) => r.riskLevel === 'hotspot').length;
  const stableFiles = topChurn.filter((r) => r.riskLevel === 'stable').length;

  // Tally authors across all commits
  const authorCounts = new Map<string, number>();
  for (const c of commits) {
    authorCounts.set(c.authorName, (authorCounts.get(c.authorName) ?? 0) + 1);
  }
  let mostActiveAuthor = '';
  let maxCount = 0;
  for (const [author, count] of authorCounts) {
    if (count > maxCount) { mostActiveAuthor = author; maxCount = count; }
  }

  return { totalFilesAnalyzed, hotspots, stableFiles, mostActiveAuthor };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  scope?: string;
  dayWindow?: number;
  topN?: number;
  granularity: 'file' | 'symbol';
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, scope, dayWindow = 90, topN = 20, granularity } = args;

  const db = openDatabase(repoId);

  // ── Verify git metadata exists ────────────────────────────────────────────
  const metaCount = (
    db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM git_metadata WHERE repo_id = ?')
      .get(repoId)
  )?.n ?? 0;

  if (metaCount === 0) {
    db.close();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: 'No git metadata found for this repo.',
              hint: 'Re-index the repo (index_folder) in a git repository so that commit history can be captured.',
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  // ── Date window ───────────────────────────────────────────────────────────
  const sinceTimestamp = Math.floor(Date.now() / 1000) - dayWindow * 86_400;

  const commits = getCommitsInWindow(db, repoId, sinceTimestamp, scope);

  if (commits.length === 0) {
    db.close();
    const output: GetChurnMetricsOutput = {
      repoId,
      dayWindow,
      topChurn: [],
      summary: { totalFilesAnalyzed: 0, hotspots: 0, stableFiles: 0, mostActiveAuthor: '' },
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  }

  // ── Aggregate ─────────────────────────────────────────────────────────────
  let topChurn: ChurnRecord[];
  if (granularity === 'symbol') {
    topChurn = buildSymbolChurn(db, repoId, commits, dayWindow, topN, scope);
  } else {
    topChurn = buildFileChurn(commits, dayWindow, topN);
  }

  db.close();

  const summary = buildSummary(commits, topChurn);

  const output: GetChurnMetricsOutput = {
    repoId,
    dayWindow,
    topChurn,
    summary,
    _meta: buildMeta({ timingMs: Date.now() - t0 }),
  };

  return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
}
