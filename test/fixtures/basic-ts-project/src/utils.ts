import type { Diagnostic, Severity } from './types.js';

/**
 * Format a diagnostic message for display.
 * Returns a human-readable string with severity and location.
 */
export function formatDiagnostic(d: Diagnostic): string {
  return `[${d.severity.toUpperCase()}] ${d.file}:${d.line} - ${d.message}`;
}

/** Filter diagnostics by minimum severity. */
export function filterBySeverity(
  diagnostics: Diagnostic[],
  minSeverity: Severity,
): Diagnostic[] {
  const order: Severity[] = ['info', 'warning', 'error'];
  const minIdx = order.indexOf(minSeverity);
  return diagnostics.filter((d) => order.indexOf(d.severity) >= minIdx);
}

export const MAX_DIAGNOSTICS = 1000;
