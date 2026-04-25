import { loadSavings, saveSavings } from './db/savings-store.js';
import { logger } from './logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const BYTES_PER_TOKEN = 4;
const FLUSH_INTERVAL = 5;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CostEstimates {
  cost_avoided: Record<string, number>;
  total_cost_avoided: Record<string, number>;
}

// ─── Pricing tiers (USD per million input tokens) ─────────────────────────────

const PRICING_TIERS: Record<string, number> = {
  claude_opus_4: 15.0,
  claude_sonnet_4: 3.0,
  claude_haiku_4: 0.8,
  gpt4o: 2.5,
  gpt4o_mini: 0.15,
};

// ─── In-memory state ──────────────────────────────────────────────────────────

class _State {
  total: number = 0;
  unflushed: number = 0;
  callCount: number = 0;
  loaded: boolean = false;
  anonId: string = '';
  sessionStart: Date | null = null;
}

const state = new _State();
let handlersRegistered = false;

// ─── Internal helpers ─────────────────────────────────────────────────────────

function ensureLoaded(): void {
  if (state.loaded) return;
  const data = loadSavings();
  state.total = data.total_tokens_saved;
  state.anonId = data.anon_id;
  state.loaded = true;
}

function flush(): void {
  if (state.unflushed === 0) return;
  try {
    saveSavings({
      total_tokens_saved: state.total,
      anon_id: state.anonId,
      last_updated: new Date().toISOString(),
    });
    state.unflushed = 0;
    state.callCount = 0;
  } catch (err) {
    logger.warn('Failed to flush token savings to disk', { error: String(err) });
  }
}

function registerExitHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  process.on('exit', () => flush());

  process.on('SIGTERM', () => {
    flush();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    flush();
    process.exit(0);
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Estimate tokens saved by comparing raw file size vs response size.
 * Returns 0 if response is larger than raw (never negative).
 */
export function estimateSavings(rawBytes: number, responseBytes: number): number {
  return Math.max(0, Math.floor((rawBytes - responseBytes) / BYTES_PER_TOKEN));
}

/**
 * Add tokensSaved to the running total. Flushes to disk every FLUSH_INTERVAL calls.
 * Returns the new cumulative total.
 */
export function recordSavings(tokensSaved: number): number {
  ensureLoaded();
  registerExitHandlers();

  if (state.sessionStart === null) {
    state.sessionStart = new Date();
  }

  state.total += tokensSaved;
  state.unflushed += tokensSaved;
  state.callCount++;

  if (state.callCount >= FLUSH_INTERVAL) {
    flush();
  }

  return state.total;
}

/**
 * Returns the current cumulative total without modifying state.
 */
export function getTotalSaved(): number {
  ensureLoaded();
  return state.total;
}

/**
 * Compute cost avoided in USD for a single call and cumulatively,
 * based on model pricing tiers. Values rounded to 4 decimal places.
 */
export function costAvoided(tokensSaved: number, totalTokensSaved: number): CostEstimates {
  const cost_avoided: Record<string, number> = {};
  const total_cost_avoided: Record<string, number> = {};

  for (const [model, ratePerMillion] of Object.entries(PRICING_TIERS)) {
    cost_avoided[model] = parseFloat((tokensSaved * ratePerMillion / 1_000_000).toFixed(4));
    total_cost_avoided[model] = parseFloat((totalTokensSaved * ratePerMillion / 1_000_000).toFixed(4));
  }

  return { cost_avoided, total_cost_avoided };
}

/**
 * Resets the cumulative total to zero, both in-memory and on disk.
 * Returns the previous total before the reset.
 */
export function resetSavings(): number {
  ensureLoaded();
  const previous = state.total;

  state.total = 0;
  state.unflushed = 0;
  state.callCount = 0;
  state.sessionStart = null;

  // Write zeroed state to disk immediately
  try {
    saveSavings({
      total_tokens_saved: 0,
      anon_id: state.anonId,
      last_updated: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn('Failed to persist savings reset to disk', { error: String(err) });
  }

  return previous;
}

/**
 * Returns the timestamp when the current session started (first recordSavings() call).
 * Returns the current time if recordSavings() has never been called this session.
 */
export function getSessionStart(): Date {
  return state.sessionStart ?? new Date();
}

// ─── Test utilities ───────────────────────────────────────────────────────────

/**
 * Reset in-memory state. For testing only.
 */
export function _resetForTesting(): void {
  state.total = 0;
  state.unflushed = 0;
  state.callCount = 0;
  state.loaded = false;
  state.anonId = '';
  state.sessionStart = null;
}
