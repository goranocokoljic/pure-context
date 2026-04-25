import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { getSymbolsByFile } from '../../core/db/symbol-store.js';
import { getFileSizeBytes } from '../../core/db/file-store.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_file_outline';

export const description =
  'List all symbols defined in a specific file with their signatures and summaries. ' +
  'Token-efficient alternative to reading the entire file. ' +
  'Use get_symbol_source to drill into a specific symbol.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  filePath: z.string().describe('File path relative to the repo root'),
};

export function handler(args: { repoId: string; filePath: string }): CallToolResult {
  const t0 = Date.now();
  const db = openDatabase(args.repoId);
  const symbols = getSymbolsByFile(db, args.repoId, args.filePath);
  const rawBytes = getFileSizeBytes(db, args.repoId, args.filePath);
  db.close();

  // responseBytes: metadata returned (name + signature + summary), not full source
  const responseBytes = symbols.reduce(
    (sum, s) => sum + s.name.length + s.signature.length + s.summary.length,
    0,
  );

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            filePath: args.filePath,
            count: symbols.length,
            symbols: symbols.map((s) => ({
              id: s.id,
              name: s.name,
              kind: s.kind,
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
