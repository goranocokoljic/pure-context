/**
 * plan-refactoring-fixture: utils.ts
 *
 * - doWork: used in caller1.ts and caller2.ts (for rename-symbol / delete-symbol tests)
 * - isolatedHelper: no external references (safe to delete)
 * - complexProcessor: deliberately complex to surface in quality metrics (for general tests)
 */

/** Transform input by trimming and lowercasing. */
export function doWork(input: string): string {
  return input.trim().toLowerCase();
}

/** Isolated helper — no files import this. */
export function isolatedHelper(): void {
  // intentionally unreferenced
}

/**
 * Deliberately complex function to trigger quality-metric findings.
 * High cyclomatic complexity from nested conditionals.
 */
export function complexProcessor(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (value < 0) {
      if (value < -1000) {
        return 'very-negative';
      }
      return 'negative';
    }
    if (value === 0) {
      return 'zero';
    }
    if (value < 10) {
      return 'tiny';
    }
    if (value < 100) {
      return 'small';
    }
    if (value < 1000) {
      return 'medium';
    }
    return 'large';
  }
  if (typeof value === 'string') {
    if (value.length === 0) {
      return 'empty-string';
    }
    if (value.startsWith('http://') || value.startsWith('https://')) {
      if (value.includes('?')) {
        return 'url-with-query';
      }
      return 'url';
    }
    if (value.includes('@')) {
      return 'email';
    }
    if (value.length > 100) {
      return 'long-string';
    }
    return 'short-string';
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 'empty-array';
    }
    return `array:${value.length}`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) {
      return 'empty-object';
    }
    return `object:${keys.length}`;
  }
  return 'unknown';
}
