import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { findImporters } from '../../graph/graph-traversal.js';
import { getFileSizesBatch } from '../../core/db/file-store.js';
import { buildMeta } from './_meta.js';
import { graphCoverageWarning } from './graph-coverage.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'find_importers';

export const description =
  'Find all files that directly import a given file. ' +
  'Returns each importing file along with its symbols. ' +
  'Useful for understanding who depends on a module before refactoring it.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  filePath: z.string().describe('File path (relative to repo root) to find importers of'),
};

export function handler(args: { repoId: string; filePath: string }): CallToolResult {
  const t0 = Date.now();
  const db = openDatabase(args.repoId);
  const importers = findImporters(args.filePath, args.repoId, db);

  // rawBytes: target file + all importer files (what agent would need to read)
  const allFiles = [args.filePath, ...importers.map((i) => i.file)];
  const fileSizes = getFileSizesBatch(db, args.repoId, allFiles);
  const coverage = graphCoverageWarning(db, args.repoId);
  db.close();

  const rawBytes = allFiles.reduce((sum, fp) => sum + (fileSizes.get(fp) ?? 0), 0);
  const responseBytes = importers.reduce(
    (sum, info) =>
      sum + info.symbols.reduce((s2, sym) => s2 + sym.name.length + sym.signature.length, 0),
    0,
  );

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            filePath: args.filePath,
            importerCount: importers.length,
            importers: importers.map((info) => ({
              file: info.file,
              symbols: info.symbols.map((s) => ({
                id: s.id,
                name: s.name,
                kind: s.kind,
                signature: s.signature,
              })),
            })),
            ...(coverage ?? {}),
            _meta: buildMeta({ timingMs: Date.now() - t0, rawBytes, responseBytes }),
          },
          null,
          2,
        ),
      },
    ],
  };
}
