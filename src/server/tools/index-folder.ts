import { z } from 'zod';
import { indexFolder } from '../../core/index-manager.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'index_folder';

export const description =
  'Index a local project folder. Discovers source files, parses symbols and imports, ' +
  'and builds a dependency graph stored in a local SQLite database. ' +
  'Returns the repo ID needed by other tools plus indexing statistics.';

export const inputSchema = {
  path: z.string().describe('Absolute path to the project root directory to index'),
  fileLimit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of files to index (default 1000)'),
};

export async function handler(
  args: { path: string; fileLimit?: number },
): Promise<CallToolResult> {
  const result = await indexFolder(args.path, { fileLimit: args.fileLimit });
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            repoId: result.repoId,
            filesIndexed: result.filesIndexed,
            filesSkipped: result.filesSkipped,
            symbolsFound: result.symbolsFound,
            edgesFound: result.edgesFound,
            durationMs: result.durationMs,
            errors: result.errors,
            _meta: buildMeta({ timingMs: result.durationMs }),
          },
          null,
          2,
        ),
      },
    ],
  };
}
