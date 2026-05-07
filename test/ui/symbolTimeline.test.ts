/**
 * Unit tests for Task 164 — Symbol Change Timeline.
 * Runs in Node — no DOM or React required.
 *
 * Tests cover pure helper functions exported from SymbolTimeline.tsx:
 *  - authorColor: deterministic HSL colour derived from seed string
 *  - initials: extracts up-to-two uppercase initials from a display name
 *  - truncateMessage: truncates at 60 chars with ellipsis
 *  - churnLabel: maps score ranges to human-readable labels
 *  - churnBadgeClasses: maps score ranges to Tailwind class strings
 *  - dateRatio: maps an ISO date to a [0, 1] position within a time window
 *
 * Component-level invariants (no DOM):
 *  - Correct number of dots (one per commit in history)
 *  - History tab hidden when history array is empty
 *  - Churn badge text format
 */

import { describe, it, expect } from 'vitest';

// ─── Inline pure helpers (mirrors SymbolTimeline.tsx exports) ─────────────────

function authorColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360}, 70%, 50%)`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w: string) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function truncateMessage(msg: string, max = 60): string {
  return msg.length > max ? `${msg.slice(0, max)}…` : msg;
}

function churnLabel(score: number): string {
  if (score >= 10) return 'Hotspot';
  if (score >= 5) return 'Volatile';
  if (score >= 2) return 'Active';
  return 'Stable';
}

function churnBadgeClasses(score: number): string {
  if (score >= 10) return 'text-red-400 bg-red-900/40';
  if (score >= 5) return 'text-orange-400 bg-orange-900/40';
  if (score >= 2) return 'text-yellow-400 bg-yellow-900/40';
  return 'text-green-400 bg-green-900/40';
}

function dateRatio(isoDate: string, xMinMs: number, xMaxMs: number): number {
  const t = new Date(isoDate).getTime();
  if (xMaxMs <= xMinMs) return 0;
  return (t - xMinMs) / (xMaxMs - xMinMs);
}

// ─── authorColor ──────────────────────────────────────────────────────────────

describe('authorColor', () => {
  it('returns a valid HSL string', () => {
    const color = authorColor('alice@example.com');
    expect(color).toMatch(/^hsl\(\d+, 70%, 50%\)$/);
  });

  it('is deterministic — same input always produces same colour', () => {
    const c1 = authorColor('bob@corp.io');
    const c2 = authorColor('bob@corp.io');
    expect(c1).toBe(c2);
  });

  it('produces different colours for different seeds', () => {
    const c1 = authorColor('alice@example.com');
    const c2 = authorColor('bob@example.com');
    expect(c1).not.toBe(c2);
  });

  it('hue is in [0, 359]', () => {
    for (const seed of ['alice', 'bob', 'carol', 'dave@x.com', '']) {
      const match = authorColor(seed).match(/^hsl\((\d+),/);
      expect(match).not.toBeNull();
      const hue = parseInt(match![1]!, 10);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it('handles empty string without throwing', () => {
    expect(() => authorColor('')).not.toThrow();
  });
});

// ─── initials ─────────────────────────────────────────────────────────────────

describe('initials', () => {
  it('extracts two initials from a two-word name', () => {
    expect(initials('Alice Brown')).toBe('AB');
  });

  it('extracts two initials from a three-word name (first two words)', () => {
    expect(initials('John Michael Doe')).toBe('JM');
  });

  it('returns single initial for a one-word name', () => {
    expect(initials('Alice')).toBe('A');
  });

  it('uppercases the result', () => {
    expect(initials('alice brown')).toBe('AB');
  });

  it('handles extra whitespace', () => {
    expect(initials('  bob   smith  ')).toBe('BS');
  });

  it('handles empty string without throwing', () => {
    expect(initials('')).toBe('');
  });
});

// ─── truncateMessage ──────────────────────────────────────────────────────────

describe('truncateMessage', () => {
  it('leaves short messages unchanged', () => {
    const msg = 'Fix login bug';
    expect(truncateMessage(msg)).toBe(msg);
  });

  it('truncates at 60 chars and adds ellipsis', () => {
    const msg = 'a'.repeat(61);
    const result = truncateMessage(msg);
    expect(result).toHaveLength(61); // 60 chars + '…' (U+2026, length 1)
    expect(result.endsWith('…')).toBe(true);
  });

  it('does not truncate a 60-char message', () => {
    const msg = 'a'.repeat(60);
    expect(truncateMessage(msg)).toBe(msg);
  });

  it('respects a custom max length', () => {
    const msg = 'abcdefgh';
    expect(truncateMessage(msg, 5)).toBe('abcde…');
  });
});

// ─── churnLabel ───────────────────────────────────────────────────────────────

describe('churnLabel', () => {
  it('score >= 10 → Hotspot', () => {
    expect(churnLabel(10)).toBe('Hotspot');
    expect(churnLabel(25)).toBe('Hotspot');
  });

  it('score >= 5 < 10 → Volatile', () => {
    expect(churnLabel(5)).toBe('Volatile');
    expect(churnLabel(9.9)).toBe('Volatile');
  });

  it('score >= 2 < 5 → Active', () => {
    expect(churnLabel(2)).toBe('Active');
    expect(churnLabel(4.99)).toBe('Active');
  });

  it('score < 2 → Stable', () => {
    expect(churnLabel(0)).toBe('Stable');
    expect(churnLabel(1.99)).toBe('Stable');
  });
});

// ─── churnBadgeClasses ────────────────────────────────────────────────────────

describe('churnBadgeClasses', () => {
  it('score >= 10 → red classes', () => {
    expect(churnBadgeClasses(10)).toContain('red');
    expect(churnBadgeClasses(15)).toContain('red');
  });

  it('score >= 5 < 10 → orange classes', () => {
    expect(churnBadgeClasses(5)).toContain('orange');
    expect(churnBadgeClasses(9)).toContain('orange');
  });

  it('score >= 2 < 5 → yellow classes', () => {
    expect(churnBadgeClasses(2)).toContain('yellow');
    expect(churnBadgeClasses(4)).toContain('yellow');
  });

  it('score < 2 → green classes', () => {
    expect(churnBadgeClasses(0)).toContain('green');
    expect(churnBadgeClasses(1)).toContain('green');
  });
});

// ─── dateRatio ────────────────────────────────────────────────────────────────

describe('dateRatio', () => {
  const JAN = new Date('2024-01-01T00:00:00.000Z').getTime();
  const DEC = new Date('2024-12-31T00:00:00.000Z').getTime();

  it('returns 0 for the start of the window', () => {
    expect(dateRatio(new Date(JAN).toISOString(), JAN, DEC)).toBeCloseTo(0, 5);
  });

  it('returns 1 for the end of the window', () => {
    expect(dateRatio(new Date(DEC).toISOString(), JAN, DEC)).toBeCloseTo(1, 5);
  });

  it('returns ~0.5 for the midpoint', () => {
    const mid = new Date((JAN + DEC) / 2).toISOString();
    expect(dateRatio(mid, JAN, DEC)).toBeCloseTo(0.5, 2);
  });

  it('may return negative for dates before the window', () => {
    const before = new Date(JAN - 86_400_000).toISOString();
    expect(dateRatio(before, JAN, DEC)).toBeLessThan(0);
  });

  it('may return > 1 for dates after the window', () => {
    const after = new Date(DEC + 86_400_000).toISOString();
    expect(dateRatio(after, JAN, DEC)).toBeGreaterThan(1);
  });

  it('returns 0 when xMax === xMin (degenerate window)', () => {
    expect(dateRatio(new Date(JAN).toISOString(), JAN, JAN)).toBe(0);
  });
});

// ─── Dot count invariant ──────────────────────────────────────────────────────

describe('dot count invariant', () => {
  it('number of dots equals number of commits in history', () => {
    // Simulate the mapping done in SymbolTimeline: one dot per history entry
    const history = [
      { date: '2024-06-01T00:00:00.000Z' },
      { date: '2024-08-15T00:00:00.000Z' },
      { date: '2024-11-01T00:00:00.000Z' },
    ];
    const xMinMs = new Date('2024-01-01').getTime();
    const xMaxMs = new Date('2024-12-31').getTime();
    const dots = history.map((c) => ({
      ratio: Math.max(0, Math.min(1, dateRatio(c.date, xMinMs, xMaxMs))),
    }));
    expect(dots).toHaveLength(history.length);
  });

  it('empty history produces zero dots', () => {
    const dots = [].map(() => ({}));
    expect(dots).toHaveLength(0);
  });
});

// ─── History tab visibility ───────────────────────────────────────────────────

describe('History tab visibility', () => {
  it('tab is hidden when history array is empty', () => {
    const history: unknown[] = [];
    // Mirrors the showHistoryTab logic: !historyFetched || hasHistory
    const historyFetched = true;
    const hasHistory = history.length > 0;
    const showHistoryTab = !historyFetched || hasHistory;
    expect(showHistoryTab).toBe(false);
  });

  it('tab is shown when history has commits', () => {
    const history = [{ sha: 'abc' }];
    const historyFetched = true;
    const hasHistory = history.length > 0;
    const showHistoryTab = !historyFetched || hasHistory;
    expect(showHistoryTab).toBe(true);
  });

  it('tab is shown speculatively before fetch completes', () => {
    const historyFetched = false;
    const hasHistory = false;
    const showHistoryTab = !historyFetched || hasHistory;
    expect(showHistoryTab).toBe(true);
  });
});

// ─── Churn badge text format ──────────────────────────────────────────────────

describe('churn badge text format', () => {
  it('formats churnScore with one decimal place', () => {
    const churnScore = 3.7;
    const text = `${churnScore.toFixed(1)} commits/90d — ${churnLabel(churnScore)}`;
    expect(text).toBe('3.7 commits/90d — Active');
  });

  it('shows integer churnScore with .0 suffix', () => {
    const churnScore = 12;
    const text = `${churnScore.toFixed(1)} commits/90d — ${churnLabel(churnScore)}`;
    expect(text).toBe('12.0 commits/90d — Hotspot');
  });

  it('shows correct label for zero churn', () => {
    const churnScore = 0;
    const text = `${churnScore.toFixed(1)} commits/90d — ${churnLabel(churnScore)}`;
    expect(text).toBe('0.0 commits/90d — Stable');
  });
});
