import { z } from 'zod';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../core/db/schema.js';
import { getContextBundle } from '../../graph/graph-traversal.js';
import { getSymbolById } from '../../core/db/symbol-store.js';
import { getFileSizesBatch } from '../../core/db/file-store.js';
import { countCommits } from '../../core/db/co-change-store.js';
import { getCoChange } from './co-change.js';
import { getConfig } from '../../config/config-loader.js';
import { BYTES_PER_TOKEN } from '../../core/token-tracker.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_context_bundle';

export const description =
  'Forward-walk the dependency graph from a symbol to collect everything needed to understand it. ' +
  'Returns the symbol plus all transitively imported files and their symbols. ' +
  'Includes a token estimate so you can gauge context size before loading. ' +
  'When git co-change data exists (git.coChangeDepth > 0), also returns ' +
  'historicalNeighbors — files that historically change together with the ' +
  'target but are not reachable via imports (e.g. a route and its test).';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  symbolId: z.string().describe('Symbol ID to start the forward walk from'),
  depth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Max dependency hops to follow (default 3)'),
};

// ─── historicalNeighbors (co-change enrichment) ──────────────────────────────

interface HistoricalNeighborSymbol {
  name: string;
  kind: string;
  signature: string;
}

interface HistoricalNeighbor {
  filePath: string;
  confidence: number;
  support: number;
  symbols: HistoricalNeighborSymbol[];
}

const MAX_NEIGHBOR_FILES = 5;
const MAX_SYMBOLS_PER_NEIGHBOR = 5;

/**
 * Build the historicalNeighbors section: top co-changing files for the target
 * symbol's file, each with a small outline. Returns [] when there is no
 * co-change data (coChangeDepth=0 / never captured), keeping bundle output
 * byte-identical to pre-Phase-76 behavior.
 */
function buildHistoricalNeighbors(
  db: Database.Database,
  repoId: string,
  symbolId: string,
  importedFiles: Set<string>,
): HistoricalNeighbor[] {
  if (countCommits(db, repoId) === 0) return [];

  const sym = getSymbolById(db, repoId, symbolId);
  if (!sym) return [];

  const cocc = getCoChange(db, repoId, sym.filePath, {
    megaCommitThreshold: getConfig().git?.megaCommitThreshold ?? 30,
    topN: MAX_NEIGHBOR_FILES * 3,
  });

  const symbolsByFile = db.prepare<[string, string], { name: string; kind: string; signature: string }>(
    `SELECT name, kind, signature FROM symbols
     WHERE repo_id = ? AND file_path = ?
     ORDER BY start_byte LIMIT ${MAX_SYMBOLS_PER_NEIGHBOR}`,
  );

  const neighbors: HistoricalNeighbor[] = [];
  for (const p of cocc.partners) {
    // Skip files already reachable via the import graph — those add no new info.
    if (importedFiles.has(p.filePath)) continue;
    const symbols = symbolsByFile.all(repoId, p.filePath);
    neighbors.push({
      filePath: p.filePath,
      confidence: p.confidence,
      support: p.support,
      symbols,
    });
    if (neighbors.length >= MAX_NEIGHBOR_FILES) break;
  }
  return neighbors;
}

export function handler(args: { repoId: string; symbolId: string; depth?: number }): CallToolResult {
  const t0 = Date.now();
  const db = openDatabase(args.repoId);
  const result = getContextBundle(args.symbolId, args.repoId, db, args.depth);

  const fileSizes = getFileSizesBatch(db, args.repoId, result.files);
  const historicalNeighbors = buildHistoricalNeighbors(
    db,
    args.repoId,
    args.symbolId,
    new Set(result.files),
  );
  db.close();

  const rawBytes = result.files.reduce((sum, fp) => sum + (fileSizes.get(fp) ?? 0), 0);

  // Account for the co-change section in the token estimate (only when present).
  const neighborTokens = historicalNeighbors.reduce(
    (sum, n) =>
      sum +
      Math.ceil(
        (n.filePath.length +
          n.symbols.reduce((s, sym) => s + sym.name.length + sym.signature.length + 16, 0)) /
          4,
      ),
    0,
  );
  const tokenEstimate = result.tokenEstimate + neighborTokens;
  const responseBytes = tokenEstimate * BYTES_PER_TOKEN;

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            symbolId: args.symbolId,
            fileCount: result.files.length,
            symbolCount: result.symbols.length,
            _tokenEstimate: tokenEstimate,
            files: result.files.sort(),
            symbols: result.symbols.map((s) => ({
              id: s.id,
              name: s.name,
              kind: s.kind,
              filePath: s.filePath,
              signature: s.signature,
              summary: s.summary,
            })),
            ...(historicalNeighbors.length > 0 ? { historicalNeighbors } : {}),
            _meta: buildMeta({ timingMs: Date.now() - t0, rawBytes, responseBytes }),
          },
          null,
          2,
        ),
      },
    ],
  };
}
