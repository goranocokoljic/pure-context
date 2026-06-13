/**
 * get-co-change.ts
 *
 * MCP tool: get_co_change
 *
 * Report temporal coupling — files that historically change together with a
 * target file/symbol — using the repo-level commit→files capture (Phase 76).
 *
 * Surfaces the "second-order edits the import graph can't see": a route and its
 * test, or a feature flag and the code it gates, that move together without
 * importing each other. Returns explainable association metrics (support,
 * confidence, lift) with mega-commit noise filtered out.
 *
 * Granularity is FILE-level (git tracks files, not symbols): a `symbolId`
 * resolves to its containing file before analysis.
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getSymbolById } from '../../core/db/symbol-store.js';
import { countCommits } from '../../core/db/co-change-store.js';
import { getCoChange } from './co-change.js';
import { getConfig } from '../../config/config-loader.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_co_change';

export const description =
  'Report temporal coupling: files that historically change together with a ' +
  'target file or symbol, derived from git commit history (the commit_files ' +
  'capture). Reveals coupling the import graph cannot — e.g. a route and its ' +
  'test, or a feature flag and the code it gates. Returns explainable metrics ' +
  '(support = shared commits; confidence = directional A→B probability; ' +
  'lift = association strength) with mega-commits (reformats/lockfile sweeps) ' +
  'filtered out. Granularity is FILE-level: a symbolId resolves to its file. ' +
  'Requires git.coChangeDepth > 0 at index time; returns signalQuality:"low" ' +
  'on shallow/sparse histories rather than overstating weak ratios.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  filePath: z
    .string()
    .optional()
    .describe('Target file path (repo-relative). Provide this OR symbolId.'),
  symbolId: z
    .string()
    .optional()
    .describe('Target symbol ID — resolved to its containing file (git is file-granular).'),
  minSupport: z
    .number().int().min(1)
    .optional()
    .describe('Drop partners with fewer than this many shared commits (default 2).'),
  dayWindow: z
    .number().int().min(1).max(3650)
    .optional()
    .describe('Look back N days (default: entire captured commit window).'),
  topN: z
    .number().int().min(1).max(200)
    .optional()
    .describe('Maximum co-changing partners to return (default 20).'),
};

export async function handler(args: {
  repoId: string;
  filePath?: string;
  symbolId?: string;
  minSupport?: number;
  dayWindow?: number;
  topN?: number;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, symbolId, minSupport, dayWindow, topN } = args;

  const db = openDatabase(repoId);
  try {
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Repo "${repoId}" not found. Run index_folder first.` }) }],
        isError: true,
      };
    }

    // Resolve target file (from filePath or symbolId).
    let targetFilePath = args.filePath;
    if (!targetFilePath && symbolId) {
      const sym = getSymbolById(db, repoId, symbolId);
      if (!sym) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Symbol "${symbolId}" not found.` }) }],
          isError: true,
        };
      }
      targetFilePath = sym.filePath;
    }
    if (!targetFilePath) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Provide either filePath or symbolId.' }) }],
        isError: true,
      };
    }

    // No co-change data captured (coChangeDepth=0 or non-git / never indexed with it).
    if (countCommits(db, repoId) === 0) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            repoId,
            targetFilePath,
            signalQuality: 'low',
            partners: [],
            hint: 'No co-change data found. Re-index a git repo with config git.coChangeDepth > 0 (default 300).',
            _meta: buildMeta({ timingMs: Date.now() - t0 }),
          }, null, 2),
        }],
      };
    }

    const result = getCoChange(db, repoId, targetFilePath, {
      minSupport,
      dayWindow,
      topN,
      megaCommitThreshold: getConfig().git?.megaCommitThreshold ?? 30,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ repoId, ...result, _meta: buildMeta({ timingMs: Date.now() - t0 }) }, null, 2),
      }],
    };
  } finally {
    db.close();
  }
}
