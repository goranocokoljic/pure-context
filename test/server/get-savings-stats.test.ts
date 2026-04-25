import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock savings-store so tests don't touch ~/.purecontext/_savings.json
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

import { handler } from '../../src/server/tools/get-savings-stats.js';
import {
  recordSavings,
  getTotalSaved,
  resetSavings,
  getSessionStart,
  _resetForTesting,
} from '../../src/core/token-tracker.js';

beforeEach(() => {
  _resetForTesting();
  mockLoadSavings.mockClear();
  mockSaveSavings.mockClear();
  mockLoadSavings.mockImplementation(() => ({
    total_tokens_saved: 0,
    anon_id: 'test-uuid',
    last_updated: '',
  }));
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parse(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

// ─── Stats retrieval ─────────────────────────────────────────────────────────

describe('get_savings_stats — stats retrieval', () => {
  it('returns zero total when nothing has been recorded', () => {
    const data = parse(handler({})) as { total_tokens_saved: number };
    expect(data.total_tokens_saved).toBe(0);
  });

  it('reflects accumulated savings', () => {
    recordSavings(500);
    recordSavings(300);
    const data = parse(handler({})) as { total_tokens_saved: number };
    expect(data.total_tokens_saved).toBe(800);
  });

  it('includes equivalent_context_windows with claude_200k and gpt4_128k', () => {
    recordSavings(200_000);
    const data = parse(handler({})) as {
      equivalent_context_windows: { claude_200k: number; gpt4_128k: number };
    };
    expect(data.equivalent_context_windows.claude_200k).toBe(1.0);
    expect(data.equivalent_context_windows.gpt4_128k).toBeCloseTo(1.56, 1);
  });

  it('context window equivalents are rounded to 2 decimal places', () => {
    recordSavings(123_456);
    const data = parse(handler({})) as {
      equivalent_context_windows: { claude_200k: number; gpt4_128k: number };
    };
    // 123456 / 200000 = 0.6173 → 0.62
    expect(data.equivalent_context_windows.claude_200k).toBe(0.62);
    // 123456 / 128000 = 0.9645 → 0.96
    expect(data.equivalent_context_windows.gpt4_128k).toBe(0.96);
  });

  it('includes total_cost_avoided for all model tiers', () => {
    recordSavings(1_000_000);
    const data = parse(handler({})) as {
      total_cost_avoided: Record<string, number>;
    };
    expect(data.total_cost_avoided).toHaveProperty('claude_opus_4');
    expect(data.total_cost_avoided).toHaveProperty('claude_sonnet_4');
    expect(data.total_cost_avoided).toHaveProperty('claude_haiku_4');
    expect(data.total_cost_avoided).toHaveProperty('gpt4o');
    expect(data.total_cost_avoided).toHaveProperty('gpt4o_mini');
    // 1M tokens * $15/M = $15 for claude_opus_4
    expect(data.total_cost_avoided['claude_opus_4']).toBe(15.0);
  });

  it('includes session_start as an ISO timestamp', () => {
    const before = new Date();
    recordSavings(100);
    const data = parse(handler({})) as { session_start: string };
    const ts = new Date(data.session_start);
    expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(data.session_start).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes _meta.powered_by', () => {
    const data = parse(handler({})) as { _meta: { powered_by: string } };
    expect(data._meta.powered_by).toBe('PureContext MCP');
  });
});

// ─── Reset ────────────────────────────────────────────────────────────────────

describe('get_savings_stats — reset', () => {
  it('returns previous_total and reset:true', () => {
    recordSavings(1000);
    const data = parse(handler({ reset: true })) as {
      reset: boolean;
      previous_total: number;
    };
    expect(data.reset).toBe(true);
    expect(data.previous_total).toBe(1000);
  });

  it('counter is zero after reset', () => {
    recordSavings(1000);
    handler({ reset: true });
    const data = parse(handler({})) as { total_tokens_saved: number };
    expect(data.total_tokens_saved).toBe(0);
  });

  it('new accumulation starts from zero after reset', () => {
    recordSavings(1000);
    handler({ reset: true });
    recordSavings(200);
    const data = parse(handler({})) as { total_tokens_saved: number };
    expect(data.total_tokens_saved).toBe(200);
  });

  it('reset writes zeros to disk', () => {
    recordSavings(500);
    mockSaveSavings.mockClear();
    handler({ reset: true });
    expect(mockSaveSavings).toHaveBeenCalledOnce();
    const arg = mockSaveSavings.mock.calls[0][0] as { total_tokens_saved: number };
    expect(arg.total_tokens_saved).toBe(0);
  });

  it('reset with no prior savings returns previous_total:0', () => {
    const data = parse(handler({ reset: true })) as { previous_total: number };
    expect(data.previous_total).toBe(0);
  });
});

// ─── token-tracker additions ──────────────────────────────────────────────────

describe('resetSavings (token-tracker)', () => {
  it('returns the previous total', () => {
    recordSavings(750);
    expect(resetSavings()).toBe(750);
  });

  it('total is 0 after reset', () => {
    recordSavings(300);
    resetSavings();
    expect(getTotalSaved()).toBe(0);
  });
});

describe('getSessionStart (token-tracker)', () => {
  it('returns a Date', () => {
    const ts = getSessionStart();
    expect(ts).toBeInstanceOf(Date);
  });

  it('is set on first recordSavings call', () => {
    const before = Date.now();
    recordSavings(1);
    const ts = getSessionStart();
    expect(ts.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('does not change on subsequent recordSavings calls', () => {
    recordSavings(1);
    const first = getSessionStart().getTime();
    recordSavings(1);
    const second = getSessionStart().getTime();
    expect(second).toBe(first);
  });

  it('is reset after resetSavings()', () => {
    recordSavings(1);
    resetSavings();
    const after = new Date();
    const sessionAfterReset = getSessionStart();
    // After reset with no new recordSavings, getSessionStart returns ~now
    expect(sessionAfterReset.getTime()).toBeGreaterThanOrEqual(after.getTime() - 100);
  });
});
