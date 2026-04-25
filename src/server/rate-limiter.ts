import { RateLimitStore, type BucketState } from './rate-limit-store.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LimiterOptions {
  /** Maximum tokens a bucket can hold (default: 100). */
  maxTokens: number;
  /** Tokens added per second (default: 10). */
  refillRate: number;
  /** Milliseconds between refill calculations (default: 100). */
  refillInterval: number;
}

export interface LimitResult {
  /** Whether the request is permitted. */
  allowed: boolean;
  /** Tokens remaining after this request (floored to integer). */
  remainingTokens: number;
  /**
   * Milliseconds until the client should retry.
   * 0 when `allowed` is true.
   */
  retryAfterMs: number;
}

// ─── Token Bucket Limiter ─────────────────────────────────────────────────────

/**
 * Token-bucket rate limiter.
 *
 * Each `key` (IP address or API key) gets an independent bucket.  Tokens refill
 * continuously at `refillRate` tokens/second up to `maxTokens`.  Requests
 * consume tokens; when the bucket is empty the request is rejected with a
 * `retryAfterMs` indicating how long to wait.
 *
 * Refill is computed lazily on each access so no background timer is needed.
 */
export class TokenBucketLimiter {
  private readonly opts: Required<LimiterOptions>;
  private readonly store: RateLimitStore;

  constructor(options: Partial<LimiterOptions> = {}) {
    this.opts = {
      maxTokens: options.maxTokens ?? 100,
      refillRate: options.refillRate ?? 10,
      refillInterval: options.refillInterval ?? 100,
    };
    this.store = new RateLimitStore();
  }

  /**
   * Attempt to consume `tokens` from the bucket for `key`.
   *
   * Refills the bucket based on elapsed wall-clock time, then either deducts
   * the requested tokens (allowed) or returns a rejected result with a
   * `retryAfterMs` estimate.
   */
  tryConsume(key: string, tokens = 1): LimitResult {
    const now = Date.now();
    const state = this.refill(key, now);

    if (state.tokens >= tokens) {
      state.tokens -= tokens;
      this.store.set(key, state);
      return {
        allowed: true,
        remainingTokens: Math.floor(state.tokens),
        retryAfterMs: 0,
      };
    }

    // Estimate how long until enough tokens accumulate
    const tokensNeeded = tokens - state.tokens;
    const msPerToken = 1000 / this.opts.refillRate;
    const retryAfterMs = Math.ceil(tokensNeeded * msPerToken);

    return {
      allowed: false,
      remainingTokens: Math.floor(state.tokens),
      retryAfterMs,
    };
  }

  /**
   * Return the number of tokens available for `key` without consuming any.
   * Returns the full bucket capacity for unknown keys.
   */
  getRemainingTokens(key: string): number {
    const state = this.refill(key, Date.now());
    return Math.floor(state.tokens);
  }

  /**
   * Reset the bucket for `key` to its maximum capacity.
   * Useful for testing and admin operations.
   */
  reset(key: string): void {
    this.store.delete(key);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /**
   * Return the bucket state for `key` after applying any accumulated refill.
   * Does NOT write back to the store — callers must call `store.set` if they
   * mutate the state (so unknown keys don't create store entries unless needed).
   */
  private refill(key: string, nowMs: number): BucketState {
    const existing = this.store.get(key);

    if (existing === undefined) {
      return { tokens: this.opts.maxTokens, lastRefillMs: nowMs };
    }

    const elapsedMs = nowMs - existing.lastRefillMs;
    const tokensToAdd = (elapsedMs / 1000) * this.opts.refillRate;
    const newTokens = Math.min(this.opts.maxTokens, existing.tokens + tokensToAdd);

    return { tokens: newTokens, lastRefillMs: nowMs };
  }
}
