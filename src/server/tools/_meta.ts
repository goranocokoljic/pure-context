import { estimateSavings, recordSavings } from '../../core/token-tracker.js';
import { VERSION } from '../../version.js';

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
  powered_by: string;
  server_version: string;
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

    return {
      timing_ms: timingMs,
      tokens_saved: tokensSaved,
      total_tokens_saved: newTotal,
      powered_by: POWERED_BY,
      server_version: VERSION,
    };
  }

  return {
    timing_ms: timingMs,
    powered_by: POWERED_BY,
    server_version: VERSION,
  };
}
