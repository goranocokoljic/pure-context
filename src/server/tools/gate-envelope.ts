/**
 * gate-envelope.ts (Phase 80, Task 486)
 *
 * A single, stable verdict envelope the harness can switch on across the whole
 * change loop. Every loop tool (prepare_change, verify_change,
 * compare_change_impact, check_consistency, merge_readiness) derives this from
 * its own detailed verdict — additive, never replacing existing fields.
 *
 *   gate         pass | warn | block   ← the one field a harness branches on
 *   gateReasons  string[]              ← why (a block always carries ≥1 reason)
 *   nextAction   string                ← a stable machine-readable next step
 *
 * Semantics:
 *   pass  — proceed; nothing structural stands in the way.
 *   warn  — proceed only with judgment; something needs a human/agent decision.
 *   block — do not proceed as-is; there is unfinished or regressed work.
 *
 * These are PURE functions (no DB, no MCP) so every consumer derives the gate the
 * same way and a change here fixes all of them at once.
 */

export type Gate = 'pass' | 'warn' | 'block';

const GATE_RANK: Record<Gate, number> = { pass: 0, warn: 1, block: 2 };

/** The most severe gate among the inputs (block > warn > pass). Empty → pass. */
export function worstGate(gates: Gate[]): Gate {
  let worst: Gate = 'pass';
  for (const g of gates) if (GATE_RANK[g] > GATE_RANK[worst]) worst = g;
  return worst;
}

export interface GateEnvelope {
  gate: Gate;
  gateReasons: string[];
  nextAction: string;
}

// ── prepare_change (pre-edit advisory — never blocks) ─────────────────────────

export function gatePrepareChange(o: {
  verdict: 'ready' | 'ambiguous_target' | 'no_target';
  risk?: { band: 'low' | 'review' | 'high' };
}): GateEnvelope {
  if (o.verdict === 'no_target') {
    return {
      gate: 'warn',
      gateReasons: ['No clear target resolved — refine the query or pass a symbolId before editing.'],
      nextAction: 'refine_target',
    };
  }
  if (o.verdict === 'ambiguous_target') {
    return {
      gate: 'warn',
      gateReasons: ['Multiple plausible targets — choose one (see candidates) before editing.'],
      nextAction: 'choose_target',
    };
  }
  if (o.risk?.band === 'high') {
    return {
      gate: 'warn',
      gateReasons: ['High aggregate risk on the predicted change set — review missingCoChange, tests, and architectural flags before editing.'],
      nextAction: 'review_then_edit',
    };
  }
  return { gate: 'pass', gateReasons: ['Predicted change set is low/moderate risk.'], nextAction: 'proceed' };
}

// ── verify_change (post-edit reconciliation) ──────────────────────────────────

export function gateVerifyChange(o: {
  verdict: 'complete' | 'incomplete' | 'scope_expanded';
  unaddressedCoChange?: string[];
  coverageGapsRemaining?: unknown[];
}): GateEnvelope {
  if (o.verdict === 'incomplete') {
    const reasons: string[] = [];
    if (o.unaddressedCoChange && o.unaddressedCoChange.length > 0) {
      reasons.push(`${o.unaddressedCoChange.length} predicted co-change partner(s) still untouched: ${o.unaddressedCoChange.slice(0, 5).join(', ')}`);
    }
    if (o.coverageGapsRemaining && o.coverageGapsRemaining.length > 0) {
      reasons.push(`${o.coverageGapsRemaining.length} changed symbol(s) still lack tests.`);
    }
    if (reasons.length === 0) reasons.push('The change is incomplete relative to the prediction.');
    return { gate: 'block', gateReasons: reasons, nextAction: 'address_gaps' };
  }
  if (o.verdict === 'scope_expanded') {
    return {
      gate: 'warn',
      gateReasons: ['The change touched files beyond the prediction — confirm the extra changes are intended.'],
      nextAction: 'confirm_scope',
    };
  }
  return { gate: 'pass', gateReasons: ['Change matches the prediction and gaps are addressed.'], nextAction: 'proceed_to_merge' };
}

// ── compare_change_impact (architecture regression delta) ─────────────────────

export function gateCompareChangeImpact(o: {
  verdict: 'regressed' | 'improved' | 'unchanged' | 'no_baseline';
  newCycles?: unknown[];
  newLayerViolations?: unknown[];
}): GateEnvelope {
  if (o.verdict === 'regressed') {
    const reasons: string[] = [];
    if (o.newCycles && o.newCycles.length > 0) reasons.push(`${o.newCycles.length} new import cycle(s) introduced.`);
    if (o.newLayerViolations && o.newLayerViolations.length > 0) reasons.push(`${o.newLayerViolations.length} new layer-boundary violation(s) introduced.`);
    if (reasons.length === 0) reasons.push('The change introduced an architecture regression.');
    return { gate: 'block', gateReasons: reasons, nextAction: 'fix_regression' };
  }
  if (o.verdict === 'no_baseline') {
    return {
      gate: 'warn',
      gateReasons: ['No baseline snapshot — architecture regression cannot be determined.'],
      nextAction: 'create_baseline',
    };
  }
  return {
    gate: 'pass',
    gateReasons: [o.verdict === 'improved' ? 'The change resolved architecture issues.' : 'No architecture regression introduced.'],
    nextAction: 'proceed',
  };
}

// ── check_consistency (pre-write greenfield front door) ───────────────────────

export function gateCheckConsistency(o: {
  signalQuality: 'ok' | 'low';
  duplicates: Array<{ similarity: number; name: string }>;
  placement: { fits: boolean } | null;
}): GateEnvelope {
  if (o.signalQuality === 'low') {
    return { gate: 'pass', gateReasons: ['Index too sparse to judge consistency.'], nextAction: 'proceed' };
  }
  const reasons: string[] = [];
  const exactDup = o.duplicates.find((d) => d.similarity >= 1);
  if (exactDup) reasons.push(`A symbol named "${exactDup.name}" already exists — you may be re-implementing it.`);
  if (o.placement && !o.placement.fits) reasons.push('Intended file diverges from where sibling symbols live.');
  if (reasons.length > 0) {
    return { gate: 'warn', gateReasons: reasons, nextAction: 'review_before_write' };
  }
  return { gate: 'pass', gateReasons: ['No duplicate or placement concerns found.'], nextAction: 'proceed' };
}
