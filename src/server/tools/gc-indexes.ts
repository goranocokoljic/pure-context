import { z } from 'zod';
import { resolve } from 'path';
import { applyGc, planGc, formatGcPlan } from '../../core/index-gc.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'gc_indexes';

export const description =
  'Garbage-collect the index directory (Phase 100). Dry-run by default: lists orphan ' +
  'index files (no repo row — crashed or half-deleted runs) and indexes whose root path no ' +
  'longer exists (removed worktrees / deleted checkouts) with their sizes; with blobs: true ' +
  'also the blobs in the shared content store that no index references any more ' +
  '(mark-and-sweep across every live index). Nothing is deleted unless apply: true. ' +
  'A live index, or one with a re-index in progress, is never a candidate.';

export const inputSchema = {
  apply: z.boolean().optional().describe('Delete what the dry run lists. Default false (report only).'),
  blobs: z
    .boolean()
    .optional()
    .describe('Also plan / sweep unreferenced blobs in <dataDir>/blobs.db (then VACUUM). Default false.'),
  scopePath: z
    .string()
    .optional()
    .describe('Only consider the index whose stored root is this path (e.g. a worktree just removed).'),
};

export function handler(args: { apply?: boolean; blobs?: boolean; scopePath?: string } = {}): CallToolResult {
  const t0 = Date.now();
  const blobs = args.blobs ?? false;
  const scopeRoot = args.scopePath ? resolve(args.scopePath) : undefined;

  if (!args.apply) {
    const plan = planGc({ blobs, scopeRoot });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              dryRun: true,
              ...plan,
              blobs: plan.blobs ? { ...plan.blobs, hashes: undefined, hashCount: plan.blobs.hashes.length } : null,
              summary: formatGcPlan(plan, { blobsRequested: blobs }),
              nextAction:
                plan.reclaimableBytes > 0
                  ? 'Re-run with apply: true to delete exactly this list.'
                  : 'Nothing to collect.',
              _meta: buildMeta({ timingMs: Date.now() - t0 }),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const result = applyGc({ blobs, scopeRoot });
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            dryRun: false,
            deletedIndexes: result.deletedIndexes,
            failedIndexes: result.failedIndexes,
            blobsDeleted: result.blobsDeleted,
            blobBytesFreed: result.blobBytesFreed,
            blobFileBytesBefore: result.blobFileBytesBefore,
            blobFileBytesAfter: result.blobFileBytesAfter,
            freedBytes: result.deletedIndexes.reduce((n, d) => n + d.bytes, 0) + result.blobBytesFreed,
            _meta: buildMeta({ timingMs: Date.now() - t0 }),
          },
          null,
          2,
        ),
      },
    ],
  };
}
