import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock token-tracker so _meta.ts never touches savings-store
const { mockEstimate, mockRecord, mockCost } = vi.hoisted(() => ({
  mockEstimate: vi.fn((raw: number, resp: number) => Math.max(0, Math.floor((raw - resp) / 4))),
  mockRecord: vi.fn((n: number) => n),           // returns the value passed (total = tokens)
  mockCost: vi.fn((saved: number, total: number) => ({
    cost_avoided: { claude_opus_4: parseFloat((saved * 15 / 1_000_000).toFixed(4)) },
    total_cost_avoided: { claude_opus_4: parseFloat((total * 15 / 1_000_000).toFixed(4)) },
  })),
}));

vi.mock('../../src/core/token-tracker.js', () => ({
  estimateSavings: mockEstimate,
  recordSavings: mockRecord,
  costAvoided: mockCost,
}));

import { buildMeta } from '../../src/server/tools/_meta.js';

beforeEach(() => {
  mockEstimate.mockClear();
  mockRecord.mockClear();
  mockCost.mockClear();
  // Restore default implementations
  mockEstimate.mockImplementation((raw: number, resp: number) =>
    Math.max(0, Math.floor((raw - resp) / 4)),
  );
  mockRecord.mockImplementation((n: number) => n);
  mockCost.mockImplementation((saved: number, total: number) => ({
    cost_avoided: { claude_opus_4: parseFloat((saved * 15 / 1_000_000).toFixed(4)) },
    total_cost_avoided: { claude_opus_4: parseFloat((total * 15 / 1_000_000).toFixed(4)) },
  }));
});

// ─── powered_by always present ────────────────────────────────────────────────

describe('buildMeta — powered_by', () => {
  it('always includes powered_by: "PureContext MCP"', () => {
    const meta = buildMeta({ timingMs: 10 });
    expect(meta.powered_by).toBe('PureContext MCP');
  });

  it('includes powered_by even when savings fields are provided', () => {
    const meta = buildMeta({ timingMs: 5, rawBytes: 1000, responseBytes: 100 });
    expect(meta.powered_by).toBe('PureContext MCP');
  });
});

// ─── timing_ms always present ─────────────────────────────────────────────────

describe('buildMeta — timing_ms', () => {
  it('includes timing_ms when no savings provided', () => {
    const meta = buildMeta({ timingMs: 42 });
    expect(meta.timing_ms).toBe(42);
  });

  it('includes timing_ms when savings are provided', () => {
    const meta = buildMeta({ timingMs: 7, rawBytes: 800, responseBytes: 200 });
    expect(meta.timing_ms).toBe(7);
  });
});

// ─── without savings fields ───────────────────────────────────────────────────

describe('buildMeta — without savings', () => {
  it('omits savings fields when rawBytes/responseBytes not provided', () => {
    const meta = buildMeta({ timingMs: 10 });
    expect(meta.tokens_saved).toBeUndefined();
    expect(meta.total_tokens_saved).toBeUndefined();
    expect(meta.cost_avoided).toBeUndefined();
    expect(meta.total_cost_avoided).toBeUndefined();
  });

  it('does not call estimateSavings/recordSavings when no bytes provided', () => {
    buildMeta({ timingMs: 10 });
    expect(mockEstimate).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('omits savings fields when only rawBytes provided', () => {
    const meta = buildMeta({ timingMs: 10, rawBytes: 1000 });
    expect(meta.tokens_saved).toBeUndefined();
  });

  it('omits savings fields when only responseBytes provided', () => {
    const meta = buildMeta({ timingMs: 10, responseBytes: 100 });
    expect(meta.tokens_saved).toBeUndefined();
  });
});

// ─── with savings fields ──────────────────────────────────────────────────────

describe('buildMeta — with savings', () => {
  it('calls estimateSavings, recordSavings, costAvoided when both byte fields given', () => {
    buildMeta({ timingMs: 5, rawBytes: 4000, responseBytes: 400 });
    expect(mockEstimate).toHaveBeenCalledWith(4000, 400);
    expect(mockRecord).toHaveBeenCalledWith(900);   // (4000-400)/4 = 900
    expect(mockCost).toHaveBeenCalledWith(900, 900);
  });

  it('includes tokens_saved in returned envelope', () => {
    const meta = buildMeta({ timingMs: 5, rawBytes: 4000, responseBytes: 400 });
    expect(meta.tokens_saved).toBe(900);
  });

  it('includes total_tokens_saved (value returned by recordSavings)', () => {
    mockRecord.mockReturnValueOnce(5000);
    const meta = buildMeta({ timingMs: 5, rawBytes: 4000, responseBytes: 400 });
    expect(meta.total_tokens_saved).toBe(5000);
  });

  it('includes cost_avoided and total_cost_avoided', () => {
    const meta = buildMeta({ timingMs: 5, rawBytes: 4000, responseBytes: 400 });
    expect(meta.cost_avoided).toBeDefined();
    expect(meta.total_cost_avoided).toBeDefined();
  });

  it('tokens_saved is 0 when raw <= response (no negative savings)', () => {
    const meta = buildMeta({ timingMs: 5, rawBytes: 100, responseBytes: 500 });
    expect(meta.tokens_saved).toBe(0);
  });
});
