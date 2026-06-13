/**
 * get-symbol-risk.ts
 *
 * MCP tool: get_symbol_risk
 *
 * Return a single, explainable "how risky is it to change this symbol?" verdict
 * (Phase 76) — a config-weighted, repo-relative blend of churn, centrality,
 * complexity, test gap, and co-change spread. Agents should consult this before
 * broad automated edits to a `high` symbol (inspect callers + co-changers first).
 *
 * Code-centered only — no author/ownership/productivity metrics.
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { computeSymbolRisk } from './symbol-risk.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_symbol_risk';

export const description =
  'Composite, explainable risk score (0–100, banded low/review/high) for ' +
  'changing a symbol. Fuses churn (90d), centrality (afferent coupling + ' +
  'reverse blast radius), cyclomatic complexity, test-coverage gap, and ' +
  'co-change spread — each normalized repo-relative. Returns factors (raw + ' +
  'normalized) and human-readable reasons[], not just a number. Consult before ' +
  'broad automated edits to a high-risk symbol. Co-change/churn factors need ' +
  'git metadata (git.coChangeDepth > 0) at index time; signalQuality:"low" ' +
  'flags shallow histories.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  symbolId: z.string().describe('Symbol ID from search_symbols or get_file_outline'),
};

export async function handler(args: { repoId: string; symbolId: string }): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, symbolId } = args;

  const db = openDatabase(repoId);
  try {
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Repo "${repoId}" not found. Run index_folder first.` }) }],
        isError: true,
      };
    }

    const risk = computeSymbolRisk(db, repoId, symbolId);
    if (!risk) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Symbol "${symbolId}" not found.` }) }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ ...risk, _meta: buildMeta({ timingMs: Date.now() - t0 }) }, null, 2),
      }],
    };
  } finally {
    db.close();
  }
}
