/**
 * Tests for the normalized gate envelope (Phase 80, Task 486).
 *
 * Pure-function mapping from each tool's detailed verdict to { gate, gateReasons,
 * nextAction }, plus the worstGate combinator. A block must always carry reasons.
 */
import { describe, it, expect } from 'vitest';
import {
  gatePrepareChange,
  gateVerifyChange,
  gateCompareChangeImpact,
  gateCheckConsistency,
  worstGate,
} from '../../src/server/tools/gate-envelope.js';

describe('gatePrepareChange', () => {
  it('ready + low risk → pass', () => {
    expect(gatePrepareChange({ verdict: 'ready', risk: { band: 'low' } }).gate).toBe('pass');
  });
  it('ready + high risk → warn', () => {
    expect(gatePrepareChange({ verdict: 'ready', risk: { band: 'high' } }).gate).toBe('warn');
  });
  it('no_target → warn (advisory never blocks)', () => {
    expect(gatePrepareChange({ verdict: 'no_target' }).gate).toBe('warn');
  });
  it('ambiguous_target → warn', () => {
    expect(gatePrepareChange({ verdict: 'ambiguous_target' }).gate).toBe('warn');
  });
});

describe('gateVerifyChange', () => {
  it('complete → pass', () => {
    expect(gateVerifyChange({ verdict: 'complete' }).gate).toBe('pass');
  });
  it('incomplete → block with reasons', () => {
    const env = gateVerifyChange({
      verdict: 'incomplete',
      unaddressedCoChange: ['ledger.ts'],
      coverageGapsRemaining: [{}],
    });
    expect(env.gate).toBe('block');
    expect(env.gateReasons.length).toBeGreaterThan(0);
  });
  it('scope_expanded → warn', () => {
    expect(gateVerifyChange({ verdict: 'scope_expanded' }).gate).toBe('warn');
  });
});

describe('gateCompareChangeImpact', () => {
  it('regressed → block with reasons', () => {
    const env = gateCompareChangeImpact({ verdict: 'regressed', newCycles: [['a', 'b']] });
    expect(env.gate).toBe('block');
    expect(env.gateReasons.length).toBeGreaterThan(0);
  });
  it('improved → pass', () => {
    expect(gateCompareChangeImpact({ verdict: 'improved' }).gate).toBe('pass');
  });
  it('unchanged → pass', () => {
    expect(gateCompareChangeImpact({ verdict: 'unchanged' }).gate).toBe('pass');
  });
  it('no_baseline → warn', () => {
    expect(gateCompareChangeImpact({ verdict: 'no_baseline' }).gate).toBe('warn');
  });
});

describe('gateCheckConsistency', () => {
  it('low signal → pass', () => {
    expect(gateCheckConsistency({ signalQuality: 'low', duplicates: [], placement: null }).gate).toBe('pass');
  });
  it('exact duplicate → warn', () => {
    const env = gateCheckConsistency({
      signalQuality: 'ok',
      duplicates: [{ similarity: 1, name: 'parseExpenseRow' }],
      placement: null,
    });
    expect(env.gate).toBe('warn');
    expect(env.gateReasons.join(' ')).toMatch(/already exists/i);
  });
  it('bad placement → warn', () => {
    expect(
      gateCheckConsistency({ signalQuality: 'ok', duplicates: [], placement: { fits: false } }).gate,
    ).toBe('warn');
  });
  it('clean → pass', () => {
    expect(
      gateCheckConsistency({ signalQuality: 'ok', duplicates: [], placement: { fits: true } }).gate,
    ).toBe('pass');
  });
});

describe('worstGate', () => {
  it('block dominates', () => {
    expect(worstGate(['pass', 'warn', 'block'])).toBe('block');
  });
  it('warn beats pass', () => {
    expect(worstGate(['pass', 'warn', 'pass'])).toBe('warn');
  });
  it('all pass → pass', () => {
    expect(worstGate(['pass', 'pass'])).toBe('pass');
  });
  it('empty → pass', () => {
    expect(worstGate([])).toBe('pass');
  });
});

describe('every block carries a reason (invariant)', () => {
  it('verify incomplete', () => {
    const env = gateVerifyChange({ verdict: 'incomplete' });
    expect(env.gate).toBe('block');
    expect(env.gateReasons.length).toBeGreaterThan(0);
  });
  it('compare regressed', () => {
    const env = gateCompareChangeImpact({ verdict: 'regressed' });
    expect(env.gate).toBe('block');
    expect(env.gateReasons.length).toBeGreaterThan(0);
  });
});
