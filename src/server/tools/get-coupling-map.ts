/**
 * get-coupling-map.ts
 *
 * MCP tool: get_coupling_map
 *
 * Return per-file coupling scores with the named files each file depends on,
 * going beyond the aggregate score in get_quality_metrics to show exactly who
 * depends on whom.
 *
 * Metrics (Martin's instability metric):
 *   efferentCoupling (Ce) — files this file imports
 *   afferentCoupling (Ca) — files that import this file
 *   instability = Ce / (Ce + Ca)
 *     0 = maximally stable (nothing this file depends on can break it)
 *     1 = maximally unstable (leaf node — safe to change without ripple effects)
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getCouplingMap } from '../../core/db/dep-store.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_coupling_map';

export const description =
  'Return per-file coupling scores showing exactly which files each file depends on and ' +
  'which files depend on it. Goes beyond get_quality_metrics to expose the full dependency ' +
  'lists, not just aggregate counts. Uses Martin\'s instability metric: ' +
  'instability = efferentCoupling / (efferentCoupling + afferentCoupling). ' +
  'A score near 0 means the file is a stable hub (risky to change). ' +
  'A score near 1 means it is a leaf (safe to change). ' +
  'Use topN to surface the most coupled files in the repo, or filePath to inspect one file.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  filePath: z
    .string()
    .optional()
    .describe(
      'Scope to a single file (relative to repo root). ' +
      'If omitted, returns the top-N most coupled files across the whole repo.',
    ),
  topN: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Maximum number of files to return when filePath is omitted (default 20)'),
  minScore: z
    .number()
    .min(0)
    .optional()
    .describe(
      'Only include files whose total coupling (efferent + afferent) is ≥ this value. ' +
      'Use to focus on highly coupled files only.',
    ),
  direction: z
    .enum(['efferent', 'afferent', 'both'])
    .optional()
    .describe(
      '"efferent" — show only outgoing deps (files this file imports); ' +
      '"afferent" — show only incoming deps (files that import this file); ' +
      '"both" (default) — show both. Restricting direction reduces response size.',
    ),
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface FileCoupling {
  filePath: string;
  efferentCoupling: number;
  afferentCoupling: number;
  instability: number;
  efferentDeps: string[];
  afferentDeps: string[];
}

interface GetCouplingMapOutput {
  files: FileCoupling[];
  totalFiles: number;
  _tokenEstimate: number;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  filePath?: string;
  topN?: number;
  minScore?: number;
  direction?: 'efferent' | 'afferent' | 'both';
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, filePath, topN = 20, minScore, direction = 'both' } = args;

  const db = openDatabase(repoId);

  try {
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: `Repo "${repoId}" not found. Run index_folder first.` }) },
        ],
        isError: true,
      };
    }

    let rows = getCouplingMap(db, repoId, filePath);

    // Apply minScore filter (total coupling)
    if (minScore !== undefined) {
      rows = rows.filter((r) => r.efferentCoupling + r.afferentCoupling >= minScore);
    }

    // Sort by total coupling descending, then by filePath for stable ordering
    rows.sort(
      (a, b) =>
        b.efferentCoupling + b.afferentCoupling - (a.efferentCoupling + a.afferentCoupling) ||
        a.filePath.localeCompare(b.filePath),
    );

    // Apply topN only when not scoped to a single file
    if (!filePath) {
      rows = rows.slice(0, topN);
    }

    // Strip dep lists for the omitted direction to save tokens
    const files: FileCoupling[] = rows.map((r) => ({
      filePath: r.filePath,
      efferentCoupling: r.efferentCoupling,
      afferentCoupling: r.afferentCoupling,
      instability: r.instability,
      efferentDeps: direction !== 'afferent' ? r.efferentDeps : [],
      afferentDeps: direction !== 'efferent' ? r.afferentDeps : [],
    }));

    const responseText = JSON.stringify(files);
    const output: GetCouplingMapOutput = {
      files,
      totalFiles: files.length,
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
