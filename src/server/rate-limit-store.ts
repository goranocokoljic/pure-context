// ─── Bucket State ─────────────────────────────────────────────────────────────

export interface BucketState {
  /** Current token count (may be fractional due to refill calculations). */
  tokens: number;
  /** Timestamp (ms) when the last refill was computed. */
  lastRefillMs: number;
}

// ─── LRU Store ────────────────────────────────────────────────────────────────

const MAX_ENTRIES = 10_000;

/**
 * In-memory LRU cache for token bucket state.
 *
 * Uses a Map for O(1) access and deletion. Insertion order is used to identify
 * the least-recently-used entry for eviction. On every access the entry is
 * deleted and re-inserted so it moves to the tail (most-recently-used position).
 */
export class RateLimitStore {
  private readonly cache = new Map<string, BucketState>();

  /** Return the bucket for `key`, promoting it to MRU position. */
  get(key: string): BucketState | undefined {
    const entry = this.cache.get(key);
    if (entry !== undefined) {
      // Promote to MRU by re-inserting at the tail
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
    return entry;
  }

  /** Store or update the bucket for `key`, evicting LRU entry if at capacity. */
  set(key: string, state: BucketState): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= MAX_ENTRIES) {
      // Evict the LRU entry (first key in insertion order)
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, state);
  }

  /** Remove the bucket for `key`. */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /** Number of buckets currently in the store. */
  get size(): number {
    return this.cache.size;
  }
}
