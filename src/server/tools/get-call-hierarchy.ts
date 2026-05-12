/**
 * get-call-hierarchy.ts
 *
 * MCP tool: get_call_hierarchy
 *
 * Return the callers and callees of a function, N levels deep, as a tree
 * structure. Unlike get_blast_radius (file-level, reverse-only) and
 * find_references (flat call sites), this tool returns a hierarchical view
 * of the call stack suitable for understanding execution flow.
 *
 * Direction options:
 *  - 'callees' — what does this function call? (forward walk)
 *  - 'callers' — what calls this function? (reverse walk)
 *  - 'both'    — bidirectional tree: callers above root, callees below
 *
 * Cycle detection: recursive calls are included as leaf nodes with
 * `cyclic: true` to prevent infinite expansion.
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { buildCallHierarchy } from '../../graph/graph-traversal.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_call_hierarchy';

export const description =
  'Return the callers and callees of a function, N levels deep, as a tree ' +
  'structure. Use direction="callees" to see what a function calls, ' +
  '"callers" to see what calls it, or "both" for a bidirectional view. ' +
  'Recursive functions are detected and marked with cyclic=true. ' +
  'Use search_symbols to find the symbolId for the function first.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  symbolId: z
    .string()
    .describe('Symbol ID of the function or method to build the hierarchy for'),
  direction: z
    .enum(['callers', 'callees', 'both'])
    .describe(
      '"callees" — what this function calls; ' +
      '"callers" — what calls this function; ' +
      '"both" — bidirectional (callers and callees combined at each level)',
    ),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(6)
    .optional()
    .describe('Maximum tree depth (default 3, max 6)'),
  maxNodes: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'Stop expanding the tree once total nodes reach this count (default 50). ' +
      'When hit, truncated=true is set in the response.',
    ),
  maxTokens: z
    .number()
    .int()
    .min(100)
    .optional()
    .describe(
      'Soft cap on response size in tokens. ' +
      'When the estimated token count exceeds this value, the tree is returned as-is ' +
      'with truncated=true.',
    ),
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface CallNode {
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  signature: string;
  callCount: number;
  cyclic: boolean;
  children: CallNode[];
}

interface GetCallHierarchyOutput {
  root: CallNode;
  direction: 'callers' | 'callees' | 'both';
  totalNodes: number;
  truncated: boolean;
  _tokenEstimate: number;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  symbolId: string;
  direction: 'callers' | 'callees' | 'both';
  maxDepth?: number;
  maxNodes?: number;
  maxTokens?: number;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const {
    repoId,
    symbolId,
    direction,
    maxDepth = 3,
    maxNodes = 50,
    maxTokens,
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

    const result = buildCallHierarchy(symbolId, repoId, db, direction, maxDepth, maxNodes);

    if (!result) {
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

    const responseText = JSON.stringify(result.root);
    const tokenEstimate = Math.ceil(responseText.length / 4);

    let truncated = result.truncated;
    if (maxTokens !== undefined && tokenEstimate > maxTokens) {
      truncated = true;
    }

    const output: GetCallHierarchyOutput = {
      root: result.root,
      direction: result.direction,
      totalNodes: result.totalNodes,
      truncated,
      _tokenEstimate: tokenEstimate,
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    };
  } finally {
    db.close();
  }
}
