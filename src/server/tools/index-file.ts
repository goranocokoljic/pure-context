import { z } from 'zod';
import { existsSync } from 'fs';
import { relative, resolve, isAbsolute, sep, join } from 'path';
import { reindexFiles } from '../../core/index-manager.js';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { discoverAdapters } from '../../adapters/adapter-registry.js';
import { getConfig } from '../../config/config-loader.js';
import { logger } from '../../core/logger.js';
import { buildMeta } from './_meta.js';
import type { FrameworkAdapter } from '../../core/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'index_file';

export const description =
  'Re-index one or a few specific files WITHOUT the full-tree discovery + stat pass that ' +
  'index_folder performs. This is the cheap, O(one file) freshness path: call it after an ' +
  'agent writes/edits a file so subsequent searches reflect the real current state. ' +
  'Accepts absolute or repo-relative paths; files that no longer exist on disk are treated ' +
  'as deletions and their symbols/edges are removed. Use index_folder for the initial index.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  filePaths: z
    .array(z.string())
    .min(1)
    .describe(
      'One or more file paths (absolute or relative to the repo root) to re-index. ' +
        'Paths that do not exist on disk are treated as deletions.',
    ),
};

// Adapter discovery does a (bounded) filesystem detect scan. Cache the resolved
// adapter set per repo so repeated single-file re-indexes stay O(one file) and
// don't pay the discovery cost on every call (the whole point of this tool).
const adapterCache = new Map<string, FrameworkAdapter[]>();

async function resolveAdapters(repoId: string, absRoot: string): Promise<FrameworkAdapter[]> {
  const cached = adapterCache.get(repoId);
  if (cached) return cached;
  let adapters: FrameworkAdapter[] = [];
  try {
    adapters = await discoverAdapters(absRoot, { adapters: getConfig().adapters });
  } catch (err) {
    logger.warn(`index_file: adapter discovery failed for ${repoId}: ${err}`);
    adapters = [];
  }
  adapterCache.set(repoId, adapters);
  return adapters;
}

/** Normalise an input path to the repo-relative, forward-slash form the index stores. */
function toRepoRelative(absRoot: string, p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(join(absRoot, p));
  return relative(absRoot, abs).split(sep).join('/');
}

export async function handler(
  args: { repoId: string; filePaths: string[] },
): Promise<CallToolResult> {
  const start = Date.now();

  // Resolve the repo root from the index (without a discovery pass).
  const db = openDatabase(args.repoId);
  const repo = getRepo(db, args.repoId);
  db.close();

  if (!repo) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: `Repository ${args.repoId} not found — run index_folder first`,
              repoId: args.repoId,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  const absRoot = repo.rootPath;

  // Split inputs into changed (exists on disk) vs deleted (missing).
  const changedPaths: string[] = [];
  const deletedPaths: string[] = [];
  const seen = new Set<string>();
  for (const p of args.filePaths) {
    const rel = toRepoRelative(absRoot, p);
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = isAbsolute(p) ? resolve(p) : resolve(join(absRoot, p));
    if (existsSync(abs)) changedPaths.push(rel);
    else deletedPaths.push(rel);
  }

  const adapters = await resolveAdapters(args.repoId, absRoot);

  const result = await reindexFiles(args.repoId, changedPaths, deletedPaths, { adapters });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            repoId: result.repoId,
            filesIndexed: result.filesIndexed,
            filesDeleted: deletedPaths.length,
            filesSkipped: result.filesSkipped,
            symbolsFound: result.symbolsFound,
            edgesFound: result.edgesFound,
            totalSymbolsInDb: result.totalSymbolsInDb,
            totalFilesInDb: result.totalFilesInDb,
            durationMs: result.durationMs,
            errors: result.errors,
            _meta: buildMeta({ timingMs: Date.now() - start }),
          },
          null,
          2,
        ),
      },
    ],
  };
}
