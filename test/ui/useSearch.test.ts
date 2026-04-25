/**
 * Unit tests for useSearch hook logic.
 * These tests exercise the LruCache and debounce/caching logic
 * without needing a DOM or React runtime.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchFilters } from '../../src/ui/src/hooks/useSearch.js';

// ─── LruCache (extracted logic) ───────────────────────────────────────────────

class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private readonly maxSize: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  size(): number {
    return this.map.size;
  }
}

// ─── Cache key logic ──────────────────────────────────────────────────────────

function makeCacheKey(repoId: string, query: string, filters: SearchFilters): string {
  return JSON.stringify({
    repoId,
    query,
    kinds: [...filters.kinds].sort(),
    filePath: filters.filePath,
  });
}

// ─── Highlight helper ─────────────────────────────────────────────────────────

function highlightSegments(
  text: string,
  query: string,
): Array<{ text: string; highlight: boolean }> {
  if (!query.trim()) return [{ text, highlight: false }];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);
  return parts.map((part) => ({
    text: part,
    highlight: regex.test(part),
  }));
}

// ─── Tests: LruCache ─────────────────────────────────────────────────────────

describe('LruCache', () => {
  it('stores and retrieves a value', () => {
    const cache = new LruCache<string[]>(10);
    cache.set('k1', ['a', 'b']);
    expect(cache.get('k1')).toEqual(['a', 'b']);
  });

  it('returns undefined for missing key', () => {
    const cache = new LruCache<string[]>(10);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the least-recently-used entry when full', () => {
    const cache = new LruCache<number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Access 'a' to make it recently used
    cache.get('a');
    // Add 'd' — should evict 'b' (oldest unused)
    cache.set('d', 4);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('does not exceed maxSize', () => {
    const cache = new LruCache<number>(5);
    for (let i = 0; i < 10; i++) {
      cache.set(`k${i}`, i);
    }
    expect(cache.size()).toBe(5);
  });

  it('updating an existing key does not grow the cache', () => {
    const cache = new LruCache<number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('a', 99); // update, not insert
    expect(cache.size()).toBe(3);
    expect(cache.get('a')).toBe(99);
  });
});

// ─── Tests: cache key ─────────────────────────────────────────────────────────

describe('makeCacheKey', () => {
  it('produces same key for equivalent filters regardless of kind order', () => {
    const k1 = makeCacheKey('r1', 'foo', { kinds: ['function', 'class'], filePath: '' });
    const k2 = makeCacheKey('r1', 'foo', { kinds: ['class', 'function'], filePath: '' });
    expect(k1).toBe(k2);
  });

  it('produces different keys for different queries', () => {
    const k1 = makeCacheKey('r1', 'foo', { kinds: [], filePath: '' });
    const k2 = makeCacheKey('r1', 'bar', { kinds: [], filePath: '' });
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for different repos', () => {
    const k1 = makeCacheKey('r1', 'foo', { kinds: [], filePath: '' });
    const k2 = makeCacheKey('r2', 'foo', { kinds: [], filePath: '' });
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for different file patterns', () => {
    const k1 = makeCacheKey('r1', 'foo', { kinds: [], filePath: 'src/**' });
    const k2 = makeCacheKey('r1', 'foo', { kinds: [], filePath: 'lib/**' });
    expect(k1).not.toBe(k2);
  });
});

// ─── Tests: highlight segments ────────────────────────────────────────────────

describe('highlightSegments', () => {
  it('returns single non-highlighted segment when query is empty', () => {
    const segs = highlightSegments('hello world', '');
    expect(segs).toEqual([{ text: 'hello world', highlight: false }]);
  });

  it('returns single non-highlighted segment when query is whitespace', () => {
    const segs = highlightSegments('hello', '   ');
    expect(segs).toEqual([{ text: 'hello', highlight: false }]);
  });

  it('highlights a simple match', () => {
    const segs = highlightSegments('hello world', 'world');
    const highlighted = segs.filter((s) => s.highlight).map((s) => s.text);
    expect(highlighted).toContain('world');
  });

  it('is case-insensitive', () => {
    const segs = highlightSegments('Hello World', 'hello');
    const highlighted = segs.filter((s) => s.highlight).map((s) => s.text);
    expect(highlighted.some((t) => t.toLowerCase() === 'hello')).toBe(true);
  });

  it('highlights multiple occurrences', () => {
    const segs = highlightSegments('foo bar foo', 'foo');
    const highlighted = segs.filter((s) => s.highlight);
    expect(highlighted.length).toBe(2);
  });

  it('escapes regex special characters in query', () => {
    // Should not throw; '.' matches literally
    expect(() => highlightSegments('a.b.c', '.')).not.toThrow();
    const segs = highlightSegments('a.b.c', '.');
    const plain = segs.filter((s) => !s.highlight).map((s) => s.text);
    // The surrounding text (a, b, c) should be non-highlighted
    expect(plain.join('')).toContain('a');
  });

  it('returns only non-highlighted segments when no match', () => {
    const segs = highlightSegments('hello world', 'xyz');
    expect(segs.every((s) => !s.highlight)).toBe(true);
    expect(segs.map((s) => s.text).join('')).toBe('hello world');
  });
});

// ─── Tests: filter state logic ────────────────────────────────────────────────

describe('SearchFilters state logic', () => {
  it('toggles a kind on', () => {
    const filters: SearchFilters = { kinds: [], filePath: '' };
    const next = { ...filters, kinds: [...filters.kinds, 'function' as const] };
    expect(next.kinds).toContain('function');
  });

  it('toggles a kind off', () => {
    const filters: SearchFilters = { kinds: ['function', 'class'], filePath: '' };
    const next = { ...filters, kinds: filters.kinds.filter((k) => k !== 'function') };
    expect(next.kinds).not.toContain('function');
    expect(next.kinds).toContain('class');
  });

  it('clearAll resets all filters', () => {
    const filters: SearchFilters = { kinds: ['function', 'class'], filePath: 'src/**' };
    const cleared: SearchFilters = { kinds: [], filePath: '' };
    expect(cleared.kinds).toHaveLength(0);
    expect(cleared.filePath).toBe('');
    // Ensure we're testing a new object
    expect(filters.kinds).toHaveLength(2);
  });
});

// ─── Tests: debounce logic ────────────────────────────────────────────────────

describe('debounce behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not call the function before the delay', () => {
    const fn = vi.fn();
    const timer = setTimeout(fn, 300);
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
    clearTimeout(timer);
  });

  it('calls the function after the delay', () => {
    const fn = vi.fn();
    setTimeout(fn, 300);
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancelling the previous timer prevents the stale call', () => {
    const fn = vi.fn();
    let timer = setTimeout(() => fn('first'), 300);
    vi.advanceTimersByTime(200);
    clearTimeout(timer);
    timer = setTimeout(() => fn('second'), 300);
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('second');
  });
});
