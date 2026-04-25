import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { getContextBundle } from '../../graph/graph-traversal.js';
import { getFileSizesBatch } from '../../core/db/file-store.js';
import { BYTES_PER_TOKEN } from '../../core/token-tracker.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_context_bundle';

export const description =
  'Forward-walk the dependency graph from a symbol to collect everything needed to understand it. ' +
  'Returns the symbol plus all transitively imported files and their symbols. ' +
  'Includes a token estimate so you can gauge context size before loading.';

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

export function handler(args: { repoId: string; symbolId: string; depth?: number }): CallToolResult {
  const t0 = Date.now();
  const db = openDatabase(args.repoId);
  const result = getContextBundle(args.symbolId, args.repoId, db, args.depth);

  const fileSizes = getFileSizesBatch(db, args.repoId, result.files);
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
            fileCount: result.files.length,
            symbolCount: result.symbols.length,
            _tokenEstimate: result.tokenEstimate,
            files: result.files.sort(),
            symbols: result.symbols.map((s) => ({
              id: s.id,
              name: s.name,
              kind: s.kind,
              filePath: s.filePath,
              signature: s.signature,
              summary: s.summary,
            })),
            _meta: buildMeta({ timingMs: Date.now() - t0, rawBytes, responseBytes }),
          },
          null,
          2,
        ),
      },
    ],
  };
}
