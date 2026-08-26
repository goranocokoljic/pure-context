/**
 * find-cycles.ts
 *
 * MCP tool: find_cycles
 *
 * Detect all import cycles in the dependency graph and return them as ordered
 * file paths. Unlike detect_antipatterns (which reports only a count and
 * severity), this tool returns the actual cycle paths so an agent can understand
 * and resolve circular dependencies.
 *
 * Algorithm: DFS with path stack. Each cycle is reported exactly once, rooted
 * at its lexicographically smallest file. Severity is 'error' for tight 2–3-node
 * cycles (tightly coupled pairs/triangles) and 'warning' for longer chains.
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { findImportCycles } from '../../graph/graph-traversal.js';
import { buildMeta } from './_meta.js';
import { graphCoverageWarning } from './graph-coverage.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'find_cycles';

export const description =
  'Detect all import cycles in the dependency graph and return them as ordered ' +
  'file paths. Unlike detect_antipatterns (which only counts cycles), this tool ' +
  'returns the actual cycle paths so you can understand and resolve circular ' +
  'dependencies. Severity is "error" for tight 2–3 node cycles and "warning" ' +
  'for longer chains. Use filePath to scope results to cycles involving one file.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  filePath: z
    .string()
    .optional()
    .describe(
      'Scope to cycles that involve this file (relative to repo root). ' +
      'If omitted, all cycles in the repo are returned up to maxCycles.',
    ),
  maxCycles: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Stop after finding this many cycles (default 20)'),
  minLength: z
    .number()
    .int()
    .min(2)
    .max(20)
    .optional()
    .describe(
      'Minimum cycle length to report (default 2). ' +
      'A mutual import A→B→A has length 2. Raise this to skip direct pairs.',
    ),
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface CyclePath {
  files: string[];
  length: number;
  severity: 'warning' | 'error';
}

interface FindCyclesOutput {
  cycles: CyclePath[];
  totalFound: number;
  truncated: boolean;
  _tokenEstimate: number;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  filePath?: string;
  maxCycles?: number;
  minLength?: number;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, filePath, maxCycles = 20, minLength = 2 } = args;

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

    const result = findImportCycles(repoId, db, filePath, maxCycles, minLength);

    const responseText = JSON.stringify(result.cycles);
    const output: FindCyclesOutput = {
      cycles: result.cycles,
      totalFound: result.totalFound,
      truncated: result.truncated,
      _tokenEstimate: Math.ceil(responseText.length / 4),
      ...(graphCoverageWarning(db, repoId) ?? {}),
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    };
  } finally {
    db.close();
  }
}
