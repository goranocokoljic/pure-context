import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { getSymbolsByRepo } from '../../core/db/symbol-store.js';
import { getFileSizesBatch } from '../../core/db/file-store.js';
import { buildMeta } from './_meta.js';
import type { SymbolRecord } from '../../core/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_repo_outline';

export const description =
  'Get a structural overview of an indexed repo: all files with their top-level symbols. ' +
  'Useful for understanding project structure before diving into specific files. ' +
  'Returns signatures and summaries only — no source code.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Max symbols per file (default unlimited)'),
};

export function handler(args: { repoId: string; limit?: number }): CallToolResult {
  const t0 = Date.now();
  const db = openDatabase(args.repoId);
  const allSymbols = getSymbolsByRepo(db, args.repoId);

  // Batch-fetch file sizes for savings calculation
  const uniqueFiles = [...new Set(allSymbols.map((s) => s.filePath))];
  const fileSizes = getFileSizesBatch(db, args.repoId, uniqueFiles);
  db.close();

  // Group by file
  const byFile = new Map<string, SymbolRecord[]>();
  for (const s of allSymbols) {
    let arr = byFile.get(s.filePath);
    if (!arr) {
      arr = [];
      byFile.set(s.filePath, arr);
    }
    // Skip method-level symbols in the outline — keep functions/classes/types
    if (s.kind !== 'method') {
      arr.push(s);
    }
  }

  const files = Array.from(byFile.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filePath, symbols]) => {
      const limited = args.limit ? symbols.slice(0, args.limit) : symbols;
      return {
        filePath,
        symbols: limited.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          signature: s.signature,
          summary: s.summary,
        })),
      };
    });

  const totalSymbols = files.reduce((n, f) => n + f.symbols.length, 0);
  const rawBytes = uniqueFiles.reduce((sum, fp) => sum + (fileSizes.get(fp) ?? 0), 0);
  const responseBytes = allSymbols.reduce(
    (sum, s) => sum + s.name.length + s.signature.length + s.summary.length,
    0,
  );

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            fileCount: files.length,
            totalSymbols,
            files,
            _meta: buildMeta({ timingMs: Date.now() - t0, rawBytes, responseBytes }),
          },
          null,
          2,
        ),
      },
    ],
  };
}
