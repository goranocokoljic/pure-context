import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { getBlastRadius } from '../../graph/graph-traversal.js';
import { getFileSizesBatch } from '../../core/db/file-store.js';
import { BYTES_PER_TOKEN } from '../../core/token-tracker.js';
import { buildMeta } from './_meta.js';
import { graphCoverageWarning } from './graph-coverage.js';
import { computeExternalImports } from './external-imports.js';
import { getSymbolById } from '../../core/db/symbol-store.js';
import { getRepo } from '../../core/db/schema.js';
import { openWorkspace, workspaceRawBytes } from '../../graph/workspace-graph.js';
import { getSymbolBlastRadius, symbolRefsAvailable } from '../../graph/symbol-traversal.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_blast_radius';

export const description =
  "Reverse-walk the dependency graph to find files that (transitively) import the symbol's FILE. " +
  'Use this to assess the impact of changing or deleting a symbol before making edits. ' +
  'Granularity is file-level: every symbol in the same file returns the same radius. ' +
  'The walk stops at `depth` hops (default 3) — `truncated: true` means deeper dependents exist. ' +
  'Since 1.32.0 the walk crosses into LINKED indexes (same git checkout, or graph.linkedRepos): ' +
  'dependents there come back under `linked` (per index, with its rootPath) and `links` lists the ' +
  'indexes searched. When the symbol\'s file still has internal-looking imports that resolved to ' +
  'nothing, `externalImports` names them: edges stop at an UNLINKED index boundary, so the radius ' +
  'is a lower bound there. Since 1.34.0 pass granularity="symbol" to walk symbol-level `ref` edges ' +
  'instead (which SYMBOLS mention this one, N hops, lexical confidence): `symbols` carry `depth`, ' +
  '`fileRadius` keeps the file-level answer as the upper bound. Falls back to the file answer ' +
  '(granularity: "file" + note) on an index that has no symbol edges yet.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  symbolId: z.string().describe('Symbol ID of the code you plan to change'),
  depth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Max reverse-dependency hops (default 3)'),
  granularity: z
    .enum(['file', 'symbol'])
    .optional()
    .describe(
      '"file" (default): files that import the symbol FILE, transitively. ' +
      '"symbol": symbols that reference THIS symbol (symbol-level `ref` edges, 1.34.0); ' +
      'the file answer is returned alongside as `fileRadius`.',
    ),
};

export function handler(args: {
  repoId: string;
  symbolId: string;
  depth?: number;
  granularity?: 'file' | 'symbol';
}): CallToolResult {
  const t0 = Date.now();
  const db = openDatabase(args.repoId);
  // Phase 99: the workspace = this index + the indexes its last build linked.
  const ws = openWorkspace(db, args.repoId, getRepo(db, args.repoId)?.rootPath ?? '');
  let result: ReturnType<typeof getBlastRadius>;
  let symbolResult: ReturnType<typeof getSymbolBlastRadius> = null;
  let symbolNote: string | undefined;
  let linkedRawBytes = 0;
  try {
    result = getBlastRadius(args.symbolId, args.repoId, db, args.depth, ws);
    linkedRawBytes = workspaceRawBytes(
      ws,
      (result.linked ?? []).flatMap((g) => g.files.map((path) => ({ repoId: g.repoId, path }))),
    );
    // Phase 101: symbol granularity walks `symbol_refs`; the file walk above
    // stays the upper bound it reports alongside.
    if (args.granularity === 'symbol') {
      if (symbolRefsAvailable(db, args.repoId)) {
        symbolResult = getSymbolBlastRadius(args.symbolId, args.repoId, db, args.depth, ws);
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
  const coverage = graphCoverageWarning(db, args.repoId);
  // Boundary honesty (Phase 97): the seam signal for the queried file.
  const ownFile = getSymbolById(db, args.repoId, args.symbolId)?.filePath;
  const externalImports = ownFile ? computeExternalImports(db, args.repoId, [ownFile]) : null;
  db.close();

  const rawBytes = result.files.reduce((sum, fp) => sum + (fileSizes.get(fp) ?? 0), 0) + linkedRawBytes;
  const responseBytes = result.tokenEstimate * BYTES_PER_TOKEN;
  const linkedFileCount = (result.linked ?? []).reduce((n, g) => n + g.files.length, 0);
  const linkedSymbolCount = (result.linked ?? []).reduce((n, g) => n + g.symbols.length, 0);

  const shape = (s: { id: string; name: string; kind: string; filePath: string; signature: string }) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    filePath: s.filePath,
    signature: s.signature,
  });

  const fileAnswer = {
    depth: args.depth ?? 3,
    truncated: result.truncated,
    affectedFiles: result.files.length + linkedFileCount,
    affectedSymbols: result.symbols.length + linkedSymbolCount,
    _tokenEstimate: result.tokenEstimate,
    files: result.files.sort(),
    symbols: result.symbols.map(shape),
    ...(links.length > 0 ? { links } : {}),
    ...(result.linked && result.linked.length > 0
      ? {
          linkedFiles: linkedFileCount,
          linked: result.linked.map((g) => ({
            repoId: g.repoId,
            rootPath: g.rootPath,
            files: [...g.files].sort(),
            symbols: g.symbols.map(shape),
          })),
        }
      : {}),
  };

  // Phase 101: the symbol answer replaces the top-level sets; the file answer
  // travels as `fileRadius` (its upper bound). Depth per symbol, refCount and
  // the matched name make the lexical evidence inspectable.
  let symbolAnswer: Record<string, unknown> | null = null;
  if (symbolResult) {
    const sr = symbolResult;
    const hopOf = new Map(sr.hops.map((h) => [`${h.repoId}\u0000${h.symbol.id}`, h]));
    const hop = (repoId: string, id: string) => hopOf.get(`${repoId}\u0000${id}`);
    const linkedSyms = (sr.linked ?? []).reduce((n, g) => n + g.symbols.length, 0);
    const linkedFiles = (sr.linked ?? []).reduce((n, g) => n + g.files.length, 0);
    symbolAnswer = {
      granularity: 'symbol',
      confidence: 'lexical',
      depth: args.depth ?? 3,
      truncated: sr.truncated,
      affectedFiles: sr.files.length + linkedFiles,
      affectedSymbols: sr.symbols.length + linkedSyms,
      _tokenEstimate: sr.tokenEstimate,
      files: [...sr.files].sort(),
      symbols: sr.symbols.map((s) => {
        const h = hop(args.repoId, s.id);
        return {
          ...shape(s),
          depth: h?.depth ?? 0,
          ...(h && h.via ? { via: h.via, refCount: h.refCount } : {}),
        };
      }),
      ...(links.length > 0 ? { links } : {}),
      ...(sr.linked && sr.linked.length > 0
        ? {
            linkedFiles,
            linked: sr.linked.map((g) => ({
              repoId: g.repoId,
              rootPath: g.rootPath,
              files: [...g.files].sort(),
              symbols: g.symbols.map((s) => ({ ...shape(s), depth: hop(g.repoId, s.id)?.depth ?? 0 })),
            })),
          }
        : {}),
      note:
        'Symbol edges are lexical: a symbol whose span mentions an imported name. Shadowed ' +
        'parameters, strings and comments can produce a false positive. `fileRadius` is the file-level ' +
        'answer at the same depth; a re-export (barrel) counts as ONE symbol hop but TWO file hops, so ' +
        'a symbol hop can reach a file the file walk reaches one hop later.',
      fileRadius: {
        affectedFiles: fileAnswer.affectedFiles,
        affectedSymbols: fileAnswer.affectedSymbols,
        truncated: fileAnswer.truncated,
        files: fileAnswer.files,
      },
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            symbolId: args.symbolId,
            ...(symbolAnswer ?? {
              // dep_edges is file-to-file. Stated so agents do not over-trust
              // the precision; granularity="symbol" gives the finer answer.
              granularity: 'file',
              ...(symbolNote ? { note: symbolNote } : {}),
              ...fileAnswer,
            }),
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
