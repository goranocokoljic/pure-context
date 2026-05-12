/**
 * get-class-hierarchy.ts
 *
 * MCP tool: get_class_hierarchy
 *
 * Return the full inheritance chain for a class or interface — ancestors
 * (extends chain upward) and/or descendants (all subclasses downward).
 *
 * Detection strategy: signature-based LIKE queries on `symbols.signature`
 * with word-boundary regex post-filtering. External base classes (e.g.
 * `extends Error`) that are not indexed appear as leaf nodes with
 * `symbolId: null`.
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getSymbolById } from '../../core/db/symbol-store.js';
import { buildClassHierarchy } from '../../graph/graph-traversal.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_class_hierarchy';

export const description =
  'Return the full inheritance chain for a class or interface — ancestors ' +
  '(extends chain upward) and/or descendants (all subclasses/implementations ' +
  'downward). External base classes not in the repo appear as leaf nodes with ' +
  'symbolId: null. Use search_symbols to find the symbolId for a class or ' +
  'interface first.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  symbolId: z
    .string()
    .describe('Symbol ID of the class or interface to root the hierarchy at'),
  direction: z
    .enum(['ancestors', 'descendants', 'both'])
    .optional()
    .describe(
      'Which direction to traverse: "ancestors" (extends chain upward), ' +
      '"descendants" (all subclasses downward), or "both" (default: "both")',
    ),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Maximum traversal depth in each direction (default 5)'),
  includeInterfaces: z
    .boolean()
    .optional()
    .describe(
      'Include implemented interfaces in the ancestor chain and interface ' +
      'subclasses in descendants (default true)',
    ),
};

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  symbolId: string;
  direction?: 'ancestors' | 'descendants' | 'both';
  maxDepth?: number;
  includeInterfaces?: boolean;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    symbolId,
    direction = 'both',
    maxDepth = 5,
    includeInterfaces = true,
  } = args;

  const db = openDatabase(repoId);

  try {
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Repo "${repoId}" not found. Run index_folder first.`,
            }),
          },
        ],
        isError: true,
      };
    }

    const target = getSymbolById(db, repoId, symbolId);
    if (!target) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Symbol "${symbolId}" not found in repo "${repoId}".`,
            }),
          },
        ],
        isError: true,
      };
    }

    if (target.kind !== 'class' && target.kind !== 'interface') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                `Symbol "${target.name}" has kind "${target.kind}". ` +
                'get_class_hierarchy only works with class or interface symbols.',
            }),
          },
        ],
        isError: true,
      };
    }

    const result = buildClassHierarchy(
      symbolId,
      repoId,
      db,
      direction,
      maxDepth,
      includeInterfaces,
    );

    if (!result) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Symbol "${symbolId}" not found during hierarchy traversal.`,
            }),
          },
        ],
        isError: true,
      };
    }

    const responseText = JSON.stringify(result.root);
    const output = {
      root: result.root,
      totalNodes: result.totalNodes,
      _tokenEstimate: Math.ceil(responseText.length / 4),
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    };
  } finally {
    db.close();
  }
}
