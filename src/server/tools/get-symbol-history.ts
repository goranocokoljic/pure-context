/**
 * get-symbol-history.ts
 *
 * MCP tool: get_symbol_history
 *
 * Returns the git commit history for a specific symbol, filtered to commits
 * that actually touched the symbol's line range — not just the containing file.
 * Also computes a churnScore (commits per 90 days) as a code-volatility proxy.
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getSymbolById } from '../../core/db/symbol-store.js';
import { getFileContent } from '../../core/db/file-store.js';
import { getFileCommits } from '../../core/db/git-metadata-store.js';
import { readSymbolHistory, isGitRepo } from '../../core/git-log-reader.js';
import { buildMeta } from './_meta.js';
import type { SymbolKind } from '../../core/types.js';
import type { CommitRecord } from '../../core/git-log-reader.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_symbol_history';

export const description =
  'Return the git commit history for a specific symbol (function, class, method, etc.), ' +
  'filtered to commits that actually touched the symbol\'s line range — not just the ' +
  'containing file. Includes a churnScore (commits per 90 days) that quantifies ' +
  'how volatile the symbol is. High churn = frequently changing = higher risk to modify.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  symbolId: z.string().describe('Symbol ID from search_symbols or get_symbols'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Maximum commits to return (default 10, max 50)'),
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface SymbolCommit {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  date: string;       // ISO 8601
  daysAgo: number;
  message: string;
}

interface GetSymbolHistoryOutput {
  symbol: {
    name: string;
    kind: SymbolKind;
    filePath: string;
  };
  history: SymbolCommit[];
  totalCommits: number;
  firstSeen: SymbolCommit | null;
  lastChanged: SymbolCommit;
  churnScore: number;
  note?: string;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a byte offset to a 1-based line number by counting newlines in
 * the content buffer up to that offset.
 */
function byteOffsetToLine(content: Buffer, byteOffset: number): number {
  let line = 1;
  const cap = Math.min(byteOffset, content.length);
  for (let i = 0; i < cap; i++) {
    if (content[i] === 0x0a) line++;
  }
  return line;
}

function toSymbolCommit(commit: CommitRecord): SymbolCommit {
  const nowMs = Date.now();
  const commitMs = commit.date * 1000;
  const daysAgo = Math.floor((nowMs - commitMs) / 86_400_000);
  return {
    sha: commit.sha,
    shortSha: commit.sha.slice(0, 8),
    author: commit.authorName,
    authorEmail: commit.authorEmail,
    date: new Date(commitMs).toISOString(),
    daysAgo,
    message: commit.message,
  };
}

/**
 * churnScore = (commitCount / daysSinceFirstCommit) × 90
 *
 * Represents "commits per 90-day window" — higher = more volatile.
 * Returns 0 when the history is too short to calculate meaningfully.
 */
function computeChurnScore(
  commitCount: number,
  firstSeenDateUnix: number | null,
): number {
  if (!firstSeenDateUnix || commitCount <= 0) return 0;
  const nowSec = Date.now() / 1000;
  const daysSinceFirst = (nowSec - firstSeenDateUnix) / 86_400;
  if (daysSinceFirst < 1) return commitCount * 90; // brand new — treat as max churn
  return Math.round(((commitCount / daysSinceFirst) * 90) * 100) / 100;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  symbolId: string;
  limit?: number;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, symbolId, limit = 10 } = args;

  const db = openDatabase(repoId);

  // ── 1. Look up the symbol ─────────────────────────────────────────────────
  const symbol = getSymbolById(db, repoId, symbolId);
  if (!symbol) {
    db.close();
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Symbol not found: ${symbolId}` }, null, 2) }],
      isError: true,
    };
  }

  // ── 2. Get file content to convert byte offsets → line numbers ────────────
  const rawContent = getFileContent(db, repoId, symbol.filePath);

  // ── 3. Get repo root path ─────────────────────────────────────────────────
  const repo = getRepo(db, repoId);
  const repoRoot = repo?.clonePath ?? repo?.rootPath ?? null;

  db.close();

  // ── 4. Try git-based line-range history ───────────────────────────────────
  let history: CommitRecord[] = [];
  let firstSeenCommit: CommitRecord | null = null;
  let totalCount = 0;
  let note: string | undefined;
  let usedFallback = false;

  if (repoRoot && rawContent) {
    const startLine = byteOffsetToLine(rawContent, symbol.startByte);
    const endLine = byteOffsetToLine(rawContent, symbol.endByte);

    if (await isGitRepo(repoRoot)) {
      const result = await readSymbolHistory(
        repoRoot,
        symbol.filePath,
        startLine,
        endLine,
        limit,
      );

      if (result && result.history.length > 0) {
        history = result.history;
        firstSeenCommit = result.firstSeen;
        totalCount = result.totalCount;
      } else {
        // git -L returned nothing — fall back to file-level history
        usedFallback = true;
      }
    } else {
      usedFallback = true;
    }
  } else {
    usedFallback = true;
  }

  // ── 5. Fallback: file-level history from git_metadata table ───────────────
  if (usedFallback) {
    const db2 = openDatabase(repoId);
    const fileCommits = getFileCommits(db2, repoId, symbol.filePath, limit);
    db2.close();

    if (fileCommits.length > 0) {
      history = fileCommits;
      firstSeenCommit = fileCommits[fileCommits.length - 1] ?? null;
      totalCount = fileCommits.length;
      note = 'Line-range tracking unavailable; showing file-level history instead.';
    }
  }

  // ── 6. Handle no history at all ───────────────────────────────────────────
  if (history.length === 0) {
    const emptyResult = {
      symbol: { name: symbol.name, kind: symbol.kind, filePath: symbol.filePath },
      history: [],
      totalCommits: 0,
      firstSeen: null,
      lastChanged: null,
      churnScore: 0,
      note: 'No git history found for this symbol. The repo may not be a git repository or the file has never been committed.',
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(emptyResult, null, 2) }],
    };
  }

  // ── 7. Format output ──────────────────────────────────────────────────────
  const historyOut = history.map(toSymbolCommit);
  const firstSeenOut = firstSeenCommit ? toSymbolCommit(firstSeenCommit) : null;
  const lastChangedOut = historyOut[0]; // newest first
  const churnScore = computeChurnScore(totalCount, firstSeenCommit?.date ?? null);

  const output: GetSymbolHistoryOutput = {
    symbol: { name: symbol.name, kind: symbol.kind, filePath: symbol.filePath },
    history: historyOut,
    totalCommits: totalCount,
    firstSeen: firstSeenOut,
    lastChanged: lastChangedOut,
    churnScore,
    _meta: buildMeta({ timingMs: Date.now() - t0 }),
  };

  if (note) output.note = note;

  return {
    content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
  };
}
