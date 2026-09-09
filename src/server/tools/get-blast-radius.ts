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
  'is a lower bound there.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  symbolId: z.string().describe('Symbol ID of the code you plan to change'),
  depth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Max reverse-dependency hops (default 3)'),
};

export function handler(args: { repoId: string; symbolId: string; depth?: number }): CallToolResult {
  const t0 = Date.now();
  const db = openDatabase(args.repoId);
  // Phase 99: the workspace = this index + the indexes its last build linked.
  const ws = openWorkspace(db, args.repoId, getRepo(db, args.repoId)?.rootPath ?? '');
  let result: ReturnType<typeof getBlastRadius>;
  let linkedRawBytes = 0;
  try {
    result = getBlastRadius(args.symbolId, args.repoId, db, args.depth, ws);
    linkedRawBytes = workspaceRawBytes(
      ws,
      (result.linked ?? []).flatMap((g) => g.files.map((path) => ({ repoId: g.repoId, path }))),
    );
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

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            symbolId: args.symbolId,
            // dep_edges is file-to-file — symbol-level edges are a future
            // phase. Stated so agents do not over-trust the precision.
            granularity: 'file',
            depth: args.depth ?? 3,
            truncated: result.truncated,
            affectedFiles: result.files.length + linkedFileCount,
            affectedSymbols: result.symbols.length + linkedSymbolCount,
            _tokenEstimate: result.tokenEstimate,
            files: result.files.sort(),
            symbols: result.symbols.map((s) => ({
              id: s.id,
              name: s.name,
              kind: s.kind,
              filePath: s.filePath,
              signature: s.signature,
            })),
            ...(links.length > 0 ? { links } : {}),
            ...(result.linked && result.linked.length > 0
              ? {
                  linkedFiles: linkedFileCount,
                  linked: result.linked.map((g) => ({
                    repoId: g.repoId,
                    rootPath: g.rootPath,
                    files: [...g.files].sort(),
                    symbols: g.symbols.map((s) => ({
                      id: s.id,
                      name: s.name,
                      kind: s.kind,
                      filePath: s.filePath,
                      signature: s.signature,
                    })),
                  })),
                }
              : {}),
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
