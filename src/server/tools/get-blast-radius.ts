import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { getBlastRadius } from '../../graph/graph-traversal.js';
import { getFileSizesBatch } from '../../core/db/file-store.js';
import { BYTES_PER_TOKEN } from '../../core/token-tracker.js';
import { buildMeta } from './_meta.js';
import { graphCoverageWarning } from './graph-coverage.js';
import { computeExternalImports } from './external-imports.js';
import { getSymbolById } from '../../core/db/symbol-store.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_blast_radius';

export const description =
  "Reverse-walk the dependency graph to find files that (transitively) import the symbol's FILE. " +
  'Use this to assess the impact of changing or deleting a symbol before making edits. ' +
  'Granularity is file-level: every symbol in the same file returns the same radius. ' +
  'The walk stops at `depth` hops (default 3) — `truncated: true` means deeper dependents exist. ' +
  'When the symbol\'s file has internal-looking imports that resolved to nothing in this index, ' +
  '`externalImports` names them and any related indexes: edges stop at an index boundary, so the ' +
  'radius is a lower bound there.';

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
  const result = getBlastRadius(args.symbolId, args.repoId, db, args.depth);

  const fileSizes = getFileSizesBatch(db, args.repoId, result.files);
  const coverage = graphCoverageWarning(db, args.repoId);
  // Boundary honesty (Phase 97): the seam signal for the queried file.
  const ownFile = getSymbolById(db, args.repoId, args.symbolId)?.filePath;
  const externalImports = ownFile ? computeExternalImports(db, args.repoId, [ownFile]) : null;
  db.close();

  const rawBytes = result.files.reduce((sum, fp) => sum + (fileSizes.get(fp) ?? 0), 0);
  const responseBytes = result.tokenEstimate * BYTES_PER_TOKEN;

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
            affectedFiles: result.files.length,
            affectedSymbols: result.symbols.length,
            _tokenEstimate: result.tokenEstimate,
            files: result.files.sort(),
            symbols: result.symbols.map((s) => ({
              id: s.id,
              name: s.name,
              kind: s.kind,
              filePath: s.filePath,
              signature: s.signature,
            })),
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
