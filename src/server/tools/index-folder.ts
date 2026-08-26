import { z } from 'zod';
import { indexFolder } from '../../core/index-manager.js';
import { getConfig } from '../../config/config-loader.js';
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
    .min(0)
    .optional()
    .describe('Maximum number of files to index (0 = unlimited; default from config, typically 10000)'),
  workspaceId: z.string().optional().describe(
    'Workspace ID to associate this repo with (default: "local" for single-user mode)'
  ),
};

export async function handler(
  args: { path: string; fileLimit?: number; workspaceId?: string },
): Promise<CallToolResult> {
  const cfg = getConfig();
  const result = await indexFolder(args.path, {
    fileLimit: args.fileLimit ?? cfg.fileLimit,
    concurrency: cfg.concurrency,
    tenantId: args.workspaceId ?? 'local',
  });
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
            warnings: result.warnings,
            limitReached: result.limitReached,
            totalBeforeLimit: result.totalBeforeLimit,
            ...(result.batchesCommitted !== undefined
              ? { batchesCommitted: result.batchesCommitted }
              : {}),
            ...(result.filesPruned !== undefined ? { filesPruned: result.filesPruned } : {}),
            ...(result.excludedDirs ? { excludedDirs: result.excludedDirs } : {}),
            _meta: buildMeta({ timingMs: result.durationMs }),
          },
          null,
          2,
        ),
      },
    ],
  };
}
