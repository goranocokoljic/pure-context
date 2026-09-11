import { z } from 'zod';
import { indexFolder } from '../../core/index-manager.js';
import { reindexChanged, type ReindexChangedResult } from '../../core/index-changed.js';
import { getConfig } from '../../config/config-loader.js';
import { getJobsDir } from '../../core/db/schema.js';
import { readHeadDrift } from '../../core/git-head.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'index_folder';

export const description =
  'Index a local project folder. Discovers source files, parses symbols and imports, ' +
  'and builds a dependency graph stored in a local SQLite database. ' +
  'Returns the repo ID needed by other tools plus indexing statistics. ' +
  'Re-runs are incremental by content hash but DISCOVERY-bound (every file is stat-ed). ' +
  'After a git checkout / pull / merge / rebase pass onlyChanged: true — the changed ' +
  'paths come from git (no directory walk); it falls back to a full run automatically ' +
  'when it cannot (mode + reason in the response). A new git worktree of an indexed ' +
  'repository is seeded by cloning a sibling index (clonedFrom in the response). ' +
  'The response echoes head (indexed sha vs HEAD) so you can see drift.';

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
  onlyChanged: z
    .boolean()
    .optional()
    .describe(
      'Re-index only what git reports changed since the sha the index was last brought ' +
        'up to (plus uncommitted edits). No discovery walk. Falls back to a full index when ' +
        'there is no stored sha / not a git checkout / too many changes (see mode + reason).',
    ),
  since: z
    .string()
    .optional()
    .describe('With onlyChanged: diff from this commit instead of the stored sha.'),
  verifyIndexed: z
    .boolean()
    .optional()
    .describe(
      'With onlyChanged: also re-hash every indexed file and refresh mismatches ' +
        '(covers `git checkout -- <path>` and external writes; reads only indexed paths).',
    ),
};

export async function handler(
  args: {
    path: string;
    fileLimit?: number;
    workspaceId?: string;
    onlyChanged?: boolean;
    since?: string;
    verifyIndexed?: boolean;
  },
): Promise<CallToolResult> {
  const cfg = getConfig();
  const common = {
    fileLimit: args.fileLimit ?? cfg.fileLimit,
    concurrency: cfg.concurrency,
    tenantId: args.workspaceId ?? 'local',
  };

  const changedOnly: ReindexChangedResult | null = args.onlyChanged
    ? await reindexChanged(args.path, {
        ...common,
        since: args.since,
        verifyIndexed: args.verifyIndexed,
      })
    : null;
  const result = changedOnly ?? (await indexFolder(args.path, common));

  const head = readHeadDrift(args.path, result.headSha ?? null, {
    jobsDir: getJobsDir(),
    repoId: result.repoId,
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            repoId: result.repoId,
            ...(changedOnly
              ? {
                  mode: changedOnly.mode,
                  since: changedOnly.since,
                  ...(changedOnly.reason ? { reason: changedOnly.reason } : {}),
                  ...(changedOnly.changedFiles !== undefined
                    ? { changedFiles: changedOnly.changedFiles, deletedFiles: changedOnly.deletedFiles }
                    : {}),
                  ...(changedOnly.verifiedStale !== undefined
                    ? { verifiedStale: changedOnly.verifiedStale }
                    : {}),
                }
              : { mode: 'full' }),
            filesIndexed: result.filesIndexed,
            filesSkipped: result.filesSkipped,
            ...(result.filesUnchanged !== undefined ? { filesUnchanged: result.filesUnchanged } : {}),
            ...(result.filesFailed !== undefined ? { filesFailed: result.filesFailed } : {}),
            ...(result.dropped ? { dropped: result.dropped } : {}),
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
            ...(result.clonedFrom ? { clonedFrom: result.clonedFrom } : {}),
            ...(result.linksUsed && result.linksUsed.length > 0
              ? { linksUsed: result.linksUsed, crossEdgesFound: result.crossEdgesFound ?? 0 }
              : {}),
            // Phase 101: symbol-level ref rows written by this run (absent when
            // the builder was skipped / disabled).
            ...(result.symbolRefsBuilt !== undefined
              ? { symbolRefsBuilt: result.symbolRefsBuilt, symbolRefsMs: result.symbolRefsMs ?? 0 }
              : {}),
            ...(head ? { head } : {}),
            _meta: buildMeta({ timingMs: result.durationMs }),
          },
          null,
          2,
        ),
      },
    ],
  };
}
