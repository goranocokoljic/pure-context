import { estimateSavings, recordSavings, costAvoided } from '../../core/token-tracker.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MetaOptions {
  timingMs: number;
  rawBytes?: number;
  responseBytes?: number;
}

export interface MetaEnvelope {
  timing_ms: number;
  tokens_saved?: number;
  total_tokens_saved?: number;
  cost_avoided?: Record<string, number>;
  total_cost_avoided?: Record<string, number>;
  powered_by: string;
}

// ─── Implementation ───────────────────────────────────────────────────────────

const POWERED_BY = 'PureContext MCP';

/**
 * Build a consistent `_meta` envelope for every tool response.
 *
 * When `rawBytes` and `responseBytes` are provided, automatically calculates
 * and records token savings. Tools that don't retrieve content (indexing,
 * listing) should omit those fields — they still get `timing_ms` and
 * `powered_by`.
 */
export function buildMeta(options: MetaOptions): MetaEnvelope {
  const { timingMs, rawBytes, responseBytes } = options;

  if (rawBytes !== undefined && responseBytes !== undefined) {
    const tokensSaved = estimateSavings(rawBytes, responseBytes);
    const newTotal = recordSavings(tokensSaved);
    const { cost_avoided, total_cost_avoided } = costAvoided(tokensSaved, newTotal);

    return {
      timing_ms: timingMs,
      tokens_saved: tokensSaved,
      total_tokens_saved: newTotal,
      cost_avoided,
      total_cost_avoided,
      powered_by: POWERED_BY,
    };
  }

  return {
    timing_ms: timingMs,
    powered_by: POWERED_BY,
  };
}
