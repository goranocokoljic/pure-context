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
import {
  findImportCycles,
  findWorkspaceCycles,
  type CyclePath as LocalCyclePath,
  type WorkspaceCyclePath,
} from '../../graph/graph-traversal.js';
import { openWorkspace } from '../../graph/workspace-graph.js';
import { buildMeta } from './_meta.js';
import { graphCoverageWarning } from './graph-coverage.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'find_cycles';

export const description =
  'Detect all import cycles in the dependency graph and return them as ordered ' +
  'file paths. Unlike detect_antipatterns (which only counts cycles), this tool ' +
  'returns the actual cycle paths so you can understand and resolve circular ' +
  'dependencies. Severity is "error" for tight 2–3 node cycles and "warning" ' +
  'for longer chains. Use filePath to scope results to cycles involving one file. ' +
  'crossIndex:true (since 1.35.0) searches the union graph of this index AND its linked ' +
  'indexes, so a cycle that passes through two roots (app → lib → app) is found; linked ' +
  'members are named `<linkedRepoId>:<path>` and each cycle carries `members` + `crossIndex`.';

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
  crossIndex: z
    .boolean()
    .optional()
    .describe(
      'Search across LINKED indexes too (default false — this index only). ' +
      'Adds `links` (indexes searched) and, per cycle, `members` with repo ids.',
    ),
};

// ─── Types ────────────────────────────────────────────────────────────────────

type CyclePath = LocalCyclePath | WorkspaceCyclePath;

interface FindCyclesOutput {
  cycles: CyclePath[];
  totalFound: number;
  truncated: boolean;
  /** Phase 102: the DFS hit its work budget — more cycles may exist unseen. */
  budgetExhausted?: true;
  note?: string;
  /** Phase 102: present only when `crossIndex: true` was requested. */
  crossIndex?: boolean;
  links?: Array<{ repoId: string; rootPath: string }>;
  missingLinks?: Array<{ repoId: string; rootPath: string }>;
  _tokenEstimate: number;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  filePath?: string;
  maxCycles?: number;
  minLength?: number;
  crossIndex?: boolean;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, filePath, maxCycles = 20, minLength = 2, crossIndex = false } = args;

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

    // Phase 102 (Task 635): opt-in union graph over the workspace. A repo
    // with no links takes the local reader (same paths, `links: []`).
    let result: { cycles: CyclePath[]; totalFound: number; truncated: boolean; budgetExhausted?: true };
    let crossFields: Pick<FindCyclesOutput, 'crossIndex' | 'links' | 'missingLinks'> = {};
    if (crossIndex) {
      const ws = openWorkspace(db, repoId, repo.rootPath);
      try {
        result =
          ws.links.length > 0
            ? findWorkspaceCycles(ws, filePath, maxCycles, minLength)
            : findImportCycles(repoId, db, filePath, maxCycles, minLength);
        crossFields = {
          crossIndex: true,
          links: ws.links.map((m) => ({ repoId: m.repoId, rootPath: m.rootPath })),
          ...(ws.missing.length > 0 ? { missingLinks: ws.missing } : {}),
        };
      } finally {
        ws.close();
      }
    } else {
      result = findImportCycles(repoId, db, filePath, maxCycles, minLength);
    }

    const responseText = JSON.stringify(result.cycles);
    const output: FindCyclesOutput = {
      cycles: result.cycles,
      totalFound: result.totalFound,
      truncated: result.truncated,
      ...(result.budgetExhausted
        ? {
            budgetExhausted: true as const,
            note:
              'The cycle search stopped at its work budget before enumerating every cycle (simple-cycle ' +
              'enumeration is exponential on dense graphs). totalFound is a LOWER bound; scope with filePath ' +
              'or raise minLength to search a smaller space.',
          }
        : {}),
      ...crossFields,
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
