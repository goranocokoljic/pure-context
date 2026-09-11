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
import { graphCoverageWarning } from './graph-coverage.js';
import { computeExternalImports } from './external-imports.js';
import { getRepo } from '../../core/db/schema.js';
import { openWorkspace, workspaceRawBytes } from '../../graph/workspace-graph.js';
import { getSymbolContextBundle, symbolRefsAvailable } from '../../graph/symbol-traversal.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_context_bundle';

export const description =
  "Forward-walk the dependency graph from a symbol's FILE to collect everything needed to understand it. " +
  'Returns the symbol plus transitively imported files and their symbols (file-granular, depth-capped). ' +
  'Includes a token estimate so you can gauge context size before loading. ' +
  'Since 1.32.0 the walk follows imports INTO linked indexes (same git checkout, or ' +
  'graph.linkedRepos): those files come back under `linked`, per index. ' +
  'When git co-change data exists (git.coChangeDepth > 0), also returns ' +
  'historicalNeighbors — files that historically change together with the ' +
  'target but are not reachable via imports (e.g. a route and its test). ' +
  'Since 1.34.0 granularity="symbol" follows symbol-level `ref` edges instead: only the symbols ' +
  'this one actually mentions (transitively), with the file bundle size kept as `fileBundle`.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  symbolId: z.string().describe('Symbol ID to start the forward walk from'),
  depth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Max dependency hops to follow (default 3)'),
  granularity: z
    .enum(['file', 'symbol'])
    .optional()
    .describe(
      '"file" (default): every symbol of every transitively imported file. ' +
      '"symbol": only the symbols this symbol references (symbol-level `ref` edges, 1.34.0).',
    ),
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

export function handler(args: {
  repoId: string;
  symbolId: string;
  depth?: number;
  granularity?: 'file' | 'symbol';
}): CallToolResult {
  const t0 = Date.now();
  const db = openDatabase(args.repoId);
  const ws = openWorkspace(db, args.repoId, getRepo(db, args.repoId)?.rootPath ?? '');
  let result: ReturnType<typeof getContextBundle>;
  let symbolResult: ReturnType<typeof getSymbolContextBundle> = null;
  let symbolNote: string | undefined;
  let linkedRawBytes = 0;
  try {
    result = getContextBundle(args.symbolId, args.repoId, db, args.depth, ws);
    linkedRawBytes = workspaceRawBytes(
      ws,
      (result.linked ?? []).flatMap((g) => g.files.map((path) => ({ repoId: g.repoId, path }))),
    );
    if (args.granularity === 'symbol') {
      if (symbolRefsAvailable(db, args.repoId)) {
        symbolResult = getSymbolContextBundle(args.symbolId, args.repoId, db, args.depth, ws);
      } else {
        symbolNote =
          'This index has no symbol-level edges yet (indexed before 1.34.0, or graph.symbolEdges is off) - ' +
          'run index_folder once; answering at file granularity.';
      }
    }
  } finally {
    ws.close();
  }
  const links = ws.links.map((m) => ({ repoId: m.repoId, rootPath: m.rootPath }));

  const fileSizes = getFileSizesBatch(db, args.repoId, result.files);
  const historicalNeighbors = buildHistoricalNeighbors(
    db,
    args.repoId,
    args.symbolId,
    new Set(result.files),
  );
  const coverage = graphCoverageWarning(db, args.repoId);
  // Boundary honesty (Phase 97): imports of the bundle's files that lead out
  // of this index — the bundle is incomplete there, not small.
  const externalImports = computeExternalImports(db, args.repoId, result.files);
  db.close();

  const rawBytes = result.files.reduce((sum, fp) => sum + (fileSizes.get(fp) ?? 0), 0) + linkedRawBytes;
  const linkedFileCount = (result.linked ?? []).reduce((n, g) => n + g.files.length, 0);
  const linkedSymbolCount = (result.linked ?? []).reduce((n, g) => n + g.symbols.length, 0);

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
  const tokenEstimate = (symbolResult ? symbolResult.tokenEstimate : result.tokenEstimate) + neighborTokens;
  const responseBytes = tokenEstimate * BYTES_PER_TOKEN;

  const shape = (s: { id: string; name: string; kind: string; filePath: string; signature: string; summary: string }) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    filePath: s.filePath,
    signature: s.signature,
    summary: s.summary,
  });
  const groups = (list: NonNullable<typeof result.linked>) =>
    list.map((g) => ({ repoId: g.repoId, rootPath: g.rootPath, files: [...g.files].sort(), symbols: g.symbols.map(shape) }));

  // Phase 101: symbol granularity — the forward ref walk (what THIS symbol
  // mentions), with the file bundle's size kept as the upper bound.
  let body: Record<string, unknown>;
  if (symbolResult) {
    const sr = symbolResult;
    const depthOf = new Map(sr.hops.map((h) => [`${h.repoId}\u0000${h.symbol.id}`, h.depth]));
    const linkedFiles = (sr.linked ?? []).reduce((n, g) => n + g.files.length, 0);
    const linkedSyms = (sr.linked ?? []).reduce((n, g) => n + g.symbols.length, 0);
    body = {
      granularity: 'symbol',
      confidence: 'lexical',
      truncated: sr.truncated,
      fileCount: sr.files.length + linkedFiles,
      symbolCount: sr.symbols.length + linkedSyms,
      _tokenEstimate: tokenEstimate,
      files: [...sr.files].sort(),
      symbols: sr.symbols.map((s) => ({ ...shape(s), depth: depthOf.get(`${args.repoId}\u0000${s.id}`) ?? 0 })),
      ...(links.length > 0 ? { links } : {}),
      ...(sr.linked && sr.linked.length > 0 ? { linkedFiles, linked: groups(sr.linked) } : {}),
      fileBundle: { fileCount: result.files.length + linkedFileCount, symbolCount: result.symbols.length + linkedSymbolCount },
    };
  } else {
    body = {
      granularity: 'file',
      ...(symbolNote ? { note: symbolNote } : {}),
      fileCount: result.files.length + linkedFileCount,
      symbolCount: result.symbols.length + linkedSymbolCount,
      _tokenEstimate: tokenEstimate,
      files: result.files.sort(),
      symbols: result.symbols.map(shape),
      ...(links.length > 0 ? { links } : {}),
      ...(result.linked && result.linked.length > 0 ? { linkedFiles: linkedFileCount, linked: groups(result.linked) } : {}),
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            symbolId: args.symbolId,
            ...body,
            ...(historicalNeighbors.length > 0 ? { historicalNeighbors } : {}),
            ...(coverage ?? {}),
            ...(externalImports ? { externalImports } : {}),
            _meta: buildMeta({ timingMs: Date.now() - t0, rawBytes, responseBytes }),
          },
          null,
          2,
        ),
      },
    ],
  };
}
