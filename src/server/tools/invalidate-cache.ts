import { z } from 'zod';
import { existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolve as resolvePath } from 'path';
import { openDatabase, computeRepoId, getIndexDir } from '../../core/db/schema.js';
import { invalidateCache as invalidateCacheDb, type InvalidateResult } from '../../core/db/symbol-store.js';
import { buildMeta } from './_meta.js';
import { PureContextError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'invalidate_cache';

export const description =
  'Delete a repo\'s index data from the database, forcing a full re-index on the next ' +
  'index_folder or index_repo call. Provide exactly one of: repoId (by ID), repoPath ' +
  '(resolved by path), or all: true (clear every indexed repo). Does not delete the ' +
  'SQLite file itself — only removes indexed rows.';

export const inputSchema = {
  repoId: z.string().optional().describe('Invalidate a specific repo by its ID'),
  repoPath: z
    .string()
    .optional()
    .describe('Invalidate the repo at this absolute path (resolved to repoId internally)'),
  all: z
    .boolean()
    .optional()
    .describe('When true, invalidate all indexed repos in the local index directory'),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Best-effort removal of the HNSW on-disk index for a repo. */
function tryDeleteHnswIndex(repoId: string): void {
  const hnswPath = join(homedir(), '.purecontext', 'indexes', repoId, 'hnsw.idx');
  if (existsSync(hnswPath)) {
    try {
      unlinkSync(hnswPath);
    } catch {
      // Ignore — stale file will be overwritten on next semantic index build
    }
  }
}

function processRepo(repoId: string): InvalidateResult | null {
  const db = openDatabase(repoId);
  try {
    const result = invalidateCacheDb(db, repoId);
    return result;
  } finally {
    db.close();
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export function handler(args: {
  repoId?: string;
  repoPath?: string;
  all?: boolean;
}): CallToolResult {
  const t0 = Date.now();
  const { repoId, repoPath, all } = args;

  // Validate: exactly one input must be provided
  const inputs = [
    repoId !== undefined,
    repoPath !== undefined,
    all === true,
  ].filter(Boolean);

  if (inputs.length === 0) {
    throw new PureContextError(
      'invalidate_cache requires exactly one of: repoId, repoPath, or all: true. None were provided.',
    );
  }
  if (inputs.length > 1) {
    throw new PureContextError(
      'invalidate_cache: provide only one of repoId, repoPath, or all — not multiple.',
    );
  }

  const deleted: InvalidateResult[] = [];

  if (all) {
    // Invalidate every repo by scanning the index directory
    const dir = getIndexDir();
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.db')) continue;
        const id = file.slice(0, -3);
        try {
          const result = processRepo(id);
          if (result) {
            deleted.push(result);
            tryDeleteHnswIndex(id);
            logger.info('invalidate_cache: cleared repo', {
              repoId: id,
              repoPath: result.repoPath,
              symbolsDeleted: result.symbolsDeleted,
              filesDeleted: result.filesDeleted,
            });
          }
        } catch {
          // Unreadable or incompatible DB — skip silently
        }
      }
    }
  } else {
    // Resolve repoId from path if necessary
    const resolvedId = repoPath ? computeRepoId(resolvePath(repoPath)) : repoId!;

    const result = processRepo(resolvedId);
    if (result) {
      deleted.push(result);
      tryDeleteHnswIndex(resolvedId);
      logger.info('invalidate_cache: cleared repo', {
        repoId: resolvedId,
        repoPath: result.repoPath,
        symbolsDeleted: result.symbolsDeleted,
        filesDeleted: result.filesDeleted,
      });
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            deleted,
            _meta: buildMeta({ timingMs: Date.now() - t0 }),
          },
          null,
          2,
        ),
      },
    ],
  };
}
