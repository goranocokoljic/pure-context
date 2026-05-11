import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock is hoisted to the top of the file, so factory variables must be
// declared with vi.hoisted() to be available when the factory runs.
const { mockLoadSavings, mockSaveSavings } = vi.hoisted(() => ({
  mockLoadSavings: vi.fn(() => ({
    total_tokens_saved: 0,
    anon_id: 'test-uuid',
    last_updated: '',
  })),
  mockSaveSavings: vi.fn(),
}));

vi.mock('../../src/core/db/savings-store.js', () => ({
  loadSavings: mockLoadSavings,
  saveSavings: mockSaveSavings,
}));

import {
  estimateSavings,
  recordSavings,
  getTotalSaved,
  BYTES_PER_TOKEN,
  _resetForTesting,
} from '../../src/core/token-tracker.js';

beforeEach(() => {
  _resetForTesting();
  mockLoadSavings.mockClear();
  mockSaveSavings.mockClear();
  // Restore default return value after any test that overrides it
  mockLoadSavings.mockImplementation(() => ({
    total_tokens_saved: 0,
    anon_id: 'test-uuid',
    last_updated: '',
  }));
});

// ─── BYTES_PER_TOKEN ──────────────────────────────────────────────────────────

describe('BYTES_PER_TOKEN', () => {
  it('is 4', () => {
    expect(BYTES_PER_TOKEN).toBe(4);
  });
});

// ─── estimateSavings ──────────────────────────────────────────────────────────

describe('estimateSavings', () => {
  it('returns positive savings when raw > response', () => {
    // (4000 - 400) / 4 = 900
    expect(estimateSavings(4000, 400)).toBe(900);
  });

  it('returns zero when raw < response (never negative)', () => {
    expect(estimateSavings(100, 500)).toBe(0);
  });

  it('returns zero when raw === response', () => {
    expect(estimateSavings(400, 400)).toBe(0);
  });

  it('floors fractional tokens', () => {
    // (10 - 3) / 4 = 1.75 → floor → 1
    expect(estimateSavings(10, 3)).toBe(1);
  });

  it('handles zero raw bytes', () => {
    expect(estimateSavings(0, 0)).toBe(0);
  });
});

// ─── recordSavings ────────────────────────────────────────────────────────────

describe('recordSavings', () => {
  it('accumulates correctly across multiple calls', () => {
    expect(recordSavings(100)).toBe(100);
    expect(recordSavings(200)).toBe(300);
    expect(recordSavings(50)).toBe(350);
  });

  it('returns new cumulative total on each call', () => {
    recordSavings(500);
    const result = recordSavings(250);
    expect(result).toBe(750);
  });

  it('lazy-loads disk state on first call', () => {
    expect(mockLoadSavings).not.toHaveBeenCalled();
    recordSavings(10);
    expect(mockLoadSavings).toHaveBeenCalledTimes(1);
  });

  it('does NOT call loadSavings on subsequent calls', () => {
    recordSavings(10);
    recordSavings(10);
    recordSavings(10);
    expect(mockLoadSavings).toHaveBeenCalledTimes(1);
  });

  it('does not flush before FLUSH_INTERVAL is reached', () => {
    recordSavings(10);
    recordSavings(10);
    recordSavings(10);
    recordSavings(10);
    expect(mockSaveSavings).not.toHaveBeenCalled();
  });

  it('flushes to disk on the 5th call', () => {
    for (let i = 0; i < 5; i++) recordSavings(10);
    expect(mockSaveSavings).toHaveBeenCalledTimes(1);
    const savedArg = mockSaveSavings.mock.calls[0][0] as { total_tokens_saved: number };
    expect(savedArg.total_tokens_saved).toBe(50);
  });

  it('resets call counter after flush (flushes again after another 5 calls)', () => {
    for (let i = 0; i < 10; i++) recordSavings(10);
    expect(mockSaveSavings).toHaveBeenCalledTimes(2);
  });

  it('includes previously loaded disk total in returned value', () => {
    mockLoadSavings.mockReturnValueOnce({ total_tokens_saved: 1000, anon_id: 'x', last_updated: '' });
    const result = recordSavings(100);
    expect(result).toBe(1100);
  });
});

// ─── getTotalSaved ────────────────────────────────────────────────────────────

describe('getTotalSaved', () => {
  it('returns 0 when nothing has been recorded', () => {
    expect(getTotalSaved()).toBe(0);
  });

  it('returns current total without modifying state', () => {
    recordSavings(300);
    const before = getTotalSaved();
    const after = getTotalSaved();
    expect(before).toBe(300);
    expect(after).toBe(300);
  });

  it('lazy-loads disk state on first call', () => {
    mockLoadSavings.mockReturnValueOnce({ total_tokens_saved: 500, anon_id: 'x', last_updated: '' });
    expect(getTotalSaved()).toBe(500);
  });

  it('reflects unflushed accumulated savings', () => {
    recordSavings(100);
    recordSavings(200);
    expect(getTotalSaved()).toBe(300);
  });
});

// ─── Persistence simulation ───────────────────────────────────────────────────

describe('persistence across restarts', () => {
  it('picks up prior total from disk on first load', () => {
    mockLoadSavings.mockReturnValueOnce({ total_tokens_saved: 50_000, anon_id: 'x', last_updated: '' });
    expect(getTotalSaved()).toBe(50_000);
  });

  it('adds new savings on top of persisted total', () => {
    mockLoadSavings.mockReturnValueOnce({ total_tokens_saved: 10_000, anon_id: 'x', last_updated: '' });
    recordSavings(500);
    expect(getTotalSaved()).toBe(10_500);
  });

  it('flush writes combined total (persisted + new) to disk', () => {
    mockLoadSavings.mockReturnValueOnce({ total_tokens_saved: 9_000, anon_id: 'persist-id', last_updated: '' });
    for (let i = 0; i < 5; i++) recordSavings(200); // adds 1000
    expect(mockSaveSavings).toHaveBeenCalledOnce();
    const saved = mockSaveSavings.mock.calls[0][0] as { total_tokens_saved: number; anon_id: string };
    expect(saved.total_tokens_saved).toBe(10_000);
    expect(saved.anon_id).toBe('persist-id');
  });
});
